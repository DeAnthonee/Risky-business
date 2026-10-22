// A human-readable play-by-play of a finished game record, turn by turn: reinforcements, card trades, attacks,
// conquests, fortifies, knockouts, surrenders and the end. Pure: it only reads the record. Served behind the records
// key (GET /api/records/:id/playbyplay), since a record holds hidden hands and boards; see docs/game-records.md.
import { getMap, type GameEvent, type GameRecord, type PlayerId, type RecordStep } from '@risk/engine';

/**
 * A decision note on a step (G1: why a model chose its move). The shape is tolerant until G1 fixes it: the known
 * fields are rendered as a line, and anything else is shown as JSON.
 */
export interface StepNote {
  text?: string;
  chose?: string;
  score?: number;
  alternatives?: { label: string; score: number }[];
  value?: number;
}

export interface PlayByPlayTurn {
  turn: number;
  round: number;
  player: string;
  lines: string[];
}

export interface PlayByPlay {
  header: string[];
  setup: string[];
  turns: PlayByPlayTurn[];
  end: string[];
}

export interface NarrateOptions {
  /** Extra header lines (e.g. the Zerg summary, from a later PR). */
  summary?: (record: GameRecord) => string[];
}

const num = (x: number) => (Math.round(x * 100) / 100).toString().replace(/^0\./, '.');

/** One decision note as a line ("↳ Delove chose Peru (.62) over Chile (.58), value .41"). */
export function noteLine(who: string, note: unknown): string {
  if (note === null || note === undefined) return '';
  if (typeof note === 'string') return `  ↳ ${note}`;
  const n = note as StepNote;
  const parts: string[] = [];
  if (n.chose) parts.push(`${who} chose ${n.chose}${n.score !== undefined ? ` (${num(n.score)})` : ''}`);
  if (n.alternatives?.length) parts.push(`over ${n.alternatives.map((a) => `${a.label} (${num(a.score)})`).join(', ')}`);
  let line = parts.join(' ');
  if (n.value !== undefined) line += `${line ? ', ' : ''}value ${num(n.value)}`;
  if (n.text) line += `${line ? ': ' : ''}${n.text}`;
  return `  ↳ ${line || JSON.stringify(note)}`;
}

