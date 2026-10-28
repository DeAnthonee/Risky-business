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
const { NESTED_BLIZZARD_SHARE, NESTED_DEFAULT_OPTIONS, blizzardsFor, isHouseAi, seatNestedRound } = await import('../src/tournaments.js');
const { createRng, genMapId, legalMoves, nestSeed } = await import('@risk/engine');

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
  /** Move on by `ms`, firing every timer due by then in order, including ones armed by a timer that fired. */
  advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      const due = this.timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = end;
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
      expect(await bad({ territoriesPerSeat: 11 })).toBe(400);
      expect(await bad({ roundMinutes: 0 })).toBe(400);
      expect(await bad({ finishShare: 2 })).toBe(400);
      expect(await bad({ finalMap: 'skirmish' })).toBe(400); // seats 4: no final of 6
      expect(await bad({ finalMap: 'nowhere' })).toBe(400);
      expect(await bad({ format: 'swiss' })).toBe(400);
      expect(await bad({ options: { neutrals: 6 } })).toBe(400); // too many for the smallest board (16 territories: at most 5)
      const ok = await call('/admin/tournaments', post({ format: 'nested', name: 'Inception', finalMap: 'world' }), ADMIN);
      expect(ok.status).toBe(201);
      expect(ok.body.tournament).toMatchObject({ format: 'nested', map: 'nested', maxEntrants: 128, nested: { finalMap: 'world', territoriesPerSeat: 8, roundMinutes: 15, finishShare: 0.51, botDelayMs: 300, plan: null } });
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

  it('plays 40 seats: round 1 at once, the bot tables play out, the people\'s tables are decided on standing at the deadline, then the final', async () => {
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

      // Round 1: ten 4-seat tables at once, each on its own generated 32-territory board; people spread over tables.
      const r1 = started.body.tournament.rounds[0];
      expect(r1.matches).toHaveLength(10);
      expect(r1.matches.every((m: any) => m.status === 'playing' && /^gen1-s\d+-p4-t32$/.test(m.map))).toBe(true);
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

      // Nobody human moves, so their three tables wait; the seven bot tables play out. A round never closes early, so
      // it waits for its deadline. Then the people's tables get a last lap (to the end of their go-around of turns);
      // nobody moves there with no turn timer, so the backstop (one more round's time) decides them on standing, and
      // the final is seated at once.
      const botTables = r1.matches.filter((m: any) => !humanTables.includes(m)).map((m: any) => m.gameId);
      await until(() => t.rounds[0].matches.filter((m) => botTables.includes(m.gameId) && m.status === 'finished').length === 7, 120_000);
      expect(t.rounds).toHaveLength(1);
      clock.advance(20 * 60_000);
      expect(t.rounds).toHaveLength(1);
      expect(t.rounds[0].lastLapAt).toBe(clock.now());
      expect((await call(`/tournaments/${id}`)).body.tournament.rounds[0].lastLapAt).toBe(clock.now());
      for (const m of t.rounds[0].matches.filter((x) => x.status === 'playing')) expect(m.lapRound).toBe(store.get(m.gameId!)!.state.round);
      clock.advance(20 * 60_000);
      expect(t.rounds).toHaveLength(2);
      const ended = t.rounds[0];
      const finished = ended.matches.filter((m) => m.status === 'finished');
      const decided = ended.matches.filter((m) => m.status === 'decided');
      expect(finished.length).toBe(7);
      expect(decided.length).toBe(3);
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
      expect(final.map).toMatch(/^gen1-s\d+-p10-t80$/); // 16 regions, the default for 80 territories
      expect(store.get(final.gameId!)!.state.players).toHaveLength(10);
      for (const p of people) {
        const me = (await call(`/tournaments/${id}`, {}, p.token)).body.tournament.you;
        if (final.entrants.includes(p.entrantId)) expect(me).toMatchObject({ status: 'playing', match: { round: 2, gameId: final.gameId } });
        else expect(me).toMatchObject({ status: 'out', match: null });
      }

      // The final has a single table: only its own end or the deadline (and its last lap) ends it. Let the clock run out.
      if (t.status === 'running') clock.advance(40 * 60_000);
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

  it('survives a restart: the round clock re-arms from the saved deadline, and a passed deadline starts the last lap', async () => {
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
    // The deadline starts the last lap (nobody moves: no turn timer), and its backstop, a round's time on, ends it.
    early.advance(60_000);
    expect(t2.rounds).toHaveLength(1);
    expect(t2.rounds[0].lastLapAt).toBe(deadline);
    expect(early.timers.map((x) => x.at)).toEqual([deadline + 10 * 60_000]);
    early.advance(10 * 60_000);
    expect(t2.rounds).toHaveLength(2);
    expect(t2.rounds[0].matches.every((m) => m.status === 'decided')).toBe(true);
    again.stopTimers();

    // Back after the deadline: the last lap starts on load, with its backstop armed.
    const late = new FakeClock();
    late.t = deadline + 1;
    const lap = new Store(file, {}, { clock: late });
    const tl = lap.tournaments.get(t.id)!;
    expect(tl.rounds).toHaveLength(1);
    expect(tl.rounds[0].lastLapAt).toBe(deadline + 1);
    expect(late.timers.map((x) => x.at)).toEqual([deadline + 10 * 60_000]);
    lap.stopTimers();

    // Back after the backstop too: the round ends on load, from the saved tables.
    late.timers = [];
    late.t = deadline + 10 * 60_000;
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
    // An all-Zerg table ends fast (the weaker Zergs give way to the strongest); once every table is over, the final is seated.
    await until(() => t.rounds.length === 2, 120_000);
    const final = t.rounds[1].matches[0];
    expect(final.entrants.every((eid) => t.entrants.find((e) => e.id === eid)!.kind === 'zerg')).toBe(true);
    expect(zergSeats(final.gameId!)).toBe(true);
    store.stopTimers();
  }, 180_000);

  it('spreads the planner\'s filler Zergs evenly over the round-1 tables for every count that needs them', () => {
    for (const n of [2, 4, 5, 11, 13, 15, 17]) {
      const store = new Store(null, {}, { clock: new FakeClock() });
      const t = store.tournaments.create({ format: 'nested', botDelayMs: 2000, options: { turnTimer: 'off' } });
      for (let i = 1; i <= n; i++) store.tournaments.join(t.id, `P${i}`);
      store.tournaments.start(t.id);
      const zergs = new Set(t.entrants.filter((e) => e.kind === 'zerg').map((e) => e.id));
      expect(zergs.size, `${n}`).toBe(t.nested!.plan!.zergs);
      // Every seat is taken, and the Zergs fill the seats people leave free: never two more at one table than another
      // of the same size.
      expect(t.rounds[0].matches.map((m) => m.entrants.length), `${n}`).toEqual(t.nested!.plan!.rounds[0].map((x) => x.seats));
      const bySize = new Map<number, number[]>();
      for (const m of t.rounds[0].matches) bySize.set(m.entrants.length, [...(bySize.get(m.entrants.length) ?? []), m.entrants.filter((e) => zergs.has(e)).length]);
      for (const counts of bySize.values()) expect(Math.max(...counts) - Math.min(...counts), `${n}`).toBeLessThanOrEqual(1);
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
    // Spread evenly (owner): never two more at one table than another.
    const perTable = t.rounds[0].matches.map((m) => m.entrants.filter((e) => fillers.some((f) => f.id === e)).length);
    expect(perTable.reduce((a, b) => a + b, 0)).toBe(7);
    expect(Math.max(...perTable) - Math.min(...perTable)).toBeLessThanOrEqual(1);
    // People are spread first: every table has a person, so none is all bots.
    for (const m of t.rounds[0].matches) expect(m.entrants.some((e) => !t.entrants.find((x) => x.id === e)!.isBot)).toBe(true);
    store.stopTimers();
    for (const room of store.rooms.values()) room.stopBot();
  });

  it('spreads 50 Zergs and 10 bots over a 100-seat round with 40 people: no table is all server bots (owner)', () => {
    const store = new Store(null, {}, { clock: new FakeClock() });
    const t = store.tournaments.create({ format: 'nested', maxEntrants: 100, botDelayMs: 2000, options: { turnTimer: 'off', autoSetup: true } });
    for (let i = 1; i <= 40; i++) store.tournaments.join(t.id, `Agent ${i}`);
    store.tournaments.addBots(t.id, 'zerg', 50);
    store.tournaments.addBots(t.id, 'bot', 10);
    store.tournaments.start(t.id);
    const entrant = (eid: string) => t.entrants.find((e) => e.id === eid)!;
    const tables = t.rounds[0].matches;
    expect(tables.reduce((n, m) => n + m.entrants.length, 0)).toBe(t.entrants.length);
    // Every table has a person or agent; none is a Zerg-only (or server-bot-only) table.
    for (const m of tables) expect(m.entrants.some((eid) => !entrant(eid).isBot)).toBe(true);
    // People and Zergs each spread within one of even over tables of the same size.
    const spread = (pick: (eid: string) => boolean) => {
      const bySize = new Map<number, number[]>();
      for (const m of tables) bySize.set(m.entrants.length, [...(bySize.get(m.entrants.length) ?? []), m.entrants.filter(pick).length]);
      return Math.max(...[...bySize.values()].map((c) => Math.max(...c) - Math.min(...c)));
    };
    expect(spread((eid) => !entrant(eid).isBot)).toBeLessThanOrEqual(1);
    expect(spread((eid) => entrant(eid).kind === 'zerg')).toBeLessThanOrEqual(1);
    // The same seed seats the same way.
    expect(seatNestedRound(t.nested!.plan!.rounds[0], t.entrants, createRng(nestSeed(t.nested!.seed!, 'seats')))).toEqual(tables.map((m) => m.entrants));
    store.stopTimers();
    for (const room of store.rooms.values()) room.stopBot();
  });

  it('never closes a round early: it ends when every table has finished, or after the deadline once the last lap has given every player the same number of turns', () => {
    // 8 people + 10 Zergs: six tables of 3, each with a person. The round deadline defaults to 15 minutes (owner).
    const clock = new FakeClock();
    const store = new Store(null, {}, { clock });
    const t = store.tournaments.create({ format: 'nested', botDelayMs: 2000, options: { turnTimer: 'off', autoSetup: true } });
    expect(t.nested!.roundMinutes).toBe(15);
    for (let i = 1; i <= 8; i++) store.tournaments.join(t.id, `P${i}`);
    store.tournaments.addBots(t.id, 'zerg', 10);
    store.tournaments.start(t.id);
    const r1 = t.rounds[0];
    expect(r1.deadline).toBe(clock.now() + 15 * 60_000);
    const m = r1.matches;
    expect(m).toHaveLength(6);
    const check = () => (store.tournaments as any).checkRound(t) as boolean;
    // Five of six tables are over (the old 51% rule closed the round at four): the round goes on.
    for (const x of m.slice(0, 5)) {
      x.status = 'finished';
      x.winner = x.entrants[0];
    }
    expect(check()).toBe(false);
    expect(t.rounds).toHaveLength(1);
    expect(r1.lastLapAt).toBeUndefined();
    // The deadline starts the last lap: the table still playing plays on from the go-around it is on.
    const last = m[5];
    const room = store.get(last.gameId!)!;
    const lap = room.state.round;
    clock.advance(15 * 60_000);
    expect(r1.lastLapAt).toBe(clock.now());
    expect(last.lapRound).toBe(lap);
    expect(last.status).toBe('playing');
    expect(t.rounds).toHaveLength(1);
    // Turns taken inside the go-around do not end it ...
    room.state = { ...room.state, turnNumber: room.state.turnNumber + 1 };
    expect(check()).toBe(false);
    // ... the turn passing the last seat in turn order does (GameState.round moves on, eliminated seats skipped by the
    // engine): every player still there has then taken the same number of turns, and the table is decided on standing.
    room.state = { ...room.state, round: lap + 1 };
    expect(check()).toBe(true);
    expect(r1.endedAt).toBe(clock.now());
    expect(last.status).toBe('decided');
    expect(room.decidedAt).not.toBeNull();
    // The finished tables still move on: all six winners sit at the final.
    expect(t.rounds).toHaveLength(2);
    expect([...t.rounds[1].matches[0].entrants].sort()).toEqual(m.map((x) => x.winner!).sort());
    store.stopTimers();
    for (const r of store.rooms.values()) r.stopBot();

    // Every table finished before the deadline: the round ends at once, with no last lap.
    const clock2 = new FakeClock();
    const store2 = new Store(null, {}, { clock: clock2 });
    const t2 = store2.tournaments.create({ format: 'nested', botDelayMs: 2000, finishShare: 0.3, options: { turnTimer: 'off', autoSetup: true } });
    for (let i = 1; i <= 18; i++) store2.tournaments.join(t2.id, `Q${i}`);
    store2.tournaments.start(t2.id);
    const check2 = () => (store2.tournaments as any).checkRound(t2) as boolean;
    const m2 = t2.rounds[0].matches;
    // finishShare is still accepted (old callers) and ignored: two of six finished does not close the round.
    for (const x of m2.slice(0, 2)) {
      x.status = 'finished';
      x.winner = x.entrants[0];
    }
    expect(check2()).toBe(false);
    for (const x of m2) {
      x.status = 'finished';
      x.winner = x.entrants[0];
    }
    expect(check2()).toBe(true);
    expect(t2.rounds[0].lastLapAt).toBeUndefined();
    expect(t2.rounds).toHaveLength(2);
    store2.stopTimers();
    for (const r of store2.rooms.values()) r.stopBot();
  });

  it('every table of every round plays the owner\'s tournament mode by default: auto setup, capitals, blizzards', () => {
    const clock = new FakeClock();
    const store = new Store(null, {}, { clock });
    const t = store.tournaments.create({ format: 'nested', finalMap: 'hexworld', botDelayMs: 2000 });
    expect(t.options).toMatchObject({ autoSetup: true, capitals: true, stallFogLift: 3, stallStorm: 5, stallEnd: 5 }); // the stall breaker: fog lifts after 3 stalled rounds
    expect(t.options.blizzards).toBeUndefined();
    expect(NESTED_DEFAULT_OPTIONS).toEqual({ autoSetup: true, capitals: true, stallFogLift: 3, stallStorm: 5, stallEnd: 5 });
    // Blizzards scale with each table's board: 10%, at least 1 (lord of game development).
    expect(NESTED_BLIZZARD_SHARE).toBe(0.1);
    expect(t.nested!.blizzardShare).toBe(0.1);
    expect([15, 30, 50].map((n) => blizzardsFor(genMapId({ seed: 1, seats: n / 5, territoriesPerSeat: 5 }), 0.1))).toEqual([2, 3, 5]);
    // 100 entrants: three rounds (generated boards, then moved-on tables on generated boards, then the Hex Earth final).
    for (let i = 1; i <= 100; i++) t.entrants.push({ id: `e_${i}`, name: `B${i}`, isBot: true, joinedAt: 0 });
    store.tournaments.start(t.id);
    const rounds = t.nested!.plan!.rounds.length;
    expect(rounds).toBe(3);
    for (let r = 0; r < rounds; r++) {
      expect(t.rounds).toHaveLength(r + 1);
      for (const m of t.rounds[r].matches) {
        const s = store.get(m.gameId!)!.state;
        const where = `round ${r + 1} ${m.map}`;
        expect(s.options, where).toMatchObject({ autoSetup: true, capitals: true, stallFogLift: 3, stallStorm: 5, stallEnd: 5, blizzards: blizzardsFor(m.map!, 0.1) });
        expect(s.phase, where).not.toBe('setup'); // dealt and placed at once
        expect(s.blizzards.length, where).toBeGreaterThan(0);
        for (const p of s.players.filter((x) => !x.isNeutral)) expect(s.blizzards, where).not.toContain(s.capitals[p.id]);
        if (r === rounds - 1) expect(m.map).toBe('hexworld');
        else expect(m.map, where).toMatch(/^gen1-/);
      }
      // The round's deadline decides whatever is still playing; the next round is seated at once.
      if (r < rounds - 1) clock.advance(30 * 60_000);
    }
    store.stopTimers();
    for (const room of store.rooms.values()) room.stopBot();

    // The host can still turn them off, and an explicit blizzard count holds at every table, whatever its size.
    const plain = store.tournaments.create({ format: 'nested', botDelayMs: 2000, options: { autoSetup: false, capitals: false, blizzards: 0 } });
    expect(plain.options).toMatchObject({ autoSetup: false, capitals: false, blizzards: 0 });
    expect(plain.nested!.blizzardShare).toBeUndefined();
    const six = store.tournaments.create({ format: 'nested', botDelayMs: 2000, options: { blizzards: 6 } });
    for (let i = 1; i <= 18; i++) six.entrants.push({ id: `s_${i}`, name: `S${i}`, isBot: true, joinedAt: 0 });
    store.tournaments.start(six.id);
    for (const m of six.rounds[0].matches) expect(store.get(m.gameId!)!.state.options.blizzards).toBe(6);
    store.stopTimers();
    for (const room of store.rooms.values()) room.stopBot();
  });

  it('seats house AI (Delove) as its own tier: 50 Delove + 10 guest agents over 10 tables puts one guest at every table', () => {
    const store = new Store(null, {}, { clock: new FakeClock() });
    const t = store.tournaments.create({ format: 'nested', maxEntrants: 60, botDelayMs: 2000, options: { turnTimer: 'off', autoSetup: true } });
    for (let i = 1; i <= 10; i++) store.tournaments.join(t.id, `Guest ${i}`, i % 2 ? 'claude-sonnet-5-5' : undefined);
    for (let i = 1; i <= 50; i++) store.tournaments.join(t.id, `Delove ${i}`, 'delove@12');
    store.tournaments.start(t.id);
    const r1 = t.rounds[0].matches;
    expect(r1).toHaveLength(10);
    const guests = (m: (typeof r1)[number]) => m.entrants.filter((eid) => t.entrants.find((e) => e.id === eid)!.name.startsWith('Guest')).length;
    expect(r1.map(guests)).toEqual(new Array(10).fill(1));
    // Who is house AI: the label, or a seat the Delove pool joined; never a server bot.
    expect(isHouseAi({ id: 'a', isBot: false, agent: 'jacob-sensei@2' })).toBe(true);
    expect(isHouseAi({ id: 'a', isBot: false, agent: 'claude-opus-5-5' })).toBe(false);
    expect(isHouseAi({ id: 'a', isBot: false }, new Set(['a']))).toBe(true);
    expect(isHouseAi({ id: 'a', isBot: true, agent: 'delove@12' })).toBe(false);
    store.stopTimers();
    for (const room of store.rooms.values()) room.stopBot();
  });

  it('finished house-AI-only tables never close a round while guest tables play', () => {
    // 2 guests + 16 Delove: six tables of 3, two with a guest, four Delove only.
    const clock = new FakeClock();
    const store = new Store(null, {}, { clock });
    const t = store.tournaments.create({ format: 'nested', roundMinutes: 20, botDelayMs: 2000, options: { turnTimer: 'off', autoSetup: true } });
    store.tournaments.join(t.id, 'Ada', 'claude-sonnet-5-5');
    store.tournaments.join(t.id, 'Grace');
    for (let i = 1; i <= 16; i++) store.tournaments.join(t.id, `Delove ${i}`, 'delove@12');
    store.tournaments.start(t.id);
    const isGuest = (eid: string) => ['Ada', 'Grace'].includes(t.entrants.find((e) => e.id === eid)!.name);
    const m1 = t.rounds[0].matches;
    const guestTables = m1.filter((m) => m.entrants.some(isGuest));
    const houseTables = m1.filter((m) => !m.entrants.some(isGuest));
    expect(guestTables).toHaveLength(2);
    expect(houseTables).toHaveLength(4);
    // Every Delove-only table is over (4 of 6, past the old 51% rule), and the guests' tables have played many turns.
    // The round must not close: it waits for every table (or its deadline and last lap, #289).
    for (const m of houseTables) {
      m.status = 'finished';
      m.winner = m.entrants[0];
    }
    for (const m of guestTables) {
      const room = store.get(m.gameId!)!;
      room.state = { ...room.state, round: 10 };
    }
    const check = () => (store.tournaments as any).checkRound(t) as boolean;
    expect(check()).toBe(false);
    // Both guest tables over: the round closes.
    for (const m of guestTables) {
      m.status = 'finished';
      m.winner = m.entrants[0];
    }
    expect(check()).toBe(true);
    expect(t.rounds).toHaveLength(2);
    store.stopTimers();
    for (const room of store.rooms.values()) room.stopBot();
  });
});

describe('stall relievers at a tournament table', () => {
  it('a stalemate (stallEnd) ends the game through commit, and the tournament counts it as decided on standing (+1)', () => {
    const clock = new FakeClock();
    const store = new Store(null, {}, { clock });
    // 18 people (six tables of 3, then a final of 6). Only the end is on here: one full round with no capture ends a table.
    const t = store.tournaments.create({ format: 'nested', botDelayMs: 2000, options: { turnTimer: 'off', autoSetup: true, stallStorm: 0, stallEnd: 1 } });
    for (let i = 1; i <= 18; i++) store.tournaments.join(t.id, `P${i}`);
    store.tournaments.start(t.id);
    const m = t.rounds[0].matches[0];
    const room = store.get(m.gameId!)!;
    // Everyone at the table places and ends the turn: a full round, no capture.
    for (let i = 0; i < 3; i++) {
      const me = room.state.currentPlayer!;
      const lm = legalMoves(room.state, me);
      if (lm.placeLimit > 0) room.act(me, { type: 'place', placements: { [lm.canPlaceOn[0]]: lm.placeLimit } });
      room.act(me, { type: 'end_turn' });
    }
    expect(room.state.phase).toBe('finished');
    const over = room.history.at(-1)!;
    expect(over.action).toMatchObject({ type: 'system' });
    expect(over.events.map((e) => e.type)).toEqual(['stalemate', 'game_over']);
    expect(room.chat.at(-1)!.message).toMatch(/Stalemate/);
    // The table is decided on standing: its winner moves on, its standing is on the bracket.
    expect(m.status).toBe('decided');
    expect(m.winner).toBe(m.standing!.order[0]);
    expect([...m.standing!.order].sort()).toEqual([...m.entrants].sort());
    expect(m.order).toEqual(m.standing!.order);
    expect(m.seats[m.winner!].playerId).toBe(room.state.winner);
    store.stopTimers();
    for (const r of store.rooms.values()) r.stopBot();
  });
});

describe('aborting a tournament (owner: every live table keeps its record)', () => {
  it('abort files every live table as "aborted" with its standing so far, keeps the bracket, and DELETE of a running one aborts first', async () => {
    const clock = new FakeClock();
    const store = new Store(join(dir, 'abort.json'), {}, { clock });
    const { risk, call } = await serve(store);
    try {
      const created = await call('/admin/tournaments', post({ format: 'nested', name: 'Stopped Cup', botDelayMs: 2000, options: { turnTimer: 'off', autoSetup: true } }), ADMIN);
      const id = created.body.tournament.id;
      const host = created.body.hostToken;
      for (let i = 1; i <= 18; i++) await call(`/tournaments/${id}/join`, post({ playerName: `A${i}` }));
      expect((await call(`/tournaments/${id}/start`, post(), host)).status).toBe(200);
      const t = store.tournaments.get(id)!;
      const tables = t.rounds[0].matches.map((m) => m.gameId!);
      expect(tables).toHaveLength(6);
      // Only the host (or the admin) may abort.
      expect((await call(`/tournaments/${id}/abort`, post())).status).toBeGreaterThanOrEqual(401);
      const aborted = await call(`/tournaments/${id}/abort`, post(), host);
      expect(aborted.status).toBe(200);
      const view = aborted.body.tournament;
      expect(view).toMatchObject({ status: 'finished', champion: null, aborted: { at: clock.now() } });
      // The bracket stays: every table abandoned with its standing so far.
      expect(view.rounds).toHaveLength(1);
      for (const m of view.rounds[0].matches) {
        expect(m.status).toBe('abandoned');
        expect([...m.standing.order].sort()).toEqual(m.players.map((p: any) => p.entrantId).sort());
      }
      // Every live table was filed first, then closed.
      for (const g of tables) expect(store.get(g)).toBeUndefined();
      const filed = store.archive.list().filter((e) => e.tournamentId === id);
      expect(filed).toHaveLength(6);
      for (const e of filed) {
        expect(e).toMatchObject({ finished: false, aborted: true, reason: 'aborted', winner: null, endedBecause: 'its tournament was aborted' });
        const record = store.archive.get(e.id)!;
        expect(record.outcome.aborted!.standing).toHaveLength(3);
        expect(record.outcome.placings.slice(0, 3)).toEqual(record.outcome.aborted!.standing);
        expect(record.outcome.decided).toBeUndefined();
      }
      // The match history lists them on request (winner null, aborted), and never by default.
      expect((await call('/history')).body.games.some((g: any) => g.aborted)).toBe(false);
      const history = (await call('/history?aborted=1&limit=100')).body.games.filter((g: any) => g.tournamentId === id);
      expect(history).toHaveLength(6);
      expect(history.every((g: any) => g.aborted && g.winner === null && g.reason === 'aborted')).toBe(true);
      // Aborting again changes nothing; nothing goes on the tournament board.
      expect((await call(`/tournaments/${id}/abort`, post(), host)).body.tournament.aborted).toEqual(view.aborted);
      expect(store.tournamentBoard.result(id)).toBeFalsy();

      // DELETE of a running tournament aborts it first: its live tables are filed, then it is gone.
      const second = await call('/admin/tournaments', post({ format: 'nested', name: 'Deleted Cup', botDelayMs: 2000, options: { turnTimer: 'off', autoSetup: true } }), ADMIN);
      const id2 = second.body.tournament.id;
      for (let i = 1; i <= 18; i++) await call(`/tournaments/${id2}/join`, post({ playerName: `D${i}` }));
      await call(`/tournaments/${id2}/start`, post(), second.body.hostToken);
      expect((await call(`/admin/tournaments/${id2}`, { method: 'DELETE' }, ADMIN)).status).toBe(200);
      expect((await call(`/tournaments/${id2}`)).status).toBe(404);
      const filed2 = store.archive.list().filter((e) => e.tournamentId === id2);
      expect(filed2).toHaveLength(6);
      expect(filed2.every((e) => e.reason === 'aborted' && e.aborted)).toBe(true);
    } finally {
      await risk.shutdown('test');
    }
  });
});
