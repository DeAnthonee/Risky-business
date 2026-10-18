import { describe, it } from 'vitest';
import { playHeadless, type SeatKind } from './headless.js';

/** Opt-in strength check (RUNNER_COMPARE=<games>): planned bot (3 seats) vs the engine bot (3 seats), six players, default options. */
const games = Number(process.env.RUNNER_COMPARE ?? 0);
/** RUNNER_COMPARE_GARRISON=30 makes every planned seat ask for a big capital garrison (what froze the live game). */
const garrison = Number(process.env.RUNNER_COMPARE_GARRISON ?? 0);

describe.skipIf(!games)('planned bot vs engine bot', () => {
  it('reports win rate and turn-limit hits', () => {
    const maps = ['classic', 'europe'] as const;
    let planned = 0;
    let engine = 0;
    let undecided = 0;
    let turns = 0;
    for (let g = 0; g < games; g++) {
      const first = g % 2;
      const seats: SeatKind[] = Array.from({ length: 6 }, (_, i) => ((i + first) % 2 === 0 ? 'planned' : 'engine'));
      const r = playHeadless({ seed: 1000 + g, map: maps[Math.floor(g / 2) % 2], seats, maxTurns: 1500, plan: garrison ? () => ({ capitalGarrison: garrison }) : undefined });
      turns += r.turns;
      if (r.winner === null) undecided++;
      else if (seats[r.winner] === 'planned') planned++;
      else engine++;
    }
    console.log(`COMPARE games=${games} planned=${planned} engine=${engine} undecided=${undecided} avgTurns=${(turns / games).toFixed(0)}`);
  }, 3_600_000);
});
