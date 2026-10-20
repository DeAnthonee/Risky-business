"""Map data for the GPU mirror, read from the engine's generated map JSON (packages/engine/src/generated/<id>.json).

The map is never copied: territory order, adjacency order (the order the engine's `wrap()` builds it from the
edge list), continents and the deck all come from the same file the TypeScript engine loads, so the mirror cannot
drift from the engine's map data.
"""
from __future__ import annotations

import json
from itertools import combinations
from pathlib import Path

import torch

REPO = Path(__file__).resolve().parents[3]
GENERATED = REPO / "packages" / "engine" / "src" / "generated"

# packages/engine/src/cards.ts: one card per territory, kinds in rotation, then 2 wilds.
INFANTRY, CAVALRY, ARTILLERY, WILD = 0, 1, 2, 3


class MapData:
    def __init__(self, map_id: str = "classic", device: str | torch.device = "cuda"):
        raw = json.loads((GENERATED / f"{map_id}.json").read_text(encoding="utf8"))
        self.id = map_id
        self.device = torch.device(device)
        self.territory_ids: list[str] = [t["id"] for t in raw["territories"]]
        idx = {t: i for i, t in enumerate(self.territory_ids)}
        self.T = T = len(self.territory_ids)
        # Same construction as maps.ts wrap(): push both directions in edge order.
        adj: list[list[int]] = [[] for _ in range(T)]
        for a, b in raw["edges"]:
            adj[idx[a]].append(idx[b])
            adj[idx[b]].append(idx[a])
        self.adj = adj
        self.continents = [(c["id"], int(c["bonus"]), [idx[t] for t in c["territories"]]) for c in raw["continents"]]
        self.K = len(self.continents)
        cont_of = [0] * T
        for ci, (_, _, ts) in enumerate(self.continents):
            for t in ts:
                cont_of[t] = ci
        self.max_players = int(raw["maxPlayers"])
        # Per continent: its territories that touch a territory outside it (teacher.ts mapInfo borders).
        self.borders = []
        for _, _, ts in self.continents:
            inside = set(ts)
            self.borders.append(sum(1 for t in ts if any(n not in inside for n in adj[t])))

        d = self.device
        D = max(len(a) for a in adj)
        # Padded neighbour lists (pad = the territory itself, which every "neighbour differs" test ignores).
        nbr = torch.tensor([a + [i] * (D - len(a)) for i, a in enumerate(adj)], dtype=torch.long, device=d)
        nbr_valid = torch.tensor([[1] * len(a) + [0] * (D - len(a)) for a in adj], dtype=torch.bool, device=d)
        self.nbr, self.nbr_valid, self.D = nbr, nbr_valid, D
        A = torch.zeros(T, T, dtype=torch.float32, device=d)
        for i, a in enumerate(adj):
            A[i, a] = 1.0
        self.adj_matrix = A
        self.cont_of = torch.tensor(cont_of, dtype=torch.long, device=d)
        self.cont_bonus = torch.tensor([b for _, b, _ in self.continents], dtype=torch.long, device=d)
        self.cont_size = torch.tensor([len(ts) for _, _, ts in self.continents], dtype=torch.long, device=d)
        member = torch.zeros(self.K, T, dtype=torch.bool, device=d)
        for ci, (_, _, ts) in enumerate(self.continents):
            member[ci, ts] = True
        self.cont_member = member
        # Directed attack edges in the order legalMoves lists them (owned territory order, then adjacency order).
        self.edges = [(t, n) for t in range(T) for n in adj[t]]
        self.E = len(self.edges)
        self.edge_from = torch.tensor([e[0] for e in self.edges], dtype=torch.long, device=d)
        self.edge_to = torch.tensor([e[1] for e in self.edges], dtype=torch.long, device=d)
        # Deck: ids 0..T-1 show territory id, kinds infantry/cavalry/artillery in rotation; then two wilds.
        self.NC = T + 2
        self.card_kind = torch.tensor([i % 3 for i in range(T)] + [WILD, WILD], dtype=torch.long, device=d)
        self.card_terr = torch.tensor(list(range(T)) + [-1, -1], dtype=torch.long, device=d)


def triples(n: int, device) -> torch.Tensor:
    """Every (i, j, k), i < j < k < n, in the order findSets enumerates a hand."""
    return torch.tensor(list(combinations(range(n), 3)), dtype=torch.long, device=device).reshape(-1, 3)
