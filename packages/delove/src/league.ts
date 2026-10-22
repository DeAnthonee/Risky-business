import { readFileSync } from 'node:fs';
import { gameSeed, mixSeed, seededRandom } from '@risk/selfplay';

/**
 * The league (packages/delove/README.md "League"): which opponents a cycle's games seat, sampled by prioritized
 * fictitious self-play (PFSP, AlphaStar) instead of a fixed list.
 *
 * A jobs file (scripts/generate.sh format) names a league seat "@league" (any member of kind "snapshot") or
 * "@league:<kind>" (a member of that kind: "exploiter", and later "zerg", "impostor" or any other seat type). expandJobs
 * splits each such line into sub-lines of up to `splitGames` games, each with its own league opponents and its own game
 * numbers (start), so the result is an ordinary jobs file that the CPU and GPU generators play unchanged.
 *
 * PFSP weights a member by how hard it is for the main version: p = the main's chance of finishing above it, from the
 * members' ratings (Elo-like, e.g. the Plackett-Luce ratings of an A/B scorecard), and the weight is (1 - p)^power
 * ("hard": opponents the main still loses to come up most), p (1 - p) ("variance": the even matches), or 1 ("even").
 * An exploiter (a version trained to beat the main) takes `exploiterShare` of the snapshot seats when one is active.
 */

export interface LeagueMember {
  id: string;
  /** "snapshot" (a past version), "exploiter", or any other seat type a template asks for ("@league:<kind>"). */
  kind: string;
  /** Rating on the main's scale (Elo-like; the main is `main`'s rating). Missing: the main's own (an even match). */
  elo?: number;
  /** Off: never sampled (e.g. an exploiter not trained yet). Default on. */
  active?: boolean;
}

export interface League {
  v: 1;
  main: string;
  /** The main's rating on the members' scale (default 0). */
  mainElo?: number;
  members: LeagueMember[];
  pfsp: { curve: 'hard' | 'variance' | 'even'; power?: number };
  /** Share of "@league" seats an active exploiter takes (default 0.15). */
  exploiterShare?: number;
  /** Games per sub-line of an expanded jobs line (default 250). */
  splitGames?: number;
}

export function loadLeague(path: string): League {
  const l = JSON.parse(readFileSync(path, 'utf8')) as League;
  if (l.v !== 1) throw new Error(`${path}: unsupported league version ${l.v}`);
  return l;
}

/** The main's chance of finishing above a member with this rating (Elo-like scale, 400 per factor of 10). */
export function winChance(mainElo: number, memberElo: number): number {
  return 1 / (1 + 10 ** ((memberElo - mainElo) / 400));
}

/** PFSP weight of a member the main beats with chance p. */
export function pfspWeight(p: number, curve: League['pfsp']['curve'], power = 2): number {
  if (curve === 'even') return 1;
  if (curve === 'variance') return p * (1 - p);
  return (1 - p) ** power;
}

/** Sampling weights of the active members of a kind, normalised to sum to 1. */
export function kindWeights(league: League, kind: string): { id: string; w: number }[] {
  const main = league.mainElo ?? 0;
  const members = league.members.filter((m) => m.kind === kind && m.active !== false);
  const ws = members.map((m) => ({ id: m.id, w: pfspWeight(winChance(main, m.elo ?? main), league.pfsp.curve, league.pfsp.power) }));
  // Every member keeps a little weight, so a version the main now beats easily still comes up now and then.
  const floor = 0.02 * Math.max(...ws.map((x) => x.w), 0);
  const total = ws.reduce((a, x) => a + Math.max(x.w, floor), 0);
  return ws.map((x) => ({ id: x.id, w: total > 0 ? Math.max(x.w, floor) / total : 1 / ws.length }));
}

function pick(ws: { id: string; w: number }[], r: number): string {
  let acc = 0;
  for (const x of ws) if ((acc += x.w) > r) return x.id;
  return ws[ws.length - 1].id;
}

/** Fill one seat token: "@league" (snapshots, or the exploiter for its share) or "@league:<kind>". */
export function sampleSeat(league: League, token: string, random: () => number): string {
  const kind = token === '@league' ? 'snapshot' : token.slice('@league:'.length);
  if (kind === 'snapshot') {
    const exploiters = kindWeights(league, 'exploiter');
    if (exploiters.length && random() < (league.exploiterShare ?? 0.15)) return pick(exploiters, random());
  }
  const ws = kindWeights(league, kind);
  if (!ws.length) throw new Error(`the league has no active member of kind "${kind}" for ${token}`);
  return pick(ws, random());
}

const hashLine = (s: string) => [...s].reduce((h, c) => mixSeed(h, c.charCodeAt(0)), 0x1ea9);

/**
 * Expand a jobs file: every line with a league seat becomes sub-lines of up to splitGames games, numbered on from the
 * line's start (so no two sub-lines play the same games), each with its league seats sampled. Lines without a league
 * seat and comments are kept as they are. The same league, file and seed always give the same result.
 */
export function expandJobs(text: string, league: League, seed: number): string {
  const split = league.splitGames ?? 250;
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !line.includes('@league')) {
      out.push(raw);
      continue;
    }
    const m = /^(\S+)\s+(\d+)\s+(\S+)(?:\s+(\d+))?(?:\s+(.*))?$/.exec(line);
    if (!m) throw new Error(`cannot read jobs line: ${line}`);
    const [, name, total, agents, start, options] = m;
    const seats = agents.split(',');
    const random = seededRandom(gameSeed(seed, hashLine(line)));
    out.push(`# ${line}`);
    for (let g = 0, k = 0; g < +total; g += split, k++) {
      const n = Math.min(split, +total - g);
      const filled = seats.map((s) => (s.startsWith('@league') ? sampleSeat(league, s, random) : s));
      out.push(`${name}-l${k} ${n} ${filled.join(',')} ${(+(start ?? 0)) + g}${options ? ` ${options}` : ''}`);
    }
  }
  return out.join('\n');
}

/** How many games each member got in an expanded file (for the summary). */
export function leagueMix(expanded: string, league: League): Record<string, number> {
  const ids = new Set(league.members.map((m) => m.id));
  const mix: Record<string, number> = {};
  for (const line of expanded.split(/\r?\n/)) {
    const m = /^(\S+)\s+(\d+)\s+(\S+)/.exec(line.trim());
    if (!m || line.trim().startsWith('#')) continue;
    for (const s of m[3].split(',')) if (ids.has(s)) mix[s] = (mix[s] ?? 0) + +m[2];
  }
  return mix;
}

/**
 * Ratings for the league from an A/B scorecard (its Plackett-Luce ratings, anchored at the scorecard's base): every
 * member and the main that the scorecard rated gets that rating, shifted so the main's own rating is `mainElo`.
 */
export function withRatings(league: League, ratings: Record<string, { elo: number }>): League {
  const main = ratings[league.main]?.elo;
  if (main === undefined) throw new Error(`the scorecard has no rating for the league's main version ${league.main}`);
  return {
    ...league,
    mainElo: 0,
    members: league.members.map((m) => (ratings[m.id] ? { ...m, elo: ratings[m.id].elo - main } : m)),
  };
}
