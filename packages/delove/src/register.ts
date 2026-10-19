import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerAgent } from '@risk/selfplay';
import { branchAgent, branchStats, DEFAULT_BRANCH, writeBranchStats } from './branch.js';
import { discoverNetAgents, modelsDir, NetScorer } from './net-agent.js';
import { DEFAULT_TEACHER_PARAMS, makeTeacher, teacher, teacherPickWith, type TeacherParams } from './teacher.js';

/**
 * Loaded with `node --import` in front of the self-play CLI (`npm run delove -- ...`), so Delove's players can be
 * named in `play` and `ladder` without the self-play package knowing about them: the teacher, every tuned teacher
 * (models/delove/delove-teacher@N.json), the branch-and-score player and every trained version in models/delove
 * (or DELOVE_MODELS). Models load lazily, on a version's first decision.
 */
registerAgent(teacher);

// Tuned teachers: models/delove/delove-teacher@N.json holds that version's judgement numbers (src/tune.ts).
const dir = modelsDir();
const tuned = new Map<string, TeacherParams>();
if (existsSync(dir)) {
  const version = (f: string) => Number(/@(\d+)/.exec(f)![1]);
  const files = readdirSync(dir).filter((f) => /^delove-teacher@\d+\.json$/.test(f));
  for (const f of files.sort((a, b) => version(a) - version(b))) {
    const id = f.replace(/\.json$/, '');
    const params: TeacherParams = { ...DEFAULT_TEACHER_PARAMS, ...JSON.parse(readFileSync(join(dir, f), 'utf8')) };
    tuned.set(id, params);
    registerAgent(makeTeacher(id, params));
  }
}

/**
 * delove-branch@1: branch and score (src/branch.ts). DELOVE_BRANCH_TEACHER picks the rollout teacher (default: the
 * newest tuned one), DELOVE_BRANCH_RANKER the network that proposes alternatives (default delove@2);
 * DELOVE_BRANCH_OPTIONS / _ROLLOUTS / _HORIZON / _MARGIN override the search size, DELOVE_BRANCH_VALUE (0-1) blends
 * the ranker's win chance into branch scores, DELOVE_BRANCH_SKIP (comma-separated
 * decision kinds, e.g. occupy,trade) the kinds it plays without branching. With DELOVE_BRANCH_STATS=<dir> each process
 * writes what branching did to <dir>/stats-<pid>.json when it exits.
 */
{
  const teacherId = process.env.DELOVE_BRANCH_TEACHER ?? [...tuned.keys()].pop() ?? 'delove-teacher@1';
  const params = tuned.get(teacherId) ?? DEFAULT_TEACHER_PARAMS;
  const rankerPath = join(dir, `${process.env.DELOVE_BRANCH_RANKER ?? 'delove@2'}.onnx`);
  const ranker = existsSync(rankerPath) ? new NetScorer(rankerPath) : null;
  // DELOVE_BRANCH_VALUE > 0 blends the ranker's win chance into branch scores (needs its .value.onnx).
  const valuePath = rankerPath.slice(0, -'.onnx'.length) + '.value.onnx';
  const valuer = existsSync(rankerPath) && existsSync(valuePath) ? new NetScorer(rankerPath, valuePath) : null;
  const env = (k: string, d: number) => (process.env[k] === undefined ? d : Number(process.env[k]));
  registerAgent(
    branchAgent('delove-branch@1', teacherPickWith(params), ranker, {
      ...DEFAULT_BRANCH,
      options: env('DELOVE_BRANCH_OPTIONS', DEFAULT_BRANCH.options),
      rollouts: env('DELOVE_BRANCH_ROLLOUTS', DEFAULT_BRANCH.rollouts),
      horizon: env('DELOVE_BRANCH_HORIZON', DEFAULT_BRANCH.horizon),
      margin: env('DELOVE_BRANCH_MARGIN', DEFAULT_BRANCH.margin),
      skip: process.env.DELOVE_BRANCH_SKIP === undefined ? DEFAULT_BRANCH.skip : process.env.DELOVE_BRANCH_SKIP.split(',').filter(Boolean),
      valueWeight: env('DELOVE_BRANCH_VALUE', DEFAULT_BRANCH.valueWeight),
      // DELOVE_STRENGTH=<file>: the strength meter's fitted share weights (python/fit_strength.py) for branch scores.
      weights: process.env.DELOVE_STRENGTH ? JSON.parse(readFileSync(process.env.DELOVE_STRENGTH, 'utf8')).weights : DEFAULT_BRANCH.weights,
    }, valuer),
  );
  const statsDir = process.env.DELOVE_BRANCH_STATS;
  if (statsDir) process.on('exit', () => void (branchStats.decisions > 0 && writeBranchStats(join(statsDir, `stats-${process.pid}.json`))));
}

for (const agent of discoverNetAgents()) registerAgent(agent);
