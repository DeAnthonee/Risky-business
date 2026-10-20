# Runner and character league: running log

Covers `packages/runner` (standalone bot runner, Ollama commander, table talk, post-game learnings) and the league
rankings it plays for. Guides: [packages/runner/README.md](../../packages/runner/README.md),
[docs/character-league.md](../character-league.md), [docs/fog-power-rankings.md](../fog-power-rankings.md).

Newest first, one line per change: `- YYYY-MM-DD #PR what changed`. Changes from before pull requests carry the
commit hash instead. **Append a line in the same PR** as any change to this area (README hard rule 12).

- 2026-10-20 #86 post-game leaderboard filters by generation, isolating active gen from legacy results
- 2026-10-19 #75 smart mechanics training, tactical bonuses, strategic diplomacy
- 2026-10-19 #64 post-game results record kills and victims
- 2026-10-18 #61 Windows fixes (CRLF) in presets and tests
- 2026-10-18 #60 concrete troop-commitment deals, fog card counts, watcher profiles
- 2026-10-18 #56 reinforcement income used for leader/threat assessment
- 2026-10-18 #55 diplomat handles spectator whispers
- 2026-10-18 #53 `packages/runner`: persistent AI league, multi-front planning, shared learnings
