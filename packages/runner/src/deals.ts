import { getMap, type GameView } from '@risk/engine';
import type { ChatResult } from '@risk/mcp';

type ChatMsg = ChatResult['messages'][number];

export type DealKind = 'truce' | 'joint_attack' | 'border';
export type DealStatus = 'proposed' | 'active' | 'expired' | 'broken' | 'rejected';
export const DEAL_KINDS: readonly DealKind[] = ['truce', 'joint_attack', 'border'];

/**
 * A concrete agreement between two players, as one seat sees it. Seats share no memory: deals travel through
 * chat as short tags (`[deal She3: truce Shen+Lux until round 9]`, `[accept She3]`, `[reject She3]`) that the
 * other seat's ledger parses out of the messages it can read.
 */
export interface Deal {
  id: string;
  kind: DealKind;
  /** The two player names. */
  parties: [string, string];
  /** Truce / border: no attacks until this round (inclusive). Joint attack: optional end. */
  untilRound?: number;
  /** Joint attack: both attack `target` from this round. */
  startRound?: number;
  target?: string;
  /** Joint attack: minimum number of troops each party commits to attack `target`. */
  commitArmies?: number;
  /** Joint attack: armies committed so far against `target` by each party name. */
  committedArmies?: Record<string, number>;
  /** Border: player name to the territory ids that player keeps (nobody attacks across them). */
  territories?: Record<string, string[]>;
  status: DealStatus;
  /** True only after this character observed acceptance, not an unanswered expired offer. */
  accepted?: boolean;
  acceptedRound?: number;
  acceptedVersion?: number;
  proposedBy: string;
  proposedRound: number;
  text: string;
  /** Who broke it (status broken). */
  brokenBy?: string;
}

export interface DealStats {
  made: number;
  kept: number;
  broken: number;
}

/** How far ahead a deal may reach, so a typo like "round 900" is not a deal. */
const MAX_AHEAD = 40;

const lc = (s: string) => s.trim().toLowerCase();
const tagName = (n: string) => n.replace(/\s+/g, '_');

/** Shortest upper-case prefix of each name that no other name at the table shares (at least one letter). */
export function dealPrefixes(names: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const n of names) {
    const clean = n.replace(/[^A-Za-z0-9]/g, '') || 'P';
    let len = 1;
    const others = names.filter((x) => x !== n).map((x) => x.replace(/[^A-Za-z0-9]/g, '').toLowerCase());
    while (len < clean.length && others.some((o) => o.startsWith(clean.slice(0, len).toLowerCase()))) len++;
    const p = clean.slice(0, len);
    out.set(n, p[0].toUpperCase() + p.slice(1).toLowerCase());
  }
  return out;
}

export interface LedgerOptions {
  /** This seat's player name. */
  me: string;
  /** Prefix of the ids this seat creates. Default: the first letter of `me`. */
  idPrefix?: string;
  /** Called with a plain line whenever a deal is made, kept, broken, rejected or expired. */
  onEvent?: (line: string) => void;
}

/** One seat's view of the deals it is party to. */
export class DealLedger {
  readonly me: string;
  private prefix: string;
  private counter = 0;
  private deals = new Map<string, Deal>();
  private madeIds = new Set<string>();
  private seenMsgs = new Set<number>();
  private names: string[] = [];
  private alive = new Set<string>();
  round = 0;
  private observedVersion = 0;
  /** Every event line, oldest first (for the scouting log and the post-game note). */
  readonly history: string[] = [];
  onEvent: ((line: string) => void) | undefined;

  constructor(o: LedgerOptions) {
    this.me = o.me;
    this.prefix = o.idPrefix ?? (o.me.replace(/[^A-Za-z0-9]/g, '')[0] ?? 'P').toUpperCase();
    this.onEvent = o.onEvent;
  }

  private emit(line: string) {
    const text = `Round ${this.round}: ${line}`;
    this.history.push(text);
    this.onEvent?.(text);
  }

