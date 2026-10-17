import { getMap, isBlizzard, legalMoves, territoriesOf, type Action, type GameState, type PlayerId } from '@risk/engine';

/**
 * A simple built-in computer player. It is not clever, but it plays legally and
 * finishes games, which is all that is needed for testing and for filling seats.
 */
export function chooseBotAction(state: GameState, me: PlayerId): Action | null {
  const lm = legalMoves(state, me);
  if (!lm.yourTurn) return null;

  if (lm.pendingConquest) {
    const pc = lm.pendingConquest;
    const n = occupyCount(state, me, pc.from, pc.minArmies, pc.maxArmies);
    return { type: 'occupy', armies: n };
  }

  if (lm.capitalChoices.length > 0) {
    // Pick a well-garrisoned territory with few enemy neighbours.
    const score = (t: string) => state.territories[t].armies * 2 - enemyNeighbours(state, me, t).length - threat(state, me, t) / 4 + Math.random();
    const best = [...lm.capitalChoices].sort((a, b) => score(b) - score(a))[0];
    return { type: 'choose_capital', territory: best };
  }

  if (lm.tradeableSets.length > 0 && (lm.mustTrade || state.phase === 'reinforce')) {
    return { type: 'trade', cardIds: lm.tradeableSets[0] };
  }

  if (lm.canPlaceOn.length > 0 && lm.placeLimit > 0) {
    const target = bestPlacement(state, me, lm.canPlaceOn);
    return { type: 'place', placements: { [target]: lm.placeLimit } };
  }

  if (state.phase === 'attack') {
    const attack = bestAttack(state, me, lm.attacks);
    if (attack) {
      // Occupation is decided on the next tick via pendingConquest.
      return { type: 'attack', from: attack.from, to: attack.to, blitz: true };
    }
    if (lm.fortifies.length > 0) {
      const f = bestFortify(state, me, lm.fortifies);
      if (f) return { type: 'fortify', from: f.from, to: f.to, armies: f.armies };
    }
    return { type: 'end_turn' };
  }

  if (state.phase === 'fortify') {
    const f = bestFortify(state, me, lm.fortifies);
    if (f) return { type: 'fortify', from: f.from, to: f.to, armies: f.armies };
    return { type: 'end_turn' };
  }

  return null;
}

function enemyNeighbours(state: GameState, me: PlayerId, t: string): string[] {
  return getMap(state.options.map).adjacency[t].filter((n) => state.territories[n].owner !== me && !isBlizzard(state, n));
}

function threat(state: GameState, me: PlayerId, t: string): number {
  return enemyNeighbours(state, me, t).reduce((n, e) => n + state.territories[e].armies, 0);
}

function bestPlacement(state: GameState, me: PlayerId, options: string[]): string {
  // During the claiming phase, prefer territories next to ones we already own.
  const unclaimed = options.filter((t) => state.territories[t].owner === null);
  if (unclaimed.length > 0) {
    const owned = new Set(territoriesOf(state, me));
    const adjacency = getMap(state.options.map).adjacency;
    const scored = unclaimed.map((t) => ({ t, s: adjacency[t].filter((n) => owned.has(n)).length + Math.random() }));
    scored.sort((a, b) => b.s - a.s);
    return scored[0].t;
  }
  // Otherwise: reinforce the border territory under the most pressure.
  let best = options[0];
  let bestScore = -Infinity;
  for (const t of options) {
    const enemies = enemyNeighbours(state, me, t);
    if (enemies.length === 0) continue;
    const score = threat(state, me, t) - state.territories[t].armies + Math.random() * 2;
    if (score > bestScore) {
      bestScore = score;
      best = t;
    }
  }
  return best;
}

function bestAttack(state: GameState, me: PlayerId, attacks: { from: string; to: string }[]) {
  let best: { from: string; to: string } | null = null;
  let bestScore = 0;
  for (const a of attacks) {
    const from = state.territories[a.from].armies;
    const to = state.territories[a.to].armies;
    // Only attack with a clear advantage.
    if (from - 1 < to + 1) continue;
    const ratio = (from - 1) / to;
    if (ratio < 1.5 && from < 4) continue;
    const score = ratio + Math.random() * 0.5;
    if (score > bestScore) {
      bestScore = score;
      best = a;
    }
  }
  return best;
}

function occupyCount(state: GameState, me: PlayerId, from: string, min: number, max: number): number {
  const stillHostile = enemyNeighbours(state, me, from).length > 0;
  if (!stillHostile) return max;
  return Math.max(min, Math.min(max, Math.ceil(max / 2)));
}

function bestFortify(state: GameState, me: PlayerId, options: { from: string; to: string; maxArmies: number }[]) {
  let best: { from: string; to: string; armies: number } | null = null;
  let bestScore = 0;
  for (const f of options) {
    const fromSafe = enemyNeighbours(state, me, f.from).length === 0;
    if (!fromSafe) continue;
    const toThreat = threat(state, me, f.to);
    if (toThreat === 0) continue;
    const score = f.maxArmies + toThreat / 10;
    if (score > bestScore) {
      bestScore = score;
      best = { from: f.from, to: f.to, armies: f.maxArmies };
    }
  }
  return best;
}
