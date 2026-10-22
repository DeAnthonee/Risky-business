import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpRiskApi } from '@risk/mcp';
import { seededRandom } from '@risk/selfplay';
import type { RiskServer } from '../../server/src/app.js';
import { jacob, teacher } from '../src/index.js';
import { latencySummary, playEntrant } from '../src/tournament-seat.js';

let risk: RiskServer;
let api: HttpRiskApi;

beforeAll(async () => {
  process.env.RISK_BOT_DELAY_MS = '0'; // read when the server's store loads: import it after setting it
  const { Store } = await import('../../server/src/store.js');
  const { createRiskServer } = await import('../../server/src/app.js');
  risk = createRiskServer(new Store(null), { clientDir: null, sweepIntervalMs: 0 });
  await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
  api = new HttpRiskApi(`http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`);
});
afterAll(() => {
  risk.server.close();
});

describe('Delove tournament entrants (playEntrant)', () => {
  it('several entrants play a whole knockout: every table they are given, until out or champion', async () => {
    const { hostToken, tournament } = await api.createTournament(undefined, { name: 'Delove cup', groupSize: 3, maxEntrants: 9, fillBots: true, options: { map: 'skirmish' } });
    const joined = await Promise.all(['Delove 1', 'Delove 2', 'Delove 3', 'Delove 4', 'Delove 5'].map((n) => api.joinTournament(tournament.id, n)));
    const decisions: number[] = [];
    const logs: string[] = [];
    const runs = joined.map((j, i) =>
      playEntrant({ api, tournamentId: tournament.id, entrantToken: j.token, name: `Delove ${i + 1}`, agent: i % 2 ? jacob : teacher, paceMs: 0,
        log: (l) => logs.push(l), random: seededRandom(i + 1), onDecision: (ms) => decisions.push(ms), waitMs: 2000 }),
    );
    await api.startTournament(hostToken, tournament.id);
    const results = await Promise.all(runs);
    const t = (await api.getTournament(tournament.id)).tournament;
    expect(t.status).toBe('finished');
    expect(results.every((r) => ['champion', 'out', 'finished'].includes(r.status))).toBe(true);
    expect(results.filter((r) => r.status === 'champion').length).toBe(t.champion && t.champion.name.startsWith('Delove') ? 1 : 0);
    // every entrant played round 1 (5 entrants + 1 bot = two tables of 3), and a winner played on
    expect(results.every((r) => r.tables >= 1)).toBe(true);
    expect(results.reduce((a, r) => a + r.tables, 0)).toBeGreaterThanOrEqual(5);
    expect(decisions.length).toBeGreaterThan(50);
    expect(latencySummary(decisions).max).toBeLessThan(5000);
    expect(logs.some((l) => /round 1, table/.test(l))).toBe(true);
  }, 120_000);

  it('a deleted tournament ends the entrant instead of waiting forever', async () => {
    const { hostToken, tournament } = await api.createTournament(undefined, { name: 'Gone cup', groupSize: 2 });
    const j = await api.joinTournament(tournament.id, 'Delove');
    const run = playEntrant({ api, tournamentId: tournament.id, entrantToken: j.token, name: 'Delove', agent: teacher, paceMs: 0, log: () => {}, waitMs: 1000 });
    await deleteTournament(tournament.id, hostToken);
    expect((await run).status).toBe('gone');
  }, 30_000);
});

async function deleteTournament(id: string, key: string) {
  const port = (risk.server.address() as AddressInfo).port;
  const r = await fetch(`http://127.0.0.1:${port}/api/tournaments/${id}`, { method: 'DELETE', headers: { authorization: `Bearer ${key}` } });
  expect(r.status).toBeLessThan(300);
}
