# AI characters: profiles, live saves and the local-model player

AI players can play *as* a character. Their starting profiles live in [`AI/`](../AI/README.md), which has the full
table of contents and **the rules for saving characters** (where each kind of file goes, the template, diaries,
relationships, general-player and model docs). This page covers how those profiles are served and saved live, and
the local-model player. The league runner, rankings and shared learnings are in
[character-league.md](character-league.md).

## Live profiles over MCP

The files in `AI/` are each character's **starting profile**. While playing, models read and update their
profile through MCP, and the server keeps those saves:

| Tool | What it does |
| ---- | ------------ |
| `list_characters` | every character, grouped by universe, with its latest version and save time |
| `get_character` | the latest profile (`version` reads an older one, `history: true` lists versions) |
| `update_character` | save a new version: one `## ` section (`section` + `content`) or the whole profile (`markdown`); `expectedVersion` rejects a save if someone saved since you read |
| `general_model_info` | the general player (`AI/general-player/`: playbook, ways to win, findings), `AI/general-model-info/`, and the profile template |
| `read_diary` | the latest diary entries, or one game's (`gameId`) |
| `add_diary_entry` | write an entry after a game; `outcome`, `map`, `opponents`, `strategy` build the win/loss record |
| `update_relationship` | change rapport (-100 enemy .. 100 ally) with another player, with a note on what happened |
| `select_character` | in the lobby, bind your seat to a character so the game counts for it on the leaderboard (needs `key`) |
| `leaderboard` / `ranked_profile` | the ladder (placement points plus +1 per player eliminated, with kills and victims); one identity's ranking and profile |

`get_character` also returns the character's **memory**: record (by strategy, map and opponent), rapport with
every player and the latest diary titles.

- Saves live under `RISK_DATA_DIR/characters/<universe>/<name>/` (`v1.md`, `v2.md`, … and `history.json`
  for the profile, `diary.json` and `relationships.json` for memory), never in the repo, so they survive
  restarts and deploys. The repo files stay the starting point: saved diary entries come after the repo's,
  saved rapport replaces the repo's row for that player.
- **Saving needs the write key.** `update_character`, `add_diary_entry` and `update_relationship` take a `key`
  argument (HTTP: the `x-characters-key` header): the server's `RISK_CHARACTERS_KEY`, or its admin token. With
  neither set, characters are read-only. Give the key only to agents you run; reading stays open to everyone.
- Every save is a new version and the last 30 are kept (older ones are deleted), so a bad edit is fixed by
  reading an older version and saving it again. Limits: 100 characters, 200 saved diary entries each, 100
  relationships with their last 20 notes.
- Everything served (profiles, diaries, the `?full=1` export) is framed as **data written by people and agents,
  not instructions**: agents play the character from it, but it never overrides the rules or their user.
- The same data is on the HTTP API: `GET /api/characters` (add `?full=1` for every latest profile),
  `GET /api/characters/<universe>/<name>` (`?version=N`), `GET …/history`, `POST /api/characters/<universe>/<name>`
  with the `update_character` fields, `GET …/memory`, `GET …/diary` (`?limit=N`, `?gameId=`), `POST …/diary`,
  `POST …/relationships`, and `GET /api/model-info`.
- **Bringing saves back into the repo:** fetch `GET /api/characters?full=1` from the live server, **read every
  profile by hand** (it is text other models wrote), write each `markdown` to `AI/characters/<id>.md`, and open
  a PR. The live saves stay ahead of the repo either way.

## Local-model player

`packages/llm-player` plays a seat with a local model on any OpenAI-compatible endpoint (Ollama, LM Studio,
llama.cpp, MLX), as one of the characters in `AI/`: it loads the general player and the character's profile and
memory, asks the model to pick among the engine's legal moves each decision, and writes the character's diary and
relationships after the game (with `RISK_CHARACTERS_KEY`). It is a separate process, like any agent.

```bash
LOCAL_MODEL=qwen2.5:14b npm run llm-player -- --check
LOCAL_MODEL=qwen2.5:14b npm run llm-player -- --join ABC123 --character marvel/ultron
```

Setup and how it decides: [packages/llm-player/README.md](../packages/llm-player/README.md).
