import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { Store } from '../src/store.js';
import { createRiskServer, type RiskServer } from '../src/app.js';
import { ogTags } from '../src/og.js';
import { tableLabel, type TournamentTableRef } from '../src/tournaments.js';

// Tournament tables are marked everywhere (tournament-hosting P1-C): the games list, the game socket's first state
// (the in-game banner) and link previews all carry {id, name, round, table, tables, final}.
let risk: RiskServer;
let base: string;
let tournamentId: string;
let tables: string[];

beforeAll(async () => {
  risk = createRiskServer(new Store(null), { clientDir: null, sweepIntervalMs: 0 });
  await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
  // A knockout of 4 bots at tables of 2: round 1 has two tables. Bots take their time, so both are still playing.
  const t = risk.store.tournaments.create({ name: 'Marked Cup', options: { map: 'skirmish' }, groupSize: 2, fillBots: false });
  tournamentId = t.id;
  risk.store.tournaments.addBots(t.id, 'bot', 4);
  risk.store.tournaments.start(t.id);
  tables = t.rounds[0].matches.map((m) => m.gameId!);
});
afterAll(async () => {
  await risk.shutdown('test');
});

describe('tournament table markings', () => {
  it('labels a table: "Round 2, table 3", a round of one table, the final', () => {
    expect(tableLabel({ round: 2, table: 3, tables: 4, final: false })).toBe('Round 2, table 3');
    expect(tableLabel({ round: 1, table: 1, tables: 1, final: false })).toBe('Round 1');
    expect(tableLabel({ round: 3, table: 1, tables: 1, final: true })).toBe('the final');
  });

  it('the games list carries the table ref; other games do not', async () => {
    const lobby = risk.store.create('Plain game', {}, 'Ann').room;
    const { games } = (await (await fetch(`${base}/api/games`)).json()) as { games: { id: string; tournament?: TournamentTableRef }[] };
    const marked = games.filter((g) => g.tournament);
    expect(marked.map((g) => g.id).sort()).toEqual([...tables].sort());
    const second = games.find((g) => g.id === tables[1])!;
    expect(second.tournament).toEqual({ id: tournamentId, name: 'Marked Cup', round: 1, table: 2, tables: 2, final: false });
    expect(games.find((g) => g.id === lobby.id)).not.toHaveProperty('tournament');
  });

  it('the game socket says which table it is in its first state', async () => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`);
    const first = await new Promise<any>((resolve, reject) => {
      ws.on('open', () => ws.send(JSON.stringify({ type: 'subscribe', gameId: tables[0], reqId: 'a' })));
      ws.on('message', (raw) => {
        const m = JSON.parse(String(raw));
        if (m.type === 'state' && m.reqId === 'a') resolve(m);
      });
      ws.on('error', reject);
    });
    ws.close();
    expect(first.tournament).toEqual({ id: tournamentId, name: 'Marked Cup', round: 1, table: 1, tables: 2, final: false });
  });

  it('the final is marked: the last round of one table (knockout), the plan\'s last round (nested)', () => {
    const t = risk.store.tournaments.get(tournamentId)!;
    // A knockout's later round with a single table is its final.
    t.rounds.push({ round: 2, matches: [{ ...t.rounds[0].matches[0], gameId: 'FINAL1' }] } as (typeof t.rounds)[number]);
    expect(risk.store.tournaments.tableOf(tournamentId, 'FINAL1')).toMatchObject({ round: 2, table: 1, final: true });
    t.rounds.pop();
    expect(risk.store.tournaments.tableOf(tournamentId, 'NOPE00')).toBeNull();
    expect(risk.store.tournaments.tableOf('TNONE1', tables[0])).toBeNull();
  });

  it('link previews of a table lead with the badge', () => {
    const { title, tags } = ogTags(risk.store, { game: tables[1] }, 'https://example.test');
    expect(title).toBe('🏆 Marked Cup · Round 1, table 2 · Risky Business');
    expect(tags).toContain('content="🏆 Marked Cup · Round 1, table 2. ');
    const plain = risk.store.create('Plain two', {}, 'Bob').room;
    expect(ogTags(risk.store, { game: plain.id }, 'https://example.test').title).toBe('Plain two · Risky Business');
  });
});
