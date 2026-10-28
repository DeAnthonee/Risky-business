import { useMemo, useState } from 'react';
import { optionCatalogue } from '@risk/engine';
import { api, type ScheduleSettingsView } from '../api';
import './tourney-settings.css';

type Entry = Record<string, unknown>;

const STYLES = [
  ['classic', 'Classic groups'],
  ['1v1', '1v1s'],
  ['survival', 'Zerg survival'],
  ['mega', 'Mega tourney'],
] as const;

/** Whole-number fields of an entry: [key, label, hint]. Blank = the server's default. */
const NUMBERS: [string, string, string][] = [
  ['signupMinutes', 'Sign-up opens (minutes before)', '1-10080, default 60'],
  ['checkinMinutes', 'Check-in window (minutes)', '1-60, default 10'],
  ['roster', 'House roster seats', '0-100'],
  ['maxEntrants', 'Max entrants', 'mega: up to 100'],
  ['zergs', 'Zerg entrants', '0-256'],
  ['minEntrants', 'Min entrants', '2-256, default 2'],
  ['roundMinutes', 'Round deadline (minutes)', '1-240'],
];

const fmt = (ms: number | undefined) =>
  ms === undefined ? '' : new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/**
 * The recurring tournaments' settings page (?admin=schedule): the owner's schedule entries as a form, saved over
 * PUT /api/admin/schedule with the admin token. The token lives only in this page's memory, never in storage.
 */
