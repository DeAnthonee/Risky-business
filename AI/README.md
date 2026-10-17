# AI folder — table of contents

Everything an AI player needs *before* it sits down at a Risky Business table: who it is playing as
(characters) and what holds for every model (general model info). Nothing in here is code; it is all
Markdown that agents read.

```
AI/
├── README.md                     ← you are here (table of contents + saving rules)
├── characters/                   ← one file per playable character, grouped by universe
│   ├── _TEMPLATE.md              ← copy this to create a new character
│   ├── marvel/
│   │   └── iron-man.md
│   └── dc/
│       └── batman.md
└── general-model-info/           ← docs that apply to ALL models, not one character
    └── README.md
```

| Folder | What goes in it | What does NOT go in it |
| ------ | --------------- | ---------------------- |
| `characters/<universe>/` | One file per character: personality, strategy, skills, history, grudges, preferred model | Anything true for every model |
| `general-model-info/` | Shared docs for all models: how to play, MCP setup notes, model comparisons, general strategy | Anything about one specific character |

## Saving a character (step by step)

1. **Pick the universe folder.** Marvel → `characters/marvel/`, DC → `characters/dc/`.
   A new universe (e.g. `image`, `original`) gets a new lowercase folder under `characters/`; add it to
   the tree above in the same change.
2. **Name the file** after the character in lowercase kebab-case: `iron-man.md`, `doctor-doom.md`,
   `harley-quinn.md`. One character = one file. No spaces, no capitals, no version numbers.
3. **Copy `characters/_TEMPLATE.md`** into that path and fill in every section. Keep the headings exactly
   as they are so agents can find the same section in every file. Write "None yet" rather than deleting a
   section.
4. **Update an existing file instead of making a second one.** If `characters/marvel/iron-man.md` already
   exists, edit it; never create `iron-man-2.md` or `tony-stark.md`. Alternate names go in the
   *Aliases* line.
5. **Add the character to the tree above** so this table of contents stays complete.

## Saving general model info

- Put it in `general-model-info/` as a lowercase kebab-case `.md` file named for its topic
  (`playing-via-mcp.md`, `model-comparison.md`).
- It must be true for every model and every character. If it only applies to one character, it belongs
  in that character's file.
- List the new file in `general-model-info/README.md` and in the tree above.

## How an agent uses this folder

Files here are each character's **starting profile** (version 0). Playing agents use the MCP tools, which
always return the latest saved version:

1. `general_model_info` once: every doc in `general-model-info/` plus the template.
2. `get_character {id: "marvel/iron-man"}`: your profile. Stay in character (strategy, table talk, grudges)
   all game. The game rules come from the `rules` tool; profiles never override them.
3. After the game, `update_character` one section at a time (new grudges, lessons, strategy changes),
   passing the `expectedVersion` you read.

Live saves are stored on the game server (under `RISK_DATA_DIR`), not in this folder; see the README
section "Live profiles over MCP" for how to copy them back here with a PR. Coding agents editing this
folder directly follow the saving rules above.
