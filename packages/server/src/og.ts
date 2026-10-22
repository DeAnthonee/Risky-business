import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { getMap, type GameView } from '@risk/engine';
import type { GameRoom, Store } from './store.js';
import { tableLabel } from './tournaments.js';

/**
 * Link previews (Open Graph / Twitter cards) for shared links: the tags the server puts in index.html for
 * `/?game=ID`, `/?tournament=ID` and the home page, and the board picture at `GET /og/game/:id.png` (outside /api).
 *
 * The picture is built from the spectator view and shows only who holds each territory (owner colours), plus an army
 * dot per territory in games without fog. Under fog of war there are no army dots at all, so it shows nothing the
 * spectator view does not (hardening #2). It is rendered with resvg (WASM, loaded on the first request) and kept in
 * memory per game version, so a busy link costs one render per move at most.
 */

export const OG_WIDTH = 1200;
export const OG_HEIGHT = 630;
/** Cache-Control for the picture: link crawlers fetch it again rarely; a minute keeps it fresh (hosting.md). */
export const OG_IMAGE_CACHE = 'public, max-age=60';
const SITE = 'Risky Business';
const BLURB = 'Classic Risk online: watch AI models and people play, or take a seat yourself.';

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function gameStatus(room: GameRoom): string {
  const s = room.state;
  const seated = s.players.filter((p) => !p.isNeutral);
  if (s.phase === 'lobby') return `Lobby: ${seated.length}/${s.options.maxPlayers} seats taken`;
  if (s.phase === 'finished') return `Won by ${s.players.find((p) => p.id === s.winner)?.name ?? 'nobody'} after ${s.turnNumber} turns`;
  return `Playing, turn ${s.turnNumber}: ${seated.filter((p) => p.alive).length} of ${seated.length} players left`;
}

/** The preview tags for a page URL's query (`game`, `tournament`), or the home page's. `origin` is this request's. */
export function ogTags(store: Store, query: Record<string, unknown>, origin: string): { tags: string; title: string } {
  let title = SITE;
  let description = BLURB;
  let url = `${origin}/`;
  let image: string | null = null;
  const gameId = typeof query.game === 'string' ? query.game.toUpperCase() : null;
  const tournamentId = typeof query.tournament === 'string' ? query.tournament.toUpperCase() : null;
  const room = gameId ? store.get(gameId) : undefined;
  const tournament = !room && tournamentId ? store.tournaments.get(tournamentId) : undefined;
  if (room && !room.closed) {
    const map = getMap(room.state.options.map);
    // A tournament table says so first: "🏆 Cup · Round 2, table 3".
    const table = room.tournamentId ? store.tournaments.tableOf(room.tournamentId, room.id) : null;
    const badge = table ? `🏆 ${table.name} · ${tableLabel(table)}` : null;
    title = badge ? `${badge} · ${SITE}` : `${room.name} · ${SITE}`;
    description = `${badge ? `${badge}. ` : ''}${map.name.replace(/ \(\d+\)$/, '')}, ${room.state.options.maxPlayers} seats${room.state.options.fogOfWar ? ', fog of war' : ''}. ${gameStatus(room)}.`;
    url = `${origin}/?game=${encodeURIComponent(room.id)}`;
    image = `${origin}/og/game/${encodeURIComponent(room.id)}.png?v=${room.state.version}`;
  } else if (tournament) {
    const people = tournament.entrants.filter((e) => !e.isBot).length;
    const champion = tournament.champion ? tournament.entrants.find((e) => e.id === tournament.champion)?.name : null;
    const status =
      tournament.status === 'registering' ? 'Registering' : tournament.status === 'finished' ? `Finished${champion ? `: ${champion} is champion` : ''}` : `Round ${tournament.rounds.length} in play`;
    title = `${tournament.name} · ${SITE} tournament`;
    description = `${tournament.format === 'nested' ? 'Nested' : 'Knockout'} tournament, ${tournament.entrants.length} entrants (${people} people). ${status}.`;
    url = `${origin}/?tournament=${encodeURIComponent(tournament.id)}`;
    // The picture is the board of its newest table being played (or last played), if any.
    const table = [...(tournament.rounds.at(-1)?.matches ?? [])].reverse().find((m) => m.gameId && store.get(m.gameId));
    if (table?.gameId) image = `${origin}/og/game/${encodeURIComponent(table.gameId)}.png?v=${store.get(table.gameId)!.state.version}`;
  }
  const tags: [string, string, string][] = [
    ['property', 'og:site_name', SITE],
    ['property', 'og:type', 'website'],
    ['property', 'og:title', title],
    ['property', 'og:description', description],
    ['property', 'og:url', url],
    ['name', 'description', description],
    ['name', 'twitter:card', image ? 'summary_large_image' : 'summary'],
    ['name', 'twitter:title', title],
    ['name', 'twitter:description', description],
  ];
  if (image) {
    tags.push(['property', 'og:image', image], ['property', 'og:image:width', String(OG_WIDTH)], ['property', 'og:image:height', String(OG_HEIGHT)], ['name', 'twitter:image', image]);
  }
  return { tags: tags.map(([attr, key, value]) => `<meta ${attr}="${key}" content="${escape(value)}" />`).join('\n    '), title };
}

