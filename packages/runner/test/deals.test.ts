import { describe, expect, it } from 'vitest';
import { addPlayer, applyAction, chooseBotAction, createGame, getMap, startGame, viewFor, type GameView } from '@risk/engine';
import { Commander } from '../src/commander.js';
import { DealLedger, dealPrefixes } from '../src/deals.js';
import { Diplomat, type ChatMsg } from '../src/diplomat.js';
import type { Llm } from '../src/llm.js';
import { DEFAULT_OPTIONS } from '../src/presets.js';
import { choosePlannedAction } from '../src/planned-bot.js';

function makeView(round = 3): GameView {
  for (let seed = 9; ; seed++) {
    let s = createGame('DL', { ...DEFAULT_OPTIONS, maxPlayers: 3, map: 'classic', chooseCapitals: false, fogOfWar: false }, seed);
    for (const [id, name] of [['a', 'Shen'], ['b', 'Lux'], ['c', 'Teemo']]) s = addPlayer(s, id, name, true);
    s = startGame(s).state;
    if (s.currentPlayer === 'a') return { ...viewFor(s, 'a'), round };
  }
}

let nextId = 1;
const msg = (name: string, message: string, extra: Partial<ChatMsg> = {}): ChatMsg => ({ id: nextId++, name, message, at: 0, ...extra });
const ownTerritory = (v: GameView) => Object.entries(v.territories).find(([, s]) => s.owner === 'a')![0];
const llmSays = (reply: unknown): Llm => ({ chat: async () => (typeof reply === 'string' ? reply : JSON.stringify(reply)) });

