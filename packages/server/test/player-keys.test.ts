import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';
import { createRiskServer, type RiskServer } from '../src/app.js';
import { PlayerKeyStore } from '../src/player-keys.js';

const ADMIN = 'keys-admin';
let dir: string;
let risk: RiskServer;
let base: string;

async function serve(store: Store) {
  risk = createRiskServer(store, { clientDir: null, adminToken: ADMIN, sweepIntervalMs: 0 });
  await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
}
async function call(path: string, opts: { body?: unknown; key?: string; token?: string; method?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.key) headers['x-player-key'] = opts.key;
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${base}/api${path}`, { method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'), headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
  const raw = await res.text();
  return { status: res.status, headers: res.headers, raw, body: raw ? JSON.parse(raw) : {} };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'risk-keys-'));
  await serve(new Store(join(dir, 'games.json')));
});
afterEach(async () => {
  risk.store.stopTimers();
  for (const room of risk.store.rooms.values()) room.stopBot();
  await risk.shutdown('test');
  rmSync(dir, { recursive: true, force: true });
});

describe('player keys', () => {
  it('issues a 192-bit key once, stores only its hash, and reads it from the header only', async () => {
    const r = await call('/players', { body: { name: 'Ada Lovelace' } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: 'Ada Lovelace', playerId: expect.stringMatching(/^pk_/) });
    const key = r.body.key as string;
    expect(key).toMatch(/^rk_[A-Za-z0-9_-]{32}$/);
    // Stored as a hash: the file never holds the key.
    const saved = readFileSync(join(dir, 'player-keys.json'), 'utf8');
    expect(saved).not.toContain(key);
    expect(saved).toContain('Ada Lovelace');
    expect((await call('/players/me', { key })).body).toMatchObject({ playerId: r.body.playerId, name: 'Ada Lovelace' });
    // Never from a query string, and a wrong key is a 401.
    expect((await call(`/players/me?key=${key}`)).status).toBe(401);
    expect((await call('/players/me', { key: 'rk_notarealkeyatall000000000000000' })).status).toBe(401);
    expect((await call('/admin/players', { token: ADMIN })).raw).not.toContain(key);
  });

  it('keeps names unique and away from AI characters, Zergs and the server', async () => {
    expect((await call('/players', { body: { name: 'Grace' } })).status).toBe(201);
    expect((await call('/players', { body: { name: 'grace' } })).status).toBe(400);
    expect((await call('/players', { body: { name: 'Elon Zerg' } })).status).toBe(400);
    expect((await call('/players', { body: { name: 'Zergling Fan' } })).status).toBe(400);
    expect((await call('/players', { body: { name: 'Bot 3' } })).status).toBe(400);
    expect((await call('/players', { body: { name: 'x' } })).status).toBe(400);
    expect((await call('/players', { body: { name: '<script>' } })).status).toBe(400);
    const character = risk.characters.list()[0];
    if (character) expect((await call('/players', { body: { name: character.name } })).status).toBe(400);
  });

  it('treats look-alike names as the same name (NFKC + a confusables fold)', async () => {
    const { nameSkeleton } = await import('../src/player-keys.js');
    expect(nameSkeleton('Ада')).not.toBe(nameSkeleton('Ada')); // д is not a look-alike: a different name
    expect(nameSkeleton('Аda')).toBe(nameSkeleton('Ada')); // Cyrillic А
    expect(nameSkeleton('Ａｄａ')).toBe(nameSkeleton('Ada')); // full-width
    expect(nameSkeleton('Ada​')).toBe(nameSkeleton('Ada')); // zero-width space
    expect(nameSkeleton('Nik0la')).toBe(nameSkeleton('Nikola'));
    expect(nameSkeleton('Bob')).not.toBe(nameSkeleton('Rob'));

    expect((await call('/players', { body: { name: 'Ada' } })).status).toBe(201);
    expect((await call('/players', { body: { name: 'Аda' } })).status).toBe(400);
    expect((await call('/players', { body: { name: 'Ａｄａ' } })).status).toBe(400);
    // A keyless seat cannot use a look-alike of a registered name either.
    const g = (await call('/games', { body: { playerName: 'Host', options: {} } })).body;
    expect((await call(`/games/${g.gameId}/join`, { body: { playerName: 'АDA' } })).status).toBe(400);
    // Server names, folded the same way.
    for (const name of ['Bot 1', 'Bot l', 'Adm1n', 'NEUTRAL']) expect((await call('/players', { body: { name } })).status, name).toBe(400);
  });

  it('limits issuing per IP and in total, and the counts survive a restart', async () => {
    for (const name of ['One', 'Two', 'Three']) expect((await call('/players', { body: { name } })).status).toBe(201);
    const over = await call('/players', { body: { name: 'Four' } });
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
    // A restart reads the counts back.
    await risk.shutdown('test');
    await serve(new Store(join(dir, 'games.json')));
    expect((await call('/players', { body: { name: 'Four' } })).status).toBe(429);
    // The global cap.
    const keys = new PlayerKeyStore(null, { perIpPerDay: 10, perDay: 2 });
    keys.issue('Alpha', '1.1.1.1');
    keys.issue('Beta', '2.2.2.2');
    expect(() => keys.issue('Gamma', '3.3.3.3')).toThrow(/Too many player keys/);
  });

  it('a keyed seat plays under the registered name, nobody else can take that name, and it ranks as one player', async () => {
    const { key, playerId } = (await call('/players', { body: { name: 'Ada' } })).body;
    // The name in the request is ignored: the seat is the registered player.
    const host = (await call('/games', { key, body: { playerName: 'Somebody', options: { autoSetup: true, maxPlayers: 2 } } })).body;
    const room = risk.store.get(host.gameId)!;
    expect(room.state.players.find((p) => p.id === host.playerId)!.name).toBe('Ada');
    expect(room.playerKeys[host.playerId]).toBe(playerId);
    // No second seat for the same player, and no keyless seat under the registered name.
    expect((await call(`/games/${host.gameId}/join`, { key, body: {} })).status).toBe(400);
    expect((await call(`/games/${host.gameId}/join`, { body: { playerName: 'ADA' } })).status).toBe(400);
    expect((await call(`/games/${host.gameId}/join`, { key: 'rk_bad', body: { playerName: 'X' } })).status).toBe(401);
    // The snapshot keeps the binding (player id -> registered id), never the key.
    expect(JSON.stringify(room.snapshot())).toContain(playerId);
    expect(JSON.stringify(room.snapshot())).not.toContain(key);

    await call(`/games/${host.gameId}/bots`, { token: host.token, body: {} });
    await call(`/games/${host.gameId}/start`, { token: host.token, body: {} });
    await call(`/games/${host.gameId}/actions`, { token: host.token, body: { action: { type: 'surrender' } } });
    expect(room.state.phase).toBe('finished');
    const rows = (await call('/rankings')).body.rankings as { key: string; name: string }[];
    expect(rows.find((x) => x.key === `key:${playerId}`)).toMatchObject({ name: 'Ada' });
    expect(rows.some((x) => x.key === 'player:ada')).toBe(false);
    // Views and history never carry the key.
    expect((await call('/games')).raw).not.toContain(key);
    expect((await call('/history')).raw).not.toContain(key);
  });

  it('rotates a key (the old one stops working at once) and the admin can revoke one', async () => {
    const issued = (await call('/players', { body: { name: 'Rotor' } })).body;
    const rotated = await call('/players/me/rotate', { key: issued.key, body: {} });
    expect(rotated.status).toBe(200);
    expect(rotated.body.key).not.toBe(issued.key);
    expect((await call('/players/me', { key: issued.key })).status).toBe(401);
    expect((await call('/players/me', { key: rotated.body.key })).status).toBe(200);
    // The admin revokes it: it no longer joins anything.
    expect((await call(`/admin/players/${issued.playerId}`, { method: 'DELETE' })).status).toBe(401);
    expect((await call(`/admin/players/${issued.playerId}`, { method: 'DELETE', token: ADMIN })).body).toMatchObject({ ok: true, player: { revoked: true } });
    expect((await call('/players/me', { key: rotated.body.key })).status).toBe(401);
    expect((await call('/games', { key: rotated.body.key, body: {} })).status).toBe(401);
    // Revoked names stay reserved.
    expect((await call('/players', { body: { name: 'Rotor' } })).status).toBe(400);
  });

  it('use_player_key binds a key to an MCP connection that cannot send headers, never echoes it, and is rate-limited', async () => {
    const { key, playerId } = (await call('/players', { body: { name: 'Juno' } })).body;
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const { RateLimiter } = await import('../src/rate-limit.js');
    const mcp = new Client({ name: 'connector', version: '0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const call_ = async (name: string, args: Record<string, unknown>) => ((await mcp.callTool({ name, arguments: args })) as { content: { text: string }[] }).content.map((c) => c.text).join('\n');
    try {
      expect((await mcp.listTools()).tools.find((t) => t.name === 'use_player_key')!.description).toMatch(/transcript/);
      expect(await call_('use_player_key', { key: 'rk_wrongwrongwrongwrongwrongwrong' })).toMatch(/does not work/);
      const ok = await call_('use_player_key', { key });
      expect(ok).toMatch(/now plays as Juno/);
      expect(ok).not.toContain(key);
      const out = await call_('create_game', { playerName: 'Somebody' });
      expect(out).not.toContain(key);
      const gameId = /game ([A-Z0-9]{6})/i.exec(out)![1];
      const room = risk.store.get(gameId)!;
      const seat = room.state.players.find((p) => !p.isBot)!;
      expect(seat.name).toBe('Juno');
      expect(room.playerKeys[seat.id]).toBe(playerId);
      // Tries are limited per client.
      risk.store.playerKeys.tryLimiter = new RateLimiter(1, 60_000);
      await call_('use_player_key', { key });
      expect(await call_('use_player_key', { key })).toMatch(/Too many player-key tries/);
    } finally {
      await mcp.close();
    }
  });

  it('tournaments, quick play and MCP connections use the key from the header', async () => {
    const { key, playerId } = (await call('/players', { body: { name: 'Mira' } })).body;
    const t = (await call('/tournaments', { body: { format: 'nested' } })).body.tournament;
    const joined = await call(`/tournaments/${t.id}/join`, { key, body: { playerName: 'whatever' } });
    expect(joined.status).toBe(201);
    const entrant = risk.store.tournaments.get(t.id)!.entrants.find((e) => e.id === joined.body.entrantId)!;
    expect(entrant).toMatchObject({ name: 'Mira', playerKey: playerId });
    expect((await call(`/tournaments/${t.id}/join`, { key, body: {} })).status).toBe(400);

    risk.store.quickPlay.config.waitMs = 60_000;
    const q = await call('/queue', { key, body: { seats: 3 } });
    expect(q.body.ticket.name).toBe('Mira');

    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    const mcp = new Client({ name: 'keyed', version: '0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { 'x-player-key': key } } }));
    try {
      const out = ((await mcp.callTool({ name: 'create_game', arguments: { playerName: 'Not Mira' } })) as { content: { text: string }[] }).content.map((c) => c.text).join('\n');
      const gameId = /game ([A-Z0-9]{6})/i.exec(out)![1];
      const room = risk.store.get(gameId)!;
      const seat = room.state.players.find((p) => !p.isBot)!;
      expect(seat.name).toBe('Mira');
      expect(room.playerKeys[seat.id]).toBe(playerId);
    } finally {
      await mcp.close();
    }
  });
});
