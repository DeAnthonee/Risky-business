import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent } from '@risk/selfplay';
import { branchAgent, DEFAULT_BRANCH, type BranchOptions } from './branch.js';
import { modelsDir, NetScorer } from './net-agent.js';
import {
  DEFAULT_JACOB_PARAMS,
  jacob,
  jacob2,
  JACOB_SENSEI_1_PARAMS,
  JACOB_SENSEI_2_DUEL_PARAMS,
  JACOB_SENSEI_2_PARAMS,
  jacobPickWith,
  type JacobParams,
} from './jacob.js';
import { DEFAULT_TEACHER_PARAMS, teacherPickWith, type TeacherParams } from './teacher.js';

/** A Jacob Sensei version's numbers, and a staged version's duel numbers (jacobPickWith(params, duel)). */
export interface JacobVersion {
  params: JacobParams;
  duel?: JacobParams;
}

/**
 * The tuned teachers in the models folder, oldest first: models/delove/delove-teacher@N.json (Sensei's judgement
 * numbers, src/tune.ts) and jacob-sensei@N.json for N >= 3 (jacob-sensei@1 and @2 are fixed in the code and always
 * included); a Jacob JSON's optional "duel" object makes that version staged (its numbers once one rival is left).
 */
export function tunedParams(dir = modelsDir()): { sensei: Map<string, TeacherParams>; jacob: Map<string, JacobVersion> } {
  const sensei = new Map<string, TeacherParams>();
  const jacobs = new Map<string, JacobVersion>([
    [jacob.id, { params: JACOB_SENSEI_1_PARAMS }],
    [jacob2.id, { params: JACOB_SENSEI_2_PARAMS, duel: JACOB_SENSEI_2_DUEL_PARAMS }],
  ]);
  if (!existsSync(dir)) return { sensei, jacob: jacobs };
  const version = (f: string) => Number(/@(\d+)/.exec(f)![1]);
  const files = readdirSync(dir);
  for (const f of files.filter((f) => /^delove-teacher@\d+\.json$/.test(f)).sort((a, b) => version(a) - version(b)))
    sensei.set(f.replace(/\.json$/, ''), { ...DEFAULT_TEACHER_PARAMS, ...JSON.parse(readFileSync(join(dir, f), 'utf8')) });
  for (const f of files.filter((f) => /^jacob-sensei@\d+\.json$/.test(f) && !/^jacob-sensei@[12]\.json$/.test(f)).sort((a, b) => version(a) - version(b))) {
    const { duel, ...json } = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    jacobs.set(f.replace(/\.json$/, ''), { params: { ...DEFAULT_JACOB_PARAMS, ...json }, duel: duel ? { ...DEFAULT_JACOB_PARAMS, ...duel } : undefined });
  }
  return { sensei, jacob: jacobs };
}

function branchScore(v: string | undefined): BranchOptions['score'] {
  if (v === undefined || v === '') return DEFAULT_BRANCH.score;
  if (v !== 'share' && v !== 'points' && v !== 'kills') throw new Error(`DELOVE_BRANCH_SCORE must be share, points or kills, not ${v}`);
  return v;
}

/**
 * delove-branch@1 (branch and score, src/branch.ts) configured from the environment, the same way for self-play
 * (register.ts) and real games (seat-cli.ts). DELOVE_BRANCH_TEACHER picks the rollout teacher (default: the newest
 * tuned Sensei; a Jacob Sensei id such as jacob-sensei@1 or jacob-sensei@2 also works), DELOVE_BRANCH_RANKER the network that proposes
 * alternatives (default delove@2); DELOVE_BRANCH_OPTIONS / _ROLLOUTS / _HORIZON / _MARGIN override the search size,
 * DELOVE_BRANCH_VALUE (0-1) blends the ranker's win chance into branch scores, DELOVE_BRANCH_SCORE=points scores
 * rollouts by leaderboard points (placement + kills, branch.ts pointsScore) instead of the share score (=kills: the
 * share score plus a kill credit), DELOVE_BRANCH_SKIP (comma-separated decision kinds, e.g. occupy,trade) the kinds it
 * plays without branching, DELOVE_STRENGTH=<file> the strength meter's fitted share weights (python/fit_strength.py).
 */
export function branchFromEnv(dir = modelsDir(), env: NodeJS.ProcessEnv = process.env): Agent {
  const tuned = tunedParams(dir);
  const teacherId = env.DELOVE_BRANCH_TEACHER ?? [...tuned.sensei.keys()].pop() ?? 'delove-teacher@1';
  const jacobParams = tuned.jacob.get(teacherId);
  const rolloutPick = jacobParams ? jacobPickWith(jacobParams.params, jacobParams.duel) : teacherPickWith(tuned.sensei.get(teacherId) ?? DEFAULT_TEACHER_PARAMS);
  const rankerPath = join(dir, `${env.DELOVE_BRANCH_RANKER ?? 'delove@2'}.onnx`);
  const ranker = existsSync(rankerPath) ? new NetScorer(rankerPath) : null;
  // DELOVE_BRANCH_VALUE > 0 blends the ranker's win chance into branch scores (needs its .value.onnx).
  const valuePath = rankerPath.slice(0, -'.onnx'.length) + '.value.onnx';
  const valuer = existsSync(rankerPath) && existsSync(valuePath) ? new NetScorer(rankerPath, valuePath) : null;
  const num = (k: string, d: number) => (env[k] === undefined ? d : Number(env[k]));
  return branchAgent(
    'delove-branch@1',
    rolloutPick,
    ranker,
    {
      ...DEFAULT_BRANCH,
      options: num('DELOVE_BRANCH_OPTIONS', DEFAULT_BRANCH.options),
      rollouts: num('DELOVE_BRANCH_ROLLOUTS', DEFAULT_BRANCH.rollouts),
      horizon: num('DELOVE_BRANCH_HORIZON', DEFAULT_BRANCH.horizon),
      margin: num('DELOVE_BRANCH_MARGIN', DEFAULT_BRANCH.margin),
      skip: env.DELOVE_BRANCH_SKIP === undefined ? DEFAULT_BRANCH.skip : env.DELOVE_BRANCH_SKIP.split(',').filter(Boolean),
      valueWeight: num('DELOVE_BRANCH_VALUE', DEFAULT_BRANCH.valueWeight),
      score: branchScore(env.DELOVE_BRANCH_SCORE),
      weights: env.DELOVE_STRENGTH ? JSON.parse(readFileSync(env.DELOVE_STRENGTH, 'utf8')).weights : DEFAULT_BRANCH.weights,
    },
    valuer,
  );
}
