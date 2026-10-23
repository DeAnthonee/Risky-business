runner: - 2026-10-22 #319 diplomatic ping system (turn pings, spectator visibility, relationship tracking), good-neighbor pacts only between adjacent bonuses, 2v1 joint attacks in 3-player endgames, capital runs and position-weighted capital defense
runner: - 2026-10-22 #319 `--llm-stats FILE` logs every model call (queue wait, prompt and output tokens and times); commander and diplomat prompts put shared text first and the seat last so Ollama reuses its prompt cache (commander calls about 15% faster over a full 10-seat game)
runner: - 2026-10-22 #319 good-neighbor pacts dissolve after 4 of a seat's turns without a conquest (pacts on every border froze 4-6 player tables)
runner: - 2026-10-22 #319 the runner's LEADERBOARD.md merges versioned seat names (Ronny@6, Ronny@13) and player:/league/ aliases into one row per character; Zerg-aware model names, seats stop when the table ends
delove: - 2026-10-22 #319 delove-seat accepts sensei@3 as another name for jacob-sensei@1
docs: - 2026-10-22 #319 docs/how-to-run-league-models.md: running League characters and DeLOVE locally or live, and a 5 vs 5 mixed table with delove@13
runner: - 2026-10-22 #319 capital-run search computes the safe-stack odds only for territories on the chosen attack tree (it ran a full odds table per map edge on every move; one headless test took 69 s and timed out vitest's worker)
