import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { RuleError } from '@risk/engine';
import { ZERG_NAMES } from './bot.js';
import { RateLimiter } from './rate-limit.js';

/**
 * Player keys (owner's choice "A": self-serve, rate-limited, no invite). A key names one player on the leaderboard:
 * seats joined with it play under the player's registered name and are ranked as `key:<playerId>`, so nobody else
 * can move that record. A key is 192 random bits, shown once when issued or rotated; only its SHA-256 is stored (under
 * RISK_DATA_DIR), and it is read from the `X-Player-Key` header only. It never appears in logs, views, records or
 * history. Issuing is limited per client IP and in total per day, and the counts survive a restart.
 */

/** A registered player as stored: the key's hash only. */
export interface PlayerAccount {
  id: string;
  name: string;
  /** SHA-256 of the key, hex. */
  hash: string;
  createdAt: number;
  rotatedAt?: number;
  /** Set by the admin: the key no longer works. The player's games and leaderboard rows stay. */
  revokedAt?: number;
}

/** A player as anyone may see it (never the hash). */
export interface PlayerInfo {
  playerId: string;
  name: string;
  createdAt: number;
  revoked?: true;
}

export interface PlayerKeyLimits {
  /** Keys issued per client IP in any 24 h. */
  perIpPerDay: number;
  /** Keys issued in total in any 24 h. */
  perDay: number;
}

export const DEFAULT_PLAYER_KEY_LIMITS: PlayerKeyLimits = { perIpPerDay: 3, perDay: 100 };
const DAY_MS = 24 * 3600_000;
export const PLAYER_KEY_HEADER = 'x-player-key';

/** RISK_PLAYER_KEYS (0 = issuing off), RISK_PLAYER_KEYS_PER_IP_DAY, RISK_PLAYER_KEYS_PER_DAY over the defaults. */
export function playerKeyConfigFromEnv(env: NodeJS.ProcessEnv): { enabled: boolean; limits: PlayerKeyLimits } {
  const int = (key: string, fallback: number) => {
    const n = Number(env[key]);
    return env[key] !== undefined && env[key] !== '' && Number.isInteger(n) && n >= 0 ? n : fallback;
  };
  return {
    enabled: env.RISK_PLAYER_KEYS !== '0',
    limits: { perIpPerDay: int('RISK_PLAYER_KEYS_PER_IP_DAY', DEFAULT_PLAYER_KEY_LIMITS.perIpPerDay), perDay: int('RISK_PLAYER_KEYS_PER_DAY', DEFAULT_PLAYER_KEY_LIMITS.perDay) },
  };
}

/** Too many keys issued (HTTP 429), or issuing switched off (403). */
export class PlayerKeyLimitError extends Error {
  constructor(
    message: string,
    readonly status: 403 | 429,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

const digest = (key: string) => createHash('sha256').update(key).digest();
const newKey = () => `rk_${randomBytes(24).toString('base64url')}`;
const newPlayerId = () => `pk_${randomBytes(6).toString('base64url')}`;
/**
 * Letters that look like others, folded to one (Cyrillic and Greek look-alikes of Latin letters, and 0/1/| vs o/l), so
 * "Аda" (Cyrillic А) or "Ada" with a zero-width space counts as "Ada".
 */
const CONFUSABLES: Record<string, string> = {
  а: 'a', в: 'b', е: 'e', ё: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', у: 'y', х: 'x', ѕ: 's', і: 'i', ї: 'i', ј: 'j', ԁ: 'd', ԛ: 'q', ԝ: 'w',
  α: 'a', β: 'b', ε: 'e', η: 'n', ι: 'i', κ: 'k', μ: 'u', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x', ω: 'w',
  '0': 'o', '1': 'l', i: 'l', '|': 'l',
};

/**
 * A name's comparison form: Unicode NFKC (full-width, ligatures and other compatibility forms to plain letters), lower
 * case, zero-width and other invisible characters removed, look-alike letters folded, spaces collapsed. Two names with
 * the same skeleton are the same name for registration and seats.
 */
export function nameSkeleton(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/[^\s]/gu, (ch) => CONFUSABLES[ch] ?? ch)
    .replace(/\s+/g, ' ')
    .trim();
}

const normal = nameSkeleton;
/** Words the server uses for seats, as skeletons. */
const SERVER_WORDS = ['neutral', 'host', 'admin'].map(nameSkeleton);

/** Names nobody may register: the Zergs, the server's bots and other built-in seats (AI characters are added by the app). */
export function builtInReservedName(name: string): string | null {
  const n = normal(name);
  if (n.includes('zerg') || ZERG_NAMES.some((z) => normal(z) === n)) return 'Zerg names belong to the house bots';
  // Compared as skeletons, where the digits 0 and 1 fold to o and l ("Bot 10" is "bot lo").
  if (/^(bot|player|agent)( [0-9ol]+)?$/.test(n) || SERVER_WORDS.includes(n)) return 'That name is used by the server';
  return null;
}

interface SavedFile {
  version: 1;
  players: PlayerAccount[];
  issued: { at: number; ip: string }[];
}

export class PlayerKeyStore {
  private players = new Map<string, PlayerAccount>();
  private byHash = new Map<string, PlayerAccount>();
  /** Registered names by skeleton (revoked ones too: a name stays taken). */
  private byName = new Map<string, PlayerAccount>();
  /** Recent issues (last 24 h), for the limits. The IP is kept only for the window. */
  private issued: { at: number; ip: string }[] = [];
  enabled = true;
  /** Key tries per client (the MCP use_player_key tool), so keys cannot be guessed through it: 10 per 15 minutes. */
  tryLimiter = new RateLimiter(10, 15 * 60_000);
  /** Extra reserved names (the app adds the AI characters' ids and names). Returns why, or null. */
  reserved: (name: string) => string | null = builtInReservedName;

