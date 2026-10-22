import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Bots move at once here, so whole tables play out in the test (set before the store module loads).
vi.hoisted(() => {
  process.env.RISK_BOT_DELAY_MS = '0';
});

const { Store } = await import('../src/store.js');
const { createRiskServer } = await import('../src/app.js');
type TournamentClock = import('../src/tournaments.js').TournamentClock;

/** A clock the test moves by hand: round deadlines fire only when it is advanced past them. */
class FakeClock implements TournamentClock {
  t = 1_000_000_000;
  timers: { at: number; fn: () => void }[] = [];
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    const h = { at: this.t + ms, fn };
    this.timers.push(h);
    return h;
  };
  clearTimeout = (h: unknown) => {
    this.timers = this.timers.filter((x) => x !== h);
  };
  advance(ms: number) {
    this.t += ms;
    for (const h of this.timers.filter((x) => x.at <= this.t)) {
      this.timers = this.timers.filter((x) => x !== h);
      h.fn();
    }
  }
}

const ADMIN = 'nested-admin-key';
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'risk-nested-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function serve(store: InstanceType<typeof Store>) {
  const risk = createRiskServer(store, { clientDir: null, adminToken: ADMIN, sweepIntervalMs: 0 });
  await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
  const call = async (path: string, init: RequestInit = {}, token?: string) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${base}/api${path}`, { ...init, headers });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { risk, base, call };
}
const post = (body: unknown = {}): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

/** Wait (real time) until `check` holds, polling. */
async function until(check: () => boolean, ms = 60_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('nested tournaments', () => {
  it('validates the settings at create', async () => {
    const clock = new FakeClock();
    const { risk, call } = await serve(new Store(null, {}, { clock }));
    try {
      const bad = async (body: object) => (await call('/admin/tournaments', post({ format: 'nested', ...body }), ADMIN)).status;
      expect(await bad({ territoriesPerSeat: 7 })).toBe(400);
      expect(await bad({ roundMinutes: 0 })).toBe(400);
      expect(await bad({ finishShare: 2 })).toBe(400);
      expect(await bad({ finalMap: 'skirmish' })).toBe(400); // seats 4: no final of 6
      expect(await bad({ finalMap: 'nowhere' })).toBe(400);
      expect(await bad({ format: 'swiss' })).toBe(400);
      expect(await bad({ options: { neutrals: 4 } })).toBe(400); // too many for the smallest board
      const ok = await call('/admin/tournaments', post({ format: 'nested', name: 'Inception', finalMap: 'world' }), ADMIN);
      expect(ok.status).toBe(201);
      expect(ok.body.tournament).toMatchObject({ format: 'nested', map: 'nested', maxEntrants: 128, nested: { finalMap: 'world', territoriesPerSeat: 5, roundMinutes: 30, finishShare: 0.51, botDelayMs: 300, plan: null } });
      // Hex Earth seats a final of 6-10 with a region per seat.
      const hex = await call('/admin/tournaments', post({ format: 'nested', name: 'Hex final', finalMap: 'hexworld', seed: 11 }), ADMIN);
      expect(hex.status).toBe(201);
      expect(hex.body.tournament.nested).toMatchObject({ finalMap: 'hexworld' });
      for (let i = 1; i <= 12; i++) await call(`/tournaments/${hex.body.tournament.id}/join`, post({ playerName: `H${i}` }));
      expect((await call(`/tournaments/${hex.body.tournament.id}/start`, post(), hex.body.hostToken)).status).toBe(200);
      const hexNodes = risk.store.tournaments.get(hex.body.tournament.id)!.nested!.nodes!;
      expect(hexNodes[0]).toMatchObject({ map: 'hexworld', depth: 0 });
      expect(hexNodes.slice(1).every((n) => n.map.startsWith('gen1-') && n.portal !== null)).toBe(true);
      // Tables run on a per-move turn timer by default.
      expect(ok.body.tournament.options).toMatchObject({ turnTimer: 'move', turnTimerSeconds: 90 });
      expect(await bad({ botDelayMs: 5000 })).toBe(400);
      // A fixed seed decides the draw before anyone joins: admin only, and nested only.
      expect((await call('/tournaments', post({ format: 'nested', seed: 5 }))).status).toBe(403);
      expect((await call('/tournaments', post({ format: 'nested' }))).status).toBe(201);
      expect((await call('/admin/tournaments', post({ seed: 5 }), ADMIN)).status).toBe(400); // a knockout
      const seeded = await call('/admin/tournaments', post({ format: 'nested', seed: 5 }), ADMIN);
      expect(seeded.status).toBe(201);
      for (let i = 1; i <= 6; i++) await call(`/tournaments/${seeded.body.tournament.id}/join`, post({ playerName: `S${i}` }));
      await call(`/tournaments/${seeded.body.tournament.id}/start`, post(), seeded.body.hostToken);
      expect(risk.store.tournaments.get(seeded.body.tournament.id)!.nested!.seed).toBe(5);
    } finally {
      await risk.shutdown('test');
    }
  });

  it('plays 40 seats: round 1 at once, 51% of tables end the round, the rest are decided on standing, then the final', async () => {
    const clock = new FakeClock();
    const store = new Store(join(dir, 'games.json'), {}, { clock });
    const { risk, base, call } = await serve(store);
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const agent = new Client({ name: 'nested-agent', version: '0' });
    await agent.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const mcp = async (name: string, args: Record<string, unknown>) => {
      const r = (await agent.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
      return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
    };
    try {
      const created = await call('/admin/tournaments', post({ format: 'nested', name: 'Inception Cup', options: { autoSetup: true, turnTimer: 'off' }, roundMinutes: 20, botDelayMs: 0 }), ADMIN);
      expect(created.status).toBe(201);
      const id = created.body.tournament.id;
      // Two people over HTTP, one agent over MCP, and 37 bot entrants (the host's bots arrive with Zerg entrants, #179/PR 3).
      const people = [];
      for (const name of ['Ada', 'Grace']) {
        const r = await call(`/tournaments/${id}/join`, post({ playerName: name }));
        expect(r.status).toBe(201);
        people.push({ name, token: r.body.token as string, entrantId: r.body.entrantId as string });
      }
      const joined = await mcp('join_tournament', { tournamentId: id, playerName: 'Claude' });
      expect(joined.isError).toBe(false);
      const t = store.tournaments.get(id)!;
      for (let i = 1; i <= 37; i++) t.entrants.push({ id: `e_bot${i}`, name: `Bot ${i}`, isBot: true, joinedAt: Date.now() });
      const started = await call(`/tournaments/${id}/start`, post(), created.body.hostToken);
      expect(started.status).toBe(200);
      expect(started.body.tournament.nested).toMatchObject({ plan: [[4, 4, 4, 4, 4, 4, 4, 4, 4, 4], [10]], zergs: 0 });

      // Round 1: ten 4-seat tables at once, each on its own generated 20-territory board; people spread over tables.
      const r1 = started.body.tournament.rounds[0];
      expect(r1.matches).toHaveLength(10);
      expect(r1.matches.every((m: any) => m.status === 'playing' && /^gen1-s\d+-p4-t20$/.test(m.map))).toBe(true);
      expect(new Set(r1.matches.map((m: any) => m.map)).size).toBe(10);
      // The whole board tree is public from the start: the final's board holds the ten round-1 boards in its portals.
      const nodes = started.body.tournament.nested.nodes;
      expect(nodes).toHaveLength(11);
      expect(nodes[0]).toMatchObject({ depth: 0, parent: null, seats: 10 });
      expect(nodes[0].portals).toHaveLength(10);
      for (const m of r1.matches) {
        expect(nodes[m.node]).toMatchObject({ map: m.map, parent: 0, depth: 1 });
        expect(nodes[0].portals).toContain(nodes[m.node].portal);
      }
      const humanTables = r1.matches.filter((m: any) => m.players.some((p: any) => !p.name.startsWith('Bot ')));
      expect(humanTables).toHaveLength(3);
      expect(r1.deadline).toBe(clock.now() + 20 * 60_000);

      // The contract: GET /tournaments/:id with the entrant token points at the seat (HTTP) ...
      for (const p of people) {
        const me = (await call(`/tournaments/${id}`, {}, p.token)).body.tournament.you;
        expect(me).toMatchObject({ name: p.name, status: 'playing', match: { round: 1 } });
        const game = (await call(`/games/${me.match.gameId}`, {}, me.match.token)).body;
        expect(game.playerId).toBe(me.match.playerId);
        expect(game.state.options.map).toMatch(/^gen1-/);
        p.match = me.match;
      }
      // ... and so does wait_for_match (MCP).
      const waited = await mcp('wait_for_match', { tournamentId: id, timeoutSeconds: 5 });
      expect(waited.text).toMatch(/Your table is ready/);
      expect(waited.text).toMatch(/YOUR TABLE: game [A-Z0-9]+ \(round 1\)\. Seat token: \S+/);
      const claudeGame = /YOUR TABLE: game ([A-Z0-9]+)/.exec(waited.text)![1];

      // Nobody human moves, so their three tables wait; the seven bot tables play out. The 6th finish (51% of 10)
      // ends the round: the tables still playing are decided on standing, and the final is seated at once.
      await until(() => t.rounds.length === 2, 120_000);
      const ended = t.rounds[0];
      const finished = ended.matches.filter((m) => m.status === 'finished');
      const decided = ended.matches.filter((m) => m.status === 'decided');
      expect(finished.length).toBe(6);
      expect(decided.length).toBe(4);
      expect(ended.endedAt).toBe(clock.now());
      for (const m of decided) {
        expect([...m.standing!.order].sort()).toEqual([...m.entrants].sort());
        expect(m.winner).toBe(m.standing!.order[0]);
        const room = store.get(m.gameId!)!;
        expect(room.decidedAt).not.toBeNull();
        expect(room.chat.at(-1)!.message).toMatch(/decided on standing/);
      }
      // A decided table refuses moves, and tells waiting agents and every view that it is over. (Nobody human moves, so
      // the people's and the agent's tables are always among the decided ones.)
      const who = people[0];
      expect(decided.some((m) => m.gameId === who.match.gameId)).toBe(true);
      const r = await call(`/games/${who.match.gameId}/actions`, post({ action: { type: 'end_turn' } }), who.match.token);
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/decided at the round's end/);
      const wait = await call(`/games/${who.match.gameId}/wait?timeoutMs=5000`, {}, who.match.token);
      expect(wait.body.reason).toBe('finished');
      expect(wait.body.state.decidedAt).toBe(store.get(who.match.gameId)!.decidedAt);
      expect((await call(`/games/${who.match.gameId}`)).body.state.decidedAt).toBeTypeOf('number');
      expect((await call('/games')).body.games.find((g: any) => g.id === who.match.gameId).decidedAt).toBeTypeOf('number');
      const agentWait = await mcp('wait_for_turn', { gameId: claudeGame, timeoutSeconds: 5 });
      expect(agentWait.text).toMatch(/decided on standing/);
      expect(agentWait.text).toMatch(/wait_for_match/);

      // The final: the ten table winners, one per table, in portal order.
      const final = t.rounds[1].matches[0];
      expect(t.rounds[1].matches).toHaveLength(1);
      expect(final.entrants).toEqual(ended.matches.map((m) => m.winner));
      expect(final.map).toMatch(/^gen1-s\d+-p10-t50$/); // 10 regions, the default for 50 territories
      expect(store.get(final.gameId!)!.state.players).toHaveLength(10);
      for (const p of people) {
        const me = (await call(`/tournaments/${id}`, {}, p.token)).body.tournament.you;
        if (final.entrants.includes(p.entrantId)) expect(me).toMatchObject({ status: 'playing', match: { round: 2, gameId: final.gameId } });
        else expect(me).toMatchObject({ status: 'out', match: null });
      }

      // The final has a single table: only its own end or the deadline ends it. Let the clock run out.
      if (t.status === 'running') clock.advance(20 * 60_000);
      expect(t.status).toBe('finished');
      expect(t.champion).toBe(final.winner);
      const view = (await call(`/tournaments/${id}`)).body.tournament;
      expect(view.champion.entrantId).toBe(t.champion);
      expect(view.rounds[1].matches[0].status).toMatch(/finished|decided/);
      // The finished tournament goes on the tournament board once: a decided table's first place has its +1 win.
      const result = store.tournamentBoard.result(id)!;
      expect(result).toBeTruthy();
      const decidedWinners = t.rounds.flatMap((r) => r.matches.filter((m) => m.status === 'decided').map((m) => m.winner));
      const person = people.find((p) => decidedWinners.includes(p.entrantId));
      if (person) expect(JSON.stringify(result)).toContain(person.name);
      // Every entrant is scored, bots flagged; only the three people are ranked (owner: no server bot on this board).
      expect(result.entrants).toHaveLength(40);
      expect(result.entrants.filter((e) => e.bot)).toHaveLength(37);
      expect((await call('/rankings?board=tournament')).body.rankings.map((r: any) => r.name).sort()).toEqual(['Ada', 'Claude', 'Grace']);
      // Table points: +2 per played-out win, +1 per decided win.
      const tablePoints = (eid: string) =>
        t.rounds.flatMap((r) => r.matches).filter((m) => m.winner === eid && (m.status === 'finished' || m.status === 'decided')).reduce((n, m) => n + (m.status === 'decided' ? 1 : 2), 0);
      for (const e of t.entrants) expect(result.entrants.find((x) => x.name === e.name)!.tablePoints).toBe(tablePoints(e.id));
      // Tournament tables never land on the public board.
      expect((await call('/rankings')).body.rankings).toEqual([]);
    } finally {
      await agent.close();
      await risk.shutdown('test');
    }
  }, 180_000);

  it('follows one entrant from round 1 to the champion through you.match alone; winners start on their portals', async () => {
    const clock = new FakeClock();
    const store = new Store(null, {}, { clock });
    // Remember every table's state right after it started (bots move at once from there).
    const startedAs = new Map<string, any>();
    const createTable = store.createTable.bind(store);
    store.createTable = ((...args: Parameters<typeof createTable>) => {
      const out = createTable(...args);
      startedAs.set(out.room.id, structuredClone(out.room.state));
      // The final's bots hold still, so they cannot knock our entrant out before the forfeits below.
      if (out.room.name.endsWith('Final')) {
        out.room.stopBot();
        out.room.botDelayMs = 3_600_000;
        out.room.scheduleBot();
      }
      return out;
    }) as typeof createTable;
    const { risk, call } = await serve(store);
    try {
      const created = await call('/admin/tournaments', post({ format: 'nested', name: 'Portal Cup', options: { autoSetup: true, turnTimer: 'off' }, botDelayMs: 0 }), ADMIN);
      const id = created.body.tournament.id;
      const host = created.body.hostToken;
      const joined = await call(`/tournaments/${id}/join`, post({ playerName: 'Follow Me' }));
      const token = joined.body.token as string;
      const t = store.tournaments.get(id)!;
      for (let i = 1; i <= 39; i++) t.entrants.push({ id: `e_bot${i}`, name: `Bot ${i}`, isBot: true, joinedAt: Date.now() });
      expect((await call(`/tournaments/${id}/start`, post(), host)).status).toBe(200);

      // Everything below reads the entrant's own view only: GET /tournaments/:id with its token.
      const me = async () => (await call(`/tournaments/${id}`, {}, token)).body.tournament;
      let view = await me();
      expect(view.you).toMatchObject({ name: 'Follow Me', status: 'playing', match: { round: 1 } });
      const table1 = view.you.match;
      // The other three at its table forfeit (host), so it wins round 1.
      const mine = view.rounds[0].matches.find((m: any) => m.gameId === table1.gameId);
      for (const p of mine.players) if (p.entrantId !== view.you.entrantId) expect((await call(`/tournaments/${id}/forfeit`, post({ entrantId: p.entrantId }), host)).status).toBe(200);
      await until(() => t.rounds.length === 2, 120_000);

      view = await me();
      expect(view.you).toMatchObject({ status: 'playing', match: { round: 2 } });
      const final = view.you.match;
      expect(final.gameId).not.toBe(table1.gameId);
      const game = (await call(`/games/${final.gameId}`, {}, final.token)).body;
      expect(game.playerId).toBe(final.playerId);
      // Every finalist started on the portal its table sits in, holding it, with the usual share of territories.
      const start = startedAs.get(final.gameId)!;
      const portals = t.nested!.portals![1][0];
      const finalMatch = t.rounds[1].matches[0];
      for (const [k, eid] of finalMatch.entrants.entries()) {
        const child = t.rounds[0].matches.find((m) => m.winner === eid)!;
        const portal = portals[t.nested!.plan!.rounds[0][child.table!].portal!];
        expect(start.territories[portal].owner, `${eid} on ${portal}`).toBe(finalMatch.seats[eid].playerId);
        expect(k).toBe(t.nested!.plan!.rounds[0][child.table!].portal);
      }
      const owned = finalMatch.entrants.map((eid) => Object.values(start.territories as Record<string, { owner: string }>).filter((s) => s.owner === finalMatch.seats[eid].playerId).length);
      expect(Math.max(...owned) - Math.min(...owned)).toBeLessThanOrEqual(1);

      // Everyone else at the final forfeits: our entrant is the champion, and its view says so.
      for (const p of view.rounds[1].matches[0].players) if (p.entrantId !== view.you.entrantId) await call(`/tournaments/${id}/forfeit`, post({ entrantId: p.entrantId }), host);
      view = await me();
      expect(view.status).toBe('finished');
      expect(view.champion.entrantId).toBe(view.you.entrantId);
      expect(view.you).toMatchObject({ status: 'champion', match: null });
    } finally {
      await risk.shutdown('test');
    }
  }, 180_000);

  it('survives a restart: the round clock re-arms from the saved deadline, and a passed deadline ends the round', async () => {
    const file = join(dir, 'restart.json');
    const clock = new FakeClock();
    const store = new Store(file, {}, { clock });
    const t = store.tournaments.create({ format: 'nested', name: 'Restart Cup', roundMinutes: 10, botDelayMs: 0, options: { turnTimer: 'off' } });
    for (let i = 1; i <= 18; i++) store.tournaments.join(t.id, `P${i}`);
    store.tournaments.start(t.id);
    expect(t.rounds[0].matches).toHaveLength(6); // 6 tables of 3, then a final of 6
    const deadline = t.rounds[0].deadline!;
    store.save();
    store.stopTimers();

    // Back before the deadline: the timer is armed again for the time left.
    const early = new FakeClock();
    early.t = deadline - 60_000;
    const again = new Store(file, {}, { clock: early });
    const t2 = again.tournaments.get(t.id)!;
    expect(t2.rounds).toHaveLength(1);
    expect(early.timers.map((x) => x.at)).toEqual([deadline]);
    early.advance(60_000);
    expect(t2.rounds).toHaveLength(2);
    expect(t2.rounds[0].matches.every((m) => m.status === 'decided')).toBe(true);
    again.stopTimers();

    // Back after the deadline: the round ends on load, from the saved tables.
    const late = new FakeClock();
    late.t = deadline + 1;
    const third = new Store(file, {}, { clock: late });
    const t3 = third.tournaments.get(t.id)!;
    expect(t3.rounds).toHaveLength(2);
    expect(t3.rounds[0].matches.every((m) => m.status === 'decided' && !!m.winner)).toBe(true);
    expect(t3.rounds[1].matches[0].entrants).toHaveLength(6);
    expect(late.timers).toHaveLength(1); // the final's deadline
    third.stopTimers();
  });

  it('replays the same boards and seating from a fixed seed, and stepBot drives a table headless', () => {
    const run = () => {
      const store = new Store(null, {}, { clock: new FakeClock() });
      const t = store.tournaments.create({ format: 'nested', seed: 42, botDelayMs: 2000, options: { turnTimer: 'off', autoSetup: true } });
      for (let i = 1; i <= 30; i++) t.entrants.push({ id: `e_${i}`, name: `B${i}`, isBot: true, joinedAt: 0 });
      store.tournaments.start(t.id);
      const out = { seed: t.nested!.seed, boards: t.nested!.boards, seating: t.rounds[0].matches.map((m) => m.entrants) };
      const room = store.get(t.rounds[0].matches[0].gameId!)!;
      const v = room.state.version;
      expect(room.stepBot()).toBe(true);
      expect(room.state.version).toBeGreaterThan(v);
      store.stopTimers();
      return out;
    };
    const a = run();
    expect(a.seed).toBe(42);
    expect(run()).toEqual(a);
  });

  it('seats Zerg entrants as Zergs at every table, round 2 included', async () => {
    const store = new Store(null, {}, { clock: new FakeClock() });
    const t = store.tournaments.create({ format: 'nested', botDelayMs: 0, options: { turnTimer: 'off', autoSetup: true } });
    store.tournaments.addBots(t.id, 'zerg', 18);
    store.tournaments.start(t.id);
    const zergSeats = (gameId: string) => store.get(gameId)!.state.players.filter((p) => !p.isNeutral).every((p) => p.isBot && p.id.startsWith('zerg_'));
    expect(t.rounds[0].matches.every((m) => zergSeats(m.gameId!))).toBe(true);
    // An all-Zerg table ends fast (the weaker Zergs give way to the strongest); the 51% rule then seats the final.
    await until(() => t.rounds.length === 2, 120_000);
    const final = t.rounds[1].matches[0];
    expect(final.entrants.every((eid) => t.entrants.find((e) => e.id === eid)!.kind === 'zerg')).toBe(true);
    expect(zergSeats(final.gameId!)).toBe(true);
    store.stopTimers();
  }, 180_000);

  it('spreads the planner\'s filler Zergs over the round-1 tables for every count that needs them', () => {
    for (const n of [2, 4, 5, 11, 13, 15, 17]) {
      const store = new Store(null, {}, { clock: new FakeClock() });
      const t = store.tournaments.create({ format: 'nested', botDelayMs: 2000, options: { turnTimer: 'off' } });
      for (let i = 1; i <= n; i++) store.tournaments.join(t.id, `P${i}`);
      store.tournaments.start(t.id);
      const zergs = new Set(t.entrants.filter((e) => e.kind === 'zerg').map((e) => e.id));
      expect(zergs.size, `${n}`).toBe(t.nested!.plan!.zergs);
      const perTable = t.rounds[0].matches.map((m) => m.entrants.filter((e) => zergs.has(e)).length);
      expect(perTable, `${n}`).toEqual(t.nested!.plan!.rounds[0].map((x) => x.zergs));
      expect(Math.max(...perTable) - Math.min(...perTable), `${n}`).toBeLessThanOrEqual(1);
      // Every table keeps at least one person while there are people enough.
      if (n >= t.rounds[0].matches.length) for (const m of t.rounds[0].matches) expect(m.entrants.some((e) => !zergs.has(e)), `${n}`).toBe(true);
      store.stopTimers();
    }
  });

  it('adds bots only when the count fits no plan', () => {
    const store = new Store(null, {}, { clock: new FakeClock() });
    const t = store.tournaments.create({ format: 'nested', botDelayMs: 0, options: { turnTimer: 'off' } });
    for (let i = 1; i <= 11; i++) store.tournaments.join(t.id, `P${i}`);
    store.tournaments.start(t.id);
    expect(t.entrants.filter((e) => e.isBot)).toHaveLength(7); // 11 -> 18: six tables of 3, then a final of 6
    // The filler entrants are Zergs, with distinct reptile names.
    const fillers = t.entrants.filter((e) => e.isBot);
    expect(fillers.every((e) => e.kind === 'zerg')).toBe(true);
    expect(new Set(fillers.map((e) => e.name)).size).toBe(7);
    // Spread as the plan shares them out (owner): every table gets its share, never two more than another table.
    const perTable = t.rounds[0].matches.map((m) => m.entrants.filter((e) => fillers.some((f) => f.id === e)).length);
    expect(perTable).toEqual(t.nested!.plan!.rounds[0].map((x) => x.zergs));
    expect(Math.max(...perTable) - Math.min(...perTable)).toBeLessThanOrEqual(1);
    // People are spread first: every table has a person, so none is all bots.
    for (const m of t.rounds[0].matches) expect(m.entrants.some((e) => !t.entrants.find((x) => x.id === e)!.isBot)).toBe(true);
    store.stopTimers();
    for (const room of store.rooms.values()) room.stopBot();
  });
});
