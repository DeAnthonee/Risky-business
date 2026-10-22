import type { PlayerId } from '@risk/engine';
import type { BattleRecord } from './game.js';
import type { TalkMessage } from './vocab.js';

/**
 * The listening features: what `observer` can tell about seat `target` from the talk it can see and from the public
 * battles, up to now. No role labels and nothing private go in. Counts are log1p-scaled.
 *
 * "Claimers" are the seats (other than the target) that claimed to be Zergs in chat the observer can see; the
 * observer counts as one if it claimed. Behaviour toward claimers vs others is the deduction signal: a true Zerg
 * hits the prey and spares the horde, an impostor says the same words but its battles tell.
 */
export const FEATURE_NAMES = [
  'claimed',
  'denied',
  'spoke',
  'vouch_given',
  'vouch_received',
  'vouch_received_from_claimers',
  'accuse_received',
  'accuse_received_from_claimers',
  'accuse_given',
  'asked',
  'named_claimer_as_target',
  'battles_vs_me',
  'damage_to_me',
  'battles_vs_claimers',
  'battles_vs_others',
  'share_vs_claimers',
  'damage_to_claimers',
  'damage_to_others',
  'claimers_battles_vs_target',
  'recent_battles_vs_claimers',
  'recent_battles_vs_me',
  'recent_share_vs_claimers',
  'round',
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

const l = (x: number) => Math.log1p(x);

export function listenFeatures(observer: PlayerId, target: PlayerId, chat: readonly TalkMessage[], battles: readonly BattleRecord[], round: number): number[] {
  const claimers = new Set(chat.filter((m) => m.kind === 'claim_zerg' && m.from !== target).map((m) => m.from));
  const by = chat.filter((m) => m.from === target);
  const about = chat.filter((m) => m.about === target && m.from !== target);
  const count = (xs: readonly TalkMessage[], kind: TalkMessage['kind']) => xs.filter((m) => m.kind === kind).length;
  let vsMe = 0;
  let dmgMe = 0;
  let vsClaimers = 0;
  let vsOthers = 0;
  let dmgClaimers = 0;
  let dmgOthers = 0;
  let claimersVsTarget = 0;
  let recentClaimers = 0;
  let recentMe = 0;
  let recentOthers = 0;
  for (const b of battles) {
    // The last two rounds: a betrayal shows up right after it happens instead of being drowned by older good behaviour.
    if (b.attacker === target && b.round >= round - 1) {
      if (b.defender === observer) recentMe++;
      else if (claimers.has(b.defender)) recentClaimers++;
      else recentOthers++;
    }
    if (b.attacker === target) {
      if (b.defender === observer) (vsMe++, (dmgMe += b.defenderLosses));
      else if (claimers.has(b.defender)) (vsClaimers++, (dmgClaimers += b.defenderLosses));
      else (vsOthers++, (dmgOthers += b.defenderLosses));
    } else if (b.defender === target && claimers.has(b.attacker)) claimersVsTarget++;
  }
  const f: Record<FeatureName, number> = {
    claimed: by.some((m) => m.kind === 'claim_zerg') ? 1 : 0,
    denied: by.some((m) => m.kind === 'deny') ? 1 : 0,
    spoke: by.length > 0 ? 1 : 0,
    vouch_given: l(count(by, 'vouch')),
    vouch_received: l(count(about, 'vouch')),
    vouch_received_from_claimers: l(about.filter((m) => m.kind === 'vouch' && claimers.has(m.from)).length),
    accuse_received: l(count(about, 'accuse')),
    accuse_received_from_claimers: l(about.filter((m) => m.kind === 'accuse' && claimers.has(m.from)).length),
    accuse_given: l(count(by, 'accuse')),
    asked: l(count(by, 'ask')),
    named_claimer_as_target: by.some((m) => m.kind === 'target' && m.about !== undefined && claimers.has(m.about)) ? 1 : 0,
    battles_vs_me: l(vsMe),
    damage_to_me: l(dmgMe),
    battles_vs_claimers: l(vsClaimers),
    battles_vs_others: l(vsOthers),
    share_vs_claimers: vsClaimers / (vsClaimers + vsOthers + 1),
    damage_to_claimers: l(dmgClaimers),
    damage_to_others: l(dmgOthers),
    claimers_battles_vs_target: l(claimersVsTarget),
    recent_battles_vs_claimers: l(recentClaimers),
    recent_battles_vs_me: l(recentMe),
    recent_share_vs_claimers: recentClaimers / (recentClaimers + recentOthers + 1),
    round: Math.min(1, round / 20),
  };
  return FEATURE_NAMES.map((k) => f[k]);
}

/**
 * Second-order listening features: how the target's battles split between seats the observer *believes* are Zergs
 * and the rest, given a first-order belief `p` (another listener's output). "Claimers" lump impostors in with real
 * Zergs; a true Zerg attacks claimers it believes are impostors, an impostor attacks claimers that really are Zergs.
 * The observer counts as a believed Zerg (it knows its own role). Totals and the last two rounds.
 */
export const SECOND_ORDER_NAMES = ['believed_hits', 'unbelieved_hits', 'share_believed', 'recent_believed_hits', 'recent_share_believed'] as const;

export function secondOrderFeatures(observer: PlayerId, target: PlayerId, battles: readonly BattleRecord[], round: number, p: (seat: PlayerId) => number): number[] {
  let believed = 0;
  let unbelieved = 0;
  let recentBelieved = 0;
  let recentAll = 0;
  for (const b of battles) {
    if (b.attacker !== target) continue;
    const w = b.defender === observer ? 1 : p(b.defender);
    believed += w;
    unbelieved += 1 - w;
    if (b.round >= round - 1) {
      recentBelieved += w;
      recentAll += 1;
    }
  }
  return [l(believed), l(unbelieved), believed / (believed + unbelieved + 1), l(recentBelieved), recentBelieved / (recentAll + 1)];
}
