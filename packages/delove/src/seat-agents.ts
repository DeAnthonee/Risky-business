import type { Agent } from '@risk/selfplay';
import { branchFromEnv, LIVE_BRANCH_DEFAULT_PRESET, LIVE_BRANCH_PRESETS, liveBranchEnv, type LiveBranchPresetName } from './branch-env.js';
import { jacob, jacob2 } from './jacob.js';
import { discoverNetAgents, scorerOf } from './net-agent.js';
import type { SeatInfo } from './notes.js';
import { discoverTunedTeachers } from './seat.js';
import { teacher } from './teacher.js';

/**
 * The players of live seats by id, shared by `delove-seat` (seat-cli.ts) and the seat pool (pool.ts): the teachers,
 * every network in the models folder (DELOVE_MODELS), `delove-branch` (search ranked by the newest base network) and
 * `<model>+search` (search ranked by that network), each search with its live preset. Each player gets its spectator
 * label and what its decision notes say it is.
 */
/** Spectator labels (the `agent` tag on join): the network that plays, e.g. "delove@10 + search"; default the agent id. */
export const labels = new Map<Agent, string>();
/** What a seat's decision notes say it is (notes.ts): its label, network and search preset. */
export const infos = new Map<Agent, SeatInfo>();

/** The players for these ids (the teachers, every network in the models folder, and delove-branch with its preset). */
export function makeAgents(ids: string[], presetName: string | undefined): Agent[] {
  const tuned = discoverTunedTeachers();
  const allAgents = [teacher, ...tuned, jacob, jacob2, ...discoverNetAgents()];
  const known = new Map<string, Agent>(
    allAgents.flatMap((a) => {
      const entries: [string, Agent][] = [[a.id, a]];
      if (a.id === 'delove-teacher@1') entries.push(['sensei@1', a], ['sensei', a]);
      if (a.id === 'delove-teacher@2') entries.push(['sensei@2', a]);
      if (a.id === jacob.id) entries.push(['jacob', a]);
      if (a.id === jacob2.id) entries.push(['jacob2', a]);
      return entries;
    }),
  );
  // Branch and score loads its ranker network, so it is only built when a seat asks for it: delove-branch ranks with
  // the newest base network (or DELOVE_BRANCH_RANKER), <model>+search (e.g. delove@10+search) with that model.
  const preset = (presetName ?? LIVE_BRANCH_DEFAULT_PRESET) as LiveBranchPresetName;
  const search = (id: string, ranker: string | undefined) => {
    if (!(preset in LIVE_BRANCH_PRESETS)) throw new Error(`--preset must be one of ${Object.keys(LIVE_BRANCH_PRESETS).join(', ')}`);
    const env = liveBranchEnv(undefined, ranker ? { ...process.env, DELOVE_BRANCH_RANKER: ranker } : process.env, preset);
    const branch = branchFromEnv(undefined, env);
    console.log(`${id} (${preset}): ranker ${env.DELOVE_BRANCH_RANKER ?? 'none'}, rollouts by ${env.DELOVE_BRANCH_TEACHER}, ${env.DELOVE_BRANCH_OPTIONS} options, ${env.DELOVE_BRANCH_SCORE} score, horizon ${env.DELOVE_BRANCH_HORIZON}, margin ${env.DELOVE_BRANCH_MARGIN}`);
    known.set(id, branch);
    labels.set(branch, `${env.DELOVE_BRANCH_RANKER ?? 'delove'} + search`);
    infos.set(branch, { label: labels.get(branch)!, model: env.DELOVE_BRANCH_RANKER ?? null, preset });
    return branch;
  };
  if (ids.some((id) => id === 'delove-branch' || id === 'delove-branch@1')) known.set('delove-branch@1', search('delove-branch', undefined));
  for (const id of new Set(ids.filter((id) => id.endsWith('+search')))) {
    const model = id.slice(0, -'+search'.length);
    if (!known.has(model)) throw new Error(`${id}: no network ${model} in the models folder`);
    search(id, model);
  }
  const agents = ids.map((id) => {
    const a = known.get(id);
    if (!a) throw new Error(`unknown Delove version "${id}" (known: ${[...known.keys()].join(', ')})`);
    return a;
  });
  for (const a of agents) if (!infos.has(a)) infos.set(a, { label: a.id, model: scorerOf(a) ? a.id : null, preset: null });
  return agents;
}

