import { describe, expect, it } from 'vitest';
import { addPlayer, createGame, startGame, viewFor, type GameView } from '@risk/engine';
import { CAPITAL_MAX_TOKENS, Commander, TURN_MAX_TOKENS } from '../src/commander.js';
import { commanderFacts } from '../src/facts.js';
import type { ChatOptions, Llm } from '../src/llm.js';
import { DEFAULT_OPTIONS } from '../src/presets.js';

function makeView(opts: { capitals?: boolean; fog?: boolean } = {}): GameView {
  for (let seed = 9; ; seed++) {
    let s = createGame('TN', { ...DEFAULT_OPTIONS, maxPlayers: 3, map: 'classic', chooseCapitals: opts.capitals ?? false, fogOfWar: opts.fog ?? false }, seed);
    for (const [id, name] of [['a', 'Shen'], ['b', 'Shaco'], ['c', 'Teemo']]) s = addPlayer(s, id, name, true);
    s = startGame(s).state;
    if (s.currentPlayer === 'a') return viewFor(s, 'a');
  }
}

describe('commanderFacts: cheapest bonuses', () => {
  it('lists the three cheapest bonuses with value, missing territories, owners, armies and border points', () => {
    const f = commanderFacts({ ...makeView(), phase: 'reinforce' }, 'a');
    const at = f.indexOf('Cheapest bonuses for you');
    expect(at).toBeGreaterThan(0);
    const block = f.slice(at).split('\n').slice(1, 4);
    expect(block).toHaveLength(3);
    for (const line of block) {
      expect(line).toMatch(/^- .+ \[[a-z_]+\] bonus \d+: you hold \d+\/\d+, missing \d+: .+; \d+ border points?$/);
    }
    // Missing territories carry the owner and the army count when visible.
    expect(block.join('\n')).toMatch(/(Shaco|Teemo) \(\d+\)/);
    // Sorted by how few territories are missing.
    const missing = block.map((l) => Number(/missing (\d+)/.exec(l)![1]));
    expect(missing).toEqual([...missing].sort((a, b) => a - b));
  });

  it('marks hidden territories as unseen under fog and stays within the facts limit', () => {
    const f = commanderFacts({ ...makeView({ fog: true }), phase: 'reinforce' }, 'a');
    expect(f).toContain('Cheapest bonuses for you');
    expect(f).toContain('unseen');
    expect(f.length).toBeLessThanOrEqual(6500);
  });
});

describe('commander turn speed', () => {
  const seen: { opts?: ChatOptions; text: string }[] = [];
  const llm: Llm = {
    async chat(messages, opts) {
      seen.push({ opts, text: messages.map((m) => m.content).join('\n') });
      return JSON.stringify({ winPath: 'bonuses', winPlan: 'Hold Australia, then Asia.', plan: 'Reinforce Siam and take Indonesia.', focus: 'australia', target: 'Shaco', aggression: 0.6, note: 'Shaco is thin in the south.' });
    },
  };
  const make = () => new Commander({ llm, seatName: 'Shen', playerId: 'a', profile: null, learnings: '', gameId: 'G1', scoutingDir: null });

  it('asks for terse JSON with a small token budget (capital pick keeps a larger one)', async () => {
    seen.length = 0;
    const c = make();
    await c.planFor({ ...makeView(), phase: 'reinforce' });
    expect(seen[0].opts).toMatchObject({ maxTokens: TURN_MAX_TOKENS, json: true });
    expect(TURN_MAX_TOKENS).toBeLessThanOrEqual(300);
    expect(seen[0].text).toMatch(/at most 20 words/);
    expect(seen[0].text).toMatch(/at most 15 words/);
    expect(seen[0].text).toMatch(/leave out every optional field/);
    const cap = makeView({ capitals: true });
    await make().chooseCapital(cap);
    expect(seen[1].opts?.maxTokens).toBe(CAPITAL_MAX_TOKENS);
    expect(CAPITAL_MAX_TOKENS).toBeGreaterThan(TURN_MAX_TOKENS);
  });

  it('a terse reply is a fraction of the old 650-token budget (about 4 characters per token)', () => {
    const sample = JSON.stringify({ winPath: 'bonuses', winPlan: 'Hold Australia, then Asia.', plan: 'Reinforce Siam and take Indonesia.', focus: 'australia', target: 'Shaco', aggression: 0.6, note: 'Shaco is thin in the south.' });
    const approxTokens = Math.ceil(sample.length / 4);
    expect(approxTokens).toBeLessThan(TURN_MAX_TOKENS / 2);
  });
});
