# @risk/llm-player

A Risk player driven by a **local model** on any OpenAI-compatible endpoint (Ollama, LM Studio, llama.cpp
server, MLX server, or a hosted API), playing as one of the characters in `AI/characters/`. It is its own process
and talks to the game server over the HTTP API like any agent; the game server never loads it.

```bash
npm ci && npm run build
# test the model setup first
LOCAL_MODEL=qwen2.5:14b npm run llm-player -- --check
# join a game a human shared, as Ultron
RISK_SERVER_URL=https://risky.deanthoneeking.com LOCAL_MODEL=qwen2.5:14b RISK_CHARACTERS_KEY=... \
  npm run llm-player -- --join ABC123 --character marvel/ultron
# or host one against two bots
npm run llm-player -- --create --bots 2 --options '{"map":"classic"}' --character marvel/ultron --model qwen2.5:14b
```

| setting | flag / env | default |
| --- | --- | --- |
| model | `--model` / `LOCAL_MODEL` | (required) |
| endpoint | `--model-url` / `LOCAL_MODEL_URL` | `http://127.0.0.1:11434/v1` (Ollama; LM Studio is `:1234/v1`, llama.cpp `:8080/v1`) |
| game server | `--server` / `RISK_SERVER_URL` | `http://localhost:8080` |
| character | `--character marvel/ultron` | none: the general player |
| save the diary | `RISK_CHARACTERS_KEY` | unset: nothing is saved |
| hosted API key | `LOCAL_MODEL_API_KEY` | unset |

Other flags: `--name`, `--game CODE --token TOKEN` (resume a seat), `--max-turns N` (surrender after N of your
turns), `--timeout S` (per answer, at least 1, default 120), `--no-chat`, `--no-reflect`. When it joins on a terminal
it prints the seat token (keep it to resume); in a non-interactive log the token is withheld.

## How it plays

1. **Layers.** The system prompt is the general player's playbook (`AI/general-player/playbook.md`), then the
   character's profile and memory (record, rapport, latest diary titles) from `get_character`, framed as data.
2. **Decisions.** Each decision shows the board (the same text MCP agents get), the last table chat, and a short
   numbered list of the engine's own legal moves, best first by a simple heuristic (stack on the most threatened
   border, attacks sorted by blitz odds, fortify toward the front). The model answers
   `{"choice": n, "say": "..."}`. Only legal moves are offered, so any pick is valid; small models handle a
   numbered pick far better than writing action JSON.
3. **Fallbacks.** A timeout, an error or an unusable answer plays option 1, so a slow or broken model never stalls
   the table. Single-option steps (like ending the turn after a fortify) skip the model. After 3 failures in a row,
   or 40 model calls, in one turn the rest of the turn plays option 1. A game server that is down (a deploy: network
   errors, 5xx) is retried with backoff for up to 5 minutes; a game that is gone ends the run as abandoned.
4. **Chat.** At most one `say` line per turn goes to the table chat.
5. **After the game.** As the character, the model writes a diary entry (outcome, map, opponents and strategy feed
   the record) and rapport changes for the players who mattered, saved with the write key. If the reflection is
   unusable, a plain diary entry still records the result.

## Code

`src/model.ts` (OpenAI-compatible client, JSON extraction), `src/options.ts` (legal moves → numbered options),
`src/prompt.ts` (layers, prompts, parsing), `src/player.ts` (the game loop and the after-game diary),
`src/cli.ts`. Tests (`npm test -w @risk/llm-player`) play whole engine games through the options, check the
client against a mock endpoint, and play a live server game as Ultron with a scripted model that sometimes
answers junk or fails.
