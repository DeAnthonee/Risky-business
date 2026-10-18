import { CAPITAL_DEFENSE_DICE, blitzOdds, getMap, type Action, type GameView, type TerritoryId } from '@risk/engine';

/** One numbered choice shown to the model: a readable label and the exact action it sends. */
export interface MoveOption {
  label: string;
  /** null = a choice that sends nothing (decline to trade now). */
  action: Action | null;
}

export interface Decision {
  /** What is being decided, in one line. */
  prompt: string;
  /** Best first by a simple heuristic, so option 1 is always a sound default when the model fails. */
  options: MoveOption[];
}

const MAX_OPTIONS = 12;
const pct = (p: number) => (p >= 0.995 ? '99%+' : p < 0.01 ? '<1%' : `${Math.round(p * 100)}%`);

/**
 * The decision the player faces in this view, as a short list of concrete legal actions. Only the engine's own
 * legal moves are offered, so whatever the model picks is valid. Returns null when it is not our turn.
 * skipTrade: the player already declined an optional trade this turn.
 */
export function buildDecision(view: GameView, opts: { skipTrade?: boolean } = {}): Decision | null {
  const lm = view.legal;
  const me = view.you;
  if (!lm || !lm.yourTurn || !me) return null;
  const map = getMap(view.options.map);
  const t = (id: TerritoryId) => view.territories[id];
  const name = (pid: string | null) => view.players.find((p) => p.id === pid)?.name ?? 'nobody';
  const enemyNeighbours = (id: TerritoryId) => map.adjacency[id].filter((n) => !t(n).hidden && t(n).owner !== null && t(n).owner !== me);
  /** Enemy armies next to a territory: how much it needs defending. */
  const threat = (id: TerritoryId) => enemyNeighbours(id).reduce((s, n) => s + t(n).armies, 0);
  const isCapital = (id: TerritoryId) => Object.values(view.capitals ?? {}).includes(id);
  const top = (list: MoveOption[]) => list.slice(0, MAX_OPTIONS);

  if (lm.pendingConquest) {
    const { from, to, minArmies, maxArmies } = lm.pendingConquest;
    const half = Math.max(minArmies, Math.floor((minArmies + maxArmies) / 2));
    const moves = [...new Set([maxArmies, half, minArmies])];
    return {
      prompt: `You took ${to} from ${from}. How many armies move in (${minArmies}-${maxArmies})? The rest stay in ${from}.`,
      options: moves.map((n) => ({
        label: `Move ${n} into ${to}, leave ${t(from).armies - n} in ${from}${n === maxArmies ? ' (push on from here)' : n === minArmies ? ' (keep the stack home)' : ''}`,
        action: { type: 'occupy', armies: n },
      })),
    };
  }

  if (lm.capitalChoices?.length) {
    const ranked = [...lm.capitalChoices].sort((a, b) => threat(a) - threat(b) || t(b).armies - t(a).armies);
    return {
      prompt: 'Choose your capital: it gets +3 armies now, defends with 3 dice and pays +2 a turn. Losing it costs you.',
      options: top(ranked.map((id) => ({ label: `Capital in ${id} (${t(id).armies} armies, ${threat(id)} enemy armies next door)`, action: { type: 'choose_capital', territory: id } }))),
    };
  }

  if (lm.tradeableSets.length && (lm.mustTrade || !opts.skipTrade)) {
    const cards = new Map((view.players.find((p) => p.id === me)?.cards ?? []).map((c) => [c.id, c]));
    const sets: MoveOption[] = lm.tradeableSets.map((set) => ({
      label: `Trade cards ${set.map((id) => `#${id} ${cards.get(id)?.kind ?? '?'}${cards.get(id)?.territory ? ` (${cards.get(id)!.territory})` : ''}`).join(', ')}`,
      action: { type: 'trade', cardIds: set },
    }));
    if (!lm.mustTrade) sets.push({ label: 'Keep the cards for now', action: null });
    return { prompt: lm.mustTrade ? 'You must trade a card set now.' : `You can trade a card set (${view.tradeCount} sets traded so far in this game).`, options: top(sets) };
  }

  if (lm.canPlaceOn.length && lm.placeLimit > 0) {
    const unclaimed = lm.canPlaceOn.filter((id) => t(id).owner === null);
    if (unclaimed.length) {
      // Claiming: grow next to what we hold, and toward continents we already started.
      const mine = (id: TerritoryId) => map.adjacency[id].filter((n) => t(n).owner === me).length;
      const ranked = [...unclaimed].sort((a, b) => mine(b) - mine(a));
      return {
        prompt: 'Claim one unclaimed territory.',
        options: top(ranked.map((id) => ({ label: `Claim ${id} (${map.territories.find((x) => x.id === id)?.continent ?? ''}, ${mine(id)} of your territories next to it)`, action: { type: 'place', placements: { [id]: 1 } } }))),
      };
    }
    const n = lm.placeLimit;
    const ranked = [...lm.canPlaceOn].sort((a, b) => Number(isCapital(b)) - Number(isCapital(a)) || threat(b) - threat(a) || t(a).armies - t(b).armies);
    const borders = ranked.filter((id) => threat(id) > 0);
    return {
      prompt: `Place ${n} armies (${lm.armiesToPlace} left to place this turn). Stacking them in one place is usually strongest.`,
      options: top((borders.length ? borders : ranked).map((id) => ({
        label: `Place ${n} on ${id} (now ${t(id).armies}${isCapital(id) ? ', a CAPITAL' : ''}; enemy next door: ${enemyNeighbours(id).map((e) => `${e} ${t(e).armies} ${name(t(e).owner)}`).join(', ') || 'none'})`,
        action: { type: 'place', placements: { [id]: n } },
      }))),
    };
  }

  if (lm.attacks.length || lm.canEndAttack) {
    const fog = !!view.options.fogOfWar;
    const balanced = !!view.options.balancedBlitz;
    const chance = (from: TerritoryId, to: TerritoryId) => {
      const o = blitzOdds(t(from).armies, t(to).armies, view.options.capitals && isCapital(to) ? CAPITAL_DEFENSE_DICE : 2);
      return balanced ? o.balancedWin : o.win;
    };
    const attacks = lm.attacks
      .map((a) => ({ ...a, p: chance(a.from, a.to) }))
      .sort((a, b) => b.p - a.p)
      .slice(0, MAX_OPTIONS - 1)
      .map((a) => ({
        label: `Attack ${a.to} (${t(a.to).armies} ${name(t(a.to).owner)}${isCapital(a.to) ? ', a CAPITAL' : ''}) from ${a.from} (${t(a.from).armies}): ${pct(a.p)} to take it in one blitz`,
        // Under fog a conquest reveals new ground, so the move-in is decided after seeing it.
        action: (fog ? { type: 'attack', from: a.from, to: a.to, blitz: true } : { type: 'attack', from: a.from, to: a.to, blitz: true, occupy: 'max' }) as Action,
        p: a.p,
      }));
    const stop: MoveOption = { label: 'Stop attacking (go to fortify)', action: { type: 'end_attack' } };
    // Long shots go below stopping, so the default (option 1) never throws armies away.
    const good = attacks.filter((a) => a.p >= 0.5);
    const rest = attacks.filter((a) => a.p < 0.5);
    return {
      prompt: `Attack phase. Taking at least one territory this turn earns a card.`,
      options: [...good, ...(lm.canEndAttack ? [stop] : []), ...rest].map(({ label, action }) => ({ label, action })),
    };
  }

  if (lm.fortifies.length || lm.canEndTurn) {
    // Move idle armies from safe territories toward the most threatened border.
    const moves = lm.fortifies
      .filter((f) => f.maxArmies > 0 && threat(f.to) > 0 && threat(f.from) === 0)
      .sort((a, b) => threat(b.to) - threat(a.to) || b.maxArmies - a.maxArmies)
      .slice(0, MAX_OPTIONS - 2);
    const other = lm.fortifies
      .filter((f) => f.maxArmies > 0 && !moves.includes(f))
      .sort((a, b) => threat(b.to) - threat(a.to))
      .slice(0, 1);
    const fortify = [...moves, ...other].map((f) => ({
      label: `Move ${f.maxArmies} from ${f.from} (${threat(f.from)} enemy next door) to ${f.to} (${threat(f.to)} enemy next door), then end the turn`,
      action: { type: 'fortify', from: f.from, to: f.to, armies: f.maxArmies } as Action,
    }));
    const end: MoveOption = { label: 'End the turn without moving', action: { type: 'end_turn' } };
    return { prompt: 'Fortify: one move, then your turn ends.', options: [...fortify.slice(0, moves.length), ...(lm.canEndTurn ? [end] : []), ...fortify.slice(moves.length)] };
  }

  return null;
}
