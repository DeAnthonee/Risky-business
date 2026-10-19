import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { finalPlacements, rankLeaderboard, type GameState, type RankedGame, type RankingRow } from '@risk/engine';

/** Server-owned, append-only results, kept independently of expiring game rooms. */
export class Rankings {
  private games: RankedGame[] = [];
  private ids = new Set<string>();
  constructor(private file: string | null) {
    if (file && existsSync(file)) {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8')) as unknown;
        if (!Array.isArray(saved)) throw new Error('not a list of games');
        this.games = saved.filter((g): g is RankedGame => !!g && typeof g.gameId === 'string' && Array.isArray(g.seats));
      } catch (e) {
        // A bad file must not keep the server from starting: set it aside and start empty.
        console.error(`rankings: could not read ${file} (${(e as Error).message}); moved to ${file}.corrupt`);
        try { renameSync(file, `${file}.corrupt`); } catch { /* keep going */ }
        this.games = [];
      }
      this.ids = new Set(this.games.map(g => g.gameId));
    }
  }
  rows(): RankingRow[] { return rankLeaderboard(this.games); }
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
    const next = [...this.games, result];
    if (this.file) {
      // Called from the room's change listener: a disk error is logged, never thrown into the move that finished the game.
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        writeFileSync(`${this.file}.tmp`, JSON.stringify(next), 'utf8');
        renameSync(`${this.file}.tmp`, this.file);
      } catch (e) {
        console.error(`rankings: could not save ${this.file}: ${(e as Error).message}`);
      }
    }
    this.games = next;
    this.ids.add(state.id);
  }
}
