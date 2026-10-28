import { useLayoutEffect, useRef, useState } from 'react';
import type { TournamentView } from '../api';
import './bracket.css';

type Match = TournamentView['rounds'][number]['matches'][number];

/** One box of the bracket: a table that was or is being played, or one still to come (TBD). */
interface Cell {
  key: string;
  label: string;
  match: Match | null;
  /** A table to come: how many seats it will have. */
  seats?: number;
  /** The key of the box in a later column this table's winner goes to (null while it is not known yet). */
  next: string | null;
}

/**
 * Same split as the server's tableSizes (packages/server/src/tournaments.ts), only to draw the rounds still to come;
 * the server reshuffles the winners each round, so these boxes are placeholders until the round is built.
 */
function tableSizes(n: number, size: number): number[] {
  if (n <= 0) return [];
  const tables = Math.ceil(n / size);
  const base = Math.floor(n / tables);
  const extra = n % tables;
  return Array.from({ length: tables }, (_, i) => base + (i < extra ? 1 : 0));
}

function roundTitle(round: number, tables: number, last: boolean): string {
  return tables === 1 && round > 1 && last ? 'The final' : `Round ${round}`;
}

/**
 * The columns, left to right: the rounds played so far, then (knockout, still running) the rounds to come as TBD
 * boxes. Each box knows the box its winner goes to, and each column is ordered by those, so the lines never cross.
 */
export function bracketColumns(t: TournamentView): { title: string; cells: Cell[] }[] {
  const nodes = t.nested?.nodes ?? null;
  const cols: { round: number; cells: Cell[] }[] = t.rounds.map((r) => ({
    round: r.round,
    cells: r.matches.map((m, i) => ({ key: `r${r.round}-${i}`, label: !m.gameId ? 'Bye' : r.matches.length === 1 && r.round > 1 ? 'Final' : `Table ${i + 1}`, match: m, next: null })),
  }));
  // Where each winner went: the later table seating them (knockout), or the parent board's table (nested).
  for (let c = 0; c < cols.length; c++) {
    for (const cell of cols[c].cells) {
      const m = cell.match!;
      for (let d = c + 1; d < cols.length && !cell.next; d++) {
        const to =
          nodes && m.node !== undefined
            ? cols[d].cells.find((x) => x.match!.node !== undefined && x.match!.node === nodes[m.node!]?.parent)
            : m.winner
              ? cols[d].cells.find((x) => x.match!.players.some((p) => p.entrantId === m.winner))
              : undefined;
        if (to) cell.next = to.key;
      }
    }
  }
  // Knockout rounds to come: the winners of the last round split into tables again, until one table is left.
  if (t.status === 'running' && t.format !== 'nested' && cols.length) {
    let feeders = cols[cols.length - 1].cells;
    let round = cols[cols.length - 1].round;
    while (feeders.length > 1) {
      round++;
      const sizes = tableSizes(feeders.length, t.groupSize);
      const cells: Cell[] = sizes.map((seats, i) => ({ key: `r${round}-${i}`, label: seats === 1 ? 'Bye' : sizes.length === 1 ? 'Final' : `Table ${i + 1}`, match: null, seats, next: null }));
      let at = 0;
      sizes.forEach((seats, i) => {
        for (const f of feeders.slice(at, at + seats)) f.next = cells[i].key;
        at += seats;
      });
      cols.push({ round, cells });
      feeders = cells;
    }
  }
  // Order each column by where its boxes lead, from the right: boxes feeding the same table sit together.
  for (let c = cols.length - 2; c >= 0; c--) {
    const pos = new Map<string, number>();
    for (let d = c + 1; d < cols.length; d++) cols[d].cells.forEach((x, i) => pos.set(x.key, d * 10_000 + i));
    const rank = (x: Cell) => (x.next ? (pos.get(x.next) ?? Infinity) : Infinity);
    cols[c].cells = cols[c].cells.map((x, i) => ({ x, i })).sort((a, b) => rank(a.x) - rank(b.x) || a.i - b.i).map((e) => e.x);
  }
  return cols.map((col, c) => ({ title: roundTitle(col.round, col.cells.length, c === cols.length - 1), cells: col.cells }));
}