  /** Update the round and the player list from the latest view, then expire what is over. */
  sync(view: GameView) {
    this.round = Math.max(this.round, view.round);
    this.observedVersion = Math.max(this.observedVersion, view.version);
    this.names = view.players.filter((p) => !p.isNeutral).map((p) => p.name);
    this.alive = new Set(view.players.filter((p) => p.alive && !p.isNeutral).map((p) => lc(p.name)));
    this.expire();
  }

  private expire() {
    for (const d of this.deals.values()) {
      if (d.status !== 'proposed' && d.status !== 'active') continue;
      const commitDeadline = d.kind === 'joint_attack' && d.commitArmies !== undefined ? (d.untilRound ?? (d.startRound ?? d.proposedRound) + 1) : undefined;
      const over = (d.untilRound !== undefined && this.round > d.untilRound) || (commitDeadline !== undefined && this.round > commitDeadline);
      const targetGone = d.kind === 'joint_attack' && d.status === 'active' && d.target !== undefined && this.alive.size > 0 && !this.alive.has(lc(d.target));
      if (!over && !targetGone) continue;
      const was = d.status;
      if (was === 'active' && !targetGone && d.kind === 'joint_attack' && d.commitArmies !== undefined) {
        const partner = this.other(d);
        const partnerDone = this.committedBy(d, partner);
        const myDone = this.committedBy(d, this.me);
        if (partnerDone < d.commitArmies) {
          d.status = 'broken';
          d.brokenBy = partner;
          this.emit(`${partner} BROKE ${d.id} by failing to commit ${d.commitArmies} troops vs ${d.target} (committed ${partnerDone}/${d.commitArmies}): ${this.describe(d)}`);
          continue;
        }
        if (myDone < d.commitArmies) {
          d.status = 'broken';
          d.brokenBy = this.me;
          this.emit(`we BROKE ${d.id} by failing to commit ${d.commitArmies} troops vs ${d.target} (committed ${myDone}/${d.commitArmies}): ${this.describe(d)}`);
          continue;
        }
      }
      d.status = 'expired';
      if (was === 'active') this.emit(`deal ${d.id} ${targetGone && !over ? 'done (target gone)' : 'kept to the end'}: ${this.describe(d)}`);
    }
  }

  /** Armies `party` has committed so far toward a joint_attack deal. */
  committedBy(d: Deal, party: string): number {
    return Object.entries(d.committedArmies ?? {}).find(([k]) => lc(k) === lc(party))?.[1] ?? 0;
  }

  get(id: string): Deal | undefined {
    return this.deals.get(id) ?? [...this.deals.values()].find((d) => lc(d.id) === lc(id));
  }

  all(): Deal[] {
    return [...this.deals.values()];
  }

  active(): Deal[] {
    return this.all().filter((d) => d.status === 'active');
  }

  /** Offers made to this seat that still wait for an answer. */
  pendingForMe(): Deal[] {
    return this.all().filter((d) => d.status === 'proposed' && lc(d.proposedBy) !== lc(this.me));
  }

  other(d: Deal): string {
    return lc(d.parties[0]) === lc(this.me) ? d.parties[1] : d.parties[0];
  }

  /** Plain words for a deal (also used in logs and prompts). */
  describe(d: Deal): string {
    const [a, b] = d.parties;
    const until = d.untilRound !== undefined ? ` until round ${d.untilRound}` : '';
    if (d.kind === 'truce') return `truce ${a}+${b}${until}`;
    if (d.kind === 'joint_attack') return `joint attack ${a}+${b} on ${d.target}${d.commitArmies ? ` (commit ${d.commitArmies} troops)` : ''} from round ${d.startRound}${until}`;
    const keeps = Object.entries(d.territories ?? {})
      .map(([p, ts]) => `${p} keeps ${ts.join(', ')}`)
      .join('; ');
    return `border ${a}+${b}${until}${keeps ? `; ${keeps}` : ''}`;
  }

