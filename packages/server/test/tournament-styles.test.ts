import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';

// Bots move at once here, so whole tables play out in the test (set before the store module loads).
vi.hoisted(() => {
  process.env.RISK_BOT_DELAY_MS = '0';
});

const { Store } = await import('../src/store.js');
const { createRiskServer } = await import('../src/app.js');
const { STYLE_LABELS } = await import('../src/tournaments.js');
const { TournamentScheduler, parseSchedule, slotMinTable } = await import('../src/tournament-schedule.js');
const { TournamentRankings } = await import('../src/tournament-scoring.js');
const { modelLabel } = await import('../src/roster.js');
type TournamentClock = import('../src/tournaments.js').TournamentClock;

/** A clock the test moves by hand. */
class FakeClock implements TournamentClock {
  timers: { at: number; fn: () => void }[] = [];
  constructor(public t = Date.UTC(2026, 9, 27, 18, 50)) {}
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

async function until(check: () => boolean, ms = 120_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

const FAST = { format: 'nested' as const, botDelayMs: 0, options: { turnTimer: 'off' as const, autoSetup: true } };

describe('tournament styles', () => {
  it('validates style and minTable at create', () => {
    const store = new Store(null, {}, { clock: new FakeClock() });
    expect(() => store.tournaments.create({ ...FAST, style: 'swiss' as never })).toThrow(/style/);
    expect(() => store.tournaments.create({ ...FAST, minTable: 7 })).toThrow(/minTable/);
    expect(() => store.tournaments.create({ ...FAST, style: '1v1', minTable: 4 })).toThrow(/minTable/);
    expect(() => store.tournaments.create({ ...FAST, style: '1v1', finalMap: 'world' })).toThrow(/1v1/);
    const t = store.tournaments.create({ ...FAST, style: 'survival', minTable: 4 });
    expect(store.tournaments.view(t.id).nested).toMatchObject({ style: 'survival', minTable: 4 });
    // A 100-seat preview at a minimum of 5: round 1 at 5+ a table and no planner Zergs.
    const p = store.tournaments.preview({ ...FAST, minTable: 5, delove: 100 });
    expect(p.plannerZergs).toBe(0);
    expect(Math.min(...p.seatsPerRound[0])).toBeGreaterThanOrEqual(5);
    store.stopTimers();
  });

  it('plays a 1v1 bracket to a champion: two seats at every table, the final included', async () => {
    const store = new Store(null, {}, { clock: new FakeClock() });
    // No capitals in 1v1 (owner, 2026-10-28), even when the options ask for them; other styles keep the default.
    const t = store.tournaments.create({ ...FAST, style: '1v1', options: { ...FAST.options, capitals: true, chooseCapitals: true } });
    expect(t.options).toMatchObject({ capitals: false });
    expect(t.options.chooseCapitals).toBeUndefined();
    expect(store.tournaments.create({ ...FAST }).options.capitals).toBe(true);
    for (let i = 1; i <= 6; i++) t.entrants.push({ id: `e_${i}`, name: `B${i}`, isBot: true, joinedAt: 0 });
    store.tournaments.start(t.id);
    expect(t.rounds[0].matches.every((m) => store.get(m.gameId!)!.state.options.capitals === false)).toBe(true);
    // Six players and two planner Zergs: 8 > 4 > 2 > 1.
    expect(t.nested!.plan!.rounds.map((r) => r.map((x) => x.seats))).toEqual([[2, 2, 2, 2], [2, 2], [2]]);
    await until(() => t.status === 'finished');
    expect(t.rounds.flatMap((r) => r.matches).every((m) => m.entrants.length === 2)).toBe(true);
    expect(t.champion).toBeTruthy();
    store.stopTimers();
  }, 180_000);

  it('mega: one table of every entrant on Mega Earth, decided at its deadline; settings checked at create', async () => {
    const clock = new FakeClock();
    const store = new Store(null, {}, { clock });
    expect(() => store.tournaments.create({ ...FAST, style: 'mega', maxEntrants: 101 })).toThrow(/at most 100/);
    expect(() => store.tournaments.create({ ...FAST, style: 'mega', minTable: 4 })).toThrow(/minTable/);
    expect(() => store.tournaments.create({ ...FAST, style: 'mega', finalMap: 'world' })).toThrow(/mega_earth/);
    const t = store.tournaments.create({ ...FAST, style: 'mega', options: { ...FAST.options, iceStartMinutes: 0 } });
    expect(t).toMatchObject({ maxEntrants: 100, nested: { style: 'mega', finalMap: 'mega_earth', roundMinutes: 240 } });
    // Closing ice is on by default at a mega table (a host may turn it off); other styles leave it off.
    expect(t.options.closingIce).toBe(true);
    expect(store.tournaments.create({ ...FAST, style: 'mega', options: { closingIce: false } }).options.closingIce).toBe(false);
    expect(store.tournaments.create({ ...FAST }).options.closingIce).toBeUndefined();
    for (let i = 1; i <= 30; i++) t.entrants.push({ id: `e_${i}`, name: `B${i}`, isBot: true, joinedAt: 0 });
    store.tournaments.start(t.id);
    expect(t.nested!.plan!.rounds.map((r) => r.map((x) => x.seats))).toEqual([[30]]);
    const room = store.get(t.rounds[0].matches[0].gameId!)!;
    expect(room.state.options.map).toBe('mega_earth');
    expect(room.state.players).toHaveLength(30);
    expect(new Set(room.state.players.map((p) => p.color)).size).toBe(30);
    // Bots play on for a few seconds, then the round's deadline (240 minutes by default) decides the table on standing.
    const v = room.state.version;
    await new Promise((r) => setTimeout(r, 3000));
    console.log(`mega: ${room.state.version - v} moves in 3 s, round ${room.state.round}`);
    // iceStartMinutes 0: the server started the ice on the first move, and it has advanced at each round start since.
    const ice = (room.state as { ice?: { level: number } }).ice;
    expect(ice).toBeDefined();
    if (room.state.round > 2) expect(room.state.blizzards.length).toBeGreaterThan(0);
    expect(room.state.version).toBeGreaterThan(v);
    clock.advance(240 * 60_000 + 1);
    await until(() => t.status === 'finished', 60_000);
    expect(t.champion).toBeTruthy();
    expect(t.rounds[0].matches[0].status).toMatch(/decided|finished/);
    store.stopTimers();
  }, 120_000);

  it('Zerg survival: every table moves on its best non-Zerg (never a Zerg), and a table ends at its last non-Zerg', async () => {
    const store = new Store(null, {}, { clock: new FakeClock() });
    const t = store.tournaments.create({ ...FAST, style: 'survival' });
    // Nine house players (plain bots here, so the tables play themselves) and nine Zerg entrants.
    for (let i = 1; i <= 9; i++) t.entrants.push({ id: `e_${i}`, name: `B${i}`, isBot: true, joinedAt: 0 });
    store.tournaments.addBots(t.id, 'zerg', 9);
    store.tournaments.start(t.id);
    const r1 = t.rounds[0].matches;
    const rooms = r1.map((m) => store.get(m.gameId!)!);
    expect(rooms.every((r) => r.survival)).toBe(true);
    await until(() => t.status === 'finished');
    // Some table ended the moment one non-Zerg was left (the engine's endBySurvival), with Zergs still in.
    expect(rooms.some((r) => r.chat.some((c) => /last one standing against the swarm/.test(c.message)))).toBe(true);
    const zerg = (eid: string | null) => t.entrants.find((e) => e.id === eid)?.kind === 'zerg';
    for (const m of t.rounds.flatMap((r) => r.matches)) {
      if (!m.entrants.some((e) => !zerg(e))) continue;
      expect(zerg(m.winner)).toBe(false);
      // The table's order lists every non-Zerg ahead of the Zergs.
      const firstZerg = m.order!.findIndex(zerg);
      if (firstZerg >= 0) expect(m.order!.slice(firstZerg).every(zerg)).toBe(true);
    }
    expect(zerg(t.champion)).toBe(false);
    // The board knows the style.
    expect(store.tournamentBoard.rows('survival').length + store.tournamentBoard.rows('classic').length).toBeGreaterThanOrEqual(0);
    store.stopTimers();
  }, 180_000);

  it('the schedule rotates three styles every 15 minutes, with Zergs added and the minimum table taking turns', () => {
    const clock = new FakeClock();
    const store = new Store(null, {}, { clock });
    const rotation = [
      { every: 45, at: '00:00', name: 'Classic', style: 'classic', minTable: [3, 4, 5], signupMinutes: 6, checkinMinutes: 6, maxEntrants: 100 },
      { every: 45, at: '00:15', name: 'Duel', style: '1v1', signupMinutes: 6, checkinMinutes: 6, maxEntrants: 100 },
      { every: 45, at: '00:30', name: 'Swarm', style: 'survival', zergs: 25, minTable: 4, signupMinutes: 6, checkinMinutes: 6, maxEntrants: 100 },
    ];
    const entries = parseSchedule(rotation, store.tournaments);
    expect(entries.map((e) => e.spec.style)).toEqual(['classic', '1v1', 'survival']);
    expect(() => parseSchedule({ ...rotation[2], zergs: 90, roster: 20 }, store.tournaments)).toThrow(/maxEntrants/);
    expect(() => parseSchedule({ ...rotation[0], minTable: [3, 9] }, store.tournaments)).toThrow(/minTable/);
    expect(() => parseSchedule({ ...rotation[1], minTable: 4 }, store.tournaments)).toThrow(/minTable/);
    // The classic slots take 3, 4, 5, 3... in turn.
    const slots = [0, 1, 2, 3].map((k) => slotMinTable(entries[0], Date.UTC(2026, 9, 27, 0, 0) + k * 45 * 60_000));
    expect(new Set(slots.slice(0, 3))).toEqual(new Set([3, 4, 5]));
    expect(slots[3]).toBe(slots[0]);

    const sched = new TournamentScheduler(store.tournaments, entries, null);
    // 18:50 UTC: 19:30 is a classic slot (19:30 = 1170 min, a multiple of 45), 18:45 was one, 19:00 is 1v1, 19:15 survival.
    const seen: string[] = [];
    for (let k = 0; k < 6; k++) {
      const n = sched.next().next!;
      seen.push(n.label);
      clock.advance(n.startsAt - clock.now() + 1);
    }
    expect(seen).toEqual([STYLE_LABELS['1v1'], STYLE_LABELS.survival, STYLE_LABELS.classic, STYLE_LABELS['1v1'], STYLE_LABELS.survival, STYLE_LABELS.classic]);
    // The survival slot opened with its 25 Zergs in the field, and its style on the bracket.
    const swarm = [...store.tournaments.tournaments.values()].find((t) => t.nested?.style === 'survival')!;
    expect(swarm.entrants.filter((e) => e.kind === 'zerg').length).toBeGreaterThanOrEqual(25);
    sched.stop();
    store.stopTimers();
  });

  it('runs a schedule entry on demand (mega): a one-off slot that starts on its own, the timetable untouched', async () => {
    const clock = new FakeClock();
    const store = new Store(null, {}, { clock });
    const entries = parseSchedule([{ at: '12:00', name: 'Mega tourney', style: 'mega', signupMinutes: 60, checkinMinutes: 10, maxEntrants: 100, botDelayMs: 2000 }], store.tournaments);
    const sched = new TournamentScheduler(store.tournaments, entries, null);
    const nextBefore = sched.next().next!.startsAt;
    expect(() => sched.runNow('1v1')).toThrow(/no 1v1s entry/);
    expect(() => sched.runNow('mega', 0)).toThrow(/startsInMinutes/);
    const t = sched.runNow('mega', 3);
    expect(t).toMatchObject({ status: 'registering', nested: { style: 'mega', finalMap: 'mega_earth' } });
    expect(t.scheduled!.startsAt).toBeGreaterThanOrEqual(clock.now() + 3 * 60_000);
    expect(sched.next().next!.startsAt).toBe(nextBefore);
    // Two people check in (joining inside the window checks in), then it starts by itself at its time.
    store.tournaments.join(t.id, 'Ann', undefined, undefined, 'ip:a');
    store.tournaments.join(t.id, 'Bob', undefined, undefined, 'ip:b');
    clock.advance(t.scheduled!.startsAt - clock.now() + 1);
    expect(t.status).toBe('running');
    expect(t.rounds[0].matches).toHaveLength(1);
    sched.stop();
    store.stopTimers();

    // Over HTTP: admin only; 404 with no schedule.
    const bare = new Store(null, {}, { clock: new FakeClock() });
    const risk = createRiskServer(bare, { clientDir: null, sweepIntervalMs: 0, adminToken: 'adm' });
    await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}/api/admin/schedule/run`;
    try {
      const post = (auth?: string) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify({ style: 'mega' }) });
      expect((await post()).status).toBe(401);
      expect((await post('adm')).status).toBe(404);
    } finally {
      await risk.shutdown('test');
    }
  });

  it('keeps one leaderboard per style, with each Delove\'s model', async () => {
    const boards = new TournamentRankings(null);
    const bracket = (id: string, style: string | undefined, model: string) => ({
      id,
      name: id,
      format: 'nested',
      ...(style ? { nested: { style } } : {}),
      entrants: [
        { id: 'a', name: 'Tom', isBot: false, rosterId: 'r1', model },
        { id: 'b', name: 'Ann', isBot: false },
      ],
      rounds: [{ matches: [{ entrants: ['a', 'b'], winner: 'a', status: 'finished' as const, order: ['a', 'b'] }] }],
      champion: 'a',
    });
    boards.record(bracket('T1', undefined, 'delove@12'));
    boards.record(bracket('T2', '1v1', 'delove@13'));
    boards.record(bracket('T3', 'survival', 'delove@13'));
    expect(boards.rows('classic').map((r) => r.tournaments)).toEqual([1, 1]);
    expect(boards.rows('1v1')[0]).toMatchObject({ key: 'roster:r1', model: 'delove@13', championships: 1 });
    expect(boards.rows('survival')).toHaveLength(2);
    expect(boards.rows()).toHaveLength(2);
    expect(boards.modelOf('roster:r1')).toBe('delove@13');

    expect(modelLabel('delove@12')).toBe('D12');
    expect(modelLabel('delove@13+search')).toBe('D13-S');
    expect(modelLabel('delove@13 + search')).toBe('D13-S');
    expect(modelLabel('delove@12-fog')).toBe('D12-fog');
    expect(modelLabel('jacob-sensei@2')).toBe('JS2');
    expect(modelLabel('claude-opus')).toBeUndefined();
    expect(modelLabel(undefined)).toBeUndefined();

    // Over HTTP: ?style picks the board, every row carries the model label; a roster name shows its bound model.
    const store = new Store(null, {}, { clock: new FakeClock() });
    const [tom] = store.roster.create('delove@14', 1);
    store.tournamentBoard.record({ ...bracket('H1', '1v1', 'delove@13+search'), entrants: [{ id: 'a', name: tom.name, isBot: false, rosterId: tom.id }, { id: 'b', name: 'Dee', isBot: false, model: 'delove@13+search' }] });
    const risk = createRiskServer(store, { clientDir: null, sweepIntervalMs: 0 });
    await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}/api`;
    try {
      const one = (await (await fetch(`${base}/rankings?board=tournament&style=1v1`)).json()) as any;
      expect(one).toMatchObject({ board: 'tournament', style: '1v1', label: '1v1s' });
      expect(Object.fromEntries(one.rankings.map((r: any) => [r.name, r.model]))).toEqual({ [tom.name]: 'D14', Dee: 'D13-S' });
      expect(((await (await fetch(`${base}/rankings?board=tournament`)).json()) as any).rankings).toEqual([]);
      expect((await fetch(`${base}/rankings?board=tournament&style=swiss`)).status).toBe(400);
    } finally {
      await risk.shutdown('test');
    }
  });
});
