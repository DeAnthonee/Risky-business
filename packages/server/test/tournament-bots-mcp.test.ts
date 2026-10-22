import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { createRiskServer, type RiskServer } from '../src/app.js';
import { ZERG_NAMES } from '../src/bot.js';

let risk: RiskServer;
let base: string;

beforeEach(async () => {
  risk = createRiskServer(new Store(null), { clientDir: null, sweepIntervalMs: 0 });
  await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await risk.shutdown('test');
});

async function mcp() {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'tbots', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
  };
  return { client, call };
}

describe('MCP add_tournament_bots', () => {
  it('the host seats Zergs in one call with the host token its connection holds', async () => {
    const host = await mcp();
    try {
      const created = await host.call('create_tournament', { name: 'Swarm Cup', groupSize: 4, fillBots: false });
      const id = created.text.match(/Created tournament (\w+)/)![1];
      const r = await host.call('add_tournament_bots', { tournamentId: id.toLowerCase(), kind: 'zerg', count: 3 });
      expect(r.isError).toBe(false);
      expect(r.text).toMatch(/^Added 3 Zergs: /);
      const t = risk.store.tournaments.get(id)!;
      expect(t.entrants).toHaveLength(3);
      expect(t.entrants.every((e) => e.isBot && e.kind === 'zerg')).toBe(true);
      for (const e of t.entrants) expect(ZERG_NAMES.some((n) => e.name.startsWith(n))).toBe(true);
      // Built-in bots too (the default kind).
      expect((await host.call('add_tournament_bots', { tournamentId: id })).text).toMatch(/^Added 1 bot: Bot /);
      const tool = (await host.client.listTools()).tools.find((x) => x.name === 'add_tournament_bots')!;
      expect(tool.description).toMatch(/pass kind "zerg" to add Zergs/);
      expect(t.entrants.filter((e) => e.isBot && !e.kind)).toHaveLength(1);
    } finally {
      await host.client.close();
    }
  });

  it('mirrors the HTTP rules: host only, within maxEntrants, only before the start', async () => {
    const host = await mcp();
    const other = await mcp();
    try {
      const created = await host.call('create_tournament', { name: 'Small Cup', groupSize: 2, maxEntrants: 4, fillBots: false });
      const id = created.text.match(/Created tournament (\w+)/)![1];
      const hostToken = created.text.match(/HOST TOKEN: (\S+)/)![1];
      // Another connection: no token, then a wrong one, then the right one.
      expect((await other.call('add_tournament_bots', { tournamentId: id, kind: 'zerg' })).text).toMatch(/needs its host token/);
      expect((await other.call('add_tournament_bots', { tournamentId: id, kind: 'zerg', hostToken: 'nope' })).text).toMatch(/Only this tournament's host can add bots/);
      expect((await other.call('add_tournament_bots', { tournamentId: id, kind: 'zerg', count: 2, hostToken })).isError).toBe(false);
      // maxEntrants: 2 seated, 3 more would pass 4; nothing is added.
      const over = await host.call('add_tournament_bots', { tournamentId: id, kind: 'zerg', count: 3 });
      expect(over.isError).toBe(true);
      expect(over.text).toMatch(/pass the tournament's 4 entrants/);
      expect(risk.store.tournaments.get(id)!.entrants).toHaveLength(2);
      // Unknown tournament.
      expect((await host.call('add_tournament_bots', { tournamentId: 'TNOPE1', kind: 'zerg' })).text).toMatch(/Tournament not found/);
      // After the start: registration is closed.
      expect((await host.call('start_tournament', { tournamentId: id })).isError).toBe(false);
      expect((await host.call('add_tournament_bots', { tournamentId: id, kind: 'zerg' })).text).toMatch(/Registration is closed/);
    } finally {
      await host.client.close();
      await other.client.close();
    }
  });
});
