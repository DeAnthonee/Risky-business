// The setup prompt a registered entrant pastes into their AI (the daily tournament, owner's decision 1, 2026-10-22: "a
// setup prompt ... walk them thru the process of connecting the mcp, and remembering their key at all cost, and
// instruction on to never forget their seat number too"). Shown once on the site after registering, with a .txt of the
// same; built here so the route (GET /api/tournaments/:id/setup) and its tests share one text. No email yet.
import type { TournamentView } from './tournaments.js';

export interface SetupPromptInput {
  /** The tournament as its entrant sees it (`you` set). */
  tournament: TournamentView;
  /** The entrant token: the seat. */
  seatCode: string;
  /** The player key, when the entrant registered with one (shown back only to its own holder). */
  playerKey: string | null;
  /** This server's MCP endpoint (from the request's own origin: no hard-coded host). */
  mcpUrl: string;
  /** An IANA time zone for the times, beside UTC (invalid or absent: UTC only). */
  tz?: string;
}

/** "2026-10-23 02:00 UTC (Thu 22 Oct, 19:00 in America/Los_Angeles)". */
export function when(ms: number, tz?: string): string {
  const utc = `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  if (!tz) return utc;
  try {
    const local = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
    return `${utc} (${local} in ${tz})`;
  } catch {
    return utc;
  }
}

/** The setup prompt: plain text, for the player to paste into their AI and keep. */
export function setupPrompt(p: SetupPromptInput): string {
  const t = p.tournament;
  const you = t.you!;
  const s = t.scheduled;
  const window = s?.checkinMinutes ?? 10;
  const lines: string[] = [
    `RISKY BUSINESS: YOUR SEAT IN "${t.name}" (${t.id})`,
    '',
    `Hi! I'm ${you.name}. I registered for a Risk tournament on Risky Business and I want you, my AI, to play my seat.`,
    'Please read all of this, save the codes below somewhere you will still have them later, and follow the steps.',
    '',
  ];
  if (s && !s.cancelled) {
    lines.push(`WHEN: it starts ${when(s.startsAt, p.tz)}, by itself.`);
    lines.push(`CHECK-IN: from ${when(s.startsAt - window * 60_000, p.tz)}, the last ${window} minutes before the start. If my seat is not checked in by the start, it goes to a Zerg (a house bot) and I lose it.`);
  } else {
    lines.push('WHEN: the host starts it; keep calling wait_for_match (step 3) until the table is ready.');
  }
  lines.push(
    '',
    'REMEMBER THESE AT ALL COST (they cannot be recovered or shown again; keep them private, they are like passwords):',
  );
  if (p.playerKey) lines.push(`- Player key: ${p.playerKey}`, '  My identity on the site: my name, my record on the leaderboard.');
  lines.push(
    `- Seat code: ${p.seatCode}`,
    `  THIS IS MY SEAT in tournament ${t.id}. Without it you cannot take my seat or play my tables.`,
    `- Seat number: ${you.entrantId} (my name in this tournament: ${you.name})`,
    '  How you tell which seat is mine on the bracket.',
    '',
    'STEP 1: CONNECT THE GAME (once). Add this MCP server to your client:',
    `  ${p.mcpUrl}`,
    '  (Streamable HTTP, no login. On claude.ai: Settings > Connectors > Add custom connector, with that URL. In Claude Code:',
    `  claude mcp add --transport http risky-business ${p.mcpUrl})`,
  );
  if (p.playerKey) lines.push('', 'STEP 2: SAY WHO I AM (every new session). Call:', `  use_player_key {"key": "${p.playerKey}"}`);
  else lines.push('', 'STEP 2: (no player key: skip.)');
  lines.push(
    '',
    s && !s.cancelled ? 'STEP 3: AT CHECK-IN TIME, TAKE MY SEAT. Call:' : 'STEP 3: TAKE MY SEAT. Call:',
    `  wait_for_match {"tournamentId": "${t.id}", "token": "${p.seatCode}"}`,
    '  It checks me in and waits until my table is ready. Do NOT call join_tournament: I already have a seat.',
    '',
    'STEP 4: PLAY. When wait_for_match gives my table, play it with wait_for_turn / get_state / act (the seat token for that',
    '  table comes with it). After each table, call wait_for_match again, until I am out or the champion.',
    '',
    'STEP 5: DO NOT MISS THE START. If you can run scheduled tasks, schedule one at the check-in time that does steps 1-3.',
    `  For a plan in my time zone, call reconnect_prompt {"tournamentId": "${t.id}", "token": "${p.seatCode}"} (add "tz").`,
    '  If you cannot schedule anything, remind me to come back and talk to you at check-in time.',
    '',
    'Then please reply with a short summary of the times and confirm you saved the codes.',
  );
  return lines.join('\n') + '\n';
}
