import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { registerAgent } from '@risk/selfplay';
import { branchStats, writeBranchStats } from './branch.js';
import { branchSeatsFromEnv, tunedParams } from './branch-env.js';
import { discoverNetAgents, modelsDir } from './net-agent.js';
import { jacob, jacob2, makeJacob } from './jacob.js';
import { makeTeacher, teacher } from './teacher.js';

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
const statsDir = process.env.DELOVE_BRANCH_STATS;
if (statsDir) process.on('exit', () => void (branchStats.decisions > 0 && writeBranchStats(join(statsDir, `stats-${process.pid}-${randomUUID().slice(0, 8)}.json`))));

for (const agent of discoverNetAgents()) registerAgent(agent);