  /** The compact chat tag for a proposal. */
  tag(d: Deal): string {
    const [a, b] = d.parties.map(tagName);
    let body: string;
    if (d.kind === 'truce') body = `truce ${a}+${b} until round ${d.untilRound}`;
    else if (d.kind === 'joint_attack') body = `joint_attack ${a}+${b} vs ${tagName(d.target!)}${d.commitArmies ? ` commit ${d.commitArmies}` : ''} from round ${d.startRound}${d.untilRound !== undefined ? ` until round ${d.untilRound}` : ''}`;
    else {
      const keeps = Object.entries(d.territories ?? {})
        .filter(([, ts]) => ts.length > 0)
        .map(([p, ts]) => `${tagName(p)} keeps ${ts.join(',')}`)
        .join('; ');
      body = `border ${a}+${b} until round ${d.untilRound}${keeps ? `; ${keeps}` : ''}`;
    }
    return `[deal ${d.id}: ${body}]`;
  }

  // ---------- outgoing ----------

  private newId(): string {
    let id: string;
    do id = `${this.prefix}${++this.counter}`;
    while (this.deals.has(id));
    return id;
  }

  private resolvePlayer(raw: unknown, view: GameView, allowSelf = false): string | null {
    if (typeof raw !== 'string') return null;
    const p = view.players.find((x) => !x.isNeutral && x.alive && lc(x.name) === lc(raw));
    if (!p) return null;
    if (!allowSelf && lc(p.name) === lc(this.me)) return null;
    return p.name;
  }

  private roundNum(v: unknown): number | undefined {
    const n = typeof v === 'string' ? Number(v) : v;
    return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= this.round + MAX_AHEAD ? n : undefined;
  }

