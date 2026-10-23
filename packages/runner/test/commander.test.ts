import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addPlayer, createGame, getMap, startGame, viewFor, type GameView } from '@risk/engine';
import { Commander, condenseLearnings, parsePlanReply, profileExcerpt } from '../src/commander.js';
import { commanderFacts } from '../src/facts.js';
import { DealLedger } from '../src/deals.js';
import type { Llm } from '../src/llm.js';
import { DEFAULT_OPTIONS, pickMap, rotationMaps, shuffled } from '../src/presets.js';

function makeView(opts: { capitals?: boolean } = {}): GameView {
  // Seed search: seat 'a' must be the one to move, so its view carries legal choices.
  for (let seed = 9; ; seed++) {
    let s = createGame('CM', { ...DEFAULT_OPTIONS, maxPlayers: 3, map: 'classic', chooseCapitals: opts.capitals ?? true }, seed);
    for (const [id, name] of [['a', 'Shen'], ['b', 'Shaco'], ['c', 'Teemo']]) s = addPlayer(s, id, name, true);
    s = startGame(s).state;
    if (s.currentPlayer === 'a') return viewFor(s, 'a');
  }
}

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});
const tmp = async () => {
  const d = await mkdtemp(path.join(tmpdir(), 'runner-cmd-'));
  dirs.push(d);
  return d;
};

const llmReturning = (...replies: string[]) => {
  const calls: string[] = [];
  let i = 0;
  const llm: Llm = {
    async chat(messages) {
      calls.push(messages.map((m) => m.content).join('\n'));
      return replies[Math.min(i++, replies.length - 1)];
    },
  };
  return { llm, calls };
};

describe('parsePlanReply', () => {
  const view = makeView();
  const t = getMap('classic').territories[3];
  const cont = getMap('classic').continents[0];

  it('accepts ids and names (any case), resolves players, clamps numbers', () => {
    const p = parsePlanReply(
      '```json\n' + JSON.stringify({ plan: 'Take it', focus: t.name.toUpperCase(), target: 'shaco', avoid: ['Teemo', 'teemo', 'Shen'], aggression: 3, capitalGarrison: 500, capital: null, note: 'n' }) + '\n```',
      view,
      'a',
    )!;
    expect(p.focus).toBe(t.id);
    expect(p.target).toBe('b');
    expect(p.avoid).toEqual(['c']); // deduped, and never ourselves
    expect(p.aggression).toBe(1);
    expect(p.capitalGarrison).toBe(60);
    expect(parsePlanReply(JSON.stringify({ plan: 'x', focus: `${cont.name} [${cont.id}]` }), view, 'a')?.focus).toBe(cont.id);
  });

  it('drops unknown ids and bad numbers instead of passing them on', () => {
    const p = parsePlanReply(JSON.stringify({ plan: 'x', focus: 'Narnia', target: 'Ghost', avoid: ['Ghost', 7], aggression: 'lots', capitalGarrison: 'a few', capital: 'Narnia' }), view, 'a')!;
    expect(p).toMatchObject({ focus: null, target: null, avoid: [], aggression: 0.5, capitalGarrison: undefined, capital: null });
  });

  it('returns null for text that is not JSON', () => {
    expect(parsePlanReply('I will attack everyone!', view, 'a')).toBeNull();
    expect(parsePlanReply('{"plan": "unfinished', view, 'a')).toBeNull();
  });

  it('only accepts a capital from the legal choices', () => {
    const v = makeView();
    expect(v.legal?.capitalChoices.length).toBeGreaterThan(0);
    const mine = v.legal!.capitalChoices[0];
    expect(parsePlanReply(JSON.stringify({ plan: 'p', capital: mine }), v, 'a')?.capital).toBe(mine);
    const notMine = getMap('classic').territoryIds.find((x) => !v.legal!.capitalChoices.includes(x))!;
    expect(parsePlanReply(JSON.stringify({ plan: 'p', capital: notMine }), v, 'a')?.capital).toBeNull();
  });
});

