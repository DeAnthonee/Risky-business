import { placementPoints } from '@risk/engine';
import { plackettLuce } from './abtest.js';

/**
 * The weekly per-version yardstick of the house roster (packages/delove/README.md "House roster"): every tournament
 * table the roster played, read from the game records, summed per name and per version.
 *
 * A table is kept as a TableSummary (a few hundred bytes; the full record is not kept). A roster seat's model comes
 * from its game record (`room.roster`, the records key) or else from the server's roster list (the pool key); each
 * seat's class is that model, "zerg" or "bot" for the server's seats, else "other".
 */

/** A roster entry as the server lists it (GET /api/roster): its name always plays its model. */
export interface RosterEntry {
  id: string;
  name: string;
  model: string;
}

export interface SeatSummary {
  name: string;
  /** 1 = first. */
  place: number;
  kills: number;
  /** Name of whoever eliminated this seat, if it was eliminated. */
  eliminatedBy?: string;
  /** The server's label in the history: "zerg", "bot", "AI agent", an agent's own, or none. */
  agent?: string;
  /** A house roster seat: its roster id and model. */
  rosterId?: string;
  model?: string;
}

export interface TableSummary {
  id: string;
  tournamentId: string;
  round: number;
  map: string;
  fog: boolean;
  endedAt: number;
  seats: SeatSummary[];
}

/** The parts of a game record (docs/game-records.md) the yardstick reads. */
export interface RecordLike {
  id: string;
  map: string;
  fog: boolean;
  endedAt?: number;
  players: { id: string; name: string; isNeutral?: boolean }[];
  outcome: { placings: string[]; eliminations?: { player: string; by: string | null }[] };
  /** The house roster seats of the game: player id to roster id and model. */
  room?: { roster?: Record<string, { id: string; model: string }> };
}

/** One table from its record, the history row's labels and the bracket's round. */
export function summarizeTable(rec: RecordLike, tournamentId: string, round: number, agents: Record<string, string | undefined>, endedAt: number): TableSummary {
  const roster = rec.room?.roster ?? {};
  const byId = new Map(rec.players.map((p) => [p.id, p]));
  const real = rec.outcome.placings.filter((id) => byId.has(id) && !byId.get(id)!.isNeutral);
  const elim = rec.outcome.eliminations ?? [];
  return {
    id: rec.id,
    tournamentId,
    round,
    map: rec.map,
    fog: rec.fog,
    endedAt: rec.endedAt ?? endedAt,
    seats: real.map((id, i) => {
      const p = byId.get(id)!;
      const out = elim.find((e) => e.player === id);
      return {
        name: p.name,
        place: i + 1,
        kills: elim.filter((e) => e.by === id && byId.has(e.player) && !byId.get(e.player)!.isNeutral).length,
        ...(out?.by && byId.has(out.by) ? { eliminatedBy: byId.get(out.by)!.name } : {}),
        ...(agents[p.name] ? { agent: agents[p.name] } : {}),
        ...(roster[id] ? { rosterId: roster[id].id, model: roster[id].model } : {}),
      };
    }),
  };
}

/** A seat's class: its roster model, "zerg", "bot" or "other". */
export function seatClass(s: { model?: string; agent?: string }): string {
  if (s.model) return s.model;
  if (s.agent === 'zerg' || s.agent === 'bot') return s.agent;
  return 'other';
}

interface Acc {
  tables: number;
  wins: number;
  relPlace: number;
  points: number;
  kills: number;
  eliminatedBy: Record<string, number>;
  /** Highest round reached per tournament. */
  rounds: Record<string, number>;
  byFog: Record<string, { tables: number; wins: number; relPlace: number }>;
  bySize: Record<string, { tables: number; wins: number; relPlace: number }>;
  byMap: Record<string, { tables: number; wins: number; relPlace: number }>;
}

const acc = (): Acc => ({ tables: 0, wins: 0, relPlace: 0, points: 0, kills: 0, eliminatedBy: {}, rounds: {}, byFog: {}, bySize: {}, byMap: {} });

export interface Line {
  tables: number;
  wins: number;
  winRate: number;
  /** Mean placement scaled 0 (first) to 1 (last). */
  relPlace: number;
  /** Mean leaderboard points per table (placement points plus kills). */
  points: number;
  kills: number;
  /** Mean of the highest round reached, over the tournaments played. */
  roundsReached: number;
  tournaments: number;
  eliminatedBy: Record<string, number>;
  byFog: Record<string, { tables: number; winRate: number; relPlace: number }>;
  bySize: Record<string, { tables: number; winRate: number; relPlace: number }>;
  byMap: Record<string, { tables: number; winRate: number; relPlace: number }>;
}

