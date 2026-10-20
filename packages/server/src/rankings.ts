import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { finalPlacements, rankLeaderboard, uniqueBoardNames, type GameState, type RankedGame, type RankingRow } from '@risk/engine';

/**
 * The live leaderboard's season. Bump it to wipe the board on the next deploy: on start, a `rankings.json` from an
 * older season is moved to `rankings.season-<old>.json` (kept, never deleted) and the ladder starts empty.
 * Season 1 was everything before the first wipe (including the Gen 5 seed from #92).
 */
export const RANKINGS_SEASON = 2;

/** Server-owned, append-only results, kept independently of expiring game rooms. */
export class Rankings {
  private games: RankedGame[] = [];
  private ids = new Set<string>();

  constructor(
    private file: string | null,
    private season = RANKINGS_SEASON,
  ) {
    if (!file) return;
    const seasonFile = `${file}.season`;
    const saved = existsSync(seasonFile) ? Number(readFileSync(seasonFile, 'utf8').trim()) || 1 : 1;
    if (saved !== season && existsSync(file)) {
      // A new season starts empty; the old board is archived beside it.
      const archived = file.replace(/\.json$/, '') + `.season-${saved}.json`;
      try {
        renameSync(file, archived);
        console.log(`rankings: season ${saved} archived to ${archived}; season ${season} starts empty`);
      } catch (e) {
        console.error(`rankings: could not archive ${file} (${(e as Error).message})`);
      }
    }
    if (saved !== season) this.writeSeason(seasonFile);

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
  }

  private writeSeason(seasonFile: string) {
    try {
      mkdirSync(dirname(seasonFile), { recursive: true });
      writeFileSync(seasonFile, `${this.season}\n`, 'utf8');
    } catch (e) {
      console.error(`rankings: could not save ${seasonFile}: ${(e as Error).message}`);
    }
  }

  private save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify(this.games), 'utf8');
      renameSync(`${this.file}.tmp`, this.file);
    } catch (e) {
      console.error(`rankings: could not save ${this.file}: ${(e as Error).message}`);
    }
  }
  /** The board, every row with its own display name (see `uniqueBoardNames`). */
  rows(): RankingRow[] { return uniqueBoardNames(rankLeaderboard(this.games), this.games); }

  profile(key: string, name: string): RankingRow {
    return this.rows().find(r => r.key === key) ?? { key, name, rank: 0, points: 0, games: 0, wins: 0, losses: 0, winRate: 0, avgPlacement: 0, kills: 0, victims: {} };
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
