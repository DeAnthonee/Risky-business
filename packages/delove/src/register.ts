import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeZergAgent, registerAgent } from '@risk/selfplay';
import { branchStats, writeBranchStats } from './branch.js';
import { branchFromEnv, branchSeatsFromEnv, tunedParams } from './branch-env.js';
import { hordeRolloutPick } from './horde-branch.js';
import { discoverNetAgents, modelsDir } from './net-agent.js';
import { jacob, jacob2, makeJacob } from './jacob.js';
import { makeTeacher, teacher } from './teacher.js';
import { DEFAULT_ZERG_BRANCH, zergBranchAgent } from './zerg-branch.js';

/**
 * Loaded with `node --import` in front of the self-play CLI (`npm run delove -- ...`), so Delove's players can be
 * named in `play` and `ladder` without the self-play package knowing about them: the teacher, every tuned teacher
 * (models/delove/delove-teacher@N.json), the branch-and-score player and every trained version in models/delove
 * (or DELOVE_MODELS). Models load lazily, on a version's first decision.
 */
registerAgent(teacher);
registerAgent(jacob);
registerAgent(jacob2);

// Tuned teachers: models/delove/delove-teacher@N.json holds that version's judgement numbers (src/tune.ts); later
// Jacob Sensei versions (src/jacob.ts) are models/delove/jacob-sensei@N.json, N >= 3 (@1 and @2 are fixed in the code).
const dir = modelsDir();
const tuned = tunedParams(dir);
for (const [id, params] of tuned.sensei) registerAgent(makeTeacher(id, params));
for (const [id, v] of tuned.jacob) if (id !== jacob.id && id !== jacob2.id) registerAgent(makeJacob(id, v.params, v.duel));

/**
 * delove-branch@1: branch and score (src/branch.ts), configured by the DELOVE_BRANCH_* variables (branch-env.ts).
 * With DELOVE_BRANCH_STATS=<dir> each process writes what branching did to <dir>/stats-<pid>-<random>.json when it
 * exits (the random part because Windows reuses process ids, and a later process would overwrite an earlier one's
 * stats). DELOVE_BRANCH_TRACE=<file> traces each branched decision (branch.ts). delove-branch@1:<score> is the same
 * player with that branch score (branch-env.ts branchSeatsFromEnv).
 */
for (const agent of branchSeatsFromEnv(dir)) registerAgent(agent);
// delove-branch@1:range-horde: the range-score branch seat whose rollouts play Zerg seats with the horde bot
// (horde-branch.ts), for the Zerg-horde scenarios (scripts/cycles/horde.jobs).
registerAgent(branchFromEnv(dir, process.env, 'range', { id: 'delove-branch@1:range-horde', rolloutPick: hordeRolloutPick }));
// delove-branch@1:fog: the same seat with fog search on (DELOVE_BRANCH_FOG=determinize, src/fog-sampler.ts), so one
// table can seat it against delove-branch@1's fog fallback.
registerAgent(branchFromEnv(dir, process.env, undefined, { id: 'delove-branch@1:fog', rolloutPick: (pick) => pick }, 'determinize'));
const statsDir = process.env.DELOVE_BRANCH_STATS;
if (statsDir) process.on('exit', () => void (branchStats.decisions > 0 && writeBranchStats(join(statsDir, `stats-${process.pid}-${randomUUID().slice(0, 8)}.json`))));

for (const agent of discoverNetAgents()) registerAgent(agent);

/**
 * zerg-branch@1: the searching Zerg (src/zerg-branch.ts, docs/zergs.md), its prey modelled by Jacob Sensei 2.
 * ZERG_BRANCH_OPTIONS, _ROLLOUTS, _HORIZON, _KILL_WEIGHT, _MARGIN and _SELF_WEIGHT override DEFAULT_ZERG_BRANCH.
 */
const zenv = (k: string, d: number) => (process.env[`ZERG_BRANCH_${k}`] !== undefined ? Number(process.env[`ZERG_BRANCH_${k}`]) : d);
registerAgent(
  zergBranchAgent('zerg-branch@1', jacob2, null, {
    options: zenv('OPTIONS', DEFAULT_ZERG_BRANCH.options),
    rollouts: zenv('ROLLOUTS', DEFAULT_ZERG_BRANCH.rollouts),
    horizon: zenv('HORIZON', DEFAULT_ZERG_BRANCH.horizon),
    killWeight: zenv('KILL_WEIGHT', DEFAULT_ZERG_BRANCH.killWeight),
    margin: zenv('MARGIN', DEFAULT_ZERG_BRANCH.margin),
    selfWeight: zenv('SELF_WEIGHT', DEFAULT_ZERG_BRANCH.selfWeight),
  }),
);

// Tuned Zergs (src/zerg-tune.ts): models/delove/zerg@N.json, N >= 3 (zerg@1, the reference horde, and zerg@2, the live
// seats' version, are fixed in the engine; a file with their name is ignored).
if (existsSync(dir)) {
  for (const f of readdirSync(dir).filter((f) => /^zerg@\d+\.json$/.test(f) && f !== 'zerg@1.json' && f !== 'zerg@2.json')) {
    registerAgent(makeZergAgent(f.slice(0, -'.json'.length), JSON.parse(readFileSync(join(dir, f), 'utf8')).params));
  }
}