describe('DealLedger', () => {
  it('records a truce proposal as a readable tag and activates it only on the accept', () => {
    const v = makeView();
    const shen = new DealLedger({ me: 'Shen', idPrefix: 'S' });
    const lux = new DealLedger({ me: 'Lux', idPrefix: 'L' });
    const d = shen.propose({ kind: 'truce', with: 'lux', untilRound: 9 }, v, 'Peace until round 9?')!;
    expect(d).toMatchObject({ id: 'S1', kind: 'truce', parties: ['Shen', 'Lux'], untilRound: 9, status: 'proposed', proposedBy: 'Shen', proposedRound: 3 });
    expect(shen.tag(d)).toBe('[deal S1: truce Shen+Lux until round 9]');
    expect(shen.active()).toHaveLength(0);

    lux.sync(v);
    lux.ingest([msg('Shen', `Peace until round 9? ${shen.tag(d)}`, { to: 'b', toName: 'Lux' })]);
    expect(lux.pendingForMe().map((x) => x.id)).toEqual(['S1']);
    expect(lux.summary()).toContain('OFFER TO YOU from Shen');
    const ans = lux.answer({ dealId: 'S1', answer: 'accept' }, v, 'Agreed')!;
    expect(ans.tags).toEqual(['[accept S1]']);
    expect(lux.active()).toHaveLength(1);

    shen.ingest([msg('Lux', `Agreed ${ans.tags[0]}`)]);
    expect(shen.active().map((x) => x.id)).toEqual(['S1']);
    expect(shen.stats()).toEqual({ made: 1, kept: 0, broken: 0 });
  });

  it('refuses vague or illegal proposals: no end round, bad target, unknown player, territories we do not own', () => {
    const v = makeView();
    const l = new DealLedger({ me: 'Shen', idPrefix: 'S' });
    expect(l.propose({ kind: 'truce', with: 'Lux' }, v, 'x')).toBeNull(); // no round number
    expect(l.propose({ kind: 'truce', with: 'Lux', untilRound: 1 }, v, 'x')).toBeNull(); // already over
    expect(l.propose({ kind: 'truce', with: 'Nobody', untilRound: 9 }, v, 'x')).toBeNull();
    expect(l.propose({ kind: 'truce', with: 'Shen', untilRound: 9 }, v, 'x')).toBeNull();
    expect(l.propose({ kind: 'joint_attack', with: 'Lux', target: 'Lux', startRound: 4 }, v, 'x')).toBeNull();
    expect(l.propose({ kind: 'joint_attack', with: 'Lux', target: 'Teemo', startRound: 4, untilRound: 3 }, v, 'x')).toBeNull();
    expect(l.propose({ kind: 'border', with: 'Lux', untilRound: 9 }, v, 'x')).toBeNull(); // no territories
    const theirs = Object.entries(v.territories).find(([, s]) => s.owner === 'b')![0];
    expect(l.propose({ kind: 'border', with: 'Lux', untilRound: 9, territories: { Shen: [theirs] } }, v, 'x')).toBeNull(); // not ours
    expect(l.all()).toHaveLength(0);
  });

  it('proposes a joint attack and a border with the whole tag, and parses both back', () => {
    const v = makeView();
    const mine = ownTerritory(v);
    const theirs = Object.entries(v.territories).find(([, s]) => s.owner === 'b')![0];
    const shen = new DealLedger({ me: 'Shen', idPrefix: 'S' });
    const lux = new DealLedger({ me: 'Lux', idPrefix: 'L' });
    const ja = shen.propose({ kind: 'joint_attack', with: 'Lux', target: 'Teemo', startRound: 5, untilRound: 8 }, v, 'x')!;
    const border = shen.propose({ kind: 'border', with: 'Lux', untilRound: 12, territories: { Shen: [getMap('classic').territoryById[mine].name], Lux: [theirs] } }, v, 'x')!;
    expect(shen.tag(ja)).toBe('[deal S1: joint_attack Shen+Lux vs Teemo from round 5 until round 8]');
    expect(shen.tag(border)).toBe(`[deal S2: border Shen+Lux until round 12; Shen keeps ${mine}; Lux keeps ${theirs}]`);
    lux.sync(v);
    lux.ingest([msg('Shen', `${shen.tag(ja)} ${shen.tag(border)}`)]);
    expect(lux.get('S1')).toMatchObject({ kind: 'joint_attack', target: 'Teemo', startRound: 5, untilRound: 8, proposedBy: 'Shen' });
    expect(lux.get('S2')).toMatchObject({ kind: 'border', untilRound: 12, territories: { Shen: [mine], Lux: [theirs] } });
  });

  it('ignores accepts from the wrong player, forged tags about others and spectators', () => {
    const v = makeView();
    const shen = new DealLedger({ me: 'Shen', idPrefix: 'S' });
    shen.propose({ kind: 'truce', with: 'Lux', untilRound: 9 }, v, 'x');
    shen.ingest([msg('Teemo', '[accept S1]'), msg('Fan', '[accept S1]', { spectator: true }), msg('Teemo', '[deal T1: truce Lux+Teemo until round 9]')]);
    expect(shen.active()).toHaveLength(0);
    expect(shen.get('T1')).toBeUndefined(); // a deal between two other players is none of our business
    shen.ingest([msg('Lux', '[reject S1]')]);
    expect(shen.get('S1')!.status).toBe('rejected');
  });

  it('a counter rejects the original and offers new terms under a new id', () => {
    const v = makeView();
    const shen = new DealLedger({ me: 'Shen', idPrefix: 'S' });
    const lux = new DealLedger({ me: 'Lux', idPrefix: 'L' });
    const d = shen.propose({ kind: 'truce', with: 'Lux', untilRound: 9 }, v, 'x')!;
    lux.sync(v);
    lux.ingest([msg('Shen', shen.tag(d))]);
    const ans = lux.answer({ dealId: 'S1', answer: 'counter', counter: { kind: 'truce', untilRound: 6 } }, v, 'Shorter')!;
    expect(ans.tags).toEqual(['[reject S1]', '[deal L1: truce Lux+Shen until round 6]']);
    shen.ingest([msg('Lux', ans.tags.join(' '))]);
    expect(shen.get('S1')!.status).toBe('rejected');
    expect(shen.get('L1')).toMatchObject({ status: 'proposed', proposedBy: 'Lux', untilRound: 6 });
  });

  it('expires deals past their round, breaks them when the partner attacks, and counts made/kept/broken', () => {
    const v = makeView(3);
    const shen = new DealLedger({ me: 'Shen', idPrefix: 'S' });
    for (const [kind, until] of [['truce', 5], ['border', 9]] as const) {
      const mine = getMap('classic').territoryById[ownTerritory(v)].name;
      const d = shen.propose({ kind, with: kind === 'truce' ? 'Lux' : 'Teemo', untilRound: until, territories: { Shen: [mine] } }, v, 'x')!;
      shen.ingest([msg(d.parties[1], `ok [accept ${d.id}]`)]);
    }
    expect(shen.active()).toHaveLength(2);
    shen.sync({ ...v, round: 6 });
    expect(shen.get('S1')!.status).toBe('expired'); // kept to its end
    expect(shen.noteHit('Teemo').map((d) => d.id)).toEqual(['S2']);
    expect(shen.get('S2')).toMatchObject({ status: 'broken', brokenBy: 'Teemo' });
    expect(shen.stats()).toEqual({ made: 2, kept: 1, broken: 1 });
    expect(shen.summary()).toContain('BROKEN by Teemo');
    expect(shen.history.join('\n')).toContain('BROKE S2');
  });

  it('gives each seat at the table a distinct id prefix', () => {
    const p = dealPrefixes(['Shen', 'Shaco', 'Lux', 'Teemo']);
    expect(p.get('Lux')).toBe('L');
    expect(p.get('Shen')).not.toBe(p.get('Shaco'));
    expect(new Set(p.values()).size).toBe(4);
  });
});

