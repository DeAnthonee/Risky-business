# Local models

Status: two player processes are built. `packages/llm-player` plays one seat as an `AI/` character on any
OpenAI-compatible model (it picks among the engine's legal moves). `packages/runner` (the character league) plays
many seats with plan-aware bot moves steered by an Ollama commander. What is left needs the Mac mini: pick the
model and point the player at it. Model training remains future work.

## Goal

Run our own "general player" model on the Mac mini that hosts the game, with each character layered on
top of it, so characters play from their own profile, diary and relationships.

## Design

- **Where:** the model runs on the Mac mini next to the game server. Model weights never go in the repo.
- **Layers, not separate models (for now):** one base model plus, per character, the profile, the diary,
  the relationships and the win/loss record, all served by the MCP tools (`get_character`, `read_diary`).
  This needs no training and works with any model, local or hosted.
- **Player process:** `packages/llm-player` joins games through the HTTP API like any other agent, asks the
  model to pick among the legal moves, and writes the diary entry and relationship updates after the game. It runs
  separately from the game server, which stays a single process with no outside services. See its README.
- **Later, per-character weights:** once characters have enough recorded games, a small fine-tuned adapter
  (LoRA) per character can be trained on top of the base model from their game logs.

## Hooking it up on the Mac mini

```bash
LOCAL_MODEL=<model name> LOCAL_MODEL_URL=http://127.0.0.1:<port>/v1 npm run llm-player -- --check
RISK_SERVER_URL=http://127.0.0.1:8080 RISK_CHARACTERS_KEY=... LOCAL_MODEL=<model name> \
  npm run llm-player -- --join <CODE> --character marvel/ultron
```

## Open questions for infrastructure

1. Which runtime serves the models (Ollama, LM Studio, llama.cpp, MLX), on what port? (All of them offer the
   OpenAI-compatible API the player uses.)
2. Which models are installed, and their sizes? A 7-14B instruct model should be enough to pick from numbered options; try it with `--check` and a game against bots.
3. How much memory does the mini have, and how much do the other project's models use?
4. Does the runtime stay up permanently alongside the game server?

## Phase 1: `packages/runner`

`@risk/runner` joins multiple tables over the HTTP API. An Ollama commander sets per-turn plans, a
validated move chooser executes legal actions, and a diplomat writes character dialogue. All lobbies
share one local model queue (`qwen3:14b`, port 11434). Planning waits are bounded; chat refreshes queued
board context and rejects expired offers.

Each character remembers its own lessons, evolving tactics, relationships, head-to-head history and
private tactical events. Completed games update shared advice and placement rankings. Local memory
needs no server write key; publishing server diaries/relationships remains opt-in.

Run instructions: `packages/runner/README.md`. Profiles, ratings and persistence: `docs/character-league.md`.