describe('Commander', () => {
  const base = (llm: Llm, extra: Partial<ConstructorParameters<typeof Commander>[0]> = {}) =>
    new Commander({ llm, seatName: 'Shen', playerId: 'a', profile: 'Calm.', learnings: '# Learnings\n- hold bonuses', gameId: 'GAME1', scoutingDir: null, ...extra });

  it('asks once per turn, keeps the plan and builds the prompt from learnings, log and facts', async () => {
    const { llm, calls } = llmReturning(JSON.stringify({ plan: 'Hold Australia', focus: null, target: 'Shaco', avoid: [], aggression: 0.7, capitalGarrison: 6, capital: null, note: 'first' }));
    const c = base(llm);
    const view = makeView({ capitals: false });
    const plan = await c.planFor({ ...view, phase: 'reinforce' });
    expect(plan).toMatchObject({ target: 'b', aggression: 0.7, capitalGarrison: 6 });
    await c.planFor({ ...view, phase: 'reinforce' }); // same turn: no second call
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('advice, not rules');
    expect(calls[0]).toContain('hold bonuses');
    expect(calls[0]).toContain('Board facts:');
    await c.planFor({ ...view, turnNumber: view.turnNumber + 1 });
    expect(calls[1]).toContain('Hold Australia'); // private log comes back
    expect(c.planText()).toContain('Hold Australia');
  });

  it('puts the text shared by every seat first, so the model can reuse its cached prompt across seats', async () => {
    const reply = JSON.stringify({ plan: 'p', aggression: 0.5 });
    const shen = llmReturning(reply);
    const shaco = llmReturning(reply);
    const view = makeView({ capitals: false });
    await base(shen.llm).planFor(view);
    await base(shaco.llm, { seatName: 'Shaco', playerId: 'b', profile: 'Sneaky.' }).planFor(view);
    const [a, b] = [shen.calls[0], shaco.calls[0]];
    let common = 0;
    while (common < a.length && a[common] === b[common]) common++;
    const seatAt = a.indexOf('YOUR SEAT: you are the commander of the Risk player "Shen"');
    expect(a.slice(0, common)).toContain('hold bonuses'); // learnings are in the shared part
    expect(a.slice(0, common)).toContain('Use only ids and names');
    expect(seatAt).toBeGreaterThan(a.indexOf('Use only ids and names')); // the seat comes after the shared part
    expect(common).toBeGreaterThan(seatAt); // and the prompts only part ways inside the seat's own text
    expect(a.indexOf('Calm.')).toBeGreaterThan(seatAt);
  });

  it('answers a joint-attack call even when the model sends "ping": null', async () => {
    const { llm } = llmReturning(JSON.stringify({ plan: 'Hold', aggression: 0.5, ping: null }));
    const c = base(llm);
    const view = makeView({ capitals: false });
    c.onMessages([{ id: 1, name: 'Shaco', message: '⚔️ [attack: Teemo]', at: 0 } as never]);
    await c.planFor({ ...view, phase: 'reinforce' });
    expect(c.popPing()).toMatchObject({ type: 'agree', to: 'Shaco', target: 'attack Teemo' });
    expect(c.currentPlan()?.target).toBe('c'); // joins the attack on Teemo
  });

  it('falls back to the previous plan on bad JSON and to null when there is none', async () => {
    const { llm } = llmReturning('no json here', JSON.stringify({ plan: 'Second', aggression: 0.2 }), 'garbage again');
    const c = base(llm);
    const v = makeView({ capitals: false });
    expect(await c.planFor(v)).toBeNull();
    expect(await c.planFor({ ...v, turnNumber: 5 })).toMatchObject({ plan: 'Second' });
    expect(await c.planFor({ ...v, turnNumber: 6 })).toMatchObject({ plan: 'Second' }); // kept
  });

  it('times out and keeps the last plan', async () => {
    let n = 0;
    let aborted = false;
    const llm: Llm = {
      chat(_m, opts) {
        if (n++ === 0) return Promise.resolve(JSON.stringify({ plan: 'First' }));
        return new Promise((_res, rej) => opts?.signal?.addEventListener('abort', () => ((aborted = true), rej(new Error('cancelled')))));
      },
    };
    const lines: string[] = [];
    const c = base(llm, { timeoutMs: 40, log: (l) => lines.push(l) });
    const v = makeView({ capitals: false });
    expect(await c.planFor(v)).toMatchObject({ plan: 'First' });
    const t0 = Date.now();
    expect(await c.planFor({ ...v, turnNumber: 9 })).toMatchObject({ plan: 'First' });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(aborted).toBe(true);
    expect(lines.join('\n')).toContain('timed out');
  });

  it('picks a capital only from the offered list, and survives model errors', async () => {
    const v = makeView();
    const choice = v.legal!.capitalChoices[1];
    const ok = base(llmReturning(JSON.stringify({ plan: 'Door', capital: choice })).llm);
    expect(await ok.chooseCapital(v)).toBe(choice);
    const bad = base(llmReturning(JSON.stringify({ plan: 'Door', capital: 'Narnia' })).llm);
    expect(await bad.chooseCapital(v)).toBeNull();
    const boom = base({ chat: async () => { throw new Error('ollama down'); } });
    expect(await boom.chooseCapital(v)).toBeNull();
    expect(await boom.planFor(makeView({ capitals: false }))).toBeNull();
  });

  it('writes the private log to scouting/<name>-<GAMEID>.md', async () => {
    const dir = await tmp();
    const c = base(llmReturning(JSON.stringify({ plan: 'Own the south', note: 'watch Shaco' })).llm, { scoutingDir: path.join(dir, 'scouting') });
    await c.planFor(makeView({ capitals: false }));
    await c.settled();
    const text = await readFile(path.join(dir, 'scouting', 'shen-GAME1.md'), 'utf8');
    expect(text).toContain('# Shen scouting GAME1');
    expect(text).toContain('Own the south');
    expect(text).toContain('watch Shaco');
    expect(c.logTail().length).toBeLessThanOrEqual(1500);
  });

  it('keeps only avoids a deal backs, and drops an agreed truce once that player takes our land', async () => {
    const view = makeView({ capitals: false });
    // A real truce with Shaco (proposed by Shen, accepted by Shaco); nothing backs avoiding Teemo.
    const ledger = new DealLedger({ me: 'Shen', idPrefix: 'S' });
    ledger.sync(view);
    const d = ledger.propose({ kind: 'truce', with: 'Shaco', untilRound: view.round + 8 }, view, 'Peace?')!;
    ledger.ingest([{ id: 1, name: 'Shaco', message: `Agreed [accept ${d.id}]` } as never]);
    const c = base(llmReturning(JSON.stringify({ plan: 'Peace with Shaco', avoid: ['Shaco', 'Teemo'] })).llm, { ledger });
    await c.planFor(view);
    expect(c.currentPlan()?.avoid).toEqual(['b']);
    c.observe(view);
    const mine = Object.entries(view.territories).find(([, s]) => s.owner === 'a')![0];
    c.observe({ ...view, territories: { ...view.territories, [mine]: { owner: 'b', armies: 3 } } });
    expect(c.currentPlan()?.avoid ?? []).toEqual([]);
  });
});

