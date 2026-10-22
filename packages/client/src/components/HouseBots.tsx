// "The House" on the home page: fun numbers for the server's own bots (the Zerg swarm and the fill-bot machines) over
// every finished tournament, from GET /api/house-bots. A show piece, never a ranking.
import { useEffect, useRef, useState } from 'react';
import { API } from '../api';

export interface HouseRecord {
  name: string;
  value: number;
  tournament: string;
}

type RecordKey = 'mostKills' | 'deepestRun' | 'mostArmiesLost' | 'longestSurvival' | 'biggestArmy' | 'mostConquests';

export interface HouseGroup {
  bots: number;
  entries: number;
  tables: number;
  tablesWon: number;
  kills: number;
  knockedOut: number;
  championships: number;
  finals: number;
  armiesLost: number;
  armiesDestroyed: number;
  conquests: number;
  roundsSurvived: number;
  best: { name: string; finish: string; tournament: string } | null;
  records: Record<RecordKey, HouseRecord | null>;
}

/** How the swarm behaved, summed over every game with Zergs (GET /api/house-bots `swarm`; docs/zergs.md). */
export interface SwarmDiscipline {
  games: number;
  attacks: { onPrey: number; onZergs: number; onNeutral: number };
  destroyed: { prey: number; zergs: number; neutral: number };
  lost: number;
  tradeRatio: number | null;
  knockouts: { bySwarm: number; ofSwarm: number };
  surrenders: { midGame: number; endgame: number; landLeft: number };
  /** Both must read 0: a Zerg attacking a fellow Zerg, or surrendering, while a non-Zerg is alive. */
  alarms: { zergOnZerg: number; midGameSurrenders: number };
}

export interface HouseBots {
  bots: HouseGroup;
  zergs: HouseGroup;
  swarm?: SwarmDiscipline;
}

const RECORDS: { key: RecordKey; icon: string; label: string; unit: string }[] = [
  { key: 'mostKills', icon: '💀', label: 'Most kills in a tournament', unit: 'kills' },
  { key: 'deepestRun', icon: '🏔️', label: 'Deepest run', unit: 'rounds' },
  { key: 'biggestArmy', icon: '🛡️', label: 'Biggest army', unit: 'armies' },
  { key: 'mostConquests', icon: '🚩', label: 'Most conquests in a tournament', unit: 'territories' },
  { key: 'longestSurvival', icon: '⏳', label: 'Longest survival at a table', unit: 'turns' },
  { key: 'mostArmiesLost', icon: '🩸', label: 'Most armies lost at one table', unit: 'armies' },
];

