import { describe, expect, it } from 'vitest';
import {
  addPlayer,
  applyAction,
  assembleRecord,
  boardOf,
  chooseBotAction,
  createGame,
  createRng,
  nextFloat,
  observeStep,
  recordHeader,
  recordStep,
  recordTurnStart,
  stateAtStep,
  startGame,
  verifyRecord,
  type GameRecord,
  type GameState,
  type RecordEntry,
} from '../src/index.js';

/** A bot game played to the end (or maxSteps), recorded the way the server records it. */
function recordedGame(options: { fogOfWar: boolean }, maxSteps = 6000): { record: GameRecord; final: GameState } {
  let s = createGame('REC', options, 7);
  s = addPlayer(s, 'a', 'Alice', true);
  s = addPlayer(s, 'b', 'Bob', true);
  s = addPlayer(s, 'c', 'Cleo', true);
  const started = startGame(s);
  s = started.state;
  const header = recordHeader('REC-1', { id: 'REC', name: 'Recorded' }, s, started.events, { a: 'test/alice' });
  const entries: RecordEntry[] = [];
  const first = recordTurnStart(header, s, started.events, 0);
  if (first) entries.push(first);
  const rng = createRng(3);
  const random = () => nextFloat(rng);
  for (let n = 0; s.phase !== 'finished' && n < maxSteps; n++) {
    const player = s.currentPlayer!;
    const action = chooseBotAction(s, player, random)!;
    const { state, events } = applyAction(s, player, action);
    entries.push(recordStep(header, s, player, action, events, n));
    const turn = recordTurnStart(header, state, events, n);
    if (turn) entries.push(turn);
    s = state;
  }
  // Through JSON, as it is stored on disk.
  return { record: JSON.parse(JSON.stringify(assembleRecord(header, entries, s, 1))), final: s };
}

describe('game records', () => {
  const fog = recordedGame({ fogOfWar: true });
  const open = recordedGame({ fogOfWar: false }, 300);

  it('records who did what, turn by turn, and how the game ended', () => {
    const { record, final } = fog;
    expect(record.format).toBe('risky-game-record');
    expect(record.players.map((p) => p.name)).toEqual(['Alice', 'Bob', 'Cleo']);
    expect(record.players[0].characterId).toBe('test/alice');
    expect(record.steps.length).toBeGreaterThan(50);
    expect(record.steps.every((s, i) => s.i === i && s.player && s.action && Array.isArray(s.board))).toBe(true);
    expect(record.turns.length).toBeGreaterThan(3);
    for (const t of record.turns.filter((t) => t.firstStep >= 0)) {
      expect(record.steps[t.firstStep].player).toBe(t.player);
      expect(record.steps[t.lastStep].turn).toBe(t.turn);
    }
    expect(final.phase).toBe('finished');
    expect(record.outcome.finished).toBe(true);
    expect(record.outcome.winner).toBe(final.winner);
    expect(record.outcome.placings[0]).toBe(final.winner);
    expect(record.outcome.eliminations).toHaveLength(2);
    expect(record.outcome.eliminations.every((e) => record.steps[e.step].events.some((ev) => ev.type === 'eliminated'))).toBe(true);
    expect(record.outcome.placings).toHaveLength(3);
    expect(record.outcome.board).toEqual(boardOf(final, record));
  });

  it('replays exactly: every step rebuilds the board it recorded', () => {
    expect(verifyRecord(fog.record)).toBeNull();
    expect(verifyRecord(open.record)).toBeNull();
    const mid = Math.floor(fog.record.steps.length / 2);
    expect(boardOf(stateAtStep(fog.record, mid), fog.record)).toEqual(fog.record.steps[mid].board);
    expect(stateAtStep(fog.record, fog.record.steps.length).territories).toEqual(fog.final.territories);
  });

  it('notices a record that does not replay', () => {
    const bad: GameRecord = structuredClone(fog.record);
    bad.steps[10].board[0] = [bad.steps[10].board[0][0], bad.steps[10].board[0][1] + 5];
    expect(verifyRecord(bad)).toEqual({ step: 10, reason: 'board before the step differs' });
  });

  it('keeps what each player saw under fog next to the true board', () => {
    const { record } = fog;
    const step = record.steps.find((s) => s.phase === 'attack')!;
    expect(step.seen).toHaveLength(record.territories.length);
    const me = record.players.find((p) => p.id === step.player)!.index;
    let hidden = 0;
    step.seen!.forEach((cell, i) => {
      if (cell === null) hidden++;
      else expect(cell).toEqual(step.board[i]);
      // A player always sees their own territories.
      if (step.board[i][0] === me) expect(cell).not.toBeNull();
    });
    expect(hidden).toBeGreaterThan(0);
    const turn = record.turns.find((t) => t.turn > 2)!;
    expect(Object.keys(turn.seen!).length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(turn.seen!).every((id) => record.players.some((p) => p.id === id && !p.isNeutral))).toBe(true);
    expect(Object.values(turn.seen!).some((b) => b.some((c) => c === null))).toBe(true);
  });

  it('leaves fog views out when fog of war is off', () => {
    expect(open.record.fog).toBe(false);
    expect(open.record.steps.every((s) => s.seen === undefined)).toBe(true);
    expect(open.record.turns.every((t) => t.seen === undefined)).toBe(true);
  });

  it('shows any moment through one player\'s eyes', () => {
    const { record } = fog;
    const step = record.steps.find((s) => s.phase === 'attack')!;
    const { view } = observeStep(record, step.i, step.player);
    expect(view.you).toBe(step.player);
    expect(view.legal).not.toBeNull();
    record.territories.forEach((t, i) => expect(!!view.territories[t].hidden).toBe(step.seen![i] === null));
    const spectator = observeStep(record, step.i, null);
    expect(Object.values(spectator.view.territories).some((t) => t.hidden)).toBe(false);
    expect(spectator.events).toEqual(step.events);
  });
});