/**
 * A March Madness style bracket: rounds as columns from left to right, a line from every table to the table its winner
 * plays next, and the final at the far right. Scrolls sideways on a phone.
 */
export function Bracket({ t, onWatch }: { t: TournamentView; onWatch: (gameId: string) => void }) {
  const cols = bracketColumns(t);
  const wrap = useRef<HTMLDivElement>(null);
  const [lines, setLines] = useState<{ key: string; d: string; won: boolean; tbd: boolean }[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const youId = t.you?.entrantId;

  // The lines are drawn from where the boxes actually are, so they follow any wrapping or font size.
  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const draw = () => {
      const box = el.getBoundingClientRect();
      const at = (key: string) => el.querySelector<HTMLElement>(`[data-cell="${key}"]`)?.getBoundingClientRect();
      const out: typeof lines = [];
      for (const col of cols)
        for (const cell of col.cells) {
          if (!cell.next) continue;
          const a = at(cell.key);
          const b = at(cell.next);
          if (!a || !b) continue;
          const x1 = a.right - box.left + el.scrollLeft;
          const y1 = a.top + a.height / 2 - box.top;
          const x2 = b.left - box.left + el.scrollLeft;
          const y2 = b.top + b.height / 2 - box.top;
          const xm = x2 - 14;
          out.push({ key: cell.key, d: `M${x1},${y1} H${xm} V${y2} H${x2}`, won: !!cell.match?.winner, tbd: !cell.match || !cell.match.winner });
        }
      setLines(out);
      setSize({ w: el.scrollWidth, h: el.scrollHeight });
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    return () => ro.disconnect();
    // Redrawn whenever the tournament changes (its version) or the box resizes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t.version, t.rounds.length]);

  if (!cols.length) return <p className="muted">The bracket appears when the tournament starts.</p>;

  return (
    <div className="bracket" ref={wrap}>
      <svg className="bracket-lines" width={size.w} height={size.h} aria-hidden="true">
        {lines.map((l) => (
          <path key={l.key} d={l.d} className={l.won ? 'won' : l.tbd ? 'tbd' : ''} />
        ))}
      </svg>
      {cols.map((col, c) => (
        <section key={c} className="bracket-col" aria-label={col.title}>
          <h3 className="bracket-col-title">{col.title}</h3>
          <div className="bracket-cells">
            {col.cells.map((cell) => {
              const m = cell.match;
              const status = !m ? 'tbd' : m.status;
              const players = m ? (m.status === 'decided' && m.standing ? m.standing.order.map((id) => m.players.find((p) => p.entrantId === id)!).filter(Boolean) : m.players) : [];
              return (
                <div key={cell.key} data-cell={cell.key} className={`bracket-cell ${status}`}>
                  <div className="bracket-cell-head">
                    <strong>{cell.label}</strong>
                    <span className="bracket-status">{status === 'playing' ? 'LIVE' : status === 'tbd' ? 'TBD' : status === 'bye' ? 'moves on' : status === 'decided' ? 'on standing' : status === 'abandoned' ? 'abandoned' : 'done'}</span>
                  </div>
                  {m ? (
                    <ul>
                      {players.map((p) => (
                        <li key={p.entrantId} className={m.winner === p.entrantId ? 'won' : m.winner || m.status === 'abandoned' ? 'out' : ''}>
                          <span className="bracket-name">
                            {m.winner === p.entrantId ? '🏅 ' : ''}
                            {p.name}
                            {youId === p.entrantId ? ' (you)' : ''}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="bracket-tbd">{cell.seats === 1 ? 'A winner moves on' : `${cell.seats} winners`}</p>
                  )}
                  {m?.gameId && (
                    <button className="bracket-watch small" onClick={() => onWatch(m.gameId!)} title={`Watch ${m.players.map((p) => p.name).join(' vs ')}`}>
                      👁 Watch
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
