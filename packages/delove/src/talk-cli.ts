#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { gameSeed, seededRandom } from '@risk/selfplay';
import { FEATURE_NAMES, listenFeatures, SECOND_ORDER_NAMES, secondOrderFeatures } from './talk/features.js';
import { playTalkGame, type Role, type TalkGameResult, type TalkSeat } from './talk/game.js';
import { auc, predict, trainListener, type Example, type ListenerModel } from './talk/listener.js';
import { heuristicBelief, impostorSeat, modelBelief, plainSeat, stackedBelief, zergSeat, type Belief } from './talk/roles.js';
import { visibleTo } from './talk/vocab.js';

/**
 * Stages 0-1 of the learned Zerg (docs/zergs.md §7), end to end on the CPU:
 *
 *   npm run delove:talk -- [--train-games 600] [--test-games 300] [--play-games 300] [--seed 1] [--out models/delove/listener@0.json]
 *
 * 1. Talking self-play on the training mix: 2 Zergs (talking or quiet), sometimes a `claimer` impostor, plain seats
 *    (some noisy). Iteration 0's Zergs act on the true allies (teacher forcing), so their behaviour is a real signal;
 *    later iterations add games where they act on the previous listener (`--iterations`, DAgger-style).
 * 2. The listening dataset: for every Zerg observer, every round and every other seat alive, the listening features
 *    and the true role. Train the listener (logistic regression).
 * 3. Held-out test: tables with the `mimic` impostor the listener never saw (it acts like a Zerg for 4 rounds, then
 *    betrays). AUC overall, Zerg vs impostor only, by round; against the heuristic.
 * 4. Play: the same held-out tables with the Zergs' belief from the heuristic, the trained listener, the second-order
 *    (stacked) listener, and the truth (an upper bound). Infighting share, hits on impostors, horde wins, turn limits.
 * 5. Recognition scored on-policy (games where the Zergs act on that listener) and teacher-forced (they act on the
 *    true roles). Step 3's test uses heuristic-acting Zergs, whose infighting makes true Zergs look like impostors:
 *    keep it only for comparison; the gate reads the on-policy AUC.
 * Output: one JSON line on stdout, a summary on stderr. The model file is local only (hard rule 13).
 */

type Mix = 'train' | 'test';

function tableFor(mix: Mix, seed: number, belief: Belief): { seats: TalkSeat[]; players: number } {
  const r = seededRandom(seed ^ 0x51ab);
  const players = r() < 0.5 ? 4 : 5;
  const seats: TalkSeat[] = [];
  seats.push(zergSeat(belief, mix === 'test' || r() < 0.7));
  seats.push(zergSeat(belief, mix === 'test' || r() < 0.7));
  if (mix === 'test') seats.push(impostorSeat('mimic'));
  else if (r() < 0.6) seats.push(impostorSeat('claimer'));
  while (seats.length < players) seats.push(plainSeat(r() < 0.5));
  // Shuffle seats so roles don't sit in fixed places.
  for (let i = seats.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [seats[i], seats[j]] = [seats[j], seats[i]];
  }
  return { seats, players };
}

function play(mix: Mix, games: number, seed: number, belief: (zergIds: Set<string>) => Belief): TalkGameResult[] {
  const out: TalkGameResult[] = [];
  for (let g = 0; g < games; g++) {
    const s = gameSeed(seed, g);
    // The truth belief needs the true Zerg ids, which are s<i> for the seats built as Zergs: build once to find them.
    const probe = tableFor(mix, s, heuristicBelief);
    const zergIds = new Set(probe.seats.map((seat, i) => (seat.role === 'zerg' ? `s${i}` : null)).filter((x): x is string => x !== null));
    const { seats } = tableFor(mix, s, belief(zergIds));
    out.push(playTalkGame({ seed: s, seats, options: { map: 'classic', autoSetup: true }, maxTurns: 250 }));
  }
  return out;
}

interface Row extends Example {
  round: number;
  targetRole: Role;
}

/**
 * The listening rows. With `first` (a first-order listener), each row also carries the second-order features: the
 * target's battles split by the observer's first-order belief in each defender at that round.
 */
