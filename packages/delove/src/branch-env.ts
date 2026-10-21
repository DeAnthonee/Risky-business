import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent } from '@risk/selfplay';
import { BRANCH_SCORES, branchAgent, DEFAULT_BRANCH, type BranchOptions, type BranchScore } from './branch.js';
import { modelsDir, NetScorer } from './net-agent.js';
import { DEFAULT_JACOB_PARAMS, jacob, JACOB_SENSEI_1_PARAMS, jacobPickWith, type JacobParams } from './jacob.js';
import { DEFAULT_TEACHER_PARAMS, teacherPickWith, type TeacherParams } from './teacher.js';

/**
 * The tuned teachers in the models folder, oldest first: models/delove/delove-teacher@N.json (Sensei's judgement
 * numbers, src/tune.ts) and jacob-sensei@N.json for N >= 2 (jacob-sensei@1 is fixed in the code and always included).
 */
export function tunedParams(dir = modelsDir()): { sensei: Map<string, TeacherParams>; jacob: Map<string, JacobParams> } {
  const sensei = new Map<string, TeacherParams>();
  const jacobs = new Map<string, JacobParams>([[jacob.id, JACOB_SENSEI_1_PARAMS]]);
  if (!existsSync(dir)) return { sensei, jacob: jacobs };
  const version = (f: string) => Number(/@(\d+)/.exec(f)![1]);
  const files = readdirSync(dir);
  for (const f of files.filter((f) => /^delove-teacher@\d+\.json$/.test(f)).sort((a, b) => version(a) - version(b)))
    sensei.set(f.replace(/\.json$/, ''), { ...DEFAULT_TEACHER_PARAMS, ...JSON.parse(readFileSync(join(dir, f), 'utf8')) });
  for (const f of files.filter((f) => /^jacob-sensei@\d+\.json$/.test(f) && f !== 'jacob-sensei@1.json').sort((a, b) => version(a) - version(b)))
    jacobs.set(f.replace(/\.json$/, ''), { ...DEFAULT_JACOB_PARAMS, ...JSON.parse(readFileSync(join(dir, f), 'utf8')) });
  return { sensei, jacob: jacobs };
}

function branchScore(v: string | undefined): BranchOptions['score'] {
  if (v === undefined || v === '') return DEFAULT_BRANCH.score;
  if (!(BRANCH_SCORES as readonly string[]).includes(v)) throw new Error(`DELOVE_BRANCH_SCORE must be one of ${BRANCH_SCORES.join(', ')}, not ${v}`);
  return v as BranchScore;
}

/**
 * delove-branch@1 (branch and score, src/branch.ts) configured from the environment, the same way for self-play
 * (register.ts) and real games (seat-cli.ts). DELOVE_BRANCH_TEACHER picks the rollout teacher (default: the newest
 * tuned Sensei; a Jacob Sensei id such as jacob-sensei@1 also works), DELOVE_BRANCH_RANKER the network that proposes
 * alternatives (default delove@2); DELOVE_BRANCH_OPTIONS / _ROLLOUTS / _HORIZON / _MARGIN override the search size,
 * DELOVE_BRANCH_VALUE (0-1) blends the ranker's win chance into branch scores, DELOVE_BRANCH_SCORE=points scores
 * rollouts by leaderboard points (placement + kills, branch.ts pointsScore) instead of the share score (=kills: the
 * share score plus a kill credit; =long / mid / close / range: the range specialists' objectives, branch.ts, tuned by
 * DELOVE_BRANCH_KILL_WEIGHT, _THREAT, _CLOSE_ROLLOUTS and _CLOSE_HORIZON), DELOVE_BRANCH_SKIP (comma-separated
 * decision kinds, e.g. occupy,trade) the kinds it plays without branching, DELOVE_STRENGTH=<file> the strength meter's
 * fitted share weights (python/fit_strength.py). `score` replaces DELOVE_BRANCH_SCORE, for the seats
 * delove-branch@1:<score> (branchSeatsFromEnv).
 */
export function branchFromEnv(dir = modelsDir(), env: NodeJS.ProcessEnv = process.env, score?: BranchScore): Agent {
  const tuned = tunedParams(dir);
  const teacherId = env.DELOVE_BRANCH_TEACHER ?? [...tuned.sensei.keys()].pop() ?? 'delove-teacher@1';
  const jacobParams = tuned.jacob.get(teacherId);
  const rolloutPick = jacobParams ? jacobPickWith(jacobParams) : teacherPickWith(tuned.sensei.get(teacherId) ?? DEFAULT_TEACHER_PARAMS);
  const rankerPath = join(dir, `${env.DELOVE_BRANCH_RANKER ?? 'delove@2'}.onnx`);
  const ranker = existsSync(rankerPath) ? new NetScorer(rankerPath) : null;
  // DELOVE_BRANCH_VALUE > 0 blends the ranker's win chance into branch scores (needs its .value.onnx).
  const valuePath = rankerPath.slice(0, -'.onnx'.length) + '.value.onnx';
  const valuer = existsSync(rankerPath) && existsSync(valuePath) ? new NetScorer(rankerPath, valuePath) : null;
  const num = (k: string, d: number) => (env[k] === undefined ? d : Number(env[k]));
  return branchAgent(
    score === undefined ? 'delove-branch@1' : `delove-branch@1:${score}`,
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
      score: score ?? branchScore(env.DELOVE_BRANCH_SCORE),
      killWeight: num('DELOVE_BRANCH_KILL_WEIGHT', DEFAULT_BRANCH.killWeight),
      threat: num('DELOVE_BRANCH_THREAT', DEFAULT_BRANCH.threat),
      closeRollouts: num('DELOVE_BRANCH_CLOSE_ROLLOUTS', DEFAULT_BRANCH.closeRollouts),
      closeHorizon: num('DELOVE_BRANCH_CLOSE_HORIZON', DEFAULT_BRANCH.closeHorizon),
      weights: env.DELOVE_STRENGTH ? JSON.parse(readFileSync(env.DELOVE_STRENGTH, 'utf8')).weights : DEFAULT_BRANCH.weights,
    },
    valuer,
  );
}

/**
 * delove-branch@1 and the same player with each branch score of its own, delove-branch@1:<score> (any of
 * BRANCH_SCORES), so one table (a jobs line) can seat a score of its own, or several side by side; delove_gpu.generate
 * takes the same ids.
 */
export function branchSeatsFromEnv(dir = modelsDir(), env: NodeJS.ProcessEnv = process.env): Agent[] {
  return [branchFromEnv(dir, env), ...BRANCH_SCORES.map((score) => branchFromEnv(dir, env, score))];
}
