#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadRoster, type Roster } from './roster.js';
import { summarizeTable, yardstick, yardstickMarkdown, type RecordLike, type TableSummary } from './roster-yardstick.js';

const USAGE = `delove:roster-yardstick: the house roster's per-name and per-version stats (packages/delove/README.md "House roster")

  RISK_RECORDS_KEY=... npm run delove:roster-yardstick -- collect --server URL --roster <roster.json> --data <dir>
      new tournament tables the roster played (GET /api/history, the newest 100), each read from its game record
      (GET /api/records/:id with the records key) and kept as one line of <dir>/tables.jsonl. Run it often (every few
      hours): the history only lists the newest 100 tables.
  npm run delove:roster-yardstick -- report --roster <roster.json> --data <dir> [--days 7] [--out <dir>]
      per name and per version over the last --days: tables, table wins, placement, points, kills, rounds reached,
      who eliminated it, by fog / size / map, and a Plackett-Luce rating per version; writes yardstick-<date>.json
      and .md to --out (default <dir>)
  ... -- weekly (collect, then report): what the weekly job runs

The records key comes only from RISK_RECORDS_KEY (header x-records-key); it is never printed or saved. Without it (or
with records off on the server) a table is kept from the history alone: places, no kills.`;

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

async function collect(server: string, roster: Roster, data: string, key: string | undefined) {
  mkdirSync(data, { recursive: true });
  const file = join(data, 'tables.jsonl');
  const have = new Set(existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as TableSummary).id) : []);
  const names = new Set(roster.names.map((n) => n.name.toLowerCase()));
  const base = server.replace(/\/+$/, '');
  const get = async (path: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}/api${path}`, { headers });
    if (!res.ok) throw Object.assign(new Error(`${path}: ${res.status}`), { status: res.status });
    return res.json() as Promise<any>;
  };
  const history = (await get('/history?board=tournament&limit=100')) as { enabled: boolean; games: HistoryGame[] };
  if (!history.enabled) throw new Error('the server keeps no game records (history is off)');
  const rounds = new Map<string, Map<string, number>>();
  let added = 0;
  let partial = 0;
  for (const g of history.games) {
    if (!g.tournamentId || have.has(g.id) || !g.players.some((p) => names.has(p.name.toLowerCase()))) continue;
    if (!rounds.has(g.tournamentId)) {
      const t = await get(`/tournaments/${g.tournamentId}`).catch(() => null);
      rounds.set(g.tournamentId, new Map((t?.tournament?.rounds ?? []).flatMap((r: any) => r.matches.map((m: any) => [m.gameId, r.round]))));
    }
    const round = rounds.get(g.tournamentId)!.get(g.room) ?? 0;
    const agents = Object.fromEntries(g.players.map((p) => [p.name, p.agent]));
    let rec: RecordLike | null = null;
    if (key) rec = await get(`/records/${g.id}`, { 'x-records-key': key }).catch(() => null);
    const table = rec
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
    if (!rec) partial++;
    appendFileSync(file, JSON.stringify(table) + '\n');
    have.add(g.id);
    added++;
  }
  log(`collect: ${added} new table(s)${partial ? `, ${partial} from the history only (no record: no kills)` : ''}; ${have.size} kept in ${file}`);
}

function report(roster: Roster, data: string, days: number, out: string) {
  const file = join(data, 'tables.jsonl');
  const tables = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as TableSummary) : [];
  const to = Date.now();
  const from = to - days * 86_400_000;
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const r = yardstick(tables.filter((t) => t.endedAt >= from && t.endedAt <= to), roster, day(from), day(to));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, `yardstick-${day(to)}.json`), JSON.stringify(r, null, 1) + '\n');
  writeFileSync(join(out, `yardstick-${day(to)}.md`), yardstickMarkdown(r));
  log(`report: ${r.tables} tables in ${r.tournaments} tournaments -> ${join(out, `yardstick-${day(to)}.md`)}`);
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { server: { type: 'string' }, roster: { type: 'string' }, data: { type: 'string' }, days: { type: 'string' }, out: { type: 'string' } },
  });
  const cmd = positionals[0];
  const rosterFile = values.roster ?? process.env.DELOVE_ROSTER;
  if (!['collect', 'report', 'weekly'].includes(cmd) || !rosterFile || !values.data) {
    console.error(USAGE);
    process.exit(2);
  }
  const roster = loadRoster(rosterFile);
  const server = values.server ?? process.env.RISK_SERVER_URL ?? 'http://localhost:8080';
  if (cmd !== 'report') await collect(server, roster, values.data, process.env.RISK_RECORDS_KEY);
  if (cmd !== 'collect') report(roster, values.data, Number(values.days ?? 7), values.out ?? values.data);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
