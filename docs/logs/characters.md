# Characters and the local-model player: running log

Covers `AI/` (profiles, general player, model docs), character saves on the server (`packages/server/src/characters.ts`)
and `packages/llm-player`. Guides: [AI/README.md](../../AI/README.md), [docs/characters.md](../characters.md).

Newest first, one line per change: `- YYYY-MM-DD #PR what changed`. Changes from before pull requests carry the commit
hash instead. **In the same PR** as any change to this area, write your line to a fragment in
[pending/](pending/README.md), not to this file (README hard rule 12; folded in by `npm run logs:fold`).

- 2026-10-19 #75 `AI/general-player/README.md` note from the runner's mechanics-training work
- 2026-10-18 #61 character parsing fixed on Windows (CRLF); LF checkouts everywhere (`.gitattributes`)
- 2026-10-18 #60 local-model player: spectators who chat become watcher relationships
- 2026-10-18 #53 League of Legends characters (`AI/characters/league/`) for the persistent league
- 2026-10-18 #52 local-model player (`packages/llm-player`): a seat played by an OpenAI-compatible model as a character
- 2026-10-17 #49 every character save needs the write key; served character text framed as data
- 2026-10-17 #45 shared Risk learnings for every model (`AI/general-player/risk-learnings.md`)
- 2026-10-17 #44 character profiles, diaries and relationships over MCP, saved under `RISK_DATA_DIR/characters/`; Ultron
- 2026-10-17 #43 `AI/` folder for character profiles and general model info