/** The play-by-play of a game record, as structured lines. */
export function narrate(record: GameRecord, opts: NarrateOptions = {}): PlayByPlay {
  let map: ReturnType<typeof getMap> | null = null;
  try {
    map = getMap(record.map);
  } catch {
    map = null;
  }
  const where = (t: string) => map?.territoryById[t]?.name ?? t;
  const who = (p: PlayerId | null | undefined) => (p ? (record.players.find((x) => x.id === p)?.name ?? p) : 'nobody');
  const armiesOn = (s: RecordStep, t: string) => s.board[record.territories.indexOf(t)]?.[1] ?? 0;

  const seats = record.players.filter((p) => !p.isNeutral);
  const winner = record.outcome.winner ? who(record.outcome.winner) : null;
  const header = [
    `${record.room.name} (${record.room.id}): ${map?.name ?? record.map}, ${seats.length} players${record.fog ? ', fog of war' : ''}`,
    `Players: ${seats.map((p) => p.name).join(', ')}`,
    winner ? `Winner: ${winner}${record.outcome.reason ? ` (${record.outcome.reason})` : ''} after ${record.turns.length} turns` : `Not finished${record.outcome.endedBecause ? `: ${record.outcome.endedBecause}` : ''}`,
    ...(opts.summary ? opts.summary(record) : []),
  ];

  const setup: string[] = [];
  const turns: PlayByPlayTurn[] = [];
  const end: string[] = [];
  const byTurn = new Map<number, PlayByPlayTurn>();
  for (const t of record.turns) {
    const entry = { turn: t.turn, round: t.round, player: who(t.player), lines: [`+${t.reinforcements} armies`] };
    byTurn.set(t.turn, entry);
    turns.push(entry);
  }

  // Setup placements are summarised per player, not listed one by one.
  const setupArmies = new Map<string, number>();
  for (const s of record.steps) {
    const me = who(s.player);
    const out = s.phase === 'setup' ? null : (byTurn.get(s.turn)?.lines ?? end);
    const line = describe(s, me);
    if (s.phase === 'setup' && s.action.type === 'place') {
      const n = Object.values(s.action.placements ?? {}).reduce((a, b) => a + b, 0);
      setupArmies.set(me, (setupArmies.get(me) ?? 0) + n);
    } else if (out && line) out.push(line);
    else if (!out && line && s.action.type !== 'place') setup.push(line);
    const note = (s as RecordStep & { note?: unknown }).note;
    if (note !== undefined && out) out.push(noteLine(me, note));
    for (const e of s.events) {
      const extra = eventLine(e);
      if (extra) (out ?? setup).push(extra);
    }
  }
  for (const [p, n] of setupArmies) setup.unshift(`${p} places ${n} armies in setup`);

  function describe(s: RecordStep, me: string): string {
    const a = s.action;
    // The turn timer (#174) marks steps it made for the player; read tolerantly so older engines still type-check.
    const timed = (s as RecordStep & { timeout?: true }).timeout ? ' (timed out)' : '';
    switch (a.type) {
      case 'place': {
        const list = Object.entries(a.placements ?? {}).map(([t, n]) => `${n} on ${where(t)}`);
        return list.length ? `${me} places ${list.join(', ')}${timed}` : '';
      }
      case 'trade': {
        const traded = s.events.find((e) => e.type === 'traded') as Extract<GameEvent, { type: 'traded' }> | undefined;
        return traded ? `${me} trades ${traded.cards.length} cards for ${traded.armies} armies${traded.bonusTerritory ? ` (+2 on ${where(traded.bonusTerritory)})` : ''}` : `${me} trades cards`;
      }
      case 'attack': {
        const battles = s.events.filter((e) => e.type === 'battle') as Extract<GameEvent, { type: 'battle' }>[];
        if (!battles.length) return `${me} attacks ${where(a.to)} from ${where(a.from)}`;
        const lostA = battles.reduce((n, b) => n + b.attackerLosses, 0);
        const lostD = battles.reduce((n, b) => n + b.defenderLosses, 0);
        const won = s.events.some((e) => e.type === 'conquered');
        const defender = who(battles[0].defender);
        return `${me} attacks ${where(a.to)} (${defender}) from ${where(a.from)}, ${armiesOn(s, a.from)} vs ${armiesOn(s, a.to)}: ${battles.length} ${battles.length === 1 ? 'roll' : 'rolls'}, loses ${lostA}, kills ${lostD}${won ? ', conquers' : ''}${timed}`;
      }
      case 'occupy':
        return `${me} moves ${a.armies} in`;
      case 'fortify':
        return `${me} fortifies ${a.armies} from ${where(a.from)} to ${where(a.to)}${timed}`;
      case 'choose_capital':
        return `${me} picks ${where(a.territory)} as capital`;
      case 'surrender':
        return `${me} surrenders`;
      case 'end_attack':
      case 'end_turn':
        return timed ? `${me} ends the turn${timed}` : '';
      default:
        return '';
    }
  }

  function eventLine(e: GameEvent): string {
    switch (e.type) {
      case 'eliminated':
        return e.by ? `  ✖ ${who(e.player)} is knocked out by ${who(e.by)}` : `  ✖ ${who(e.player)} is out (surrendered)`;
      case 'cards_taken':
        return `  ${who(e.player)} takes ${e.count} cards from ${who(e.from)}`;
      case 'capital_captured':
        return `  ★ ${who(e.player)} captures ${who(e.previousOwner)}'s capital ${where(e.territory)}`;
      case 'game_over':
        return `Game over: ${who(e.winner)} wins${e.reason ? ` by ${e.reason}` : ''}`;
      default:
        return '';
    }
  }

  return { header, setup, turns, end };
}

/** The play-by-play as plain text. */
export function playByPlayText(p: PlayByPlay): string {
  const out = [...p.header, ''];
  if (p.setup.length) out.push('Setup', ...p.setup.map((l) => `  ${l}`), '');
  for (const t of p.turns) {
    if (t.lines.length <= 1) continue;
    out.push(`t${t.turn} (round ${t.round}) ${t.player}: ${t.lines[0]}`, ...t.lines.slice(1).map((l) => `  ${l}`));
  }
  if (p.end.length) out.push('', ...p.end);
  return out.join('\n') + '\n';
}
