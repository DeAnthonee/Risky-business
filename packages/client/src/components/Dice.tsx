import { useEffect, useState } from 'react';
import type { GameEvent } from '@risk/engine';
import { getMap } from '@risk/engine';
import { territoryName } from './Map';

export type BattleEvent = Extract<GameEvent, { type: 'battle' }>;

const PIPS: Record<number, [number, number][]> = {
  1: [[50, 50]],
  2: [
    [25, 25],
    [75, 75],
  ],
  3: [
    [25, 25],
    [50, 50],
    [75, 75],
  ],
  4: [
    [25, 25],
    [75, 25],
    [25, 75],
    [75, 75],
  ],
  5: [
    [25, 25],
    [75, 25],
    [50, 50],
    [25, 75],
    [75, 75],
  ],
  6: [
    [25, 25],
    [75, 25],
    [25, 50],
    [75, 50],
    [25, 75],
    [75, 75],
  ],
};

export function Die({ value, color, lost, rolling }: { value: number; color: string; lost: boolean; rolling: boolean }) {
  const [face, setFace] = useState(value);
  useEffect(() => {
    if (!rolling) {
      setFace(value);
      return;
    }
    const t = setInterval(() => setFace(1 + Math.floor(Math.random() * 6)), 70);
    return () => clearInterval(t);
  }, [rolling, value]);
  return (
    <svg className={`die ${rolling ? 'rolling' : ''} ${lost ? 'lost' : ''}`} viewBox="0 0 100 100">
      <rect x={4} y={4} width={92} height={92} rx={18} fill={color} stroke="rgba(0,0,0,.35)" strokeWidth={3} />
      {PIPS[face].map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={9} fill="#fff" />
      ))}
    </svg>
  );
}

export function DicePanel({
  battle,
  rolling,
  attackerColor,
  defenderColor,
  names,
  mapId,
  streak = 1,
}: {
  battle: BattleEvent;
  rolling: boolean;
  /** Rolls in a row on this attack; above 1 the panel shows a blitz counter. */
  streak?: number;
  attackerColor: string;
  defenderColor: string;
  names: Record<string, string>;
  mapId: string;
}) {
  const map = getMap(mapId);
  const shortName = (id: string) => territoryName(map, id);
  const n = Math.min(battle.attackerDice.length, battle.defenderDice.length);
  const aLost = (i: number) => i < n && battle.attackerDice[i] <= battle.defenderDice[i];
  const dLost = (i: number) => i < n && battle.attackerDice[i] > battle.defenderDice[i];
  return (
    <div className="dice-panel">
      <div className="dice-side">
        <div className="dice-name" style={{ color: attackerColor }}>
          {names[battle.attacker] ?? battle.attacker} · {shortName(battle.from)}
        </div>
        <div className="dice-row">
          {battle.attackerDice.map((v, i) => (
            <Die key={i} value={v} color={attackerColor} lost={!rolling && aLost(i)} rolling={rolling} />
          ))}
        </div>
        <div className={`dice-loss ${!rolling && battle.attackerLosses ? 'show' : ''}`}>−{battle.attackerLosses}</div>
      </div>
      <div className="dice-vs">
        ⚔️
        {streak > 1 && <div className="dice-blitz">BLITZ ×{streak}</div>}
      </div>
      <div className="dice-side">
        <div className="dice-name" style={{ color: defenderColor }}>
          {names[battle.defender] ?? battle.defender} · {shortName(battle.to)}
        </div>
        <div className="dice-row">
          {battle.defenderDice.map((v, i) => (
            <Die key={i} value={v} color={defenderColor} lost={!rolling && dLost(i)} rolling={rolling} />
          ))}
        </div>
        <div className={`dice-loss ${!rolling && battle.defenderLosses ? 'show' : ''}`}>−{battle.defenderLosses}</div>
      </div>
    </div>
  );
}
