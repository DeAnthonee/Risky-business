import { describe, expect, it } from 'vitest';
import { addPlayer, applyAction, createGame, exponentialTradeBonus, nextTradeValue, parseOptions, setValue, startGame, viewFor, type Card, type GameState } from '../src/index.js';

function game(mode: 'fixed' | 'progressive' | 'exponential' = 'exponential') {
  let s = createGame('EXP', { maxPlayers: 3, autoSetup: true, capitals: false, cardValues: mode }, 9);
  for (const id of ['a', 'b', 'c']) s = addPlayer(s, id, id, true);
  return startGame(s).state;
}
function hand(): Card[] {
  return [1000, 1001, 1002].map(id => ({ id, kind: 'infantry', territory: null }));
}
function trade(s: GameState, who: string) {
  s.currentPlayer = who; s.phase = 'reinforce';
  s.players.find(p => p.id === who)!.cards = hand();
  return applyAction(s, who, { type: 'trade', cardIds: hand().map(c => c.id) });
}

describe('per-player exponential cards', () => {
  it('uses exact round-up growth and switches to flat 1000 after the 25th trade', () => {
    expect(Array.from({ length: 10 }, (_, i) => exponentialTradeBonus(i))).toEqual([5, 7, 10, 13, 17, 23, 30, 39, 51, 67]);
    expect(exponentialTradeBonus(24)).toBe(3529);
    expect(exponentialTradeBonus(25)).toBe(4529);
    expect(exponentialTradeBonus(26)).toBe(5529);
    expect(exponentialTradeBonus(100000)).toBe(3529 + (100000 - 24) * 1000);
  });

  it('keeps two interleaved players on independent sequences', () => {
    let s = game();
    const payouts: number[] = [];
    for (const who of ['a', 'a', 'b', 'a', 'b']) {
      const result = trade(s, who);
      s = result.state;
      payouts.push(result.events.find(e => e.type === 'traded')!.armies);
    }
    expect(payouts).toEqual([5, 7, 5, 10, 7]);
    expect(s.tradeCount).toBe(5);
    expect(s.players.find(p => p.id === 'a')!.tradesMade).toBe(3);
    expect(s.players.find(p => p.id === 'b')!.tradesMade).toBe(2);
    expect(s.players.find(p => p.id === 'c')!.tradesMade ?? 0).toBe(0);
    const restored = JSON.parse(JSON.stringify(s)) as GameState;
    expect(trade(restored, 'a').events.find(e => e.type === 'traded')!.armies).toBe(13);
  });

  it('uses the recipient progression for forced mid-attack trades and defaults legacy players to zero', () => {
    const s = game();
    s.currentPlayer = 'a'; s.phase = 'attack'; s.tradeCount = 100;
    const p = s.players.find(p => p.id === 'a')!;
    p.tradesMade = 6;
    p.cards = [...hand(), { id: 1003, kind: 'cavalry', territory: null }, { id: 1004, kind: 'artillery', territory: null }];
    const result = applyAction(s, 'a', { type: 'trade', cardIds: [1000, 1001, 1002] });
    expect(result.events.find(e => e.type === 'traded')!.armies).toBe(30);
    expect(result.state.players.find(p => p.id === 'a')!.tradesMade).toBe(7);
    const legacy = game(); delete legacy.players[0].tradesMade;
    expect(trade(legacy, legacy.players[0].id).events.find(e => e.type === 'traded')!.armies).toBe(5);
  });

  it('exposes personal counters without exposing enemy hands under fog', () => {
    const s = game();
    s.options.fogOfWar = true;
    s.players.find(p => p.id === 'b')!.tradesMade = 8;
    s.players.find(p => p.id === 'b')!.cards = hand();
    const enemy = viewFor(s, 'a').players.find(p => p.id === 'b')!;
    expect(enemy.tradesMade).toBe(8);
    expect(enemy.cards).toBeNull();
    expect(nextTradeValue('exponential', s.tradeCount, enemy.tradesMade)).toBe(51);
  });

  it('accepts the new option while preserving existing card values', () => {
    expect(parseOptions({ cardValues: 'exponential' })).toEqual({ cardValues: 'exponential' });
    expect(setValue(hand(), 'fixed', 100, 24)).toBe(4);
    expect(setValue(hand(), 'progressive', 2, 24)).toBe(8);
    expect(setValue(hand(), 'exponential', 100, 0)).toBe(5);
    expect(trade(game('fixed'), 'a').events.find(e => e.type === 'traded')!.armies).toBe(4);
    expect(trade(game('progressive'), 'a').events.find(e => e.type === 'traded')!.armies).toBe(4);
  });
});
