// balancedWin of packages/engine/src/odds.ts for an array of ordinary win chances (float64 little-endian in, out), so
// the GPU teacher's balanced-blitz odds are V8's numbers bit for bit (Math.pow differs between C libraries).
// balanced() and binomial() are copied from odds.ts (not exported there); the fingerprint covers odds.ts, and the
// teacher replay on balanced-blitz logs checks the result.
//   node packages/delove-gpu/scripts/balanced_odds.mjs IN.bin OUT.bin
import { readFileSync, writeFileSync } from 'node:fs';
import { BALANCED_BLITZ_RUNS } from '../../engine/dist/index.js';

function binomial(n, k) {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

function balanced(p) {
  const n = BALANCED_BLITZ_RUNS;
  let b = 0;
  for (let k = Math.floor(n / 2) + 1; k <= n; k++) b += binomial(n, k) * p ** k * (1 - p) ** (n - k);
  return b;
}

const [src, dst] = process.argv.slice(2);
const buf = readFileSync(src);
const win = new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
const out = new Float64Array(win.length);
for (let i = 0; i < win.length; i++) out[i] = balanced(win[i]);
writeFileSync(dst, Buffer.from(out.buffer));
