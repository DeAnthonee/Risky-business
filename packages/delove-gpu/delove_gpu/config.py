"""Game configurations for the GPU mirror: map, table size and game settings, checked like the engine checks them.

The facts a configuration rests on (DEFAULT_OPTIONS, MAP_IDS, every map's player limit, starting armies per table size
and blizzard limit) are read from the built engine itself (packages/engine/dist), so the mirror cannot drift from them:
`STARTING_ARMIES` and `classicScaledArmies` are never re-implemented here.

Every setting of a configuration is a compile-time constant of the CUDA kernels (one compile per configuration,
cached on disk). Fog of war is not mirrored.
"""
from __future__ import annotations

import json
import os
import subprocess
from dataclasses import dataclass, field
from functools import lru_cache

from .fingerprint import REPO

# The settings the mirror covers (GameOptions keys). maxPlayers, spectatorChat and fogOfWar (always false) do not
# change a game played by a fixed table.
COVERED = ["map", "setupBatch", "fortifyMode", "randomDeal", "autoSetup", "cardValues", "capitals", "chooseCapitals",
           "firstRoundBonus", "balancedBlitz", "neutrals", "neutralArmies", "blizzards"]
IGNORED = ["maxPlayers", "spectatorChat", "fogOfWar"]


@lru_cache(maxsize=1)
def engine_facts() -> dict:
    """{defaults, mapIds, maps: {id: {maxPlayers, territories, startingArmies: {n: armies}, maxBlizzards}}} from the
    built engine (run `npm run build` first)."""
    js = (
        "import * as e from './packages/engine/dist/index.js';"
        "const maps = {};"
        "for (const id of e.MAP_IDS) { const m = e.getMap(id); const sa = {};"
        " for (let n = 2; n <= m.maxPlayers; n++) sa[n] = m.startingArmies(n);"
        " maps[id] = {maxPlayers: m.maxPlayers, territories: m.territoryIds.length, startingArmies: sa, maxBlizzards: e.maxBlizzards(m)}; }"
        "console.log(JSON.stringify({defaults: e.DEFAULT_OPTIONS, mapIds: e.MAP_IDS, maps}));"
    )
    r = subprocess.run(["node", "--input-type=module", "-e", js], cwd=REPO, capture_output=True, text=True, shell=os.name == "nt")
    if r.returncode:
        raise RuntimeError(f"reading the engine's map facts failed (npm run build first?): {r.stderr}")
    return json.loads(r.stdout)


@dataclass(frozen=True)
class GameConfig:
    """A table: map, number of seats and the game settings (DEFAULT_OPTIONS for anything not given)."""

    map: str = "classic"
    seats: int = 2
    options: tuple = field(default_factory=tuple)  # sorted (key, value) pairs over the defaults

    @staticmethod
    def make(seats: int, options: dict | None = None) -> "GameConfig":
        o = dict(options or {})
        facts = engine_facts()
        unknown = [k for k in o if k not in COVERED and k not in IGNORED]
        if unknown:
            raise ValueError(f"settings not covered by the GPU mirror: {unknown}")
        if o.get("fogOfWar"):
            raise ValueError("fog of war is not mirrored on the GPU")
        merged = {**facts["defaults"], **o}
        cfg = GameConfig(merged["map"], int(seats), tuple(sorted((k, merged[k]) for k in COVERED if k != "map")))
        cfg.validate()
        return cfg

    def opt(self, key: str):
        return dict(self.options)[key]

    @property
    def facts(self) -> dict:
        return engine_facts()["maps"][self.map]

    def validate(self):
        """engine.ts validateOptions, plus startGame's seat limit."""
        f = engine_facts()
        if self.map not in f["maps"]:
            raise ValueError(f"unknown map {self.map!r} (the GPU mirror covers {f['mapIds']})")
        m = self.facts
        if not 2 <= self.seats <= m["maxPlayers"]:
            raise ValueError(f"{self.seats} seats on {self.map}: the map takes 2-{m['maxPlayers']}")
        sb = self.opt("setupBatch")
        if not (isinstance(sb, int) and 1 <= sb <= 40):
            raise ValueError("setupBatch must be an integer between 1 and 40")
        if self.opt("fortifyMode") not in ("connected", "adjacent"):
            raise ValueError("fortifyMode must be 'adjacent' or 'connected'")
        if self.opt("cardValues") not in ("progressive", "fixed", "exponential"):
            raise ValueError("cardValues must be 'progressive', 'fixed' or 'exponential'")
        b = self.opt("blizzards")
        if not (isinstance(b, int) and 0 <= b <= m["maxBlizzards"]):
            raise ValueError(f"blizzards must be an integer between 0 and {m['maxBlizzards']} on {self.map}")
        nt = self.opt("neutrals")
        if not (isinstance(nt, int) and 0 <= nt <= m["territories"] // 3):
            raise ValueError(f"neutrals must be an integer between 0 and {m['territories'] // 3} on {self.map}")
        na = self.opt("neutralArmies")
        if not (isinstance(na, int) and 1 <= na <= 10):
            raise ValueError("neutralArmies must be an integer between 1 and 10")

    @property
    def starting_armies(self) -> int:
        return int(self.facts["startingArmies"][str(self.seats)])

    @property
    def neutral_territories(self) -> int:
        """startGame's neutralTerritories: 0 at 2 players (the classic Neutral is dealt in instead)."""
        if self.seats == 2:
            return 0
        return min(self.opt("neutrals"), self.facts["territories"] - self.seats)

    @property
    def has_neutral(self) -> bool:
        return self.seats == 2 or self.neutral_territories > 0

    def label(self) -> str:
        d = engine_facts()["defaults"]
        diff = {k: v for k, v in self.options if d.get(k) != v}
        return f"{self.map}/{self.seats}p" + (" " + json.dumps(diff, separators=(",", ":")) if diff else "")

    def options_json(self) -> dict:
        """The options as the engine takes them (for `play --options`)."""
        return {"map": self.map, **dict(self.options)}
