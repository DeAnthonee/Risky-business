import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { registerAgent } from '@risk/selfplay';
import { branchAgent, branchStats, DEFAULT_BRANCH, writeBranchStats, type BranchOptions } from './branch.js';
import { discoverNetAgents, modelsDir, NetScorer } from './net-agent.js';
import { DEFAULT_JACOB_PARAMS, jacob, JACOB_SENSEI_1_PARAMS, jacobPickWith, makeJacob, type JacobParams } from './jacob.js';
import { DEFAULT_TEACHER_PARAMS, makeTeacher, teacher, teacherPickWith, type TeacherParams } from './teacher.js';

/**
 * Loaded with `node --import` in front of the self-play CLI (`npm run delove -- ...`), so Delove's players can be
 * named in `play` and `ladder` without the self-play package knowing about them: the teacher, every tuned teacher
 * (models/delove/delove-teacher@N.json), the branch-and-score player and every trained version in models/delove
 * (or DELOVE_MODELS). Models load lazily, on a version's first decision.
 */
registerAgent(teacher);
registerAgent(jacob);

// Tuned teachers: models/delove/delove-teacher@N.json holds that version's judgement numbers (src/tune.ts).
const dir = modelsDir();
const tuned = new Map<string, TeacherParams>();
const jacobTuned = new Map<string, JacobParams>([[jacob.id, JACOB_SENSEI_1_PARAMS]]);
if (existsSync(dir)) {
  const version = (f: string) => Number(/@(\d+)/.exec(f)![1]);
  const files = readdirSync(dir).filter((f) => /^delove-teacher@\d+\.json$/.test(f));
  for (const f of files.sort((a, b) => version(a) - version(b))) {
    const id = f.replace(/\.json$/, '');
    const params: TeacherParams = { ...DEFAULT_TEACHER_PARAMS, ...JSON.parse(readFileSync(join(dir, f), 'utf8')) };
    tuned.set(id, params);
    registerAgent(makeTeacher(id, params));
  }
  // Later Jacob Sensei versions (src/jacob.ts): models/delove/jacob-sensei@N.json, N >= 2 (@1 is fixed in the code).
  const jacobFiles = readdirSync(dir).filter((f) => /^jacob-sensei@\d+\.json$/.test(f) && f !== 'jacob-sensei@1.json');
  for (const f of jacobFiles.sort((a, b) => version(a) - version(b))) {
    const id = f.replace(/\.json$/, '');
    const params: JacobParams = { ...DEFAULT_JACOB_PARAMS, ...JSON.parse(readFileSync(join(dir, f), 'utf8')) };
    jacobTuned.set(id, params);
    registerAgent(makeJacob(id, params));
  }
}

/**
 * delove-branch@1: branch and score (src/branch.ts). DELOVE_BRANCH_TEACHER picks the rollout teacher (default: the
 * newest tuned Sensei; a Jacob Sensei id such as jacob-sensei@1 also works), DELOVE_BRANCH_RANKER the network that proposes alternatives (default delove@2);
 * DELOVE_BRANCH_OPTIONS / _ROLLOUTS / _HORIZON / _MARGIN override the search size, DELOVE_BRANCH_VALUE (0-1) blends
 * the ranker's win chance into branch scores, DELOVE_BRANCH_SCORE=points scores rollouts by leaderboard points
 * (placement + kills, branch.ts pointsScore) instead of the share score (=kills: the share score plus a kill credit),
 * DELOVE_BRANCH_SKIP (comma-separated
 * decision kinds, e.g. occupy,trade) the kinds it plays without branching. With DELOVE_BRANCH_STATS=<dir> each process
 * writes what branching did to <dir>/stats-<pid>-<random>.json when it exits (the random part because Windows reuses
 * process ids, and a later process would overwrite an earlier one's stats).
 */
function branchScore(v: string | undefined): BranchOptions['score'] {
  if (v === undefined || v === '') return DEFAULT_BRANCH.score;
  if (v !== 'share' && v !== 'points' && v !== 'kills') throw new Error(`DELOVE_BRANCH_SCORE must be share, points or kills, not ${v}`);
  return v;
}

{
  const teacherId = process.env.DELOVE_BRANCH_TEACHER ?? [...tuned.keys()].pop() ?? 'delove-teacher@1';
  const jacobParams = jacobTuned.get(teacherId);
  const rolloutPick = jacobParams ? jacobPickWith(jacobParams) : teacherPickWith(tuned.get(teacherId) ?? DEFAULT_TEACHER_PARAMS);
  const rankerPath = join(dir, `${process.env.DELOVE_BRANCH_RANKER ?? 'delove@2'}.onnx`);
  const ranker = existsSync(rankerPath) ? new NetScorer(rankerPath) : null;
  // DELOVE_BRANCH_VALUE > 0 blends the ranker's win chance into branch scores (needs its .value.onnx).
  const valuePath = rankerPath.slice(0, -'.onnx'.length) + '.value.onnx';
  const valuer = existsSync(rankerPath) && existsSync(valuePath) ? new NetScorer(rankerPath, valuePath) : null;
  const env = (k: string, d: number) => (process.env[k] === undefined ? d : Number(process.env[k]));
  registerAgent(
    branchAgent('delove-branch@1', rolloutPick, ranker, {
      ...DEFAULT_BRANCH,
      options: env('DELOVE_BRANCH_OPTIONS', DEFAULT_BRANCH.options),
      rollouts: env('DELOVE_BRANCH_ROLLOUTS', DEFAULT_BRANCH.rollouts),
      horizon: env('DELOVE_BRANCH_HORIZON', DEFAULT_BRANCH.horizon),
      margin: env('DELOVE_BRANCH_MARGIN', DEFAULT_BRANCH.margin),
      skip: process.env.DELOVE_BRANCH_SKIP === undefined ? DEFAULT_BRANCH.skip : process.env.DELOVE_BRANCH_SKIP.split(',').filter(Boolean),
      valueWeight: env('DELOVE_BRANCH_VALUE', DEFAULT_BRANCH.valueWeight),
      score: branchScore(process.env.DELOVE_BRANCH_SCORE),
      // DELOVE_STRENGTH=<file>: the strength meter's fitted share weights (python/fit_strength.py) for branch scores.
      weights: process.env.DELOVE_STRENGTH ? JSON.parse(readFileSync(process.env.DELOVE_STRENGTH, 'utf8')).weights : DEFAULT_BRANCH.weights,
    }, valuer),
  );
  const statsDir = process.env.DELOVE_BRANCH_STATS;
  if (statsDir) process.on('exit', () => void (branchStats.decisions > 0 && writeBranchStats(join(statsDir, `stats-${process.pid}-${randomUUID().slice(0, 8)}.json`))));
}

for (const agent of discoverNetAgents()) registerAgent(agent);