/** index.html with the preview tags in its head and its <title> set to the page's. */
export function withOgTags(html: string, og: { tags: string; title: string }): string {
  return html.replace('</head>', `    ${og.tags}\n  </head>`).replace(/<title>[^<]*<\/title>/, `<title>${escape(og.title)}</title>`);
}

/** The board as an SVG card, from the spectator view: owner colours, and army dots unless the game has fog. */
export function boardSvg(view: GameView): string {
  const map = getMap(view.options.map);
  const [vw, vh] = map.viewBox;
  const colour = new Map(view.players.map((p) => [p.id, p.color]));
  const fog = !!view.options.fogOfWar && !view.fogLifted;
  const blizzards = new Set(view.blizzards ?? []);
  const maxArmies = Math.max(1, ...Object.values(view.territories).map((t) => t.armies ?? 0));
  const shapes = map.territories
    .map((t) => {
      const s = view.territories[t.id];
      const fill = blizzards.has(t.id) ? '#cfe3f2' : s?.owner ? (colour.get(s.owner) ?? '#888') : '#3a3f47';
      return `<path d="${t.path}" fill="${fill}" stroke="#0d1117" stroke-width="${Math.max(vw, vh) / 600}"/>`;
    })
    .join('');
  const dots = fog
    ? ''
    : map.territories
        .map((t) => {
          const armies = view.territories[t.id]?.armies ?? 0;
          if (!armies) return '';
          const r = (Math.max(vw, vh) / 160) * (0.6 + Math.sqrt(armies / maxArmies));
          return `<circle cx="${t.x}" cy="${t.y}" r="${r.toFixed(1)}" fill="#ffffff" fill-opacity="0.85" stroke="#0d1117" stroke-width="${(r / 5).toFixed(1)}"/>`;
        })
        .join('');
  const pad = 30;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${OG_WIDTH}" height="${OG_HEIGHT}" viewBox="0 0 ${OG_WIDTH} ${OG_HEIGHT}">` +
    `<rect width="${OG_WIDTH}" height="${OG_HEIGHT}" fill="#0d1117"/>` +
    `<svg x="${pad}" y="${pad}" width="${OG_WIDTH - 2 * pad}" height="${OG_HEIGHT - 2 * pad}" viewBox="0 0 ${vw} ${vh}" preserveAspectRatio="xMidYMid meet">${shapes}${dots}</svg>` +
    `</svg>`
  );
}

type ResvgModule = typeof import('@resvg/resvg-wasm');

/** resvg's WASM, loaded once for the whole process on the first picture (it can be initialised only once). */
let resvg: Promise<ResvgModule> | null = null;
function loadResvg(): Promise<ResvgModule> {
  if (!resvg) {
    resvg = (async () => {
      const mod = await import('@resvg/resvg-wasm');
      const wasm = await readFile(createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm'));
      await mod.initWasm(wasm);
      return mod;
    })();
    resvg.catch(() => (resvg = null));
  }
  return resvg;
}

/** Board pictures, rendered on demand and kept per game version. */
export class OgImages {
  private cache = new Map<string, Buffer>();
  renders = 0;

  constructor(private max = 100) {}

  private load(): Promise<ResvgModule> {
    return loadResvg();
  }

  /** The PNG for a room's current version. */
  async gamePng(room: GameRoom): Promise<Buffer> {
    const key = `${room.id}:${room.state.version}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const { Resvg } = await this.load();
    const png = Buffer.from(new Resvg(boardSvg(room.view(null)), { fitTo: { mode: 'width', value: OG_WIDTH } }).render().asPng());
    this.renders++;
    // One entry per room: an older version of the same room is dropped, then the least recently used beyond `max`.
    for (const k of this.cache.keys()) if (k.startsWith(`${room.id}:`)) this.cache.delete(k);
    this.cache.set(key, png);
    while (this.cache.size > this.max) this.cache.delete(this.cache.keys().next().value!);
    return png;
  }
}
