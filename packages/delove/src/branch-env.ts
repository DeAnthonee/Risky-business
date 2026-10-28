import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stepAgent, type Agent, type StepContext } from '@risk/selfplay';
import { BRANCH_SCORES, branchAgent, DEFAULT_BRANCH, type BranchOptions, type BranchScore, type FogSearch, type RolloutNet } from './branch.js';
import { FogGuesser, type FogGuess } from './fog-guesser.js';
import { FogTracker, sampleBoard } from './fog-sampler.js';
import { modelsDir, NetScorer, setScorer } from './net-agent.js';
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
import { parseStyles, styleParams } from './styles.js';
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

function branchRoot(v: string | undefined): BranchOptions['root'] {
  if (v === undefined || v === '') return DEFAULT_BRANCH.root;
  if (v !== 'top' && v !== 'gumbel') throw new Error(`DELOVE_BRANCH_ROOT must be top or gumbel, not ${v}`);
  return v;
}

/** DELOVE_BRANCH_INCUMBENT: 'teacher' (default) or 'net' (BranchOptions.incumbent). */
function branchIncumbent(v: string | undefined): BranchOptions['incumbent'] {
  if (v === undefined || v === '') return DEFAULT_BRANCH.incumbent;
  if (v !== 'teacher' && v !== 'net') throw new Error(`DELOVE_BRANCH_INCUMBENT must be teacher or net, not ${v}`);
  return v;
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

/** How branch and score plays fog games: 'off' (fogSafe: the ranker's top move) or 'determinize' (FogSearch). */
export const BRANCH_FOG_MODES = ['off', 'determinize'] as const;
export type BranchFogMode = (typeof BRANCH_FOG_MODES)[number];

function branchFog(v: string | undefined): BranchFogMode {
  if (v === undefined || v === '') return 'off';
  if (!(BRANCH_FOG_MODES as readonly string[]).includes(v)) throw new Error(`DELOVE_BRANCH_FOG must be one of ${BRANCH_FOG_MODES.join(', ')}, not ${v}`);
  return v as BranchFogMode;
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
 * DELOVE_BRANCH_ROOT=gumbel searches a Gumbel root instead of the top options (branch.ts gumbelRoot): DELOVE_BRANCH_K
 * candidates (default 8) within DELOVE_BRANCH_COPIES rollout copies (default 0: options x rollouts).
 * DELOVE_BRANCH_ROLLOUT=<model> has that network (e.g. delove@5) play the rollouts in every seat instead of the teacher,
 * <model>:self in the decider's seat only (unset: the teacher).
 * DELOVE_BRANCH_FOG=determinize searches fog games too, on boards sampled from the seat's view and memory
 * (fogSearch, src/fog-sampler.ts; DELOVE_BRANCH_FOG_SAMPLES boards per option, default 8); unset or `off`: fogSafe's
 * fallback. `fog` replaces DELOVE_BRANCH_FOG. DELOVE_FOG_MODEL=<id> has the sampler draw hidden owners and armies from the
 * learned fog guesser models/<id>.onnx, or the .onnx file it names (fog-guesser.ts, python/fog_guess.py).
 */
export function branchFromEnv(
  dir = modelsDir(),
  env: NodeJS.ProcessEnv = process.env,
  score?: BranchScore,
  /** Wraps the rollout teacher's pick (e.g. horde-branch.ts: Zerg seats play the horde bot) for a seat with its own id. */
  variant?: { id: string; rolloutPick: (pick: (ctx: StepContext) => number) => (ctx: StepContext) => number },
  fog?: BranchFogMode,
): Agent {
  const tuned = tunedParams(dir);
  const teacherId = env.DELOVE_BRANCH_TEACHER ?? [...tuned.sensei.keys()].pop() ?? 'delove-teacher@1';
  const jacobParams = tuned.jacob.get(teacherId);
  const teacherPick = jacobParams ? jacobPickWith(jacobParams.params, jacobParams.duel) : teacherPickWith(tuned.sensei.get(teacherId) ?? DEFAULT_TEACHER_PARAMS);
  // T2 opponent styles: the rollout teacher with each style's multipliers (styles.ts)
  const styleMix = parseStyles(env.DELOVE_BRANCH_STYLES);
  const stylePicks = styleMix
    ? Object.fromEntries(
        styleMix.names
          .filter((n) => n !== 'net')
          .map((n) => [
            n,
            jacobParams
              ? jacobPickWith(styleParams(jacobParams.params, n), jacobParams.duel && styleParams(jacobParams.duel, n))
              : teacherPickWith(styleParams(tuned.sensei.get(teacherId) ?? DEFAULT_TEACHER_PARAMS, n)),
          ]),
      )
    : null;
  const rolloutPick = variant ? variant.rolloutPick(teacherPick) : teacherPick;
  const rankerPath = join(dir, `${env.DELOVE_BRANCH_RANKER ?? 'delove@2'}.onnx`);
  const ranker = existsSync(rankerPath) ? new NetScorer(rankerPath) : null;
  // DELOVE_BRANCH_VALUE > 0 blends the ranker's win chance into branch scores (needs its .value.onnx).
  const valuePath = rankerPath.slice(0, -'.onnx'.length) + '.value.onnx';
  const valuer = existsSync(rankerPath) && existsSync(valuePath) ? new NetScorer(rankerPath, valuePath) : null;
  const num = (k: string, d: number) => (env[k] === undefined ? d : Number(env[k]));
  const fogMode = fog ?? branchFog(env.DELOVE_BRANCH_FOG);
  const tracker = new FogTracker();
  // DELOVE_FOG_MODEL=<id>: the learned fog guesser models/<id>.onnx (fog-guesser.ts), one guess per decision shared by
  // all its sampled boards
  const fogModel = env.DELOVE_FOG_MODEL;
  const guesser = fogMode === 'determinize' && fogModel ? new FogGuesser(fogModel.endsWith('.onnx') ? fogModel : join(dir, `${fogModel}.onnx`)) : null;
  const guesses = new WeakMap<object, FogGuess>();
  const guessFor = (state: Parameters<FogGuesser['guess']>[0], me: string): FogGuess | undefined => {
    if (!guesser) return undefined;
    let g = guesses.get(state);
    if (!g) guesses.set(state, (g = guesser.guess(state, me, tracker.observe(state, me))));
    return g;
  };
  const fogSearch: FogSearch | null =
    fogMode === 'determinize'
      ? {
          anchor: rankerTop(ranker, rolloutPick),
          sample: (state, me, random) => sampleBoard(state, me, random, tracker.observe(state, me), undefined, guessFor(state, me)),
          samples: num('DELOVE_BRANCH_FOG_SAMPLES', 8),
        }
      : null;
  const opts: BranchOptions = {
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
    root: branchRoot(env.DELOVE_BRANCH_ROOT),
    gumbelK: num('DELOVE_BRANCH_K', DEFAULT_BRANCH.gumbelK),
    copies: num('DELOVE_BRANCH_COPIES', DEFAULT_BRANCH.copies),
    incumbent: branchIncumbent(env.DELOVE_BRANCH_INCUMBENT),
    styles: env.DELOVE_BRANCH_STYLES ?? DEFAULT_BRANCH.styles,
    weights: env.DELOVE_STRENGTH ? JSON.parse(readFileSync(env.DELOVE_STRENGTH, 'utf8')).weights : DEFAULT_BRANCH.weights,
  };
  const search = branchAgent(
    variant?.id ?? (score === undefined ? 'delove-branch@1' : `delove-branch@1:${score}`),
    rolloutPick,
    ranker,
    opts,
    valuer,
    rolloutNet(env.DELOVE_BRANCH_ROLLOUT, dir, ranker),
    fogSearch,
    stylePicks,
  );
  // Fog search: remember what each fog decision shows (the sampler reads it), then search.
  const agent: Agent = !fogSearch
    ? fogSafe(search, ranker, rolloutPick)
    : {
        ...search,
        choose: (ctx) => {
          if (ctx.state.options.fogOfWar) tracker.observe(ctx.state, ctx.me);
          return search.choose(ctx);
        },
        ...(ranker?.fogInputs ? { fogInputs: ranker.fogInputs } : {}),
      };
  if (ranker) setScorer(agent, ranker);
  searches.set(agent, opts);
  return agent;
}

/** A search seat's settings, for its decision notes (notes.ts): options, margin, rollouts (decisionScore). */
const searches = new WeakMap<Agent, BranchOptions>();
export function searchOf(agent: Agent): BranchOptions | undefined {
  return searches.get(agent);
}

/** The ranker's top move (ties: the first candidate), or the teacher's pick without a ranker or with one candidate. */
function rankerTop(ranker: NetScorer | null, teacherPick: (ctx: StepContext) => number): (ctx: StepContext) => number {
  return (ctx) => {
    if (ctx.candidates.length === 1 || !ranker) return teacherPick(ctx);
    const { logits } = ranker.score(ctx);
    let best = 0;
    for (let i = 1; i < logits.length; i++) if (logits[i] > logits[best]) best = i;
    return best;
  };
}

/**
 * Branch and score without fog search (DELOVE_BRANCH_FOG unset or `off`) never searches under fog of war: its
 * rollouts would play out a rebuilt board whose hidden territories are blank. In a fog game it plays its ranker's top
 * move on the seat view instead (the rollout teacher's pick without a ranker), and it takes fog seats only when the
 * ranker was trained for fog (its `fogInputs`).
 */
export function fogSafe(search: Agent, ranker: NetScorer | null, teacherPick: (ctx: StepContext) => number): Agent {
  const bare = stepAgent(search.id, rankerTop(ranker, teacherPick));
  return {
    ...search,
    choose: (ctx) => (ctx.state.options.fogOfWar ? bare.choose(ctx) : search.choose(ctx)),
    ...(ranker?.fogInputs ? { fogInputs: ranker.fogInputs } : {}),
  };
}

/**
 * delove-branch@1 and the same player with each branch score of its own, delove-branch@1:<score> (any of
 * BRANCH_SCORES), so one table (a jobs line) can seat a score of its own, or several side by side; and each of those
 * with the Gumbel root, delove-branch@1:gumbel and delove-branch@1:<score>:gumbel. delove_gpu.generate takes the same
 * ids.
 */
export function branchSeatsFromEnv(dir = modelsDir(), env: NodeJS.ProcessEnv = process.env): Agent[] {
  // ...:gumbel: the same seat with the Gumbel root (branch.ts gumbelRoot), e.g. on a cycle's 2p and stage tables only;
  // the value blend is off for them (the Gumbel root does not support it)
  const g = { ...env, DELOVE_BRANCH_ROOT: 'gumbel', DELOVE_BRANCH_VALUE: '0', DELOVE_BRANCH_INCUMBENT: 'teacher', DELOVE_BRANCH_STYLES: '' };
  const same = (pick: (ctx: StepContext) => number) => pick;
  return [
    branchFromEnv(dir, env),
    ...BRANCH_SCORES.map((score) => branchFromEnv(dir, env, score)),
    branchFromEnv(dir, g, undefined, { id: 'delove-branch@1:gumbel', rolloutPick: same }),
    ...BRANCH_SCORES.map((score) => branchFromEnv(dir, g, score, { id: `delove-branch@1:${score}:gumbel`, rolloutPick: same })),
  ];
}

/** The newest base network in the models folder (delove@N.onnx with the highest N), or null when there is none. */
export function newestBaseModel(dir = modelsDir()): string | null {
  if (!existsSync(dir)) return null;
  const versions = readdirSync(dir).map((f) => /^delove@(\d+)\.onnx$/.exec(f)).filter((m) => m !== null).map((m) => Number(m![1]));
  return versions.length ? `delove@${Math.max(...versions)}` : null;
}

/** One live search setting: the rollout teacher, options per decision, rollout score, horizon and margin. */
export interface LiveBranchPreset { teacher: string; options: number; score: BranchScore; horizon: number; margin: number }

/**
 * The live seat's search presets. `measured` is the default: #142's measured setup (Jacob Sensei 1 rollouts, 5 options,
 * share score, horizon 1, margin 0.01; +2.07 points per seat at World 6p and +1.43 at Classic 4p against the bare
 * network). `js2-range` is opt-in (`delove-seat --preset js2-range`): Jacob Sensei 2 rollouts and the range score (each
 * stage's goal by players alive) with horizon 2 and margin 0.02, the setting live yardstick baseline 2 ran; it has no
 * mirrored live-strength ladder yet.
 */
export const LIVE_BRANCH_PRESETS = {
  measured: { teacher: 'jacob-sensei@1', options: 5, score: 'share', horizon: 1, margin: 0.01 },
  'js2-range': { teacher: 'jacob-sensei@2', options: 5, score: 'range', horizon: 2, margin: 0.02 },
} as const satisfies Record<string, LiveBranchPreset>;
export type LiveBranchPresetName = keyof typeof LIVE_BRANCH_PRESETS;
export const LIVE_BRANCH_DEFAULT_PRESET: LiveBranchPresetName = 'js2-range';

/**
 * The environment for the live seat's search (seat-cli.ts): DELOVE_BRANCH_RANKER defaults to the newest base network
 * (newestBaseModel); DELOVE_BRANCH_TEACHER, _OPTIONS, _SCORE, _HORIZON and _MARGIN come from the preset (default
 * `js2-range`, the winner of #164's mirrored ladder). A variable already set wins. Self-play (register.ts) keeps branchFromEnv's own defaults, so training runs
 * don't change.
 */
export function liveBranchEnv(dir = modelsDir(), env: NodeJS.ProcessEnv = process.env, preset: LiveBranchPresetName = LIVE_BRANCH_DEFAULT_PRESET): NodeJS.ProcessEnv {
  const p: LiveBranchPreset = LIVE_BRANCH_PRESETS[preset];
  if (!p) throw new Error(`unknown live search preset ${preset} (known: ${Object.keys(LIVE_BRANCH_PRESETS).join(', ')})`);
  const ranker = env.DELOVE_BRANCH_RANKER ?? newestBaseModel(dir) ?? undefined;
  return {
    ...env,
    ...(ranker ? { DELOVE_BRANCH_RANKER: ranker } : {}),
    DELOVE_BRANCH_TEACHER: env.DELOVE_BRANCH_TEACHER ?? p.teacher,
    DELOVE_BRANCH_OPTIONS: env.DELOVE_BRANCH_OPTIONS ?? String(p.options),
    DELOVE_BRANCH_SCORE: env.DELOVE_BRANCH_SCORE ?? p.score,
    DELOVE_BRANCH_HORIZON: env.DELOVE_BRANCH_HORIZON ?? String(p.horizon),
    DELOVE_BRANCH_MARGIN: env.DELOVE_BRANCH_MARGIN ?? String(p.margin),
  };
}
