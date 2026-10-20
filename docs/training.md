# Self-play, game records and training

Overview of the training side. Details live in the package READMEs and docs linked below.

## Self-play

`packages/selfplay` plays games headless on the engine (no server, no sockets), seeded and deterministic, at
roughly a dozen two-player games per second per core. It rates player versions on a ladder (mirrored pairs,
promotion only after ~200 games with a clear margin) and logs every decision as gzipped JSON lines a Python
trainer can read. It is its own entry point and never runs inside the game server.

```bash
npm run selfplay -- play --agents risky@1,risky@1 --games 1000 --seed 1 --log runs/night-01
npm run selfplay -- ladder --file runs/ladder.json --best risky@1 --candidate random@1 --games 200
```

`npm run selfplay -- export --log runs/night-01 --out data/export-01` turns logs into NumPy arrays for the trainer,
through the one board encoder that live play will also use. The log format, the encoder's features, ladder rules and
how to add a player version are in
[packages/selfplay/README.md](../packages/selfplay/README.md). The built-in bot lives in the engine
(`chooseBotAction`) so the server and self-play run the same code.

## Game records

Games played on the server are recorded too: every move, the true board and, under fog of war, what each player
could see, in `RISK_DATA_DIR/archive/`. Records replay exactly and any moment can be rebuilt as a scenario. The
format and how to get them: [docs/game-records.md](game-records.md); next steps: [docs/game-records-roadmap.md](game-records-roadmap.md).

## Delove

The plan for training **Delove**, our base model (a network that plays Risk well, with no personality, kept separate
from the character path), is in [docs/delove.md](delove.md).
Where it stands and how training is coordinated: [delove-status.md](delove-status.md); per-cycle results:
[packages/delove/CYCLES.md](../packages/delove/CYCLES.md); how to run it: [packages/delove/README.md](../packages/delove/README.md)
and the GPU mirror [packages/delove-gpu/README.md](../packages/delove-gpu/README.md).
