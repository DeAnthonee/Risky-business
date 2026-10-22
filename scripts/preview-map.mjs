#!/usr/bin/env node
/**
 * Renders a generated board (packages/engine/src/generated/<id>.json) to a standalone HTML page with one SVG:
 * territories filled by region colour, region outlines, sea links (dashed, as the client draws them), army badges
 * at the label anchors, territory names, and the region labels upper-case with their bonus. Optionally lays a
 * reference image under the board so a traced sketch can be checked against the picture it came from.
 *
 * A design aid for map-making (docs/map-making.md). Node only, no dependencies; nothing in the server, engine or
 * client imports it. The page is written outside the repo (the OS temp folder) unless --out says otherwise.
 *
 *   node scripts/preview-map.mjs <id> [--out page.html] [--ref image.png x y width height] [--ref-opacity 0.45]
 *
 * Generated boards (procgen.ts) are built from their id by the built engine (run `npm run build` first): pass one or
 * more gen ids, or --sheet for a contact sheet of many seeds at once:
 *
 *   node scripts/preview-map.mjs gen1-s42-p4-t20
 *   node scripts/preview-map.mjs --sheet seats=3,4,6,10 seeds=1-4 [tps=5] [--out sheet.html]
 *
 * --ref places the image in viewBox units (x, y, width, height), the same placement the map's P() helper assumes,
 * so a sketch traced on the image's own pixel grid lines up. To rasterize the page to a PNG (Edge on Windows;
 * Chrome or Chromium take the same flags):
 *
 *   msedge --headless --disable-gpu --hide-scrollbars --window-size=1400,1600 --screenshot=<out.png> file:///<page.html>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args.slice(i + 1) : null;
};
const sheet = opt('--sheet');
const firstFlag = args.findIndex((a) => a.startsWith('--'));
const ids = sheet ? [] : args.slice(0, firstFlag < 0 ? args.length : firstFlag);
if (sheet) {
  const kv = Object.fromEntries(sheet.filter((a) => a.includes('=')).map((a) => a.split('=')));
  const [from, to] = (kv.seeds ?? '1-4').split('-').map(Number);
  const { genMapId } = await import(pathToFileURL(join(root, 'packages/engine/dist/procgen.js')).href);
  for (const seats of (kv.seats ?? '3,4,6,10').split(',').map(Number))
    for (let seed = from; seed <= (to ?? from); seed++) ids.push(genMapId({ seed, seats, territoriesPerSeat: kv.tps ? Number(kv.tps) : undefined }));
}
if (!ids.length || !ids[0] || ids[0].startsWith('--')) {
  console.error('usage: node scripts/preview-map.mjs <id> [more ids] [--out page.html] [--ref image x y width height] [--ref-opacity 0.45]\n       node scripts/preview-map.mjs --sheet seats=3,4,6,10 seeds=1-4 [tps=5]');
  process.exit(1);
}

async function load(id) {
  if (!id.startsWith('gen')) return JSON.parse(readFileSync(join(root, 'packages/engine/src/generated', `${id}.json`), 'utf8'));
  const { generateFromId } = await import(pathToFileURL(join(root, 'packages/engine/dist/procgen.js')).href);
  return generateFromId(id);
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const out = resolve(opt('--out')?.[0] ?? join(tmpdir(), 'risky-map-preview', `${sheet ? 'sheet' : ids[0]}.html`));
const boards = [];
for (const id of ids) boards.push(render(await load(id)));

function render(map) {
const [W, H] = map.viewBox;

// Region colours: evenly spaced hues, alternating lightness so neighbours in the list differ.
const colour = new Map(map.continents.map((c, i) => [c.id, `hsl(${Math.round((i * 360) / map.continents.length)}, 55%, ${i % 2 ? 62 : 52}%)`]));
const byId = new Map(map.territories.map((t) => [t.id, t]));
const dense = map.territories.length > 50;
const badge = dense ? 15 : 19;

let ref = '';
const r = opt('--ref');
if (r) {
  const [file, x, y, w, h] = r;
  if ([x, y, w, h].some((v) => v === undefined || Number.isNaN(Number(v)))) throw new Error('--ref needs: image x y width height');
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[extname(file).toLowerCase()];
  if (!mime) throw new Error(`--ref: unsupported image type ${extname(file)}`);
  const data = readFileSync(resolve(file)).toString('base64');
  const opacity = Number(opt('--ref-opacity')?.[0] ?? 0.45);
  ref = `<image href="data:${mime};base64,${data}" x="${x}" y="${y}" width="${w}" height="${h}" opacity="${opacity}" preserveAspectRatio="none"/>`;
}

const seaLinks = map.seaLinks
  .map((l) => {
    const a = byId.get(l.a), b = byId.get(l.b);
    if (!l.wrap) return `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`;
    const [left, right] = a.x < b.x ? [a, b] : [b, a];
    return `<line x1="${left.x}" y1="${left.y}" x2="0" y2="${left.y}"/><line x1="${right.x}" y1="${right.y}" x2="${W}" y2="${right.y}"/>`;
  })
  .join('');

const territories = map.territories
  .map((t) => `<path d="${t.path}" fill="${colour.get(t.continent)}"><title>${esc(t.name)} (${t.id})</title></path>`)
  .join('');
const outlines = map.continents.map((c) => `<path d="${c.outline}"/>`).join('');
const badges = map.territories
  .map((t) => `<circle cx="${t.x}" cy="${t.y}" r="${badge}"/><text class="name" x="${t.x}" y="${t.y + badge + 9}">${esc(t.name)}</text>`)
  .join('');
// The client puts a region label at its labelX/labelY, or above the region's anchors when it has none.
const labels = map.continents
  .map((c) => {
    let x = c.labelX, y = c.labelY;
    if (x === undefined || y === undefined) {
      const pts = c.territories.map((t) => byId.get(t));
      x = pts.reduce((s, p) => s + p.x, 0) / pts.length;
      y = Math.max(12, Math.min(...pts.map((p) => p.y)) - 22);
    }
    return `<text class="region" x="${x}" y="${y}" fill="${colour.get(c.id)}">${esc(c.name.toUpperCase())} +${c.bonus}</text>`;
  })
  .join('');

return `<p>${esc(map.name)} <code>${esc(map.id)}</code>: ${map.territories.length} territories, ${map.continents.length} regions, ${map.edges.length} edges, ${map.seaLinks.length} sea links, viewBox ${W}x${H}</p>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" class="${dense ? 'dense' : ''}" style="max-width:${sheet ? W : Math.max(W, 1000)}px">
<rect width="${W}" height="${H}" fill="#0d1b2a"/>${ref}
<g class="land">${territories}</g><g class="outlines">${outlines}</g><g class="sea">${seaLinks}</g>
<g class="badges">${badges}</g><g>${labels}</g>
</svg>`;
}

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(sheet ? 'Generated boards' : ids[0])} preview</title>
<style>
  body { margin: 0; background: #0d1b2a; color: #e0e6ee; font: 13px system-ui, sans-serif; }
  p { margin: 8px 12px; }
  .sheet { display: flex; flex-wrap: wrap; gap: 8px; }
  .sheet > div { flex: 1 1 520px; }
  svg { display: block; width: 100%; height: auto; }
  .land path { stroke: #1b263b; stroke-width: 0.8; }
  .outlines path { fill: none; stroke: #0d1b2a; stroke-width: 2.5; }
  .sea line { stroke: #9fb3c8; stroke-width: 1.4; stroke-dasharray: 4 4; }
  .badges circle { fill: #0d1b2a; fill-opacity: 0.75; stroke: #e0e6ee; stroke-width: 1.2; }
  text { text-anchor: middle; paint-order: stroke; stroke: #0d1b2a; }
  .name { font-size: 9.5px; fill: #e0e6ee; stroke-width: 2.5px; }
  .region { font-size: 12px; font-weight: 800; letter-spacing: 2px; stroke-width: 3px; }
  .dense .name { font-size: 7.5px; }
  .dense .region { font-size: 10px; letter-spacing: 1.5px; }
</style></head><body>
<div class="${sheet ? 'sheet' : ''}">${boards.map((b) => `<div>${b}</div>`).join('')}</div>
</body></html>
`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(out);
console.log(`PNG: msedge --headless --disable-gpu --hide-scrollbars --window-size=1400,1600 --screenshot=${out.replace(/\.html$/, '.png')} ${pathToFileURL(out).href}`);