export interface YardstickReport {
  from: string;
  to: string;
  tables: number;
  tournaments: number;
  anchor: string;
  perVersion: Record<string, Line>;
  perName: Record<string, Line & { model: string }>;
  /** Plackett-Luce over every table's finishing order, by class (the anchor at 0, Elo-like). */
  ratings: Record<string, number>;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

function line(a: Acc): Line {
  const split = (m: Acc['byFog']) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { tables: v.tables, winRate: r3(v.wins / v.tables), relPlace: r3(v.relPlace / v.tables) }]));
  const ts = Object.values(a.rounds);
  return {
    tables: a.tables,
    wins: a.wins,
    winRate: r3(a.tables ? a.wins / a.tables : 0),
    relPlace: r3(a.tables ? a.relPlace / a.tables : 0),
    points: r3(a.tables ? a.points / a.tables : 0),
    kills: a.kills,
    roundsReached: r3(ts.length ? ts.reduce((x, y) => x + y, 0) / ts.length : 0),
    tournaments: ts.length,
    eliminatedBy: a.eliminatedBy,
    byFog: split(a.byFog),
    bySize: split(a.bySize),
    byMap: split(a.byMap),
  };
}

/** Per-name and per-version stats over these tables, and the per-class Plackett-Luce ratings. */
export function yardstick(tables: TableSummary[], anchor: string, from: string, to: string): YardstickReport {
  const perVersion = new Map<string, Acc>();
  const perName = new Map<string, Acc>();
  const modelOf = new Map<string, string>();
  const get = (m: Map<string, Acc>, k: string) => (m.has(k) ? m.get(k)! : (m.set(k, acc()), m.get(k)!));
  const split = (m: Acc['byFog'], k: string, win: boolean, rel: number) => {
    const v = (m[k] ??= { tables: 0, wins: 0, relPlace: 0 });
    v.tables++;
    v.wins += win ? 1 : 0;
    v.relPlace += rel;
  };
  for (const t of tables) {
    const n = t.seats.length;
    for (const s of t.seats) {
      const cls = seatClass(s);
      if (!cls.startsWith('delove@')) continue;
      const rel = n > 1 ? (s.place - 1) / (n - 1) : 0;
      const killer = t.seats.find((x) => x.name === s.eliminatedBy);
      modelOf.set(s.name, cls);
      for (const a of [get(perVersion, cls), get(perName, s.name)]) {
        a.tables++;
        a.wins += s.place === 1 ? 1 : 0;
        a.relPlace += rel;
        a.points += (n > 1 ? placementPoints(s.place, n) : 0) + s.kills;
        a.kills += s.kills;
        if (killer) a.eliminatedBy[seatClass(killer)] = (a.eliminatedBy[seatClass(killer)] ?? 0) + 1;
        a.rounds[t.tournamentId] = Math.max(a.rounds[t.tournamentId] ?? 0, t.round);
        split(a.byFog, t.fog ? 'fog' : 'no fog', s.place === 1, rel);
        split(a.bySize, `${n}p`, s.place === 1, rel);
        split(a.byMap, t.map.startsWith('gen1-') ? 'generated' : t.map, s.place === 1, rel);
      }
    }
  }
  const games = tables.map((t) => [...t.seats].sort((a, b) => a.place - b.place).map((s) => seatClass(s)));
  return {
    from,
    to,
    tables: tables.length,
    tournaments: new Set(tables.map((t) => t.tournamentId)).size,
    anchor,
    perVersion: Object.fromEntries([...perVersion].map(([k, a]) => [k, line(a)])),
    perName: Object.fromEntries(
      [...perName].map(([k, a]) => [k, { ...line(a), model: modelOf.get(k)! }]),
    ),
    ratings: games.length && games.flat().includes(anchor) ? plackettLuce(games, anchor) : {},
  };
}

/** The report as Markdown: versions first, then the names. */
export function yardstickMarkdown(r: YardstickReport): string {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const rows = (m: Record<string, Line>, extra = (_k: string) => '') =>
    Object.entries(m)
      .sort((a, b) => a[1].relPlace - b[1].relPlace)
      .map(([k, l]) => `| ${k}${extra(k)} | ${l.tables} | ${pct(l.winRate)} | ${l.relPlace} | ${l.points >= 0 ? '+' : ''}${l.points} | ${l.kills} | ${l.roundsReached} | ${l.byFog.fog ? pct(l.byFog.fog.winRate) : '-'} |`);
  const head = '| | tables | table wins | placement (0 first, 1 last) | points / table | kills | rounds reached | fog win rate |\n| --- | --- | --- | --- | --- | --- | --- | --- |';
  return [
    `# House roster yardstick, ${r.from} to ${r.to}`,
    '',
    `${r.tournaments} tournaments, ${r.tables} tables. Anchor ${r.anchor}.`,
    '',
    '## Per version',
    '',
    head,
    ...rows(r.perVersion),
    '',
    `Plackett-Luce over every table (${r.anchor} = 0, Elo-like): ${Object.entries(r.ratings)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v >= 0 ? '+' : ''}${v}`)
      .join(', ')}`,
    '',
    'Eliminated by (per version): ' +
      Object.entries(r.perVersion)
        .map(([k, l]) => `${k}: ${Object.entries(l.eliminatedBy).map(([c, n]) => `${c} ${n}`).join(', ') || 'none'}`)
        .join('; '),
    '',
    '## Per name',
    '',
    head,
    ...rows(r.perName as Record<string, Line>, (k) => ` (${(r.perName[k] as { model: string }).model})`),
  ].join('\n') + '\n';
}
