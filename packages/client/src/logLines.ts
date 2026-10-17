import type { GameEvent } from '@risk/engine';

type Battle = Extract<GameEvent, { type: 'battle' }>;
type Conquered = Extract<GameEvent, { type: 'conquered' }>;

/** One attack (from one territory into another) summed up over all of its dice rolls. */
export interface BattleSummary {
  type: 'battle_summary';
  attacker: string;
  defender: string;
  from: string;
  to: string;
  rolls: number;
  /** Armies on each side before the first roll and after the last. */
  fromStart: number;
  fromEnd: number;
  toStart: number;
  toEnd: number;
  attackerLosses: number;
  defenderLosses: number;
  /** Set when the attack took the territory. */
  conquered: Conquered | null;
  /** Armies moved into the conquered territory right after (null until then). */
  movedIn: number | null;
  /** The individual rolls, for a tooltip. */
  battles: Battle[];
}

/** Several identical fog markers in a row, shown once with a count. */
export interface FoggedRun {
  type: 'fogged_run';
  kind: string;
  count: number;
}

export type LogItem = { key: string; e: GameEvent | BattleSummary | FoggedRun };

/**
 * Flatten the event batches into log items, folding every run of consecutive dice rolls between the same
 * two territories into one summary (start and end armies, losses on each side, number of rolls, and the
 * conquest and the armies moved in if the attack took the territory), and runs of identical fog markers into one line. Grouping
 * works across batches, so single rolls and replayed blitzes (one roll per batch) fold the same way.
 * `keep` drops events the log does not show (it must not drop battles, conquests or fog markers).
 */
export function logItems(batches: { id: string | number; events: GameEvent[] }[], keep: (e: GameEvent) => boolean): LogItem[] {
  const out: LogItem[] = [];
  for (const b of batches) {
    b.events.forEach((e, i) => {
      const key = `${b.id}-${i}`;
      const last = out[out.length - 1]?.e;
      if (e.type === 'battle') {
        if (
          last?.type === 'battle_summary' &&
          !last.conquered &&
          last.attacker === e.attacker &&
          last.from === e.from &&
          last.to === e.to
        ) {
          last.rolls++;
          last.fromEnd = e.fromArmies;
          last.toEnd = e.toArmies;
          last.attackerLosses += e.attackerLosses;
          last.defenderLosses += e.defenderLosses;
          last.battles.push(e);
          return;
        }
        out.push({
          key,
          e: {
            type: 'battle_summary',
            attacker: e.attacker,
            defender: e.defender,
            from: e.from,
            to: e.to,
            rolls: 1,
            fromStart: e.fromArmies + e.attackerLosses,
            fromEnd: e.fromArmies,
            toStart: e.toArmies + e.defenderLosses,
            toEnd: e.toArmies,
            attackerLosses: e.attackerLosses,
            defenderLosses: e.defenderLosses,
            conquered: null,
            movedIn: null,
            battles: [e],
          },
        });
        return;
      }
      if (e.type === 'conquered' && last?.type === 'battle_summary' && !last.conquered && last.to === e.to && last.attacker === e.player) {
        last.conquered = e;
        return;
      }
      if (e.type === 'moved' && last?.type === 'battle_summary' && last.conquered && last.movedIn === null && last.from === e.from && last.to === e.to) {
        last.movedIn = e.armies;
        return;
      }
      if (e.type === 'fogged' && last?.type === 'fogged_run' && last.kind === e.kind) {
        last.count++;
        return;
      }
      if (e.type === 'fogged') {
        out.push({ key, e: { type: 'fogged_run', kind: e.kind, count: 1 } });
        return;
      }
      if (keep(e)) out.push({ key, e });
    });
  }
  return out;
}
