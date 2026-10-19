import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { getMap } from '@risk/engine';
import { CANDIDATE_FEATURES, encodeDecision, ENCODER_VERSION, GLOBAL_FEATURES, TERRITORY_FEATURES } from './encode.js';
import { LOG_VERSION, RULE_KEYS, type DecisionRecord } from './log.js';
import { NpyWriter } from './npy.js';

/**
 * Turn decision logs into training arrays, one folder per map (maps have different territory counts):
 *
 *   territory.npy   float32 [N, T, F_t]   per-territory features (encode.ts)
 *   global.npy      float32 [N, F_g]
 *   cand.npy        float32 [M, F_c]      every candidate of every decision, decisions back to back
 *   cand_from.npy   int32   [M]           territory index a candidate starts from (-1 = none)
 *   cand_to.npy     int32   [M]           territory index it targets (-1 = none)
 *   cand_offset.npy int64   [N + 1]       decision k's candidates are rows cand_offset[k] .. cand_offset[k+1]-1
 *   choice.npy      int32   [N]           index of the chosen candidate within the decision
 *   z.npy           float32 [N]           final result for the decider (1 win, 0 loss, shared at the turn limit)
 *   game.npy        int32   [N]           game number within this export (split train/validation by game)
 *   seat.npy        int32   [N]
 *   features.json                         feature names, the map's territory order and adjacency, counts
 *
 * Decisions an agent played outside the candidate list (choice -1) are skipped and counted. So are decisions
 * from fog-of-war games: the encoder sees the full board, so a net trained on them would learn from hidden
 * information (fog games need a seat-perspective encoder first).
 */
export interface ExportResult {
  map: string;
  decisions: number;
  candidates: number;
  games: number;
  skipped: number;
  /** Decisions left out because the game was played with fog of war. */
  fogSkipped: number;
}

interface MapWriters {
  territory: NpyWriter;
  global: NpyWriter;
  cand: NpyWriter;
  candFrom: NpyWriter;
  candTo: NpyWriter;
  candOffset: NpyWriter;
  choice: NpyWriter;
  z: NpyWriter;
  game: NpyWriter;
  seat: NpyWriter;
  candidates: number;
  games: Map<string, number>;
  skipped: number;
  fogSkipped: number;
}

/** Decision shards of a log directory, in order. */
export function decisionShards(logDir: string): string[] {
  return readdirSync(logDir)
    .filter((f) => /^decisions-.*\.jsonl(\.gz)?$/.test(f))
    .sort()
    .map((f) => join(logDir, f));
}

