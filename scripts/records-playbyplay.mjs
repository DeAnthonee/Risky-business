#!/usr/bin/env node
// Print a game record's play-by-play (docs/game-records.md).
//   npm run records:playbyplay -- <record.json>   a local record file
//   npm run records:playbyplay -- <record id>     fetched from RISK_SERVER_URL with RISK_RECORDS_KEY (never printed)
// Needs the built server (npm run build).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const arg = process.argv[2];
if (!arg) {
  console.error('usage: npm run records:playbyplay -- <record.json | record id>');
  process.exit(2);
}

if (existsSync(arg)) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const { narrate, playByPlayText } = await import(pathToFileURL(join(root, 'packages', 'server', 'dist', 'playbyplay.js')).href);
  process.stdout.write(playByPlayText(narrate(JSON.parse(readFileSync(arg, 'utf8')))));
} else {
  const server = (process.env.RISK_SERVER_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
  const key = process.env.RISK_RECORDS_KEY;
  if (!key) {
    console.error('Set RISK_RECORDS_KEY to fetch a record by id (or pass a local record file).');
    process.exit(2);
  }
  const res = await fetch(`${server}/api/records/${encodeURIComponent(arg)}/playbyplay`, { headers: { 'x-records-key': key } });
  const body = await res.text();
  if (!res.ok) {
    console.error(`${res.status}: ${body}`);
    process.exit(1);
  }
  process.stdout.write(body);
}
