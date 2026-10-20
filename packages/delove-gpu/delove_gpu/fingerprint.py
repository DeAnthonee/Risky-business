"""Which engine the GPU mirror was last verified against, and whether that is still the engine in this checkout.

The mirror copies the behaviour of a handful of TypeScript files (RULE_FILES). engine-fingerprint.json records a hash
of each, written by verify.py only after logs made with exactly those files replayed identically through the GPU
engines. When any of them changes, the mirror is "stale": it may no longer play the engine's game. Engine() refuses
to start on a stale mirror (training data from it could silently teach a different game) unless the caller passes
allow_unverified=True, as the replay test and the benchmarks do. The fix is always the same: run verify.py, and if the
replay finds a mismatch, change the mirror (never the engine) until it passes.

Standard library only, so CI can run `python packages/delove-gpu/delove_gpu/fingerprint.py check --github` without
PyTorch. Hashes ignore line endings (CRLF and LF checkouts give the same hash).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
FINGERPRINT = REPO / "packages" / "delove-gpu" / "engine-fingerprint.json"

# The files whose behaviour the mirror copies: the rules, the RNG, cards, defaults, every map, the self-play
# action space, log format and encoder the replay test and encode.py follow, and the teacher, its odds, branch and
# score and the export format (teacher.py, branch.py, generate.py). Add a file here when the mirror starts depending
# on it.
RULE_FILES = [
    "packages/engine/src/engine.ts",
    "packages/engine/src/cards.ts",
    "packages/engine/src/rng.ts",
    "packages/engine/src/types.ts",
    "packages/engine/src/maps.ts",
    # every map offered for new games (MAP_IDS), as the mirror loads them
    "packages/engine/src/generated/classic.json",
    "packages/engine/src/generated/world.json",
    "packages/engine/src/generated/world_large.json",
    "packages/engine/src/generated/europe.json",
    "packages/engine/src/generated/greater_europe.json",
    "packages/engine/src/generated/europe_classic.json",
    "packages/engine/src/generated/usa.json",
    "packages/engine/src/generated/asia.json",
    "packages/engine/src/generated/fantasy.json",
    "packages/engine/src/generated/skirmish.json",
    "packages/engine/src/generated/nine_realms.json",
    "packages/selfplay/src/actions.ts",
    "packages/selfplay/src/encode.ts",
    "packages/selfplay/src/log.ts",
    "packages/selfplay/src/game.ts",
    "packages/selfplay/src/traits.ts",
    # the GPU teacher, branch and score, and the training-array writer
    "packages/delove/src/teacher.ts",
    "packages/engine/src/odds.ts",
    "packages/delove/src/branch.ts",
    "packages/selfplay/src/export.ts",
    "packages/selfplay/src/npy.ts",
    # the outcome training reads (log v3: leaderboard placements, kills and points)
    "packages/engine/src/ranking.ts",
]


class StaleMirror(RuntimeError):
    pass


def file_hash(rel: str) -> str:
    """A missing file (renamed or split in the engine) hashes as "missing", so it reads as changed, not as a crash."""
    path = REPO / rel
    if not path.is_file():
        return "missing"
    data = path.read_bytes().replace(b"\r\n", b"\n")
    return hashlib.sha256(data).hexdigest()


def current() -> dict[str, str]:
    return {rel: file_hash(rel) for rel in RULE_FILES}


def recorded() -> dict:
    if not FINGERPRINT.exists():
        return {"files": {}, "verified": None}
    return json.loads(FINGERPRINT.read_text(encoding="utf8"))


def changed_files(engine: str | None = None) -> list[str]:
    """Rule files that differ from the verified fingerprint (all of them if there is none). With `engine`
    ("engine.py", "fused.py", "teacher" or "branch"), also reports it as unverified if the last verification skipped it."""
    rec = recorded()
    files = rec.get("files", {})
    out = [rel for rel, h in current().items() if files.get(rel) != h]
    if engine and engine not in (rec.get("verified") or {}).get("engines", []):
        out.append(f"({engine} not replayed in the last verification)")
    return out


_checked: dict[str, list[str]] = {}


def require_verified(engine: str) -> None:
    """Raise StaleMirror if the engine files changed since the mirror was last verified (cached per process)."""
    if engine not in _checked:
        _checked[engine] = changed_files(engine)
    stale = _checked[engine]
    if stale:
        raise StaleMirror(
            "The GPU mirror has not been verified against this engine. Changed since the last verification:\n  "
            + "\n  ".join(stale)
            + "\nRun `python packages/delove-gpu/verify.py` (it replays fresh engine logs through the GPU engines and"
            " updates engine-fingerprint.json when they match). Pass allow_unverified=True only for tests and benchmarks."
        )


def write(verified: dict) -> None:
    FINGERPRINT.write_text(
        json.dumps(
            {
                "about": "Hashes of the engine files packages/delove-gpu mirrors, as of its last successful replay "
                "verification. Written by packages/delove-gpu/verify.py; do not edit by hand.",
                "files": current(),
                "verified": verified,
            },
            indent=2,
        )
        + "\n",
        encoding="utf8",
        newline="\n",
    )


def main() -> int:
    ap = argparse.ArgumentParser(description="Is the GPU mirror verified against the engine in this checkout?")
    ap.add_argument("command", choices=["check"])
    ap.add_argument("--github", action="store_true", help="report as a GitHub Actions warning and always exit 0")
    args = ap.parse_args()
    stale = changed_files()
    v = recorded().get("verified") or {}
    if not stale:
        print(f"GPU mirror verified against the current engine ({v.get('steps', '?')} steps replayed on {v.get('at', '?')}).")
        return 0
    msg = (
        "Engine rules files changed since packages/delove-gpu (the training-only GPU mirror) was last verified: "
        + ", ".join(stale)
        + ". Not a problem for this PR or the server; before the next GPU training run, run "
        "`python packages/delove-gpu/verify.py` on the training PC (fix the mirror, never the engine, if it finds a mismatch)."
    )
    if args.github:
        print(f"::warning title=GPU mirror needs re-verifying::{msg}")
        return 0
    print(msg)
    return 1


if __name__ == "__main__":
    sys.exit(main())
