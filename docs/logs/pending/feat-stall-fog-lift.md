engine: - 2026-10-22 #PR stall breaker, step 1 (owner's request): option `stallFogLift` (0 = off, up to 20); the engine counts full rounds since the last territory captured (`lastCaptureRound`), and in a fog game at N it sets the sticky `fogLifted` and emits `fog_lifted {rounds}`; viewFor stops fogging; rules text and options summary; engine.ts and types.ts changed (GPU verify needed)
server: - 2026-10-22 #PR nested and scheduled tournaments default `stallFogLift: 3`; old snapshots load with 0; reaction pop-ups and link previews treat a lifted fog as no fog; the play-by-play shows the lift
client: - 2026-10-22 #PR the fog lift in the log and as a banner, a "Fog lifted" tag for spectators, and the board drawn unfogged after it
mcp: - 2026-10-22 #PR recent events show the fog lift
docs: - 2026-10-22 #PR playing.md (the stallFogLift setting), tournaments.md (the tournament default)
