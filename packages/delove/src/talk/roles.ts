import { chooseBotAction, chooseZergAction, ZERG_2_PARAMS, type Action, type PlayerId } from '@risk/engine';
import { listenFeatures } from './features.js';
import type { TalkSeat, TalkView, Speech } from './game.js';
import { predict, type ListenerModel } from './listener.js';

/**
 * Scripted seats for stages 0-1 of the learned Zerg (docs/zergs.md §7): what the listening head trains and is tested
 * against. None of them is told anyone's role; a Zerg's allies are a belief (`Belief`) read from chat and battles.
 */

/** p(seat is a Zerg) as `me` sees it. */
export type Belief = (view: TalkView, target: PlayerId) => number;

/** Baseline belief: a seat that claimed to be a Zerg, until it attacks me or a claimer. */
export const heuristicBelief: Belief = (view, target) => {
  const claimers = new Set(view.chat.filter((m) => m.kind === 'claim_zerg').map((m) => m.from));
  if (!claimers.has(target)) return 0.1;
  const hitHorde = view.battles.some((b) => b.attacker === target && (b.defender === view.me || (claimers.has(b.defender) && b.defender !== target)));
  return hitHorde ? 0.1 : 0.9;
};

/** The trained listener as a belief. */
export function modelBelief(model: ListenerModel): Belief {
  return (view, target) => predict(model, listenFeatures(view.me, target, view.chat, view.battles, view.state.round));
}

function others(view: TalkView): PlayerId[] {
  return view.state.players.filter((p) => p.alive && !p.isNeutral && p.id !== view.me).map((p) => p.id);
}

/** Believed allies above the threshold. */
export function believedAllies(view: TalkView, belief: Belief, threshold = 0.5): Set<PlayerId> {
  return new Set(others(view).filter((j) => belief(view, j) > threshold));
}

/** Plays the hand-coded Zerg policy (zerg@2) with `allies` as its horde; never surrenders mid-game. */
function playAsZerg(view: TalkView, allies: ReadonlySet<PlayerId>): Action | null {
  const horde = new Set([view.me, ...allies]);
  const a = chooseZergAction(view.state, view.me, horde, view.random, ZERG_2_PARAMS);
  // A believed horde with nobody else left would surrender to its strongest; the true endgame is the loop's (by
  // standing, on true roles), so a mistaken belief never ends a seat: play on as the built-in bot instead.
  return a?.type === 'surrender' ? chooseBotAction(view.state, view.me, view.random) : a;
}

/** The talk a Zerg (or an impostor copying one) gives: claim on its first turn, then vouch, accuse, or name a target. */
function zergTalk(view: TalkView, belief: Belief, said: Set<string>): Speech | null {
  if (!said.has('claim')) {
    said.add('claim');
    return { kind: 'claim_zerg' };
  }
  const me = view.me;
  const hitMe = view.battles.filter((b) => b.defender === me && b.round >= view.state.round - 1).map((b) => b.attacker);
  const claimers = new Set(view.chat.filter((m) => m.kind === 'claim_zerg').map((m) => m.from));
  const traitor = hitMe.find((j) => claimers.has(j) && !said.has(`accuse:${j}`));
  if (traitor) {
    said.add(`accuse:${traitor}`);
    return { kind: 'accuse', about: traitor };
  }
  const ally = others(view).find((j) => belief(view, j) > 0.5 && !said.has(`vouch:${j}`));
  if (ally) {
    said.add(`vouch:${ally}`);
    return { kind: 'vouch', about: ally };
  }
  return null;
}

/** A Zerg seat. `talks: false` is a quiet Zerg (never speaks, still deduces). */
export function zergSeat(belief: Belief, talks = true, id = 'talk-zerg@0'): TalkSeat {
  return {
    role: 'zerg',
    make: () => {
      const said = new Set<string>();
      return {
        id: talks ? id : `${id}:quiet`,
        speak: talks ? (view) => zergTalk(view, belief, said) : undefined,
        act: (view) => playAsZerg(view, believedAllies(view, belief)),
      };
    },
  };
}

/**
 * An impostor: talks exactly like a Zerg. `claimer` then plays the built-in bot (hits anyone, Zergs included).
 * `mimic` (the held-out kind) also *acts* like a Zerg, sparing the claimers, for `betrayRound` rounds, then betrays.
 */
export function impostorSeat(kind: 'claimer' | 'mimic', betrayRound = 4): TalkSeat {
  return {
    role: 'impostor',
    make: () => {
      const said = new Set<string>();
      return {
        id: `impostor:${kind}`,
        speak: (view) => zergTalk(view, heuristicBelief, said),
        act: (view) => {
          if (kind === 'mimic' && view.state.round < betrayRound) {
            const claimers = new Set(view.chat.filter((m) => m.kind === 'claim_zerg' && m.from !== view.me).map((m) => m.from));
            return playAsZerg(view, claimers);
          }
          return chooseBotAction(view.state, view.me, view.random);
        },
      };
    },
  };
}

/** A plain seat: the built-in bot. `noisy` accuses whoever hit it last round, as people do. */
export function plainSeat(noisy = false): TalkSeat {
  return {
    role: 'plain',
    make: () => ({
      id: noisy ? 'plain:noisy' : 'plain',
      speak: noisy
        ? (view) => {
            const hit = view.battles.filter((b) => b.defender === view.me && b.round === view.state.round - 1).map((b) => b.attacker);
            return hit.length ? { kind: 'accuse', about: hit[hit.length - 1] } : null;
          }
        : undefined,
      act: (view) => chooseBotAction(view.state, view.me, view.random),
    }),
  };
}