export async function exportDataset(
  logDirs: string[],
  outDir: string,
  /** `agents`: keep only decisions these player versions made (e.g. the one being trained in a mixed game). */
  opts: { maps?: string[]; force?: boolean; agents?: string[] } = {},
): Promise<ExportResult[]> {
  // Arrays are rewritten from scratch, and map folders from an earlier export with other --maps would linger.
  if (!opts.force && existsSync(outDir) && readdirSync(outDir).length > 0) throw new Error(`${outDir} is not empty (pass force / --force to overwrite)`);
  const FOG = RULE_KEYS.indexOf('fogOfWar');
  const writers = new Map<string, MapWriters>();
  const open = (mapId: string): MapWriters => {
    let w = writers.get(mapId);
    if (w) return w;
    const map = getMap(mapId);
    const dir = join(outDir, mapId);
    mkdirSync(dir, { recursive: true });
    const T = map.territoryIds.length;
    const npy = (name: string, dtype: '<f4' | '<i4' | '<i8', shape: number[]) => new NpyWriter(join(dir, `${name}.npy`), dtype, shape);
    w = {
      territory: npy('territory', '<f4', [T, TERRITORY_FEATURES.length]),
      global: npy('global', '<f4', [GLOBAL_FEATURES.length]),
      cand: npy('cand', '<f4', [CANDIDATE_FEATURES.length]),
      candFrom: npy('cand_from', '<i4', []),
      candTo: npy('cand_to', '<i4', []),
      candOffset: npy('cand_offset', '<i8', []),
      choice: npy('choice', '<i4', []),
      z: npy('z', '<f4', []),
      game: npy('game', '<i4', []),
      seat: npy('seat', '<i4', []),
      candidates: 0,
      games: new Map(),
      skipped: 0,
      fogSkipped: 0,
    };
    w.candOffset.append(new BigInt64Array([0n]));
    writers.set(mapId, w);
    return w;
  };

  for (const logDir of logDirs) {
    const meta = join(logDir, 'meta.json');
    if (!existsSync(meta)) throw new Error(`${logDir}: no meta.json (not a decision log directory)`);
    const v = JSON.parse(readFileSync(meta, 'utf8')).v;
    if (v !== LOG_VERSION) throw new Error(`${logDir}: log format v${v}; export reads v${LOG_VERSION} (re-run the games)`);
    for (const shard of decisionShards(logDir)) {
      const input = shard.endsWith('.gz') ? createReadStream(shard).pipe(createGunzip()) : createReadStream(shard);
      for await (const line of createInterface({ input, crlfDelay: Infinity })) {
        if (!line) continue;
        const rec = JSON.parse(line) as DecisionRecord;
        // A run continued after an upgrade can leave older shards next to a newer meta.json.
        if (rec.v !== LOG_VERSION) throw new Error(`${shard}: record in log format v${rec.v}; export reads v${LOG_VERSION} (re-run the games)`);
        if (opts.maps && !opts.maps.includes(rec.map)) continue;
        if (opts.agents && !opts.agents.includes(rec.agent)) continue;
        const w = open(rec.map);
        if (rec.rules?.[FOG]) {
          w.fogSkipped++;
          continue;
        }
        if (rec.choice < 0) {
          w.skipped++;
          continue;
        }
        const f = encodeDecision(rec);
        w.territory.append(f.territory);
        w.global.append(f.global);
        w.cand.append(f.cand);
        w.candFrom.append(f.candFrom);
        w.candTo.append(f.candTo);
        w.candidates += f.candidates;
        w.candOffset.append(new BigInt64Array([BigInt(w.candidates)]));
        w.choice.append(new Int32Array([rec.choice]));
        w.z.append(new Float32Array([rec.outcome.z]));
        const key = `${logDir}\u0000${rec.game}\u0000${rec.seed}`;
        if (!w.games.has(key)) w.games.set(key, w.games.size);
        w.game.append(new Int32Array([w.games.get(key)!]));
        w.seat.append(new Int32Array([rec.seat]));
      }
    }
  }

  const results: ExportResult[] = [];
  for (const [mapId, w] of writers) {
    for (const k of ['territory', 'global', 'cand', 'candFrom', 'candTo', 'candOffset', 'choice', 'z', 'game', 'seat'] as const) w[k].close();
    const map = getMap(mapId);
    const idx = new Map(map.territoryIds.map((t, i) => [t, i]));
    const result: ExportResult = { map: mapId, decisions: w.choice.length, candidates: w.candidates, games: w.games.size, skipped: w.skipped, fogSkipped: w.fogSkipped };
    writeFileSync(
      join(outDir, mapId, 'features.json'),
      JSON.stringify(
        {
          encoderVersion: ENCODER_VERSION,
          logVersion: LOG_VERSION,
          ...result,
          territoryFeatures: TERRITORY_FEATURES,
          globalFeatures: GLOBAL_FEATURES,
          candidateFeatures: CANDIDATE_FEATURES,
          territoryIds: map.territoryIds,
          adjacency: map.territoryIds.map((t) => map.adjacency[t].map((n) => idx.get(n)!)),
          sources: logDirs,
        },
        null,
        1,
      ) + '\n',
    );
    results.push(result);
  }
  return results;
}
