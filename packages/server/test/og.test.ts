import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chooseBotAction } from '@risk/engine';
import { Store } from '../src/store.js';
import { createRiskServer, type RiskServer } from '../src/app.js';
import { OgImages, boardSvg } from '../src/og.js';

let dir: string;
let risk: RiskServer;
let base: string;
let store: Store;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'risk-og-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><html><head><meta charset="UTF-8" /><title>Risky Business</title></head><body><div id="root"></div></body></html>');
  store = new Store(null);
  risk = createRiskServer(store, { clientDir: dir, adminToken: 'og-admin', sweepIntervalMs: 0 });
  await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await risk.shutdown('test');
  rmSync(dir, { recursive: true, force: true });
});

/** A started 2-human game (no bots, so nothing moves by itself). */
function started(options: Record<string, unknown> = {}, name = 'Friday night') {
  const { room } = store.create(name, { autoSetup: true, maxPlayers: 2, ...options }, 'Ada');
  room.join('Grace');
  room.start();
  return room;
}

const meta = (html: string, key: string) => new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`).exec(html)?.[1];

describe('link previews', () => {
  it('a game link carries its title, status and board picture; the page stays no-cache', async () => {
    const room = started({ map: 'skirmish' });
    const res = await fetch(`${base}/?game=${room.id.toLowerCase()}&spectate=1`);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    const html = await res.text();
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('<title>Friday night · Risky Business</title>');
    expect(meta(html, 'og:title')).toBe('Friday night · Risky Business');
    expect(meta(html, 'og:description')).toMatch(/^Four Crowns, 2 seats\. Playing, turn 1: 2 of 2 players left\.$/);
    expect(meta(html, 'og:url')).toBe(`${base}/?game=${room.id}`);
    expect(meta(html, 'og:image')).toBe(`${base}/og/game/${room.id}.png?v=${room.state.version}`);
    expect(meta(html, 'twitter:card')).toBe('summary_large_image');
  });

  it('escapes what people typed, and the home page and unknown ids get the site card', async () => {
    const room = started({}, '<b>"Evil" & co</b>');
    const html = await (await fetch(`${base}/?game=${room.id}`)).text();
    expect(html).not.toContain('<b>"Evil"');
    expect(meta(html, 'og:title')).toBe('&lt;b&gt;&quot;Evil&quot; &amp; co&lt;/b&gt; · Risky Business');
    for (const path of ['/', '/?game=NOPE12', '/?tournament=TNOPE1']) {
      const h = await (await fetch(`${base}${path}`)).text();
      expect(meta(h, 'og:title')).toBe('Risky Business');
      expect(meta(h, 'og:image')).toBeUndefined();
      expect(meta(h, 'twitter:card')).toBe('summary');
    }
  });

  it('a tournament link carries its name, format, entrants and status, and its newest table as the picture', async () => {
    const t = store.tournaments.create({ name: 'Crown Cup', groupSize: 2, fillBots: false });
    for (const n of ['A', 'B']) store.tournaments.join(t.id, n);
    let html = await (await fetch(`${base}/?tournament=${t.id}`)).text();
    expect(meta(html, 'og:title')).toBe('Crown Cup · Risky Business tournament');
    expect(meta(html, 'og:description')).toBe('Knockout tournament, 2 entrants (2 people). Registering.');
    store.tournaments.start(t.id);
    html = await (await fetch(`${base}/?tournament=${t.id}`)).text();
    expect(meta(html, 'og:description')).toMatch(/Round 1 in play\.$/);
    expect(meta(html, 'og:image')).toContain(`/og/game/${t.rounds[0].matches[0].gameId}.png`);
    for (const m of t.rounds[0].matches) if (m.gameId) store.get(m.gameId)!.close('admin');
  });

  it('the board picture is a PNG outside /api, cacheable for a minute; lobbies and unknown games are 404', async () => {
    const room = started();
    const res = await fetch(`${base}/og/game/${room.id}.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    const png = Buffer.from(await res.arrayBuffer());
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(1200); // IHDR width
    expect(png.readUInt32BE(20)).toBe(630); // IHDR height
    const { room: lobby } = store.create('Lobby', {}, 'Host');
    expect((await fetch(`${base}/og/game/${lobby.id}.png`)).status).toBe(404);
    expect((await fetch(`${base}/og/game/NOPE12.png`)).status).toBe(404);
    expect((await fetch(`${base}/og/game/${room.id}.jpg`)).status).toBe(404);
    // /api stays no-store throughout (hard rule 6), and the old /api path is not the picture.
    expect((await fetch(`${base}/api/games`)).headers.get('cache-control')).toBe('no-store');
    expect((await fetch(`${base}/api/og/game/${room.id}.png`)).headers.get('content-type')).not.toBe('image/png');
  });

  it('renders once per game version', async () => {
    const room = started();
    const og = new OgImages();
    const a = await og.gamePng(room);
    expect(await og.gamePng(room)).toBe(a);
    expect(og.renders).toBe(1);
    const cur = room.state.currentPlayer!;
    room.act(cur, chooseBotAction(room.state, cur)!);
    await og.gamePng(room);
    expect(og.renders).toBe(2);
  });

  it('under fog of war the picture shows owners only: no army marks at all', () => {
    const fog = started({ fogOfWar: true });
    const open = started();
    expect(boardSvg(fog.view(null))).not.toContain('<circle');
    expect(boardSvg(open.view(null))).toContain('<circle');
    // No numbers or names in the picture either way (there are no fonts in it).
    expect(boardSvg(open.view(null))).not.toContain('<text');
  });
});
