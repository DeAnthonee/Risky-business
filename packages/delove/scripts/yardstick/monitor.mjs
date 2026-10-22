// Live yardstick, step 2: watch one game. When the Delove seat is knocked out (or the game finishes) it appends one
// line to $YARDSTICK_DIR/results.jsonl: Delove's place, leaderboard points (placement table + 1 per kill, as in
// packages/engine/src/ranking.ts), kills, the round, minutes, who knocked it out. If the game is still running it then
// closes the room with the host token (a closed room is never ranked), so the remaining seats stop. It also lists the
// seats that attacked Delove in rounds 1-2 (attackersRounds1to2) and saves the event stream as ev-<gameId>.json.
// usage: node packages/delove/scripts/yardstick/monitor.mjs <server> <gameId> <deloveSeatName> <label>
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [server, gameId, deloveName, label] = process.argv.slice(2);
if (!server || !gameId || !deloveName) throw new Error('usage: monitor.mjs <server> <gameId> <deloveSeatName> <label>');
const dir = process.env.YARDSTICK_DIR || join(homedir(), 'risk-yardstick');
const hostToken = JSON.parse(readFileSync(join(dir, `host-${gameId}.json`), 'utf8')).token;
// Placement points by table size (docs/character-league.md).
const TABLE = {
  2: [1, -1], 3: [1, 0, -1], 4: [2, 1, -1, -2], 5: [2, 1, 0, -1, -2], 6: [3, 2, 1, -1, -2, -3],
  7: [3, 2, 1, 0, -1, -2, -3], 8: [4, 3, 2, 1, -1, -2, -3, -4], 9: [4, 3, 2, 1, 0, -1, -2, -3, -4],
  10: [5, 4, 3, 2, 1, -1, -2, -3, -4, -5],
};
const get = async (path) => (await fetch(`${server}/api${path}`)).json();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (;;) {
  let state, entries;
  try {
    state = (await get(`/games/${gameId}`)).state;
    entries = (await get(`/games/${gameId}/events?since=0`)).entries;
  } catch (e) {
    console.log(`poll failed (${e.message}); retrying`);
    await sleep(20000);
    continue;
  }
  if (!state) { console.log('game gone'); break; }
  const name = Object.fromEntries(state.players.map((p) => [p.id, p.name]));
  const delove = state.players.find((p) => p.name === deloveName);
  if (!delove) throw new Error(`no seat named ${deloveName}`);
  const elims = entries.flatMap((e) => e.events ?? []).filter((x) => x.type === 'eliminated');
  const out = elims.findIndex((x) => x.player === delove.id);
  const finished = state.phase === 'finished';
  if (out >= 0 || finished) {
    const n = state.players.filter((p) => !p.isNeutral).length;
    let place;
    if (out >= 0) place = n - out; // the k-th player knocked out (from 0) places n - k
    else if (state.winner === delove.id) place = 1;
    else {
      // Alive at the end without winning: survivors rank by territories, then armies.
      const alive = state.players.filter((p) => p.alive && p.id !== state.winner)
        .sort((a, b) => b.territoryCount - a.territoryCount || b.armyCount - a.armyCount);
      place = 2 + alive.findIndex((p) => p.id === delove.id);
    }
    const kills = elims.filter((x) => x.by === delove.id).map((x) => name[x.player]);
    // Who attacked Delove in rounds 1-2: a turn starts when another seat acts, so the first 2n turns (n seats).
    let turn = -1, last = null;
    const early = new Set();
    for (const e of entries) {
      if (!e.playerId || e.action?.type === 'system') continue;
      if (e.playerId !== last) { turn++; last = e.playerId; }
      if (turn >= 2 * state.players.filter((p) => !p.isNeutral).length) break;
      for (const ev of e.events ?? []) if (ev.type === 'battle' && ev.defender === delove.id) early.add(name[ev.attacker]);
    }
    const result = {
      label, gameId, date: new Date().toISOString(), map: state.options.map, options: state.options, players: n,
      delove: deloveName, place, placementPoints: TABLE[n][place - 1], points: TABLE[n][place - 1] + kills.length, kills,
      round: state.round, turn: state.turnNumber, minutes: Math.round((Date.now() - state.startedAt) / 60000),
      eliminatedBy: out >= 0 ? name[elims[out].by] : null, winner: state.winner ? name[state.winner] : null, finished,
      attackersRounds1to2: [...early],
      eliminations: elims.map((x) => ({ player: name[x.player], by: name[x.by] })),
      opponents: state.players.filter((p) => p.id !== delove.id).map((p) => p.name),
    };
    appendFileSync(join(dir, 'results.jsonl'), JSON.stringify(result) + '\n');
    // The whole event stream, for review play by play: a room closed here never gets an archive record.
    writeFileSync(join(dir, `ev-${gameId}.json`), JSON.stringify({ entries }));
    console.log('RESULT', JSON.stringify(result));
    if (!finished) {
      const res = await fetch(`${server}/api/games/${gameId}/close`, { method: 'POST', headers: { Authorization: `Bearer ${hostToken}` } });
      console.log('closed room:', res.status);
    }
    break;
  }
  await sleep(20000);
}