  private commitNum(v: unknown, text: string): number | undefined {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 500) return n;
    const m =
      /\b(?:commit(?:ting)?|send(?:ing)?|throw(?:ing)?|put(?:ting)?|pledg(?:e|ing))\s+(\d+)\s+(?:troops?|armies)\b/i.exec(text) ??
      /\b(\d+)\s+(?:troops?|armies)\s+(?:into|against|at|on)\b/i.exec(text);
    if (m) {
      const parsed = Number(m[1]);
      if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 500) return parsed;
    }
    return undefined;
  }

  /**
   * Validate a model's proposal (`{kind, with, untilRound, startRound, target, commitArmies, territories}`) against the board
   * and record it as proposed by this seat. Null when it is not a concrete, legal deal.
   * `exceptId`: a deal being countered (does not block its replacement).
   */
  propose(raw: unknown, view: GameView, text: string, exceptId?: string): Deal | null {
    this.sync(view);
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const kind = DEAL_KINDS.find((k) => k === lc(String(r.kind ?? '').replace(/[\s-]+/g, '_')));
    if (!kind) return null;
    let partner: string | null = this.resolvePlayer(r.with, view);
    if (!partner && Array.isArray(r.parties)) {
      for (const x of r.parties) partner = partner ?? this.resolvePlayer(x, view);
    }
    if (!partner) return null;
    const until = this.roundNum(r.untilRound);
    const start = this.roundNum(r.startRound);
    const deal: Deal = {
      id: '',
      kind,
      parties: [this.me, partner],
      status: 'proposed',
      proposedBy: this.me,
      proposedRound: this.round,
      text: text.replace(/\s+/g, ' ').trim().slice(0, 240),
    };
    if (kind === 'truce' || kind === 'border') {
      // Concrete terms only: an end round is required, and it must lie ahead.
      if (until === undefined || until < this.round) return null;
      deal.untilRound = until;
    }
    if (kind === 'joint_attack') {
      const target = this.resolvePlayer(r.target, view);
      if (!target || lc(target) === lc(partner)) return null;
      const from = start ?? this.round + 1;
      if (from < this.round) return null;
      if (until !== undefined && until < from) return null;
      deal.target = target;
      deal.startRound = from;
      if (until !== undefined) deal.untilRound = until;
      const commit = this.commitNum(r.commitArmies ?? r.commit ?? r.troops ?? r.armies, text);
      if (commit !== undefined) {
        deal.commitArmies = commit;
        deal.committedArmies = { [this.me]: 0, [partner]: 0 };
      }
    }
    if (kind === 'border') {
      const map = getMap(view.options.map);
      const byName = new Map(map.territories.map((t) => [lc(t.name), t.id]));
      const territories: Record<string, string[]> = {};
      const given = r.territories && typeof r.territories === 'object' && !Array.isArray(r.territories) ? (r.territories as Record<string, unknown>) : {};
      for (const [who, list] of Object.entries(given)) {
        const owner = this.resolvePlayer(who, view, true);
        if (!owner || ![lc(this.me), lc(partner)].includes(lc(owner)) || !Array.isArray(list)) continue;
        const ids = list
          .map((x) => (typeof x === 'string' ? (map.isTerritory(x.trim().toLowerCase()) ? x.trim().toLowerCase() : byName.get(lc(x))) : undefined))
          .filter((x): x is string => !!x);
        if (ids.length > 0) territories[owner] = [...new Set(ids)];
      }
      if (Object.keys(territories).length === 0) return null;
      // Only claim territories we really hold.
      const mine = Object.entries(territories).find(([who]) => lc(who) === lc(this.me))?.[1] ?? [];
      if (mine.some((t) => view.territories[t]?.owner !== view.you)) return null;
      deal.territories = territories;
    }
    // No second live deal of the same kind with the same player (a counter replaces its original).
    const clash = this.all().some((d) => d.id !== exceptId && (d.status === 'proposed' || d.status === 'active') && d.kind === kind && lc(this.other(d)) === lc(partner!) && (kind !== 'joint_attack' || lc(d.target ?? '') === lc(deal.target ?? '')));
    if (clash) return null;
    deal.id = this.newId();
    this.deals.set(deal.id, deal);
    this.emit(`proposed ${deal.id} to ${partner}: ${this.describe(deal)}`);
    return deal;
  }

  /**
   * Answer an offer: `{dealId, answer: 'accept'|'reject'|'counter', counter?}`. Returns the chat tags to post
   * (and the partner's name), or null when the answer does not fit a pending offer.
   */
  answer(raw: unknown, view: GameView, text: string): { tags: string[]; partner: string } | null {
    this.sync(view);
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const d = typeof r.dealId === 'string' ? this.get(r.dealId.trim()) : undefined;
    if (!d || d.status !== 'proposed' || lc(d.proposedBy) === lc(this.me)) return null;
    const how = lc(String(r.answer ?? ''));
    const partner = this.other(d);
    if (how === 'accept') {
      d.status = 'active';
      this.madeIds.add(d.id);
      d.accepted = true;
      d.acceptedRound = this.round;
      d.acceptedVersion = this.observedVersion;
      this.emit(`accepted ${d.id} from ${partner}: ${this.describe(d)}`);
      return { tags: [`[accept ${d.id}]`], partner };
    }
    if (how === 'reject') {
      d.status = 'rejected';
      this.emit(`rejected ${d.id} from ${partner}`);
      return { tags: [`[reject ${d.id}]`], partner };
    }
    if (how === 'counter') {
      const counter = r.counter && typeof r.counter === 'object' ? { with: partner, ...(r.counter as Record<string, unknown>) } : null;
      if (!counter || lc(String((counter as Record<string, unknown>).with)) !== lc(partner)) return null;
      d.status = 'rejected';
      const next = this.propose(counter, view, text, d.id);
      if (!next) {
        d.status = 'proposed';
        return null;
      }
      this.emit(`countered ${d.id} with ${next.id}`);
      return { tags: [`[reject ${d.id}]`, this.tag(next)], partner };
    }
    return null;
  }

  // ---------- incoming ----------

  private resolveKnown(raw: string): string | null {
    const spaced = raw.replace(/_/g, ' ');
    return this.names.find((n) => lc(n) === lc(spaced) || lc(n) === lc(raw)) ?? null;
  }

  private parseBody(id: string, body: string, from: string): Deal | null {
    const m = /^(truce|joint_attack|border)\s+(\S+?)\+(\S+)(.*)$/.exec(body.trim());
    if (!m) return null;
    const a = this.resolveKnown(m[2]);
    const b = this.resolveKnown(m[3]);
    if (!a || !b || lc(a) === lc(b)) return null;
    const rest = m[4];
    const num = (re: RegExp) => {
      const x = re.exec(rest);
      return x ? Number(x[1]) : undefined;
    };
    const deal: Deal = { id, kind: m[1] as DealKind, parties: [a, b], status: 'proposed', proposedBy: from, proposedRound: this.round, text: '' };
    const until = num(/\buntil round (\d+)/);
    if (until !== undefined) deal.untilRound = until;
    if (deal.kind === 'joint_attack') {
      const t = /\bvs (\S+)/.exec(rest);
      const target = t ? this.resolveKnown(t[1]) : null;
      const from2 = num(/\bfrom round (\d+)/);
      const commit = num(/\bcommit (\d+)(?:\s+(?:troops?|armies))?/);
      if (!target || from2 === undefined || lc(target) === lc(a) || lc(target) === lc(b)) return null;
      deal.target = target;
      deal.startRound = from2;
      if (commit !== undefined && commit >= 1 && commit <= 500) {
        deal.commitArmies = commit;
        deal.committedArmies = { [a]: 0, [b]: 0 };
      }
    } else if (until === undefined) return null;
    if (deal.kind === 'border') {
      const terr: Record<string, string[]> = {};
      for (const k of rest.matchAll(/;\s*(\S+) keeps ([^;]+)/g)) {
        const who = this.resolveKnown(k[1]);
        if (who) terr[who] = k[2].split(',').map((x) => x.trim()).filter(Boolean);
      }
      if (Object.keys(terr).length === 0) return null;
      deal.territories = terr;
    }
    deal.text = body.trim();
    return deal;
  }

  /** Read deal tags out of messages this seat could read. Messages are handled once (by id). */
  ingest(msgs: ChatMsg[]) {
    for (const m of msgs) {
      if (this.seenMsgs.has(m.id)) continue;
      this.seenMsgs.add(m.id);
      if (this.seenMsgs.size > 2000) this.seenMsgs = new Set([...this.seenMsgs].slice(-1000));
      if (m.spectator || lc(m.name) === lc(this.me)) continue;
      const from = this.names.find((n) => lc(n) === lc(m.name));
      if (!from) continue;
      for (const t of m.message.matchAll(/\[(deal|accept|reject) ([A-Za-z0-9]+)(?::\s*([^\]]*))?\]/g)) {
        const [, verb, id, body] = t;
        if (verb === 'deal') {
          if (this.deals.has(id) || !body) continue;
          const deal = this.parseBody(id, body, from);
          if (!deal) continue;
          const involvesBoth = [lc(deal.parties[0]), lc(deal.parties[1])];
          if (!involvesBoth.includes(lc(this.me)) || !involvesBoth.includes(lc(from))) continue;
          if (deal.untilRound !== undefined && deal.untilRound < this.round) continue;
          this.deals.set(id, deal);
          this.emit(`offered ${id} by ${from}: ${this.describe(deal)}`);
          continue;
        }
        const d = this.get(id);
        if (!d || d.status !== 'proposed' || lc(d.proposedBy) !== lc(this.me) || lc(this.other(d)) !== lc(from)) continue;
        if (verb === 'accept') {
          d.status = 'active';
          this.madeIds.add(d.id);
          d.accepted = true;
          d.acceptedRound = this.round;
          d.acceptedVersion = this.observedVersion;
          this.emit(`${from} accepted ${d.id}: ${this.describe(d)}`);
        } else {
          d.status = 'rejected';
          this.emit(`${from} rejected ${d.id}`);
        }
      }
    }
  }

  // ---------- breaking and counting ----------

  /** Record `armies` committed by `attacker` into attacks against `target` toward any active joint_attack deal. */
  noteCommitment(attacker: string, target: string, armies: number): Deal[] {
    if (armies <= 0) return [];
    const updated: Deal[] = [];
    for (const d of this.active()) {
      if (d.kind !== 'joint_attack' || !d.target || lc(d.target) !== lc(target)) continue;
      const party = d.parties.find((p) => lc(p) === lc(attacker));
      if (!party) continue;
      d.committedArmies ??= { [d.parties[0]]: 0, [d.parties[1]]: 0 };
      const before = d.committedArmies[party] ?? 0;
      const after = before + armies;
      d.committedArmies[party] = after;
      updated.push(d);
      if (d.commitArmies !== undefined && before < d.commitArmies && after >= d.commitArmies) {
        this.emit(`${party} honored troop commitment on ${d.id} (${after}/${d.commitArmies} troops vs ${d.target})`);
      }
    }
    return updated;
  }

  /** `attacker` took territory from this seat: every active deal with them is broken by them. */
  noteHit(attacker: string, observedIds?: Set<string>): Deal[] {
    const hit: Deal[] = [];
    for (const d of this.active()) {
      if (lc(this.other(d)) !== lc(attacker) || (observedIds && !observedIds.has(d.id))) continue;
      d.status = 'broken';
      d.brokenBy = this.other(d);
      hit.push(d);
      this.emit(`${d.brokenBy} BROKE ${d.id} by attacking us: ${this.describe(d)}`);
    }
    return hit;
  }

  /** This seat deliberately breaks an active deal (the commander's choice). */
  breakByMe(id: string): Deal | null {
    const d = this.get(id);
    if (!d || d.status !== 'active') return null;
    d.status = 'broken';
    d.brokenBy = this.me;
    this.emit(`we BROKE ${d.id} on purpose: ${this.describe(d)}`);
    return d;
  }

  /** End of game: deals still running count as kept. */
  finish() {
    for (const d of this.active()) {
      d.status = 'expired';
      this.emit(`deal ${d.id} kept to the end of the game: ${this.describe(d)}`);
    }
  }

  stats(): DealStats {
    const made = this.madeIds.size;
    const broken = this.all().filter((d) => d.status === 'broken' && this.madeIds.has(d.id)).length;
    const kept = this.all().filter((d) => d.status === 'expired' && this.madeIds.has(d.id)).length;
    return { made, kept, broken };
  }

  /** The ledger in words for prompts: live deals with rounds, offers waiting, and recent breaks. */
  summary(): string {
    const lines: string[] = [];
    for (const d of this.pendingForMe()) lines.push(`- ${d.id}: OFFER TO YOU from ${d.proposedBy}, waiting for your answer: ${this.describe(d)}`);
    for (const d of this.active()) {
      const progress =
        d.kind === 'joint_attack' && d.commitArmies !== undefined
          ? ` [${d.parties.map((p) => `${p} committed ${this.committedBy(d, p)}/${d.commitArmies}`).join(', ')}]`
          : '';
      lines.push(`- ${d.id}: ACTIVE ${this.describe(d)}${progress}`);
    }
    for (const d of this.all()) if (d.status === 'proposed' && lc(d.proposedBy) === lc(this.me)) lines.push(`- ${d.id}: you offered ${this.other(d)}, no answer yet: ${this.describe(d)}`);
    for (const d of this.all().filter((x) => x.status === 'broken').slice(-3)) lines.push(`- ${d.id}: BROKEN by ${d.brokenBy}: ${this.describe(d)}`);
    return lines.length > 0 ? lines.join('\n') : '(none)';
  }
}
