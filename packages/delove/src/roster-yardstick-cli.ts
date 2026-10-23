#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { summarizeTable, yardstick, yardstickMarkdown, type RecordLike, type RosterEntry, type TableSummary } from './roster-yardstick.js';

const USAGE = `delove:roster-yardstick: the house roster's per-name and per-version stats (packages/delove/README.md "House roster")

  RISK_RECORDS_KEY=... RISK_SEAT_POOL_KEY=... npm run delove:roster-yardstick -- collect --server URL --data <dir>
      new tournament tables the house roster played (GET /api/history, the newest 100), each read from its game
      record (GET /api/records/:id, the records key: places, kills, who eliminated whom, each roster seat's model) and
      kept as one line of <dir>/tables.jsonl. Run it often (every few hours): the history lists only the newest 100.
  npm run delove:roster-yardstick -- report --data <dir> [--days 7] [--anchor delove@12] [--out <dir>]
      per name and per version over the last --days: tables, table wins, placement, points, kills, rounds reached,
      who eliminated it, by fog / size / map, and a Plackett-Luce rating per version (the anchor at 0); writes
      yardstick-<date>.json and .md to --out (default <dir>)
  ... -- weekly (collect, then report): what the weekly job runs

Keys come only from the environment and are never printed or saved: RISK_RECORDS_KEY (header x-records-key) reads the
records; RISK_SEAT_POOL_KEY (x-seat-pool-key) reads the roster list (GET /api/roster), which names the roster seats
and their models when a record is missing. Without the records key a table is kept from the history: places, no kills.`;

interface HistoryGame {
  id: string;
  room: string;
  map: string;
  fog: boolean;
  tournamentId?: string;
  endedAt: number;
  players: { id: string; name: string; place: number; agent?: string }[];
}

const log = (s: string) => console.error(`[${new Date().toISOString().slice(0, 19)}] ${s}`);

async function collect(server: string, data: string, recordsKey: string | undefined, poolKey: string | undefined) {
  if (!recordsKey && !poolKey) throw new Error('collect needs RISK_RECORDS_KEY or RISK_SEAT_POOL_KEY (or both) to know the roster seats');
  mkdirSync(data, { recursive: true });
  const file = join(data, 'tables.jsonl');
  const have = new Set(existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as TableSummary).id) : []);
  const base = server.replace(/\/+$/, '');
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}/api${path}`, { headers });
    if (!res.ok) throw Object.assign(new Error(`${path}: ${res.status}`), { status: res.status });
    return res.json() as Promise<any>;
  };
  // Every roster entry, retired ones too (a retired name keeps its model): names to roster id and model.
  const roster = new Map<string, RosterEntry>();
  if (poolKey) for (const e of ((await get('/roster', { 'x-seat-pool-key': poolKey })).roster as RosterEntry[]) ?? []) roster.set(e.name.toLowerCase(), e);
  const history = (await get('/history?board=tournament&limit=100')) as { enabled: boolean; games: HistoryGame[] };
  if (!history.enabled) throw new Error('the server keeps no game records (history is off)');
  const rounds = new Map<string, Map<string, number>>();
  let added = 0;
  let partial = 0;
  for (const g of history.games) {
    // A roster seat shows as "AI agent" (the server's label) and, with the pool key, by its roster name.
    const rosterSeat = (p: HistoryGame['players'][number]) => p.agent === 'AI agent' || roster.has(p.name.toLowerCase());
    if (!g.tournamentId || have.has(g.id) || !g.players.some(rosterSeat)) continue;
    if (!rounds.has(g.tournamentId)) {
      const t = await get(`/tournaments/${g.tournamentId}`).catch(() => null);
      rounds.set(g.tournamentId, new Map((t?.tournament?.rounds ?? []).flatMap((r: any) => r.matches.map((m: any) => [m.gameId, r.round]))));
    }
    const round = rounds.get(g.tournamentId)!.get(g.room) ?? 0;
    const agents = Object.fromEntries(g.players.map((p) => [p.name, p.agent]));
    let rec: RecordLike | null = null;
    if (recordsKey) rec = await get(`/records/${g.id}`, { 'x-records-key': recordsKey }).catch(() => null);
    const table: TableSummary & { partial?: true } = rec
      ? summarizeTable(rec, g.tournamentId, round, agents, g.endedAt)
      : {
          id: g.id,
          tournamentId: g.tournamentId,
          round,
          map: g.map,
          fog: g.fog,
          endedAt: g.endedAt,
          seats: [...g.players].sort((a, b) => a.place - b.place).map((p) => ({ name: p.name, place: p.place, kills: 0, ...(p.agent ? { agent: p.agent } : {}) })),
          partial: true,
        };
    // A seat the record does not name (or no record): the roster list names its model.
    for (const s of table.seats) {
      const e = roster.get(s.name.toLowerCase());
      if (!s.model && e) Object.assign(s, { rosterId: e.id, model: e.model });
    }
    if (!rec) partial++;
    appendFileSync(file, JSON.stringify(table) + '\n');
    have.add(g.id);
    added++;
  }
  log(`collect: ${added} new table(s)${partial ? `, ${partial} from the history only (no record: no kills)` : ''}; ${have.size} kept in ${file}`);
}

function report(data: string, anchor: string, days: number, out: string) {
  const file = join(data, 'tables.jsonl');
  const tables = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as TableSummary) : [];
  const to = Date.now();
  const from = to - days * 86_400_000;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const r = yardstick(tables.filter((t) => t.endedAt >= from && t.endedAt <= to), anchor, day(from), day(to));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `yardstick-${day(to)}.json`), JSON.stringify(r, null, 1) + '\n');
  writeFileSync(join(out, `yardstick-${day(to)}.md`), yardstickMarkdown(r));
  log(`report: ${r.tables} tables in ${r.tournaments} tournaments -> ${join(out, `yardstick-${day(to)}.md`)}`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { server: { type: 'string' }, data: { type: 'string' }, days: { type: 'string' }, out: { type: 'string' }, anchor: { type: 'string' } },
  });
  const cmd = positionals[0];
  if (!['collect', 'report', 'weekly'].includes(cmd) || !values.data) {
    console.error(USAGE);
    process.exit(2);
  }
  const server = values.server ?? process.env.RISK_SERVER_URL ?? 'http://localhost:8080';
  if (cmd !== 'report') await collect(server, values.data, process.env.RISK_RECORDS_KEY, process.env.RISK_SEAT_POOL_KEY);
  if (cmd !== 'collect') report(values.data, values.anchor ?? 'delove@12', Number(values.days ?? 7), values.out ?? values.data);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
