"""Merge the outputs of several GPU workers into one cycle step, exactly as a local GPU step leaves it.

Each worker (remote.py) plays whole configurations of a step and writes, like `delove_gpu.generate`, one training-array
folder per map and a summary JSON. A map whose configurations went to several workers has several folders; this joins
them into one DATA/<name>-<step>/<map> folder in export's format (rows appended worker after worker, `cand_offset`
continued, `game` renumbered, features.json counts summed), and the summaries into the step's gpu.json (tables, branch
statistics, groups and per-map export counts), so training, summary.mjs and the dashboard read it unchanged.

Rows keep their order within a game, so tests/dataset_compare.py finds the same games in a merged folder as in one
written by a single local run of the same tables and seed.

    python cloud/merge.py --part a/gpu.json a/data --part b/gpu.json b/data --out data/delove/c7-big --summary runs/delove/c7/big/gpu.json

Standard library and NumPy only (no PyTorch, no GPU).
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from delove_gpu.npy import NpyWriter  # noqa: E402

CAND_ARRAYS = {"cand", "cand_from", "cand_to", "branch_q"}  # one row per candidate; every other array but cand_offset: per decision
COUNTS = ("decisions", "candidates", "games", "skipped", "fogSkipped")
CHUNK_BYTES = 64 << 20


def _load(path: Path) -> np.ndarray:
    return np.load(path, mmap_mode="r")


def _append(w: NpyWriter, a: np.ndarray, add: int = 0):
    rows = max(1, CHUNK_BYTES // max(1, a.itemsize * int(np.prod(a.shape[1:], dtype=np.int64))))
    for i in range(0, a.shape[0], rows):
        part = np.asarray(a[i:i + rows])
        w.append(part + add if add else part)


def merge_map(srcs: list[Path], dst: Path) -> dict:
    """Join the folders `srcs` (one map, same encoder and features) into `dst`. Returns dst's features.json counts."""
    infos = [json.loads((s / "features.json").read_text(encoding="utf8")) for s in srcs]
    first = infos[0]
    for s, info in zip(srcs[1:], infos[1:]):
        diff = [k for k in first if k not in COUNTS and k != "sources" and info.get(k) != first[k]]
        if diff:
            raise SystemExit(f"{s}: features.json differs from {srcs[0]} in {diff}; not the same map and encoder")
    names = sorted(p.name for p in srcs[0].glob("*.npy"))
    for s in srcs[1:]:
        if sorted(p.name for p in s.glob("*.npy")) != names:
            raise SystemExit(f"{s}: not the same arrays as {srcs[0]}")
    dst.mkdir(parents=True, exist_ok=True)
    if len(srcs) == 1:
        for n in names + ["features.json"]:
            shutil.copyfile(srcs[0] / n, dst / n)
        return {k: first.get(k, 0) for k in COUNTS}
    for f in names:
        n = f[:-4]  # the array's name (stem)
        arrays = [_load(s / f) for s in srcs]
        dtype = arrays[0].dtype.str
        w = NpyWriter(dst / f, dtype, list(arrays[0].shape[1:]))
        if n == "cand_offset":
            base = 0
            for i, a in enumerate(arrays):
                _append(w, a if i == 0 else a[1:], base)
                base += int(a[-1])
        elif n == "game":
            base = 0
            for a, info in zip(arrays, infos):
                _append(w, a, base)
                base += int(info["games"])
        else:
            for s, a, info in zip(srcs, arrays, infos):
                want = info["candidates"] if n in CAND_ARRAYS else info["decisions"]
                if a.shape[0] != want:
                    raise SystemExit(f"{s / f}: {a.shape[0]} rows, features.json says {want}")
                _append(w, a)
        w.close()
    out = dict(first)
    for k in COUNTS:
        out[k] = sum(int(i.get(k, 0)) for i in infos)
    out["sources"] = [x for i in infos for x in i.get("sources", [])]
    (dst / "features.json").write_text(json.dumps(out, indent=1) + "\n", encoding="utf8", newline="\n")
    return {k: out[k] for k in COUNTS}


def _deep_sum(a, b):
    if isinstance(a, dict):
        return {k: _deep_sum(a.get(k, 0), b.get(k, 0)) if k in a and k in b else (a[k] if k in a else b[k]) for k in {**a, **b}}
    return a + b


def merge_tables(parts: list[list[dict]]) -> list[dict]:
    """generate.py's table_summary entries of several workers, summed per table (a table is normally on one worker)."""
    out: dict[str, dict] = {}
    for tables in parts:
        for t in tables:
            m = out.get(t["table"])
            if m is None:
                out[t["table"]] = json.loads(json.dumps(t))
                continue
            for k in ("games", "turnLimit", "turns", "decisions"):
                m[k] += t[k]
            m["wins"] = [x + y for x, y in zip(m["wins"], t["wins"])]
    for t in out.values():
        t["meanTurns"] = round(t["turns"] / t["games"], 1) if t["games"] else 0
    return sorted(out.values(), key=lambda t: t["table"])


def merge_summaries(parts: list[dict], export: list[dict], extra: dict | None = None) -> dict:
    """One step's gpu.json from its workers' summaries: seconds is the slowest worker's (they ran at the same time)."""
    branch = parts[0]["branch"]
    for p in parts[1:]:
        branch = _deep_sum(branch, p["branch"])
    out = {"games": sum(p["games"] for p in parts), "seconds": max(p["seconds"] for p in parts),
           "groups": [g for p in parts for g in p["groups"]], "branch": branch}
    if export:
        out["export"] = export
    out["tables"] = merge_tables([p["tables"] for p in parts])
    out["config"] = parts[0]["config"]
    if extra:
        out["remote"] = extra
    return out


def count_map(srcs: list[Path]) -> dict:
    """merge_map's counts from the folders' features.json alone (the arrays may be elsewhere, e.g. on a network volume)."""
    infos = [json.loads((s / "features.json").read_text(encoding="utf8")) for s in srcs]
    return {k: sum(int(i.get(k, 0)) for i in infos) for k in COUNTS}


def merge_step(parts: list[tuple[dict, Path]], out: Path | None, extra: dict | None = None) -> dict:
    """parts: (summary, data folder) of each worker that played some of this step. Writes out/<map>/ per map and
    returns the merged summary (the caller writes it as the step's gpu.json). out=None writes nothing and counts from
    the features.json files only (the step's arrays stay on the cloud volume; cloud/trainer.py merges them there)."""
    maps: dict[str, list[Path]] = {}
    for _, d in parts:
        for m in sorted(p.parent.name for p in d.glob("*/features.json")):
            maps.setdefault(m, []).append(d / m)
    export = []
    for m, srcs in maps.items():
        counts = merge_map(srcs, out / m) if out is not None else count_map(srcs)
        export.append({"map": m, **counts})
    return merge_summaries([s for s, _ in parts], export, extra)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--part", nargs=2, action="append", required=True, metavar=("SUMMARY", "DATA"), help="one worker's summary JSON and data folder")
    ap.add_argument("--out", required=True, help="the step's data folder (one folder per map is written in it)")
    ap.add_argument("--summary", required=True, help="where to write the merged summary (the step's gpu.json)")
    args = ap.parse_args()
    parts = [(json.loads(Path(s).read_text(encoding="utf8")), Path(d)) for s, d in args.part]
    res = merge_step(parts, Path(args.out))
    Path(args.summary).write_text(json.dumps(res, indent=2) + "\n", encoding="utf8")
    print(json.dumps(res["export"], indent=1))


if __name__ == "__main__":
    main()
