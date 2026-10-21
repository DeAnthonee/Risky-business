import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent } from '@risk/selfplay';
import { BRANCH_SCORES, branchAgent, DEFAULT_BRANCH, type BranchOptions, type BranchScore, type RolloutNet } from './branch.js';
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
  if (!(BRANCH_SCORES as readonly string[]).includes(v)) throw new Error(`DELOVE_BRANCH_SCORE must be one of ${BRANCH_SCORES.join(', ')}, not ${v}`);
  return v as BranchScore;
}

/** DELOVE_BRANCH_ROLLOUT: '<model>' or '<model>:all' (every seat), '<model>:self' (the decider's seat); unset: none. */
function rolloutNet(v: string | undefined, models: string, ranker: NetScorer | null): RolloutNet | null {
  if (v === undefined || v === '') return null;
  const [id, seats = 'all'] = v.split(':');
  if (seats !== 'all' && seats !== 'self') throw new Error(`DELOVE_BRANCH_ROLLOUT must be <model>, <model>:all or <model>:self, not ${v}`);
  const path = join(models, `${id}.onnx`);
  if (!existsSync(path)) throw new Error(`DELOVE_BRANCH_ROLLOUT: ${path} not found`);
  return { net: ranker && ranker.modelPath === path ? ranker : new NetScorer(path), seats };
}

/**
 * delove-branch@1 (branch and score, src/branch.ts) configured from the environment, the same way for self-play
 * (register.ts) and real games (seat-cli.ts). DELOVE_BRANCH_TEACHER picks the rollout teacher (default: the newest
 * tuned Sensei; a Jacob Sensei id such as jacob-sensei@1 or jacob-sensei@2 also works), DELOVE_BRANCH_RANKER the network that proposes
 * alternatives (default delove@2); DELOVE_BRANCH_OPTIONS / _ROLLOUTS / _HORIZON / _MARGIN override the search size,
 * DELOVE_BRANCH_VALUE (0-1) blends the ranker's win chance into branch scores, DELOVE_BRANCH_SCORE=points scores
 * rollouts by leaderboard points (placement + kills, branch.ts pointsScore) instead of the share score (=kills: the
 * share score plus a kill credit; =long / mid / close / range: the range specialists' objectives, branch.ts, tuned by
 * DELOVE_BRANCH_KILL_WEIGHT, _THREAT, _CLOSE_ROLLOUTS and _CLOSE_HORIZON), DELOVE_BRANCH_SKIP (comma-separated
 * decision kinds, e.g. occupy,trade) the kinds it plays without branching, DELOVE_STRENGTH=<file> the strength meter's
 * fitted share weights (python/fit_strength.py). `score` replaces DELOVE_BRANCH_SCORE, for the seats
 * delove-branch@1:<score> (branchSeatsFromEnv).
 * DELOVE_BRANCH_ROLLOUT=<model> has that network (e.g. delove@5) play the rollouts in every seat instead of the teacher,
 * <model>:self in the decider's seat only (unset: the teacher).
 */
export function branchFromEnv(dir = modelsDir(), env: NodeJS.ProcessEnv = process.env, score?: BranchScore): Agent {
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
    rolloutNet(env.DELOVE_BRANCH_ROLLOUT, dir, ranker),
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
