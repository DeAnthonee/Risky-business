import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { createRiskServer } from '../src/app.js';
import { placementPoints, rankTournaments, scoreTournament, type ScoredBracket } from '../src/tournament-scoring.js';

const ADMIN = 'board-admin';
const post = (body: unknown = {}): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

async function server(file: string | null) {
  const store = new Store(file);
  const risk = createRiskServer(store, { clientDir: null, adminToken: ADMIN, sweepIntervalMs: 0 });
  await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
  const call = async (path: string, init: RequestInit = {}, token?: string) => {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${base}/api${path}`, { ...init, headers });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { store, risk, base, call };
}

/** A knockout of 4 people at tables of 2, played out by forfeits: round 1 then a final. Returns ids by name. */
async function playKnockout(call: Awaited<ReturnType<typeof server>>['call']) {
  const id = (await call('/admin/tournaments', post({ name: 'Board Cup', groupSize: 2, fillBots: false }), ADMIN)).body.tournament.id;
  const entrants: Record<string, string> = {};
  for (const n of ['Ann', 'Bob', 'Cat', 'Dan']) entrants[n] = (await call(`/tournaments/${id}/join`, post({ playerName: n }))).body.entrantId;
  let t = (await call(`/admin/tournaments/${id}/start`, post(), ADMIN)).body.tournament;
  // Round 1: the first seat of each table forfeits.
  for (const m of t.rounds[0].matches) await call(`/admin/tournaments/${id}/forfeit`, post({ entrantId: m.players[0].entrantId }), ADMIN);
  t = (await call(`/tournaments/${id}`)).body.tournament;
  expect(t.rounds).toHaveLength(2);
  const final = t.rounds[1].matches[0];
  await call(`/admin/tournaments/${id}/forfeit`, post({ entrantId: final.players[0].entrantId }), ADMIN);
  t = (await call(`/tournaments/${id}`)).body.tournament;
  expect(t.status).toBe('finished');
  return { id, t, final };
}

describe('tournament scoring (owner decisions 18 and 20)', () => {
  it('placement: 3 per round survived, final places 2 apart, the champion +6', () => {
    // 100 seats, L = 3, final of 10 (the worked example).
    expect(placementPoints(3, 3, { place: 1, of: 10 }, true)).toBe(30);
    expect(placementPoints(3, 3, { place: 2, of: 10 }, false)).toBe(22);
    expect(placementPoints(3, 3, { place: 5, of: 10 }, false)).toBe(16);
    expect(placementPoints(3, 3, { place: 10, of: 10 }, false)).toBe(6);
    expect(placementPoints(3, 2, null, false)).toBe(3);
    expect(placementPoints(3, 1, null, false)).toBe(0);
    // A one-round event: L = 1.
    expect(placementPoints(1, 1, { place: 1, of: 6 }, true)).toBe(16);
    expect(placementPoints(1, 1, { place: 6, of: 6 }, false)).toBe(0);
  });

  it('scores a hand-built bracket: placement + 2 per table won (+1 if decided) + 1 per kill', () => {
    const bracket: ScoredBracket = {
      id: 'TBRK01',
      name: 'Hand',
      entrants: ['A', 'B', 'C', 'D', 'E', 'F'].map((id) => ({ id, name: `P${id}`, isBot: id === 'F', ...(id === 'F' ? { kind: 'zerg' } : {}) })),
      rounds: [
        {
          matches: [
            { entrants: ['A', 'B', 'C'], winner: 'A', status: 'finished', order: ['A', 'C', 'B'], kills: { A: 2 } },
            { entrants: ['D', 'E', 'F'], winner: 'D', status: 'decided', order: ['D', 'F', 'E'], kills: { F: 1 } },
          ],
        },
        { matches: [{ entrants: ['A', 'D'], winner: 'A', status: 'finished', order: ['A', 'D'], kills: { A: 1 } }] },
      ],
      champion: 'A',
    };
    const r = scoreTournament(bracket, 1)!;
    const by = Object.fromEntries(r.entrants.map((e) => [e.name, e]));
    // A: 3×1 + 2×1 + 6 = 11 placement, 2 tables × 2, 3 kills.
    expect(by.PA).toMatchObject({ placementPoints: 11, tablesWon: 2, tablePoints: 4, kills: 3, points: 18, champion: true, final: { place: 1, of: 2 } });
    // D: final 2nd of 2 = 3; a decided table win = +1.
    expect(by.PD).toMatchObject({ placementPoints: 3, tablesWon: 1, tablePoints: 1, kills: 0, points: 4, final: { place: 2, of: 2 } });
    expect(by.PB).toMatchObject({ placementPoints: 0, points: 0, round: 1, final: null });
    expect(by.PF).toMatchObject({ key: 'bot:pf', points: 1, kills: 1 });
    const rows = rankTournaments([r]);
    expect(rows.map((x) => x.name)).toEqual(['PA', 'PD', 'PF', 'PB', 'PC', 'PE']);
    expect(rows[0]).toMatchObject({ rank: 1, tournaments: 1, championships: 1, finals: 1, tablesWon: 2, kills: 3, bestFinish: 'champion' });
    expect(rows[1].bestFinish).toBe('2nd in the final');
    expect(rows[3].bestFinish).toBe('out in round 1');
  });

  it('built-in fill bots stay off the board; Zergs and a person named "Bot 1" score', () => {
    const bracket: ScoredBracket = {
      id: 'TFILL1',
      name: 'Fill',
      entrants: [
        { id: 'h', name: 'Bot 1', isBot: false },
        { id: 'z', name: 'Zerg 1', isBot: true, kind: 'zerg' },
        { id: 'f', name: 'Bot 2', isBot: true },
      ],
      rounds: [{ matches: [{ entrants: ['h', 'z', 'f'], winner: 'z', status: 'finished', order: ['z', 'h', 'f'], kills: { z: 1 } }] }],
      champion: 'z',
    };
    const r = scoreTournament(bracket, 1)!;
    expect(r.entrants.map((e) => e.key).sort()).toEqual(['bot:zerg 1', 'player:bot 1']);
    expect(rankTournaments([r]).map((x) => x.name)).toEqual(['Zerg 1', 'Bot 1']);
  });

  it('sums results over tournaments, sorted by points then championships', () => {
    const one = (id: string, champ: string, other: string): ScoredBracket => ({
      id,
      name: id,
      entrants: [champ, other].map((x) => ({ id: x, name: x, isBot: false })),
      rounds: [{ matches: [{ entrants: [champ, other], winner: champ, status: 'finished', order: [champ, other] }] }],
      champion: champ,
    });
    const rows = rankTournaments([scoreTournament(one('T1', 'x', 'y'))!, scoreTournament(one('T2', 'y', 'x'))!, scoreTournament(one('T3', 'x', 'y'))!]);
    expect(rows[0]).toMatchObject({ key: 'player:x', tournaments: 3, championships: 2 });
    expect(rows[0].points).toBeGreaterThan(rows[1].points);
  });
});

describe('the tournament leaderboard', () => {
  it('a finished knockout lands on the tournament board, never the public one', async () => {
    const { risk, call, store } = await server(null);
    try {
      const { id, t, final } = await playKnockout(call);
      const board = (await call('/rankings?board=tournament')).body;
      expect(board.board).toBe('tournament');
      expect(board.rankings).toHaveLength(4);
      const champion = t.champion.name.toLowerCase();
      expect(board.rankings[0]).toMatchObject({ key: `player:${champion}`, championships: 1, finals: 1, tablesWon: 2, bestFinish: 'champion' });
      // Champion of a 2-round knockout with finals of 2: 3 + 2 + 6 = 11, plus 2 tables = 15 (forfeits credit no kills).
      expect(board.rankings[0].points).toBe(15);
      const runnerUp = final.players.find((p: any) => p.name !== t.champion.name);
      expect(board.rankings[1]).toMatchObject({ name: runnerUp.name, points: 3 + 2, bestFinish: '2nd in the final' });
      expect(board.rankings.slice(2).map((r: any) => r.points)).toEqual([0, 0]);
      // The tables never count on the public board.
      expect((await call('/rankings')).body.rankings).toEqual([]);
      expect(store.rankings.rows()).toEqual([]);
      // One result per tournament, even if it is read again.
      expect(store.tournamentBoard.record(store.tournaments.get(id)!)).toBe(false);
      // Profiles.
      const p = (await call(`/rankings/profile?key=${encodeURIComponent(`player:${champion}`)}&board=tournament`)).body;
      expect(p).toMatchObject({ board: 'tournament', stats: { rank: 1, championships: 1, results: [{ tournamentId: id, finish: 'champion', points: 15 }] } });
      expect((await call('/rankings?board=nope')).status).toBe(400);
    } finally {
      await risk.shutdown('test');
    }
  });

  it('MCP leaderboard and ranked_profile read it with board "tournament"', async () => {
    const { risk, call, base } = await server(null);
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const client = new Client({ name: 'board', version: '0' });
    try {
      const { t } = await playKnockout(call);
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
      const tool = async (name: string, args: Record<string, unknown>) => ((await client.callTool({ name, arguments: args })) as { content: { text: string }[] }).content.map((c) => c.text).join('\n');
      const board = JSON.parse(await tool('leaderboard', { board: 'tournament' }));
      expect(board.rankings[0]).toMatchObject({ name: t.champion.name, championships: 1 });
      expect(await tool('ranked_profile', { key: `player:${t.champion.name.toLowerCase()}`, board: 'tournament' })).toContain('"championships": 1');
    } finally {
      await client.close();
      await risk.shutdown('test');
    }
  });

  it('survives a restart; the public and training files are untouched; old finished tournaments are not backfilled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'risk-tboard-'));
    const file = join(dir, 'games.json');
    try {
      // A tournament saved before the board existed: finished, but its tables have no scores.
      const now = Date.now();
      const old = {
        id: 'TOLD33', name: 'Old', status: 'finished', options: { map: 'skirmish' }, groupSize: 2, maxEntrants: 64, fillBots: false,
        entrants: [{ id: 'e1', name: 'X', isBot: false, joinedAt: now }, { id: 'e2', name: 'Y', isBot: false, joinedAt: now }],
        rounds: [{ round: 1, matches: [{ gameId: null, entrants: ['e1', 'e2'], seats: {}, winner: 'e1', status: 'finished' }] }],
        champion: 'e1', createdAt: now, updatedAt: now, version: 3,
      };
      writeFileSync(join(dir, 'tournaments.json'), JSON.stringify([old]));
      const first = await server(file);
      await playKnockout(first.call);
      await first.risk.shutdown('test');
      expect(existsSync(join(dir, 'rankings-tournament.json'))).toBe(true);
      const second = await server(file);
      try {
        const rows = (await second.call('/rankings?board=tournament')).body.rankings;
        expect(rows).toHaveLength(4);
        expect(rows.some((r: any) => r.name === 'X')).toBe(false);
        expect(second.store.tournamentBoard.has('TOLD33')).toBe(false);
        const publicFile = join(dir, 'rankings.json');
        expect(existsSync(publicFile) ? JSON.parse(readFileSync(publicFile, 'utf8')) : []).toEqual([]);
      } finally {
        await second.risk.shutdown('test');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('match history: ?board=tournament lists the tables, ?board=public leaves them out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'risk-tboard-hist-'));
    try {
      const { risk, call } = await server(join(dir, 'games.json'));
      try {
        await playKnockout(call);
        const all = (await call('/history')).body.games;
        expect(all.length).toBe(3);
        expect((await call('/history?board=tournament')).body.games).toHaveLength(3);
        expect((await call('/history?board=public')).body.games).toHaveLength(0);
        expect((await call('/history?board=training')).body.games).toHaveLength(0);
        expect((await call('/history?board=nope')).status).toBe(400);
      } finally {
        await risk.shutdown('test');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