  constructor(
    private file: string | null,
    public limits: PlayerKeyLimits = DEFAULT_PLAYER_KEY_LIMITS,
    private now: () => number = Date.now,
  ) {
    if (file && existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8')) as SavedFile;
        for (const p of data.players ?? []) this.index(p);
        this.issued = (data.issued ?? []).filter((x) => this.now() - x.at < DAY_MS);
      } catch (err) {
        console.error('[player-keys] could not read the saved players:', (err as Error).message);
      }
    }
  }

  /** Register `rawName` and issue its key (returned once). `ip`: the client, for the per-IP limit. */
  issue(rawName: unknown, ip: string): { player: PlayerInfo; key: string } {
    if (!this.enabled) throw new PlayerKeyLimitError('Player keys are switched off on this server', 403);
    const name = this.checkName(rawName);
    const now = this.now();
    this.issued = this.issued.filter((x) => now - x.at < DAY_MS);
    const retry = (list: { at: number }[]) => Math.max(1, Math.ceil((list[0].at + DAY_MS - now) / 1000));
    const mine = this.issued.filter((x) => x.ip === ip);
    if (mine.length >= this.limits.perIpPerDay) throw new PlayerKeyLimitError(`At most ${this.limits.perIpPerDay} player keys a day from one address`, 429, retry(mine));
    if (this.issued.length >= this.limits.perDay) throw new PlayerKeyLimitError('Too many player keys were issued today: try again tomorrow', 429, retry(this.issued));
    const key = newKey();
    let id = newPlayerId();
    while (this.players.has(id)) id = newPlayerId();
    const account: PlayerAccount = { id, name, hash: digest(key).toString('hex'), createdAt: now };
    this.index(account);
    this.issued.push({ at: now, ip });
    this.save();
    return { player: this.info(account), key };
  }

  /** The live player a key belongs to, or null (unknown, malformed or revoked). Constant-time on the hash. */
  verify(key: unknown): PlayerAccount | null {
    if (typeof key !== 'string' || !key.startsWith('rk_') || key.length > 100) return null;
    const d = digest(key);
    const p = this.byHash.get(d.toString('hex'));
    if (!p || p.revokedAt !== undefined) return null;
    return timingSafeEqual(Buffer.from(p.hash, 'hex'), d) ? p : null;
  }

  /** A new key for the player holding `key`; the old one stops working at once. */
  rotate(key: unknown): { player: PlayerInfo; key: string } | null {
    const p = this.verify(key);
    if (!p) return null;
    this.byHash.delete(p.hash);
    const fresh = newKey();
    p.hash = digest(fresh).toString('hex');
    p.rotatedAt = this.now();
    this.byHash.set(p.hash, p);
    this.save();
    return { player: this.info(p), key: fresh };
  }

  /** Admin: the player's key stops working. False when there is no such player. */
  revoke(id: string): boolean {
    const p = this.players.get(id);
    if (!p) return false;
    if (p.revokedAt === undefined) {
      p.revokedAt = this.now();
      this.byHash.delete(p.hash);
      this.save();
    }
    return true;
  }

  get(id: string): PlayerAccount | null {
    return this.players.get(id) ?? null;
  }

  list(): PlayerInfo[] {
    return [...this.players.values()].map((p) => this.info(p));
  }

  /** Is this a registered player's name (any case)? Seats without that player's key may not use it. */
  isRegistered(name: string): boolean {
    return this.byName.has(normal(name));
  }

  /**
   * The name a seat joins under: the key's registered name when there is a key, else `rawName`, refused when it is a
   * registered player's name (nobody can play under someone's registered name without their key).
   */
  seatName(rawName: string, account: PlayerAccount | null): string {
    if (account) return account.name;
    if (rawName.trim() && this.isRegistered(rawName)) throw new RuleError(`"${rawName.trim()}" is a registered player's name: join with that player's key, or pick another name`);
    return rawName;
  }

  info(p: PlayerAccount): PlayerInfo {
    return { playerId: p.id, name: p.name, createdAt: p.createdAt, ...(p.revokedAt !== undefined ? { revoked: true as const } : {}) };
  }

  private checkName(raw: unknown): string {
    const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
    if (name.length < 2 || name.length > 24) throw new RuleError('A player name is 2-24 characters');
    if (!/^[\p{L}\p{N} ._'-]+$/u.test(name)) throw new RuleError('A player name uses letters, digits, spaces and . _ \' - only');
    const why = this.reserved(name) ?? builtInReservedName(name);
    if (why) throw new RuleError(`"${name}" cannot be registered: ${why}`);
    if (this.isRegistered(name)) throw new RuleError(`"${name}" is already registered`);
    return name;
  }

  private index(p: PlayerAccount) {
    this.players.set(p.id, p);
    this.byName.set(normal(p.name), p);
    if (p.revokedAt === undefined) this.byHash.set(p.hash, p);
  }

  private save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const data: SavedFile = { version: 1, players: [...this.players.values()], issued: this.issued };
      writeFileSync(this.file + '.tmp', JSON.stringify(data));
      renameSync(this.file + '.tmp', this.file);
    } catch (err) {
      console.error('[player-keys] could not save the players:', (err as Error).message);
    }
  }
}
