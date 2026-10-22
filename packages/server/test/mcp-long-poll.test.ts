import { describe, expect, it } from 'vitest';
import { DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS, MemoryIdentityStore, createRiskMcpServer, waitSeconds, type RiskApi } from '@risk/mcp';

/** An MCP server over a fake API that records how long each long-poll was asked to wait. */
async function connect(api: Partial<RiskApi>, progressEveryMs?: number) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const server = createRiskMcpServer({ api: api as RiskApi, identities: new MemoryIdentityStore(), ...(progressEveryMs ? { progressEveryMs } : {}) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'long-poll', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const text = (r: unknown) => (r as { content: { text: string }[] }).content.map((c) => c.text).join('\n');

describe('MCP long-poll tools stay under proxy idle limits', () => {
  it('clamps every wait to MAX_WAIT_SECONDS (85 s) and defaults to 60 s', async () => {
    expect(MAX_WAIT_SECONDS).toBeLessThan(100);
    expect(DEFAULT_WAIT_SECONDS).toBeLessThanOrEqual(60);
    expect(waitSeconds(undefined)).toBe(DEFAULT_WAIT_SECONDS);
    expect(waitSeconds(110)).toBe(MAX_WAIT_SECONDS);
    expect(waitSeconds(30)).toBe(30);

    const asked: number[] = [];
    const client = await connect({
      wait: async (_id, _token, _since, timeoutMs) => {
        asked.push(timeoutMs);
        return { reason: 'timeout', yourTurn: false, state: null, events: [] } as never;
      },
    });
    try {
      // An agent still passing the old maximum gets the cap, not an error.
      const r = await client.callTool({ name: 'wait_for_turn', arguments: { gameId: 'ABC123', token: 't', timeoutSeconds: 110 } });
      // (The fake answers with no state; what matters is that 110 passed validation and reached the API capped.)
      expect(text(r)).not.toMatch(/Invalid arguments|less than or equal/i);
      await client.callTool({ name: 'wait_for_turn', arguments: { gameId: 'ABC123', token: 't' } });
      expect(asked).toEqual([MAX_WAIT_SECONDS * 1000, DEFAULT_WAIT_SECONDS * 1000]);
      // The descriptions tell agents a timeout is normal.
      const tools = (await client.listTools()).tools;
      for (const name of ['wait_for_turn', 'wait_for_match', 'quick_play']) {
        const tool = tools.find((t) => t.name === name)!;
        expect(tool.description, name).toMatch(/at most 85 s/);
        expect(tool.description, name).toMatch(/call again/);
        expect(JSON.stringify(tool.inputSchema), name).not.toContain('110');
      }
    } finally {
      await client.close();
    }
  });

  it('reports progress while it waits when the client asks for it', async () => {
    const client = await connect(
      {
        wait: async () => {
          await new Promise((r) => setTimeout(r, 200));
          return { reason: 'timeout', yourTurn: false, state: null, events: [] } as never;
        },
      },
      40,
    );
    try {
      const progress: { progress: number; message?: string }[] = [];
      const r = await client.callTool({ name: 'wait_for_turn', arguments: { gameId: 'ABC123', token: 't', timeoutSeconds: 5 } }, undefined, { onprogress: (p) => progress.push(p) });
      expect(text(r)).toBeTruthy();
      expect(progress.length).toBeGreaterThanOrEqual(2);
      expect(progress[0].message).toMatch(/waiting for your turn/);
      // No progress once the call has answered.
      const n = progress.length;
      await new Promise((res) => setTimeout(res, 150));
      expect(progress.length).toBe(n);
    } finally {
      await client.close();
    }
  });
});