describe('Diplomat deals', () => {
  const diplomat = (reply: unknown, ledger: DealLedger) => new Diplomat({ llm: llmSays(reply), seatName: 'Shen', playerId: 'a', characterMarkdown: null, cooldownMs: 0, random: () => 0, whisperReplyChance: 0, ledger });

  it('turns the deal fields into a whispered line with a trailing tag', async () => {
    const v = makeView();
    const ledger = new DealLedger({ me: 'Shen', idPrefix: 'S' });
    const d = diplomat({ say: 'Truce until round 9, Lux?', to: null, deal: { kind: 'truce', with: 'Lux', untilRound: 9 } }, ledger);
    const out = await d.onMessages([msg('Lux', 'Shen, talk to me')], v);
    expect(out).toEqual({ message: 'Truce until round 9, Lux? [deal S1: truce Shen+Lux until round 9]', to: 'Lux' });
    expect(ledger.get('S1')!.status).toBe('proposed');
  });

  it('suppresses the whole invalid offer when a deal has no round number', async () => {
    const v = makeView();
    const ledger = new DealLedger({ me: 'Shen', idPrefix: 'S' });
    const out = await diplomat({ say: 'Let us be friends, Lux.', deal: { kind: 'truce', with: 'Lux' } }, ledger).onMessages([msg('Lux', 'Shen, friends?')], v);
    expect(out).toBeNull();
    expect(ledger.all()).toHaveLength(0);
  });

  it('reads an offer from chat, shows it in the prompt, and answers it with an accept tag', async () => {
    const v = makeView();
    const prompts: string[] = [];
    const ledger = new DealLedger({ me: 'Shen', idPrefix: 'S' });
    const llm: Llm = {
      async chat(m) {
        prompts.push(m.map((x) => x.content).join('\n'));
        return JSON.stringify({ say: 'Done, no attacks between us.', respond: { dealId: 'L1', answer: 'accept' } });
      },
    };
    const d = new Diplomat({ llm, seatName: 'Shen', playerId: 'a', characterMarkdown: null, cooldownMs: 0, random: () => 0, whisperReplyChance: 0, ledger });
    const out = await d.onMessages([msg('Lux', 'Shen, truce? [deal L1: truce Lux+Shen until round 8]', { to: 'a', toName: 'Shen' })], v);
    expect(prompts[0]).toContain('L1: OFFER TO YOU from Lux');
    expect(prompts[0]).toContain('Current round: 3');
    expect(prompts[0]).toMatch(/concrete terms/i);
    expect(out).toEqual({ message: 'Done, no attacks between us. [accept L1]', to: 'Lux' });
    expect(ledger.active().map((x) => x.id)).toEqual(['L1']);
  });
});

