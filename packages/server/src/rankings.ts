import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { rankLeaderboard, type GameState, type RankedGame, type RankingRow } from '@risk/engine';

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
    return this.rows().find(r => r.key === key) ?? { key, name, rank: 0, points: 0, games: 0, wins: 0, losses: 0, winRate: 0, avgPlacement: 0, eliminations: 0 };
  }
  record(state: GameState, identities: Record<string, string>, eliminated: string[]) {
    if (state.phase !== 'finished' || !state.winner || this.ids.has(state.id)) return;
    const totals = (id: string) => Object.values(state.territories).filter(t => t.owner === id);
    const players = state.players.filter(p => !p.isNeutral).sort((a, b) => {
      if (a.id === state.winner) return -1;
      if (b.id === state.winner) return 1;
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      if (!a.alive) return eliminated.indexOf(b.id) - eliminated.indexOf(a.id) || a.order - b.order;
      const at = totals(a.id), bt = totals(b.id);
      return bt.length - at.length || bt.reduce((n,t) => n+t.armies,0) - at.reduce((n,t) => n+t.armies,0) || a.order-b.order;
    });
    if (players.length < 2) return;
    const kills = new Map<string, number>();
    for (const p of state.players) {
      if (p.eliminatedBy) {
        kills.set(p.eliminatedBy, (kills.get(p.eliminatedBy) ?? 0) + 1);
      }
    }
    const result = {
      gameId: state.id,
      seats: players.map((p, i) => ({
        key: identities[p.id] ?? `${p.isBot ? 'bot' : 'player'}:${p.name.trim().toLowerCase()}`,
        name: p.name,
        placement: i + 1,
        eliminations: kills.get(p.id) ?? 0,
      })),
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