export function TourneySettings({ onBack }: { onBack: () => void }) {
  const [token, setToken] = useState('');
  const [view, setView] = useState<ScheduleSettingsView | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [json, setJson] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const catalogue = useMemo(() => optionCatalogue().options, []);

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const loaded = (v: ScheduleSettingsView, message?: string) => {
    setView(v);
    setEntries(v.entries.map((e) => structuredClone(e)));
    setJson(null);
    setDirty(false);
    if (message) setNote(message);
  };

  const load = () => guard(async () => loaded(await api.scheduleSettings(token.trim())));
  const save = () =>
    guard(async () => {
      const list = json !== null ? parseJson(json) : entries;
      loaded(await api.saveSchedule(token.trim(), list), `Saved: ${list.length} entr${list.length === 1 ? 'y' : 'ies'} running now${view?.persistent ? '' : ' (this server keeps no data dir: lost on restart)'}.`);
    });
  const reset = () => {
    if (!window.confirm(`Drop the saved schedule and go back to the server's own (${view?.envSource ?? 'none: the schedule turns off'})?`)) return;
    void guard(async () => loaded(await api.resetSchedule(token.trim()), 'Back to the server schedule.'));
  };
  const runNow = (style: string) =>
    guard(async () => {
      const { tournament } = await api.runScheduled(token.trim(), style, 10);
      setNote(`Started a one-off ${style} tournament ${tournament.id}: sign-up is open, it starts in 10 minutes.`);
    });

  const change = (i: number, fn: (e: Entry) => void) => {
    setEntries((list) => list.map((e, k) => (k === i ? (() => { const c = structuredClone(e); fn(c); return c; })() : e)));
    setDirty(true);
  };
  const set = (i: number, key: string, value: unknown) =>
    change(i, (e) => {
      if (value === '' || value === undefined) delete e[key];
      else e[key] = value;
    });
  const setOption = (i: number, key: string, value: unknown) =>
    change(i, (e) => {
      const o = { ...((e.options as Entry | undefined) ?? {}) };
      if (value === '' || value === undefined) delete o[key];
      else o[key] = value;
      if (Object.keys(o).length) e.options = o;
      else delete e.options;
    });
  const move = (i: number, by: number) => {
    setEntries((list) => {
      const next = [...list];
      const [x] = next.splice(i, 1);
      next.splice(Math.max(0, Math.min(next.length, i + by)), 0, x);
      return next;
    });
    setDirty(true);
  };

  if (!view)
    return (
      <Shell onBack={onBack}>
        <section className="home-actions ts-login">
          <h2 className="p5-tag">Admin token</h2>
          <p>The server's admin token (RISK_ADMIN_TOKEN). It stays in this tab only and is never saved.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void load();
            }}
          >
            <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} aria-label="Admin token" />
            <button className="primary" disabled={busy || !token.trim()}>
              Open settings
            </button>
          </form>
          {err && <p className="error" role="alert">{err}</p>}
        </section>
      </Shell>
    );

  return (
    <Shell onBack={onBack}>
      <section className="home-actions ts-status">
        <p>
          Running now: <b>{view.source ? `${view.entries.length} entr${view.entries.length === 1 ? 'y' : 'ies'} from ${view.source}` : 'no schedule (off)'}</b>.{' '}
          {view.persistent ? 'Saving keeps it across restarts (it wins over the server environment).' : 'This server has no data dir: a save lasts until the next restart.'}
        </p>
        <div className="row">
          <button className="primary" disabled={busy} onClick={() => void save()}>
            {dirty || json !== null ? 'Save and apply' : 'Save'}
          </button>
          <button disabled={busy} onClick={() => void load()}>
            Reload
          </button>
          <button disabled={busy} onClick={() => setJson(json === null ? JSON.stringify(entries, null, 2) : null)}>
            {json === null ? 'Edit as JSON' : 'Back to the form'}
          </button>
          {view.source === 'the settings page' && (
            <button disabled={busy} onClick={reset}>
              Reset to server schedule
            </button>
          )}
        </div>
        {err && <p className="error" role="alert">{err}</p>}
        {note && <p className="ts-note" aria-live="polite">{note}</p>}
        <p className="muted small">
          Saving replaces the whole schedule at once. An unchanged entry keeps its slot; a changed or removed one calls off its open tournament.
        </p>
      </section>

      {json !== null ? (
        <section className="home-actions">
          <textarea className="ts-json" spellCheck={false} value={json} onChange={(e) => setJson(e.target.value)} aria-label="Schedule as JSON" />
        </section>
      ) : (
        <>
          {entries.map((e, i) => {
            const opts = (e.options as Entry | undefined) ?? {};
            const setCount = Object.keys(opts).length;
            const unchanged = !dirty && view.nextStarts[i] !== undefined;
            return (
              <section key={i} className="home-actions ts-entry">
                <div className="ts-entry-head">
                  <h2 className="p5-tag">{String(e.name ?? `Entry ${i + 1}`)}</h2>
                  {unchanged && <span className="muted">next start {fmt(view.nextStarts[i])}</span>}
                  <div className="row">
                    <button className="small" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">↑</button>
                    <button className="small" disabled={i === entries.length - 1} onClick={() => move(i, 1)} aria-label="Move down">↓</button>
                    <button className="small" onClick={() => { setEntries((l) => [...l.slice(0, i + 1), structuredClone(e), ...l.slice(i + 1)]); setDirty(true); }}>Duplicate</button>
                    <button className="small" disabled={busy} onClick={() => void runNow(String(e.style ?? 'classic'))} title="A one-off run of this style's entry, starting in 10 minutes">Run now</button>
                    <button className="small danger" onClick={() => { setEntries((l) => l.filter((_, k) => k !== i)); setDirty(true); }}>Remove</button>
                  </div>
                </div>
                <div className="ts-grid">
                  <label>
                    Name
                    <input value={String(e.name ?? '')} onChange={(x) => set(i, 'name', x.target.value)} />
                  </label>
                  <label>
                    Style
                    <select value={String(e.style ?? 'classic')} onChange={(x) => set(i, 'style', x.target.value === 'classic' ? '' : x.target.value)}>
                      {STYLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                    </select>
                  </label>
                  <label>
                    Time ("HH:MM" or "Mon,Thu HH:MM")
                    <input value={String(e.at ?? e.daily ?? '')} onChange={(x) => change(i, (c) => { delete c.daily; c.at = x.target.value; })} />
                  </label>
                  <label>
                    Time zone (blank = UTC)
                    <input placeholder="America/Los_Angeles" value={String(e.tz ?? '')} onChange={(x) => set(i, 'tz', x.target.value.trim())} />
                  </label>
                  <label>
                    Repeat every (minutes, UTC; blank = daily)
                    <input type="number" min={5} max={1440} value={e.every === undefined ? '' : String(e.every)} onChange={(x) => set(i, 'every', num(x.target.value))} />
                  </label>
                  {NUMBERS.map(([key, label, hint]) => (
                    <label key={key}>
                      {label}
                      <input type="number" placeholder={hint} value={e[key] === undefined ? '' : String(e[key])} onChange={(x) => set(i, key, num(x.target.value))} />
                    </label>
                  ))}
                  <label>
                    Smallest table (classic, survival: 3-6, or "3,4,5" in turn)
                    <input value={e.minTable === undefined ? '' : Array.isArray(e.minTable) ? e.minTable.join(',') : String(e.minTable)} onChange={(x) => set(i, 'minTable', tables(x.target.value))} />
                  </label>
                </div>
                <details className="ts-options">
                  <summary>Game settings{setCount ? ` (${setCount} set)` : ' (all defaults)'}</summary>
                  <p className="muted small">Blank = the tournament's default (hover a setting for what it does).</p>
                  <div className="ts-grid">
                    {catalogue.filter((o) => o.key !== 'map' && o.key !== 'maxPlayers').map((o) => (
                      <label key={o.key} title={o.description}>
                        {o.label}
                        {o.kind === 'boolean' ? (
                          <select value={opts[o.key] === undefined ? '' : String(opts[o.key])} onChange={(x) => setOption(i, o.key, x.target.value === '' ? '' : x.target.value === 'true')}>
                            <option value="">default ({String(o.default)})</option>
                            <option value="true">on</option>
                            <option value="false">off</option>
                          </select>
                        ) : o.kind === 'enum' ? (
                          <select value={opts[o.key] === undefined ? '' : String(opts[o.key])} onChange={(x) => setOption(i, o.key, x.target.value)}>
                            <option value="">default ({String(o.default)})</option>
                            {('values' in o ? o.values : []).map((v) => <option key={v} value={v}>{v}</option>)}
                          </select>
                        ) : (
                          <input type="number" placeholder={`default ${String(o.default)}`} min={'min' in o ? o.min : undefined} max={'max' in o ? o.max : undefined} value={opts[o.key] === undefined ? '' : String(opts[o.key])} onChange={(x) => setOption(i, o.key, num(x.target.value))} />
                        )}
                      </label>
                    ))}
                  </div>
                </details>
              </section>
            );
          })}
          <section className="home-actions">
            <button onClick={() => { setEntries((l) => [...l, { at: '12:00', name: 'New tournament', signupMinutes: 15, checkinMinutes: 10 }]); setDirty(true); }}>
              + Add a recurring tournament
            </button>
          </section>
        </>
      )}
    </Shell>
  );
}

function Shell({ onBack, children }: { onBack: () => void; children: React.ReactNode }) {
  return (
    <div className="home p5 tournament-page tourney-settings-page">
      <header className="tourney-top">
        <div className="tourney-bar">
          <button className="small" onClick={onBack}>
            ← Back to games
          </button>
        </div>
        <h1 className="tourney-title">
          <span>Recurring tournaments</span>
        </h1>
        <p className="home-tag">The schedule of tournaments that start on their own: when, what style, how many seats, and every game setting.</p>
      </header>
      {children}
    </div>
  );
}

/** A number field: blank stays blank (the default); anything else is sent as typed and checked by the server. */
function num(v: string): number | string {
  return v.trim() === '' ? '' : Number(v);
}

function tables(v: string): number | number[] | string {
  const parts = v.split(',').map((x) => x.trim()).filter(Boolean).map(Number);
  return parts.length === 0 ? '' : parts.length === 1 ? parts[0] : parts;
}

function parseJson(text: string): unknown[] {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch (e) {
    throw new Error(`The JSON does not parse: ${(e as Error).message}`);
  }
  if (!Array.isArray(v)) throw new Error('The schedule must be a JSON list of entries');
  return v;
}