describe('prompt helpers', () => {
  it('condenseLearnings keeps short text, drops tool tips and game log first, then cuts the middle', () => {
    expect(condenseLearnings('short', 100)).toBe('short');
    const text = `# T\n\n## Rules\n${'r '.repeat(300)}\n\n## Tool tips\n${'t '.repeat(300)}\n\n## Game log\n${'g '.repeat(300)}\n`;
    const c = condenseLearnings(text, 800);
    expect(c).toContain('## Rules');
    expect(c).not.toContain('Tool tips');
    expect(c).not.toContain('Game log');
    const long = `HEAD${'x'.repeat(5000)}TAIL`;
    const cut = condenseLearnings(long, 1000);
    expect(cut.length).toBeLessThanOrEqual(1000);
    expect(cut.startsWith('HEAD')).toBe(true);
    expect(cut.endsWith('TAIL')).toBe(true);
  });

  it('condenseLearnings filters sections based on game mode options', () => {
    const raw = [
      '# Risk Rules',
      '## Game Rules & Foundations',
      'Core rules here.',
      '### Fog of War & Information Control',
      'Watch border troops closely.',
      '### Non-Fog of War (Public Board & Coalition Counterplay)',
      'Public troop counts are known.',
      '### Fixed Cards (Continental Attrition & Border Defense)',
      'Bonuses matter most.',
      '### Progressive Cards (Escalating Spoils & Chain Eliminations)',
      'Escalating trade values.',
      '### Capitals Conquest',
      'Capitals hold bonuses.',
    ].join('\n\n');

    const progFog = condenseLearnings(raw, { fogOfWar: true, cardValues: 'progressive', capitals: false });
    expect(progFog).toContain('Fog of War & Information Control');
    expect(progFog).not.toContain('Non-Fog of War');
    expect(progFog).toContain('Progressive Cards');
    expect(progFog).not.toContain('Fixed Cards');
    expect(progFog).not.toContain('Capitals Conquest');

    const fixedCaps = condenseLearnings(raw, { fogOfWar: false, cardValues: 'fixed', capitals: true });
    expect(fixedCaps).not.toContain('Fog of War & Information Control');
    expect(fixedCaps).toContain('Non-Fog of War');
    expect(fixedCaps).not.toContain('Progressive Cards');
    expect(fixedCaps).toContain('Fixed Cards');
    expect(fixedCaps).toContain('Capitals Conquest');
  });

  it('profileExcerpt keeps the intro and Strategy, and truncates', () => {
    const md = '# Shen\nWarrior.\n\n## Strategy\nHold the line.\n\n## History\nLong ago.';
    const ex = profileExcerpt(md)!;
    expect(ex).toContain('Hold the line');
    expect(ex).not.toContain('Long ago');
    expect(profileExcerpt(md, 10)!.length).toBe(10);
    expect(profileExcerpt(null)).toBeNull();
  });

  it('commanderFacts names capitals, continents and card value, and stays bounded', () => {
    const v = makeView();
    const f = commanderFacts({ ...v, phase: 'reinforce' }, 'a');
    expect(f).toContain('Next card set is worth 4 armies');
    expect(f).toContain('bonus');
    expect(f).toMatch(/\[[a-z_]+\]/);
    expect(f.length).toBeLessThanOrEqual(6500);
    expect(f).toMatch(/next to .* held by .* \(\d+\)/);
    expect(commanderFacts(v, 'a')).toContain('CAPITAL CHOICES');
  });
});

describe('presets', () => {
  it('rotation fits the seat count and never offers skirmish or the legacy europe', () => {
    const six = rotationMaps(6);
    expect(six).toContain('classic');
    expect(six).toContain('europe');
    expect(six).not.toContain('skirmish');
    expect(six).not.toContain('europe_advanced');
    expect(rotationMaps(9)).not.toContain('classic'); // classic seats 6
    expect(rotationMaps(9).length).toBeGreaterThan(0);
  });

  it('rotates, honours a fixed id and picks randomly from the pool', () => {
    const n = rotationMaps(6).length;
    expect(pickMap('rotate', 6, 0)).toBe(rotationMaps(6)[0]);
    expect(pickMap('rotate', 6, n)).toBe(rotationMaps(6)[0]);
    expect(pickMap('asia', 6, 3)).toBe('asia');
    expect(rotationMaps(6)).toContain(pickMap('random', 6, 0, () => 0.99));
    expect(() => pickMap('narnia' as never, 6, 0)).toThrow();
  });

  it('shuffles without losing seats', () => {
    const seats = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(shuffled(seats, () => 0.3).sort()).toEqual(seats);
    expect(seats).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});
