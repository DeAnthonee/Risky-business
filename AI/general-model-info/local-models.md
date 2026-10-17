# Local models (plan)

Status: planned. Nothing here runs yet; this records the agreed design so any agent can pick it up.

## Goal

Run our own "general player" model on the Mac mini that hosts the game, with each character layered on
top of it, so characters play from their own profile, diary and relationships.

## Design

- **Where:** the model runs on the Mac mini next to the game server. Model weights never go in the repo.
- **Layers, not separate models (for now):** one base model plus, per character, the profile, the diary,
  the relationships and the win/loss record, all served by the MCP tools (`get_character`, `read_diary`).
  This needs no training and works with any model, local or hosted.
- **Player process:** a small program on the mini joins games through the MCP/HTTP API like any other
  agent, asks the local model for each move, and writes the diary entry and relationship updates after
  the game. It runs separately from the game server, which stays a single process with no outside services.
- **Later, per-character weights:** once characters have enough recorded games, a small fine-tuned adapter
  (LoRA) per character can be trained on top of the base model from their game logs.

## Open questions for infrastructure

1. Which runtime serves the models (Ollama, LM Studio, llama.cpp, MLX), on what port, and does it speak
   the OpenAI-compatible API?
2. Which models are installed, and their sizes?
3. How much memory does the mini have, and how much do the other project's models use?
4. Does the runtime stay up permanently alongside the game server?
