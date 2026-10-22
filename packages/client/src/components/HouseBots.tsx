// The house-bot panel beside the tournament board: fun numbers for the server's own bots, never a ranking. Fill bots
// are not ranked at all; Zergs are ranked like anyone and only appear here for their numbers.

export interface HouseRecord {
  name: string;
  value: number;
  tournament: string;
}

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
  best: { name: string; finish: string; tournament: string } | null;
  records: Record<'mostKills' | 'mostArmiesLost' | 'longestSurvival' | 'biggestArmy' | 'mostConquests', HouseRecord | null>;
}

export interface HouseBots {
  bots: HouseGroup;
  zergs: HouseGroup;
}

const RECORDS: { key: keyof HouseGroup['records']; label: string; unit: string }[] = [
  { key: 'mostKills', label: 'Most kills in a tournament', unit: 'kills' },
  { key: 'mostArmiesLost', label: 'Most armies lost at one table', unit: 'armies' },
  { key: 'longestSurvival', label: 'Longest survival at a table', unit: 'turns' },
  { key: 'biggestArmy', label: 'Biggest army', unit: 'armies' },
  { key: 'mostConquests', label: 'Most conquests in a tournament', unit: 'territories' },
];

function Group({ title, g, note }: { title: string; g: HouseGroup; note: string }) {
  if (!g.entries) return null;
  const tiles: [string, number][] = [
    ['tables played', g.tables],
    ['tables won', g.tablesWon],
    ['eliminations', g.kills],
    ['knocked out', g.knockedOut],
    ['finals', g.finals],
    ['championships', g.championships],
    ['armies lost', g.armiesLost],
    ['enemy armies destroyed', g.armiesDestroyed],
    ['conquests', g.conquests],
  ];
  return (
    <div className="house-group">
      <h4>
        {title} <span className="muted small">· {g.bots} bots, {g.entries} entries · {note}</span>
      </h4>
      <div className="house-tiles">
        {tiles.map(([label, v]) => (
          <div key={label} className="house-tile">
            <strong>{v.toLocaleString()}</strong>
            <span>{label}</span>
          </div>
        ))}
      </div>
      {g.best && (
        <p className="small">
          Best finish: <strong>{g.best.name}</strong>, {g.best.finish} ({g.best.tournament})
        </p>
      )}
      <ul className="house-records">
        {RECORDS.map(({ key, label, unit }) => {
          const r = g.records[key];
          return r ? (
            <li key={key}>
              {label}: <strong>{r.name}</strong>, {r.value.toLocaleString()} {unit} <span className="muted small">({r.tournament})</span>
            </li>
          ) : null;
        })}
      </ul>
    </div>
  );
}

export function HouseBotsPanel({ h }: { h: HouseBots }) {
  if (!h.bots.entries && !h.zergs.entries) return null;
  return (
    <aside className="house-bots" aria-label="House bots">
      <h3>House bots</h3>
      <p className="small muted">Fun numbers for the server's own bots over every finished tournament. Nothing here is ranked.</p>
      <Group title="Fill bots" g={h.bots} note="not on the board" />
      <Group title="Zergs" g={h.zergs} note="ranked like anyone" />
    </aside>
  );
}