function rows(games: readonly TalkGameResult[], first?: ListenerModel): Row[] {
  const out: Row[] = [];
  for (const g of games) {
    const outRound = new Map(g.eliminated.map((e) => [g.ids[e.seat], e.round]));
    for (let o = 0; o < g.ids.length; o++) {
      if (g.roles[o] !== 'zerg') continue;
      const me = g.ids[o];
      const seen = visibleTo(g.chat, me);
      for (let round = 1; round <= Math.min(g.rounds, 12); round++) {
        if ((outRound.get(me) ?? Infinity) <= round) break;
        const chat = seen.filter((m) => m.round <= round);
        const battles = g.battles.filter((b) => b.round <= round);
        for (let j = 0; j < g.ids.length; j++) {
          if (j === o || (outRound.get(g.ids[j]) ?? Infinity) <= round) continue;
          const x = listenFeatures(me, g.ids[j], chat, battles, round);
          if (first) {
            const p1 = (seat: string) => predict(first, listenFeatures(me, seat, chat, battles, round));
            x.push(...secondOrderFeatures(me, g.ids[j], battles, round, p1));
          }
          out.push({ x, y: g.roles[j] === 'zerg' ? 1 : 0, round, targetRole: g.roles[j] });
        }
      }
    }
  }
  return out;
}

function aucs(data: readonly Row[], score: (x: number[]) => number) {
  const s = data.map((d) => score(d.x));
  const y = data.map((d) => d.y);
  const zi = data.map((d, i) => i).filter((i) => data[i].targetRole !== 'plain');
  const byRound = (lo: number, hi: number) => {
    const idx = data.map((_, i) => i).filter((i) => data[i].round >= lo && data[i].round <= hi);
    return auc(idx.map((i) => s[i]), idx.map((i) => y[i]));
  };
  const zIdx = (lo: number, hi: number) => zi.filter((i) => data[i].round >= lo && data[i].round <= hi);
  const zAuc = (lo: number, hi: number) => auc(zIdx(lo, hi).map((i) => s[i]), zIdx(lo, hi).map((i) => y[i]));
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    all: r3(auc(s, y)),
    zergVsImpostor: r3(auc(zi.map((i) => s[i]), zi.map((i) => y[i]))),
    byRound: { '1-2': r3(byRound(1, 2)), '3-5': r3(byRound(3, 5)), '6+': r3(byRound(6, 99)) },
    zergVsImpostorByRound: { '1-2': r3(zAuc(1, 2)), '3-5': r3(zAuc(3, 5)), '6+': r3(zAuc(6, 99)) },
  };
}