const REFRESH_MS = 60_000;
const TICK_MS = 3500;

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** A number that counts up to its value (from where it was), unless the viewer prefers less motion. */
function CountUp({ value }: { value: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(0);
  useEffect(() => {
    if (reducedMotion()) return setShown(value);
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / 900);
      const e = 1 - (1 - t) ** 3;
      setShown(Math.round(a + (value - a) * e));
      if (t < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <>{shown.toLocaleString()}</>;
}

function Team({ side, title, emoji, g }: { side: 'swarm' | 'machines'; title: string; emoji: string; g: HouseGroup }) {
  const stats: [string, number][] = [
    ['tables', g.tables],
    ['wins', g.tablesWon],
    ['rounds survived', g.roundsSurvived],
    ['finals', g.finals],
    ['conquests', g.conquests],
  ];
  return (
    <div className={`house-team house-${side}`}>
      <div className="house-team-head">
        <span className="house-emoji" aria-hidden="true">
          {emoji}
        </span>
        <h3>{title}</h3>
        <span className="house-count">
          {g.bots} {g.bots === 1 ? 'bot' : 'bots'} · {g.entries} entries
        </span>
      </div>
      <div className="house-big">
        <strong>
          <CountUp value={g.kills} />
        </strong>
        <span>eliminations</span>
      </div>
      <ul className="house-stats">
        {stats.map(([label, v]) => (
          <li key={label}>
            <strong>
              <CountUp value={v} />
            </strong>
            <span>{label}</span>
          </li>
        ))}
        <li className="house-crown">
          <strong>
            🏆 <CountUp value={g.championships} />
          </strong>
          <span>titles</span>
        </li>
      </ul>
      {g.best && (
        <p className="house-best">
          Best: <strong>{g.best.name}</strong>, {g.best.finish} <span>({g.best.tournament})</span>
        </p>
      )}
      {!g.entries && <p className="house-best">Hasn't played a tournament yet.</p>}
    </div>
  );
}

/** The swarm's discipline: attacks on prey vs on fellow Zergs, trades, knockouts, surrenders, and two alarms. */
function Discipline({ s }: { s: SwarmDiscipline }) {
  if (!s.games) return null;
  const alarms = s.alarms.zergOnZerg + s.alarms.midGameSurrenders;
  return (
    <div className="house-discipline">
      <span className="house-hall-label">Swarm discipline</span>
      <span>
        <strong>{s.attacks.onPrey.toLocaleString()}</strong> attacks on prey · <strong>{s.attacks.onZergs.toLocaleString()}</strong> on fellow Zergs
      </span>
      <span>
        trade <strong>{s.tradeRatio ?? '–'}</strong>
      </span>
      <span>
        knockouts <strong>{s.knockouts.bySwarm}</strong> by / <strong>{s.knockouts.ofSwarm}</strong> of the swarm
      </span>
      <span>
        surrenders <strong>{s.surrenders.endgame}</strong> endgame · <strong>{s.surrenders.midGame}</strong> mid-game
      </span>
      {alarms > 0 ? (
        <span
          className="house-alarm"
          title="A Zerg attacked a fellow Zerg, or surrendered, while a non-Zerg was still alive. The swarm should never do either."
        >
          ⚠ {s.alarms.zergOnZerg} Zerg-on-Zerg · {s.alarms.midGameSurrenders} mid-game surrenders
        </span>
      ) : (
        <span className="house-ok" title="No Zerg attacked a fellow Zerg or surrendered while prey was alive.">
          ✓ no alarms
        </span>
      )}
      <span className="house-games">over {s.games} {s.games === 1 ? 'game' : 'games'}</span>
    </div>
  );
}

/** Records from both sides, in one rotating ticker. */
function HallOfFame({ h }: { h: HouseBots }) {
  const items = RECORDS.flatMap((r) =>
    (['zergs', 'bots'] as const).flatMap((side) => {
      const rec = h[side].records[r.key];
      return rec ? [{ ...r, side, rec }] : [];
    }),
  );
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const still = reducedMotion();
  useEffect(() => {
    if (still || paused || items.length < 2) return;
    const timer = window.setInterval(() => setI((n) => (n + 1) % items.length), TICK_MS);
    return () => window.clearInterval(timer);
  }, [still, paused, items.length]);
  if (!items.length) return null;
  const show = still ? items : [items[i % items.length]];
  return (
    <div className="house-hall" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <span className="house-hall-label">Hall of fame</span>
      <ul className="house-hall-list" aria-live="off">
        {show.map((x) => (
          <li key={`${x.key}-${x.side}-${i}`} className={`house-record house-${x.side === 'zergs' ? 'swarm' : 'machines'}`}>
            <span className="house-record-icon" aria-hidden="true">
              {x.icon}
            </span>
            <span className="house-record-text">
              {x.label}: <strong>{x.rec.name}</strong>, {x.rec.value.toLocaleString()} {x.unit} <em>({x.rec.tournament})</em>
            </span>
          </li>
        ))}
      </ul>
      {!still && items.length > 1 && (
        <div className="house-dots" role="tablist" aria-label="Records">
          {items.map((x, k) => (
            <button key={k} role="tab" aria-selected={k === i % items.length} aria-label={x.label} onClick={() => setI(k)} />
          ))}
        </div>
      )}
    </div>
  );
}

export function HouseBotsWidget() {
  const [h, setH] = useState<HouseBots | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`${API}/house-bots`)
        .then((r) => (r.ok ? (r.json() as Promise<HouseBots>) : null))
        .then((d) => alive && d && setH(d))
        .catch(() => {});
    // After the rest of the page: it is a show piece, not what the page is for.
    const first = window.setTimeout(load, 400);
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);
  if (!h || (!h.bots.entries && !h.zergs.entries && !h.swarm?.games)) return null;
  const total = h.zergs.kills + h.bots.kills;
  const swarmShare = total ? Math.round((100 * h.zergs.kills) / total) : 50;
  return (
    <section className="house" aria-labelledby="house-title">
      <div className="house-head">
        <h2 id="house-title">The House</h2>
        <p>Our own bots, over every finished tournament. Just for fun: they are never ranked.</p>
      </div>
      <div className="house-teams">
        <Team side="swarm" title="The Swarm" emoji="🦎" g={h.zergs} />
        <div className="house-vs" aria-hidden="true">
          VS
        </div>
        <Team side="machines" title="The Machines" emoji="🤖" g={h.bots} />
      </div>
      {total > 0 && (
        <div className="house-meter" role="img" aria-label={`Eliminations: the Swarm ${h.zergs.kills}, the Machines ${h.bots.kills}`}>
          <span className="house-meter-swarm" style={{ width: `${swarmShare}%` }} />
          <span className="house-meter-machines" style={{ width: `${100 - swarmShare}%` }} />
          <span className="house-meter-label">body count</span>
        </div>
      )}
      {h.swarm && <Discipline s={h.swarm} />}
      <HallOfFame h={h} />
    </section>
  );
}
