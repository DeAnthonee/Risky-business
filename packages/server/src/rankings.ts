import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { finalPlacements, rankLeaderboard, uniqueBoardNames, type GameState, type RankedGame, type RankingRow } from '@risk/engine';

/**
 * The live leaderboard's season in code. Bump it to wipe the board on the next deploy: on start, a `rankings.json` from
 * an older season is moved to `rankings.season-<old>.json` (kept, never deleted) and the ladder starts empty.
 * The admin route `POST /api/admin/rankings/new-season` does the same without a deploy. The season in force is the
 * higher of this number and the one saved in `rankings.json.season`: a code season at or below the saved one changes
 * nothing, a newer one starts that season on the next start.
 * Season 1 was everything before the first wipe (including the Gen 5 seed from #92); season 2 ran from #107 to #119;
 * season 3 from #119 to #135.
 */
export const RANKINGS_SEASON = 4;

/** One leaderboard season: the current one, or an archive. `id` is the season, plus `-<n>` for a rare second archive. */
export interface RankingSeason { id: string; season: number; current: boolean; games: number }

const ARCHIVE = /\.season-(\d+)(?:-(\d+))?\.json$/;

/** Server-owned, append-only results, kept independently of expiring game rooms. */
export class Rankings {
  private games: RankedGame[] = [];
  /** Every game id ever recorded, archives included, so a finished room still open is never counted twice. */
  private ids = new Set<string>();
  /** The season in force (see `RANKINGS_SEASON`). */
  season: number;
  /** Archived boards by id: read from disk on first use (archives never change), or held here when not persisted. */
  private archives = new Map<string, RankedGame[]>();

  constructor(
    private file: string | null,
    codeSeason = RANKINGS_SEASON,
  ) {
    if (!file) { this.season = codeSeason; return; }
    const seasonFile = `${file}.season`;
    const saved = existsSync(seasonFile) ? Number(readFileSync(seasonFile, 'utf8').trim()) || 1 : 1;
    this.season = saved;
    if (existsSync(file)) {
      try {
        const games = JSON.parse(readFileSync(file, 'utf8')) as unknown;
        if (!Array.isArray(games)) throw new Error('not a list of games');
        for (const g of games) {
          if (g && typeof g.gameId === 'string' && Array.isArray(g.seats) && !this.ids.has(g.gameId)) {
            this.games.push(g);
            this.ids.add(g.gameId);
          }
        }
      } catch (e) {
        // A bad file must not keep the server from starting: set it aside and start empty.
        console.error(`rankings: could not read ${file} (${(e as Error).message}); moved to ${file}.corrupt`);
        try { renameSync(file, `${file}.corrupt`); } catch { /* keep going */ }
      }
    }
    // A newer code season starts a new one, archiving the old board first. If that fails the season file is left
    // alone and it is retried on the next start.
    if (codeSeason > saved) this.archiveTo(codeSeason);
    for (const id of this.archiveIds()) for (const g of this.archive(id) ?? []) this.ids.add(g.gameId);
  }

  /**
   * Archive the current board and start `next` empty: the deploy-time bump and the admin route both come here.
   * The board is saved, then moved beside it under a free name (never over an archive), then the season file is
   * replaced atomically; if that last step fails the board is moved back and nothing changes. It is synchronous, so a
   * game finishing at the same moment is recorded wholly before (archived) or wholly after (new season) it.
   */
  private archiveTo(next: number): boolean {
    const from = this.season;
    if (!this.file) {
      if (this.games.length) this.archives.set(this.freeArchiveId(from), this.games);
      this.games = [];
      this.season = next;
      return true;
    }
    const seasonFile = `${this.file}.season`;
    let archived: string | null = null;
    if (this.games.length && !this.save()) return false;
    if (existsSync(this.file)) {
      archived = this.archivePath(this.freeArchiveId(from));
      try {
        renameSync(this.file, archived);
      } catch (e) {
        console.error(`rankings: could not archive ${this.file} (${(e as Error).message}); still on season ${from}`);
        return false;
      }
    }
    try {
      mkdirSync(dirname(seasonFile), { recursive: true });
      writeFileSync(`${seasonFile}.tmp`, `${next}\n`, 'utf8');
      renameSync(`${seasonFile}.tmp`, seasonFile);
    } catch (e) {
      console.error(`rankings: could not save ${seasonFile} (${(e as Error).message}); still on season ${from}`);
      if (archived) try { renameSync(archived, this.file); } catch { /* the archive is kept either way */ }
      return false;
    }
    this.games = [];
    this.season = next;
    console.log(`rankings: season ${from} archived${archived ? ` to ${archived}` : ' (empty)'}; season ${next} starts empty`);
    return true;
  }

