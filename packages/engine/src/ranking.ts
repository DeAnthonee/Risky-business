import type { GameState, PlayerId } from './types.js';

/** Placement points, not opponent-strength Elo. Six seats: +3,+2,+1,-1,-2,-3. */
export function placementPoints(placement: number, players: number): number {
  if (!Number.isInteger(players) || players < 2 || !Number.isInteger(placement) || placement < 1 || placement > players) throw new Error('Invalid placement');
  const centered = (players + 1) / 2 - placement;
  return Math.sign(centered) * Math.ceil(Math.abs(centered));
}

/** Points for each player you eliminate, on top of placement: a high-kill runner-up can outscore the winner. */
export const KILL_POINTS = 1;

/** `killed` lists the ranking keys of the players this seat eliminated (absent on records from before kills were tracked). */
export interface RankedSeat { key: string; name: string; placement: number; playerId?: string; killed?: string[] }
export interface RankedGame { gameId: string; seats: RankedSeat[] }
export interface RankingRow {
  key: string; name: string; rank: number; points: number;
  games: number; wins: number; losses: number; winRate: number; avgPlacement: number;
  /** Players eliminated across all games, and how many times each victim (by ranking key). */
  kills: number; victims: Record<string, number>;
  /** Unique player IDs and raw keys associated with this character/player. */
  playerIds?: string[];
}

export const CANONICAL_LEAGUE_CHARACTERS: Record<string, string> = {
  jinx: 'Jinx',
  shaco: 'Shaco',
  leona: 'Leona',
  tryndamere: 'Tryndamere',
  teemo: 'Teemo',
  shen: 'Shen',
  thresh: 'Thresh',
  darius: 'Darius',
  lux: 'Lux',
  ahri: 'Ahri',
};

/** Normalizes seat/player keys so versioned names (e.g. Delove@3) and unranked aliases (player:jinx) merge into canonical entries. */
export function normalizeLeaderboardKey(raw: string): { key: string; name: string; playerId: string } {
  if (!raw) return { key: 'unknown', name: 'Unknown', playerId: 'unknown' };
  let clean = raw.trim();
  const rawClean = clean;
  if (clean.startsWith('player:')) clean = clean.slice(7);
  if (clean.startsWith('bot:')) clean = clean.slice(4);
  clean = clean.replace(/@\d+$/, '');
  const lower = clean.toLowerCase();

  if (lower.startsWith('league/')) {
    const sub = lower.slice(7);
    if (CANONICAL_LEAGUE_CHARACTERS[sub]) {
      return { key: `league/${sub}`, name: CANONICAL_LEAGUE_CHARACTERS[sub], playerId: `league/${sub}` };
    }
  }
  if (CANONICAL_LEAGUE_CHARACTERS[lower]) {
    return { key: `league/${lower}`, name: CANONICAL_LEAGUE_CHARACTERS[lower], playerId: `league/${lower}` };
  }
  if (lower === 'delove') return { key: 'Delove', name: 'Delove', playerId: 'delove' };
  if (lower === 'sensei' || lower === 'delove-teacher') return { key: 'Sensei', name: 'Sensei', playerId: 'sensei' };
  if (lower === 'ronny') return { key: 'Ronny', name: 'Ronny', playerId: 'ronny' };
  if (lower === 'joey') return { key: 'Joey', name: 'Joey', playerId: 'joey' };

  return { key: rawClean, name: clean, playerId: lower };
}

/** Points one seat earns from one game: placement plus kills. */
export function gamePoints(seat: RankedSeat, players: number): number {
  return placementPoints(seat.placement, players) + KILL_POINTS * (seat.killed?.length ?? 0);
}

/** A finished game's standing for one player: its place and the players it eliminated (ids). */
export interface Placement {
  id: PlayerId;
  placement: number;
  killed: PlayerId[];
}

/**
 * Final standings of a finished game, the leaderboard's rule: the winner places first; other survivors by
 * territories, then armies, then turn order; eliminated players by reverse elimination order (`eliminationOrder`:
 * player ids in the order they went out; missing ids rank by turn order). The Neutral is never ranked. Kills are the
 * ranked players a seat eliminated (surrenders and the Neutral credit nobody). Shared by the server's rankings and
 * self-play training, so both always agree.
 */
export function finalPlacements(state: GameState, eliminationOrder: readonly PlayerId[]): Placement[] {
  const totals = (id: PlayerId) => Object.values(state.territories).filter((t) => t.owner === id);
  const players = state.players
    .filter((p) => !p.isNeutral)
    .sort((a, b) => {
      if (a.id === state.winner) return -1;
      if (b.id === state.winner) return 1;
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      if (!a.alive) return eliminationOrder.indexOf(b.id) - eliminationOrder.indexOf(a.id) || a.order - b.order;
      const at = totals(a.id);
      const bt = totals(b.id);
      return bt.length - at.length || bt.reduce((n, t) => n + t.armies, 0) - at.reduce((n, t) => n + t.armies, 0) || a.order - b.order;
    });
  return players.map((p, i) => ({ id: p.id, placement: i + 1, killed: players.filter((v) => !v.alive && v.eliminatedBy === p.id).map((v) => v.id) }));
}

/** Input order is completion order. Rating floors at zero after each game; duplicate game IDs are ignored. */
export function rankLeaderboard(results: readonly RankedGame[]): RankingRow[] {
  const rows = new Map<string, RankingRow & { places: number; ids: Set<string> }>();
  const seen = new Set<string>();
  for (const result of results) {
    if (seen.has(result.gameId) || result.seats.length < 2) continue;
    seen.add(result.gameId);
    for (const seat of result.seats) {
      const norm = normalizeLeaderboardKey(seat.key || seat.name);
      const row = rows.get(norm.key) ?? {
        key: norm.key,
        name: norm.name,
        rank: 0,
        points: 0,
        games: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        avgPlacement: 0,
        kills: 0,
        victims: {},
        places: 0,
        ids: new Set<string>(),
        playerIds: [],
      };
      row.name = norm.name;
      if (seat.playerId) row.ids.add(seat.playerId);
      if (seat.key) row.ids.add(seat.key);
      if (seat.name) row.ids.add(seat.name);
      if (norm.playerId) row.ids.add(norm.playerId);
      row.points = Math.max(0, row.points + gamePoints(seat, result.seats.length));
      row.games++;
      row.wins += Number(seat.placement === 1);
      row.losses = row.games - row.wins;
      row.places += seat.placement;
      row.avgPlacement = Math.round(row.places / row.games * 100) / 100;
      row.winRate = Math.round(row.wins / row.games * 1000) / 10;
      for (const victim of seat.killed ?? []) {
        const normVictim = normalizeLeaderboardKey(victim).key;
        row.kills++;
        row.victims[normVictim] = (row.victims[normVictim] ?? 0) + 1;
      }
      rows.set(norm.key, row);
    }
  }
  return [...rows.values()].sort((a, b) => b.points - a.points || b.wins - a.wins || b.kills - a.kills || a.avgPlacement - b.avgPlacement || a.key.localeCompare(b.key))
    .map(({ places: _places, ids, ...row }, i) => ({
      ...row,
      rank: i + 1,
      playerIds: [...ids],
    }));
}