function hordeStats(games: readonly TalkGameResult[]) {
  let zergBattlesPrey = 0;
  let infight = 0;
  let onImpostor = 0;
  let hordeWins = 0;
  let limits = 0;
  let rounds = 0;
  for (const g of games) {
    const role = new Map(g.ids.map((id, i) => [id, g.roles[i]]));
    for (const b of g.battles) {
      if (role.get(b.attacker) !== 'zerg' || !b.preyAlive) continue;
      zergBattlesPrey++;
      if (role.get(b.defender) === 'zerg') infight++;
      if (role.get(b.defender) === 'impostor') onImpostor++;
    }
    if (g.winner !== null && g.roles[g.winner] === 'zerg') hordeWins++;
    if (g.turnLimit) limits++;
    rounds += g.rounds;
  }
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return {
    games: games.length,
    infightingShare: r3(infight / Math.max(1, zergBattlesPrey)),
    shareOnImpostor: r3(onImpostor / Math.max(1, zergBattlesPrey)),
    hordeWinRate: r3(hordeWins / games.length),
    turnLimits: limits,
    meanRounds: r3(rounds / games.length),
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      'train-games': { type: 'string', default: '600' },
      'test-games': { type: 'string', default: '300' },
      'play-games': { type: 'string', default: '300' },
      iterations: { type: 'string', default: '2' },
      seed: { type: 'string', default: '1' },
      out: { type: 'string' },
    },
  });
  const seed = Number(values.seed);
  const t0 = Date.now();
  // Iteration 0: the Zergs that generate the listener's data act on the TRUE allies ("teacher forcing"), so a real
  // Zerg's behaviour is a genuine signal; the listener itself still sees only chat and battles. Each next iteration adds
  // games where the Zergs act on the previous listener, and retrains on everything (DAgger-style).
  const truth = (ids: Set<string>): Belief => (_v, j) => (ids.has(j) ? 1 : 0);
  const trainGames = Number(values['train-games']);
  const trainSet = play('train', trainGames, seed, truth);
  let trainRows = rows(trainSet);
  let model: ListenerModel = trainListener(trainRows);
  const iterationAuc: unknown[] = [];
  for (let it = 1; it < Number(values.iterations); it++) {
    const m = model;
    const more = play('train', trainGames, seed + 31 * it, () => modelBelief(m));
    trainSet.push(...more);
    trainRows = trainRows.concat(rows(more));
    model = trainListener(trainRows);
    iterationAuc.push({ iteration: it, rows: trainRows.length });
  }
  // Second order: the same games, each row extended by how the target's battles split by the first listener's belief.
  const second = trainListener(rows(trainSet, model), 400, 0.5, 1e-3, [...FEATURE_NAMES, ...SECOND_ORDER_NAMES]);
  if (values.out) {
    mkdirSync(dirname(values.out), { recursive: true });
    writeFileSync(values.out, JSON.stringify({ first: model, second }, null, 2) + '\n');
  }
  const test = play('test', Number(values['test-games']), seed + 7919, () => heuristicBelief);
  const testRows = rows(test);
  const secondAuc = aucs(rows(test, model), (x) => predict(second, x));
  const heuristicScore = (x: number[]) => (x[0] === 1 ? (x[13] > 0 || x[11] > 0 ? 0.1 : 0.9) : 0.1);
  const listenerAuc = aucs(testRows, (x) => predict(model, x));
  const heuristicAuc = aucs(testRows, heuristicScore);
  const playGames = Number(values['play-games']);
  const playHeuristic = hordeStats(play('test', playGames, seed + 104729, () => heuristicBelief));
  const listenerGames = play('test', playGames, seed + 104729, () => modelBelief(model));
  const secondGames = play('test', playGames, seed + 104729, () => stackedBelief(model, second));
  const truthGames = play('test', playGames, seed + 104729, truth);
  const playListener = hordeStats(listenerGames);
  const playSecond = hordeStats(secondGames);
  const playTruth = hordeStats(truthGames);
  // On-policy AUC: each listener scored on games where the Zergs act on that same listener. Teacher-forced AUC: on games
  // where they act on the true roles, so a real Zerg's behaviour is clean (the listener's discrimination by itself).
  const onPolicy = {
    listener: aucs(rows(listenerGames), (x) => predict(model, x)),
    second: aucs(rows(secondGames, model), (x) => predict(second, x)),
  };
  const teacherForced = {
    listener: aucs(rows(truthGames), (x) => predict(model, x)),
    second: aucs(rows(truthGames, model), (x) => predict(second, x)),
  };
  const weights = Object.fromEntries(second.features.map((f, i) => [f, Math.round(second.weights[i] * 100) / 100]));
  const result = {
    seconds: (Date.now() - t0) / 1000,
    trainRows: trainRows.length,
    iterations: iterationAuc,
    testRows: testRows.length,
    listenerAuc,
    secondAuc,
    heuristicAuc,
    onPolicy,
    teacherForced,
    play: { heuristic: playHeuristic, listener: playListener, second: playSecond, truth: playTruth },
    weights,
  };
  console.log(JSON.stringify(result));
  console.error(`listener AUC (held-out mimic impostors): all ${listenerAuc.all}, Zerg vs impostor ${listenerAuc.zergVsImpostor} (heuristic ${heuristicAuc.all} / ${heuristicAuc.zergVsImpostor})`);
  console.error(`second-order AUC: all ${secondAuc.all}, Zerg vs impostor ${secondAuc.zergVsImpostor}, by round ${JSON.stringify(secondAuc.zergVsImpostorByRound)}`);
  console.error(`  by round, Zerg vs impostor: listener ${JSON.stringify(listenerAuc.zergVsImpostorByRound)} heuristic ${JSON.stringify(heuristicAuc.zergVsImpostorByRound)}`);
  console.error(`on-policy Zerg vs impostor: listener ${onPolicy.listener.zergVsImpostor} ${JSON.stringify(onPolicy.listener.zergVsImpostorByRound)}, second ${onPolicy.second.zergVsImpostor} ${JSON.stringify(onPolicy.second.zergVsImpostorByRound)}`);
  console.error(`teacher-forced Zerg vs impostor: listener ${teacherForced.listener.zergVsImpostor} ${JSON.stringify(teacherForced.listener.zergVsImpostorByRound)}, second ${teacherForced.second.zergVsImpostor} ${JSON.stringify(teacherForced.second.zergVsImpostorByRound)}`);
  for (const [k, v] of Object.entries(result.play)) console.error(`play ${k.padEnd(9)} ${JSON.stringify(v)}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
