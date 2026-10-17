import { useEffect, useMemo, useState } from 'react';
import { blitzOdds, commitForOdds } from '@risk/engine';

const TARGETS = [0.5, 0.75, 0.9, 0.99];

const pct = (p: number) => (p >= 0.9995 ? '100%' : p < 0.0005 ? '0%' : `${(p * 100).toFixed(p >= 0.995 || p < 0.01 ? 1 : 0)}%`);

/**
 * Commit slider for a blitz: how many armies to throw at the target (the rest stay home: stopAt), with the
 * exact chance to take it under ordinary dice and under balanced blitz, the expected losses, and how many armies
 * each common win chance needs. The odds come from the engine (blitzOdds), so they match how the server rolls.
 */
export function BlitzPlanner({
  fromArmies,
  toArmies,
  defenseLimit,
  balancedOn,
  commit,
  onCommit,
}: {
  fromArmies: number;
  toArmies: number;
  defenseLimit: number;
  balancedOn: boolean;
  commit: number;
  onCommit: (n: number) => void;
}) {
  const max = fromArmies - 1;
  const c = Math.max(1, Math.min(commit, max));
  const odds = useMemo(() => blitzOdds(fromArmies, toArmies, defenseLimit, fromArmies - c), [fromArmies, toArmies, defenseLimit, c]);
  // How many armies each win chance needs, for the mode this game uses.
  // Computed just after render: on very large stacks the search takes a moment and must not block the click.
  const [needed, setNeeded] = useState<{ t: number; n: number | null }[] | null>(null);
  useEffect(() => {
    setNeeded(null);
    const id = setTimeout(() => setNeeded(TARGETS.map((t) => ({ t, n: commitForOdds(fromArmies, toArmies, defenseLimit, t, balancedOn) }))), 0);
    return () => clearTimeout(id);
  }, [fromArmies, toArmies, defenseLimit, balancedOn]);
  return (
    <div className="blitz-planner">
      <label className="inline">
        Commit
        <input type="range" min={1} max={max} value={c} onChange={(e) => onCommit(Number(e.target.value))} />
        <span className="num">{c}</span>
        <span className="muted small">
          of {max} · {fromArmies - c} stay{c === max ? ' (all in)' : ''}
        </span>
      </label>
      <span className="blitz-odds">
        <span className={balancedOn ? 'muted' : 'active'} title="Chance to take it with ordinary random dice">
          Random <b>{pct(odds.win)}</b>
        </span>
        <span className={balancedOn ? 'active' : 'muted'} title="Chance to take it with balanced blitz (the middle of 5 real blitzes is played out)">
          Balanced <b>{pct(odds.balancedWin)}</b>
        </span>
        <span className="muted small" title="Average losses with ordinary dice">
          avg loss: you {odds.expectedAttackerLosses.toFixed(1)} · them {odds.expectedDefenderLosses.toFixed(1)}
        </span>
      </span>
      <span className="blitz-needs muted small">
        Commit for:{' '}
        {!needed && '…'}
        {needed?.map(({ t, n }) =>
          n === null ? (
            <span key={t} className="need none" title={`Even all ${max} armies give less than ${pct(t)}`}>
              {pct(t)}: n/a
            </span>
          ) : (
            <button key={t} className={`need small${n === c ? ' on' : ''}`} onClick={() => onCommit(n)} title={`Commit ${n} for at least ${pct(t)} (${balancedOn ? 'balanced' : 'random'})`}>
              {pct(t)}: {n}
            </button>
          ),
        )}
      </span>
    </div>
  );
}