describe('Commander and deals', () => {
  const commander = (reply: unknown, ledger: DealLedger) => new Commander({ llm: llmSays(reply), seatName: 'Shen', playerId: 'a', profile: null, learnings: '', gameId: 'G1', scoutingDir: null, ledger });
  const activate = (ledger: DealLedger, v: GameView, raw: Record<string, unknown>, partner: string) => {
    const d = ledger.propose(raw, v, 'x')!;
    ledger.ingest([msg(partner, `ok [accept ${d.id}]`)]);
    return d;
  };

  it('an active truce adds the partner to avoid, a border blocks their listed territory, a started joint attack sets the target', async () => {
    const v = makeView(4);
    const theirs = Object.entries(v.territories).find(([, s]) => s.owner === 'b')![0];
    const ledger = new DealLedger({ me: 'Shen', idPrefix: 'S' });
    const c = commander({ plan: 'hold', target: null, avoid: [] }, ledger);
    c.observe(v);
    activate(ledger, v, { kind: 'truce', with: 'Lux', untilRound: 9 }, 'Lux');
    activate(ledger, v, { kind: 'border', with: 'Teemo', untilRound: 9, territories: { Teemo: [Object.entries(v.territories).find(([, s]) => s.owner === 'c')![0]] } }, 'Teemo');
    expect(c.currentPlan()).toMatchObject({ avoid: ['b'], noAttack: [Object.entries(v.territories).find(([, s]) => s.owner === 'c')![0]] });
    activate(ledger, v, { kind: 'joint_attack', with: 'Teemo', target: 'Lux', startRound: 6 }, 'Teemo');
    expect(c.currentPlan()?.target).toBeNull(); // not started
    c.observe({ ...v, round: 6 });
    // The joint target is Lux, whom the truce protects: the target wins, the avoid entry goes.
    expect(c.currentPlan()).toMatchObject({ target: 'b', avoid: [] });
    void theirs;
  });

  it('honours deals even with no plan, and expired deals stop mattering', async () => {
    const v = makeView(4);
    const ledger = new DealLedger({ me: 'Shen', idPrefix: 'S' });
    const c = commander('no json', ledger);
    c.observe(v);
    expect(c.currentPlan()).toBeNull();
    activate(ledger, v, { kind: 'truce', with: 'Lux', untilRound: 5 }, 'Lux');
    expect(c.currentPlan()?.avoid).toEqual(['b']);
    c.observe({ ...v, round: 6 });
    expect(c.currentPlan()).toBeNull();
  });

  it('breakDeals betrays an active deal; an attack by the partner breaks it for the commander too', async () => {
    const v = makeView(4);
    const ledger = new DealLedger({ me: 'Shen', idPrefix: 'S' });
    const c = commander({ plan: 'Betray Lux', breakDeals: ['S1'], note: 'n' }, ledger);
    c.observe(v);
    activate(ledger, v, { kind: 'truce', with: 'Lux', untilRound: 9 }, 'Lux');
    expect(c.currentPlan()?.avoid).toEqual(['b']);
    await c.planFor({ ...v, phase: 'reinforce' });
    expect(ledger.get('S1')).toMatchObject({ status: 'broken', brokenBy: 'Shen' });
    expect(c.currentPlan()?.avoid).toEqual([]);
    expect(c.privateLog().join('\n')).toContain('Broke S1');

    const l2 = new DealLedger({ me: 'Shen', idPrefix: 'S' });
    const c2 = commander({ plan: 'p' }, l2);
    c2.observe(v);
    activate(l2, v, { kind: 'truce', with: 'Lux', untilRound: 9 }, 'Lux');
    const mine = ownTerritory(v);
    c2.observe({ ...v, territories: { ...v.territories, [mine]: { owner: 'b', armies: 3 } } });
    expect(l2.get('S1')).toMatchObject({ status: 'broken', brokenBy: 'Lux' });
    expect(c2.currentPlan()).toBeNull(); // nothing left to honour
  });

  it('shows the ledger and the round in the prompt, and logs deals to the scouting log text', async () => {
    const v = makeView(4);
    const ledger = new DealLedger({ me: 'Shen', idPrefix: 'S' });
    const seen: string[] = [];
    const llm: Llm = { chat: async (m) => (seen.push(m.map((x) => x.content).join('\n')), JSON.stringify({ plan: 'p' })) };
    const c = new Commander({ llm, seatName: 'Shen', playerId: 'a', profile: null, learnings: '', gameId: 'G1', scoutingDir: null, ledger });
    c.observe(v);
    activate(ledger, v, { kind: 'truce', with: 'Lux', untilRound: 9 }, 'Lux');
    await c.planFor({ ...v, phase: 'reinforce' });
    expect(seen[0]).toContain('Current round: 4');
    expect(seen[0]).toContain('S1: ACTIVE truce Shen+Lux until round 9');
    expect(seen[0]).toContain('breakDeals');
    expect(ledger.history.join('\n')).toContain('accepted');
  });
});

describe('noAttack in the move chooser', () => {
  /** A real attack phase for 'a': the engine bot places the reinforcements, so the legal moves include attacks. */
  function attackView(): GameView {
    for (let seed = 9; ; seed++) {
      let s = createGame('NA', { ...DEFAULT_OPTIONS, maxPlayers: 3, map: 'classic', chooseCapitals: false, fogOfWar: false }, seed);
      for (const [id, name] of [['a', 'Shen'], ['b', 'Lux'], ['c', 'Teemo']]) s = addPlayer(s, id, name, true);
      s = startGame(s).state;
      if (s.currentPlayer !== 'a') continue;
      for (let i = 0; i < 50 && s.phase !== 'attack' && s.currentPlayer === 'a'; i++) {
        const a = chooseBotAction(s, 'a', () => 0.5);
        if (!a || a.type === 'attack') break;
        s = applyAction(s, 'a', a).state;
      }
      if (s.phase === 'attack' && s.currentPlayer === 'a') return viewFor(s, 'a');
    }
  }

  it('never attacks a territory on the no-attack list unless it wins the game', () => {
    const v = attackView();
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const hits = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const a = choosePlannedAction(v, 'a', { aggression: 1 }, random, 0);
      if (a?.type === 'attack') hits.add(a.to);
    }
    expect(hits.size).toBeGreaterThan(0);
    const blocked = [...hits];
    for (let i = 0; i < 40; i++) {
      const a = choosePlannedAction(v, 'a', { noAttack: blocked, aggression: 1 }, random, 0);
      if (a?.type === 'attack') expect(blocked).not.toContain(a.to);
    }
  });
});
