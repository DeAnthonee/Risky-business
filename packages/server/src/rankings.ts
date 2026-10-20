import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { finalPlacements, rankLeaderboard, type GameState, type RankedGame, type RankingRow } from '@risk/engine';

/** Server-owned, append-only results, kept independently of expiring game rooms. */
export class Rankings {
  private games: RankedGame[] = [];
  private ids = new Set<string>();

  constructor(
    private file: string | null,
    seedGames: RankedGame[] = [],
  ) {
    const seedIds = new Set(seedGames.map((g) => g.gameId));

    if (file && existsSync(file)) {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8')) as unknown;
        if (!Array.isArray(saved)) throw new Error('not a list of games');

        // Check if the file on disk contains any seed games.
        // If seedGames is provided but NONE of its games exist in `file`, then `file` is an obsolete
        // pre-seed test dataset (e.g. from early development). We back it up and initialize from the seed.
        const containsAnySeed = seedGames.length === 0 || saved.some((g) => g && typeof g.gameId === 'string' && seedIds.has(g.gameId));

        if (!containsAnySeed) {
          try {
            renameSync(file, `${file}.legacy-unseeded.bak`);
            console.log(`rankings: backed up pre-seed file to ${file}.legacy-unseeded.bak`);
          } catch {
            /* ignore backup failure */
          }
          this.games = [...seedGames];
          this.ids = new Set(this.games.map((g) => g.gameId));
          this.save();
        } else {
          // File has seed games or no seed was provided; load file games.
          for (const g of saved) {
            if (g && typeof g.gameId === 'string' && Array.isArray(g.seats) && !this.ids.has(g.gameId)) {
              this.games.push(g);
              this.ids.add(g.gameId);
            }
          }
          // Merge in any seed games that might not be in the file yet.
          for (const g of seedGames) {
            if (!this.ids.has(g.gameId)) {
              this.games.push(g);
              this.ids.add(g.gameId);
            }
          }
        }
      } catch (e) {
        // A bad file must not keep the server from starting: set it aside and start empty or from seed.
        console.error(`rankings: could not read ${file} (${(e as Error).message}); moved to ${file}.corrupt`);
        try { renameSync(file, `${file}.corrupt`); } catch { /* keep going */ }
        this.games = [...seedGames];
        this.ids = new Set(this.games.map((g) => g.gameId));
        this.save();
      }
    } else {
      // No existing file on disk: start with seed games if provided.
      this.games = [...seedGames];
      this.ids = new Set(this.games.map((g) => g.gameId));
      if (this.file && this.games.length > 0) {
        this.save();
      }
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
    this.games.push(result);
    this.ids.add(state.id);
    this.save();
  }
}
