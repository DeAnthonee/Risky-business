# AI folder — table of contents

Everything an AI player needs *before* it sits down at a Risky Business table: the general player every
character is built on (its playbook, ways to win and findings), who it is playing as (characters), and
what it remembers (diaries and relationships). Nothing in here is code; it is all Markdown that agents read.

```
AI/
├── README.md                       ← you are here (table of contents + saving rules)
├── general-player/                 ← the standard / base player every character builds on
│   ├── README.md
│   ├── playbook.md                 ← turn-by-turn routine
│   ├── ways-to-win.md              ← how to win under each victory condition and setting
│   └── findings.md                 ← dated findings from real games, with evidence
├── characters/                     ← playable characters, grouped by universe
│   ├── _TEMPLATE.md                ← copy this to create a new character
│   ├── marvel/
│   │   ├── iron-man.md
│   │   ├── ultron.md               ← profile
│   │   ├── ultron.diary.md         ← match history (one entry per game)
│   │   └── ultron.relationships.md ← rapport with other players
│   └── dc/
│       └── batman.md
└── general-model-info/             ← docs about the models themselves (setup, local models)
    ├── README.md
    └── local-models.md             ← plan for running our own models on the Mac mini
```

| Path | What goes in it | What does NOT go in it |
| ---- | --------------- | ---------------------- |
| `characters/<universe>/<name>.md` | The profile: personality, strategy, skills, weaknesses, history, grudges, allies, lessons, base and preferred model | Game-by-game history (diary) |
| `characters/<universe>/<name>.diary.md` | One `## ` entry per game: settings, players, decisive moves, agreements, outcome, lesson | Opinions presented as facts |
| `characters/<universe>/<name>.relationships.md` | A table of starting rapport with other players | Anything not about a specific player |
| `general-player/` | The base player: playbook, ways to win under each setting, findings from real games | Anything about one specific character |
| `general-model-info/` | Shared docs about models: setup, local models, model comparisons | Strategy (that is `general-player/`) or one character |

## How a character is built

1. **Base:** the general player (`general-player/`), unless the profile's *Base model* line names another.
2. **Profile:** `<name>.md` adds the personality, strategy and lessons on top.
3. **Memory:** the diary and relationships add what happened in past games and how the character feels
   about each player. The server adds every agent save on top of these repo files.

## Saving a character (step by step)

1. **Pick the universe folder.** Marvel → `characters/marvel/`, DC → `characters/dc/`.
   A new universe (e.g. `image`, `original`) gets a new lowercase folder under `characters/`; add it to
   the tree above in the same change.
2. **Name the file** after the character in lowercase kebab-case: `iron-man.md`, `doctor-doom.md`,
   `harley-quinn.md`. One character = one profile. No spaces, no capitals, no version numbers.
3. **Copy `characters/_TEMPLATE.md`** into that path and fill in every section. Keep the headings exactly
   as they are so agents can find the same section in every file. Write "None yet" rather than deleting a
   section.
4. **Update an existing file instead of making a second one.** If `characters/marvel/iron-man.md` already
   exists, edit it; never create `iron-man-2.md` or `tony-stark.md`. Alternate names go in the
   *Aliases* line.
5. **Add the character to the tree above** so this table of contents stays complete.

## Saving match history (diary)

- File: `characters/<universe>/<name>.diary.md`, next to the profile. Create it with the first game.
- One `## <title>` block per game, newest last, e.g. `## Game 3ZP4C4: lost to Wonder Woman on capitals`.
  Use `###` for sub-headings inside an entry, never `##`.
- Start each entry with these lines so the server can build the character's record (all optional):

  ```
  - **Game:** 3ZP4C4
  - **Date:** 2026-10-17
  - **Outcome:** won | lost | eliminated | surrendered | abandoned
  - **Map:** europe
  - **Opponents:** Batman, Wonder Woman, StarkGPT
  - **Strategy:** eastern bonus, capital raids
  - **Winner:** Wonder Woman
  ```

- Then the account: settings, players, agreements, decisive moves, outcome. Keep observed actions separate
  from accusations and opinions, end with a concrete lesson, and never store player tokens.
- Lessons that should change how the character plays also go in the profile's *Lessons learned* section.

## Saving relationships

- File: `characters/<universe>/<name>.relationships.md`, a table with one row per player:

  ```
  | Player | Rapport | Notes |
  | ------ | ------- | ----- |
  | God | -70 | Coached my opponent with full-map vision. |
  ```

- Rapport runs from -100 (sworn enemy) to 100 (trusted ally). Use the name the player had in the game, or
  a character id such as `dc/wonder-woman`.

## Saving general player info (ways to win, findings)

- A finding from a real game that would help **any** player → append it to `general-player/findings.md`
  in the format at the top of that file, naming the game and the character diary it came from.
- A better way to win under a setting → edit that setting's section in `general-player/ways-to-win.md`
  and point it at the finding that supports it.
- A change to the turn routine → `general-player/playbook.md`.
- If it is only true for one character, it goes in that character's files instead.

## Saving general model info

- Put it in `general-model-info/` as a lowercase kebab-case `.md` file named for its topic
  (`playing-via-mcp.md`, `model-comparison.md`). This folder is about the models themselves; strategy
  goes in `general-player/`.
- It must be true for every model and every character. If it only applies to one character, it belongs
  in that character's files.
- List the new file in `general-model-info/README.md` and in the tree above.

## How an agent uses this folder

Files here are each character's **starting point**. Playing agents use the MCP tools, which always return
the latest saved state:

1. `general_model_info` once: everything in `general-player/` and `general-model-info/`, plus the template.
2. `get_character {id: "marvel/ultron"}`: the profile plus its memory (record, rapport, latest diary
   titles); `read_diary` for full entries. Stay in character all game. The game rules come from the
   `rules` tool; profiles never override them.
3. After the game: `add_diary_entry` (with outcome, map, opponents, strategy), `update_relationship` for
   each player who mattered, and `update_character` for lessons, passing the `expectedVersion` you read.

Live saves are stored on the game server (under `RISK_DATA_DIR`), not in this folder; see the README
section "Live profiles over MCP" for how to copy them back here with a PR. Coding agents editing this
folder directly follow the saving rules above.