  /** Admin: archive the board now and start the next season. Throws if the archive could not be made. */
  newSeason(): { archived: number; season: number } {
    const archived = this.season;
    if (!this.archiveTo(archived + 1)) throw new Error('Could not archive the leaderboard; see the server log');
    return { archived, season: this.season };
  }

  private save(): boolean {
    if (!this.file) return true;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.games), 'utf8');
      renameSync(`${this.file}.tmp`, this.file);
      return true;
    } catch (e) {
      console.error(`rankings: could not save ${this.file}: ${(e as Error).message}`);
      return false;
    }
  }

  /** `rankings.season-<id>.json` beside the live file. */
  private archivePath(id: string) { return join(dirname(this.file!), `${basename(this.file!).replace(/\.json$/, '')}.season-${id}.json`); }

  /** The first unused archive id for a season: `<season>`, then `<season>-2`, `<season>-3`... */
  private freeArchiveId(season: number): string {
    const taken = (id: string) => this.file ? existsSync(this.archivePath(id)) : this.archives.has(id);
    let id = String(season);
    for (let n = 2; taken(id); n++) id = `${season}-${n}`;
    return id;
  }

  /** Every season, current first, then archives newest first. */
  seasons(): RankingSeason[] {
    const out: RankingSeason[] = [{ id: String(this.season), season: this.season, current: true, games: this.games.length }];
    for (const id of this.archiveIds()) {
      const games = this.archive(id);
      if (games) out.push({ id, season: Number(id.split('-')[0]), current: false, games: games.length });
    }
    return out;
  }

  private archiveIds(): string[] {
    const ids = new Set(this.archives.keys());
    if (this.file) {
      const stem = basename(this.file).replace(/\.json$/, '');
      try {
        for (const name of readdirSync(dirname(this.file))) {
          const m = name.startsWith(`${stem}.season-`) ? ARCHIVE.exec(name) : null;
          if (m) ids.add(m[2] ? `${m[1]}-${m[2]}` : m[1]);
        }
      } catch { /* no data dir yet */ }
    }
    const order = (id: string) => { const [s, n] = id.split('-').map(Number); return [s, n || 1]; };
    return [...ids].sort((a, b) => { const [x, y] = [order(a), order(b)]; return y[0] - x[0] || y[1] - x[1]; });
  }

  /** An archived board, or null when there is none by that id. */
  private archive(id: string): RankedGame[] | null {
    if (!/^\d+(?:-\d+)?$/.test(id)) return null;
    const cached = this.archives.get(id);
    if (cached || !this.file) return cached ?? null;
    const path = this.archivePath(id);
    if (!existsSync(path)) return null;
    try {
      const games = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (!Array.isArray(games)) throw new Error('not a list of games');
      const valid = games.filter(g => g && typeof g.gameId === 'string' && Array.isArray(g.seats)) as RankedGame[];
      this.archives.set(id, valid);
      return valid;
    } catch (e) {
      console.error(`rankings: could not read ${path}: ${(e as Error).message}`);
      return null;
    }
  }

  /** The board, every row with its own display name (see `uniqueBoardNames`). */
  rows(): RankingRow[] { return uniqueBoardNames(rankLeaderboard(this.games), this.games); }

  /** A season's board by id (current when omitted or equal to the current season); null when there is none. */
  seasonRows(season?: string): RankingRow[] | null {
    if (season === undefined || season === '' || season === String(this.season)) return this.rows();
    const games = this.archive(season);
    return games && uniqueBoardNames(rankLeaderboard(games), games);
  }

  profile(key: string, name: string, season?: string): RankingRow {
    return (this.seasonRows(season) ?? []).find(r => r.key === key) ?? { key, name, rank: 0, points: 0, games: 0, wins: 0, losses: 0, winRate: 0, avgPlacement: 0, kills: 0, victims: {} };
  }

  record(state: GameState, identities: Record<string, string>, eliminated: string[]) {
    if (state.phase !== 'finished' || !state.winner || this.ids.has(state.id)) return;
    const standings = finalPlacements(state, eliminated);
    if (standings.length < 2) return;
    const byId = new Map(state.players.map((p) => [p.id, p]));
    const keyOf = (id: string) => {
      const p = byId.get(id)!;
      return identities[p.id] ?? `${p.isBot ? 'bot' : 'player'}:${p.name.trim().toLowerCase()}`;
    };
    // Kills: ranked players this seat eliminated (surrenders and neutral armies credit nobody).
    const result = {
      gameId: state.id,
      seats: standings.map((s) => ({ key: keyOf(s.id), name: byId.get(s.id)!.name, placement: s.placement, killed: s.killed.map(keyOf) })),
    };
    this.games.push(result);
    this.ids.add(state.id);
    this.save();
  }
}
