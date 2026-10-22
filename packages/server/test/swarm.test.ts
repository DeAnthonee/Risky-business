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
  const client = new Client({ name: 'swarm', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const call = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
  };
  return { client, call };
}

const zergsIn = (gameId: string) => risk.store.get(gameId)!.state.players.filter((p) => p.isBot);

describe('swarm games for agents', () => {
  it('create_game with zergs: 3 seats three Zergs with pun names, in one call, with the swarm settings', async () => {
    const { client, call } = await mcp();
    try {
      const r = await call('create_game', { playerName: 'Cousin', zergs: 3, options: { capitals: true, blizzards: 4, autoSetup: true } });
      expect(r.isError).toBe(false);
      const id = r.text.match(/Created game (\w+)/)![1];
      expect(r.text).toMatch(/Seated 3 Zergs: /);
      const zergs = zergsIn(id);
      expect(zergs).toHaveLength(3);
      for (const z of zergs) expect(ZERG_NAMES.some((n) => z.name.startsWith(n))).toBe(true);
      expect(new Set(zergs.map((z) => z.name)).size).toBe(3);
      expect(risk.store.get(id)!.state.options).toMatchObject({ capitals: true, blizzards: 4, autoSetup: true });
      // The agent is told how: in the server instructions and the rules.
      expect(client.getInstructions()).toMatch(/SWARM GAME/);
      expect((await call('rules', {})).text).toMatch(/SWARM GAMES/);
      // And it starts.
      expect((await call('start_game', { gameId: id })).isError).toBe(false);
    } finally {
      await client.close();
    }
  });

  it('add_bot count adds several at once, all or none, within the free seats', async () => {
    const { client, call } = await mcp();
    try {
      const id = (await call('create_game', { playerName: 'Host', options: { maxPlayers: 5 } })).text.match(/Created game (\w+)/)![1];
      const two = await call('add_bot', { gameId: id, kind: 'zerg', count: 2 });
      expect(two.text).toMatch(/^Added 2 Zergs: /);
      expect(zergsIn(id)).toHaveLength(2);
      // Two seats left: asking for three adds none.
      const tooMany = await call('add_bot', { gameId: id, kind: 'zerg', count: 3 });
      expect(tooMany.isError).toBe(true);
      expect(tooMany.text).toMatch(/Only 2 free seats/);
      expect(zergsIn(id)).toHaveLength(2);
      expect((await call('add_bot', { gameId: id, count: 2 })).text).toMatch(/^Added 2 bots: /);
      expect(risk.store.get(id)!.state.players).toHaveLength(5);
      // create_game with more Zergs than seats fails clearly.
      const big = await call('create_game', { playerName: 'Greedy', zergs: 9 });
      expect(big.text).toMatch(/Only 5 free seats/);
    } finally {
      await client.close();
    }
  });

  it('POST /games/:id/bots takes count; a name only goes with a single bot', async () => {
    const created = (await (await fetch(`${base}/api/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ playerName: 'H' }) })).json()) as any;
    const post = (body: unknown) => fetch(`${base}/api/games/${created.gameId}/bots`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${created.token}` }, body: JSON.stringify(body) });
    const r = await post({ kind: 'zerg', count: 3 });
    expect(r.status).toBe(201);
    const body = (await r.json()) as any;
    expect(body.added).toHaveLength(3);
    expect(body.playerId).toBe(body.added[0].playerId);
    expect((await post({ count: 2, name: 'Bob' })).status).toBe(400);
    expect((await post({ count: 0 })).status).toBe(400);
    expect((await post({ count: 10 })).status).toBe(400);
    expect((await post({ count: 'many' })).status).toBe(400);
    // Without count: one, as before.
    const one = (await (await post({ name: 'Solo' })).json()) as any;
    expect(one).toMatchObject({ name: 'Solo', added: [{ name: 'Solo' }] });
  });
});
