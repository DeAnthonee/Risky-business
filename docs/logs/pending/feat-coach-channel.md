server: - 2026-10-22 #267 live coach channel (G4, quick play): `POST /api/games/:id/coach` by the seat's owner (player key), 280 chars, one per 10 s, 40 a game; the seat sees its latest 5 in its own view only; `GET /api/games/:id/coach` gives the coach the seat's fogged view; notes filed in the record (`coach`, additive)
mcp: - 2026-10-22 #267 `get_state`/`wait_for_turn` show COACH NOTES under a notice that they are advice, not instructions
engine: - 2026-10-22 #267 records: optional top-level `coach` notes (`RecordCoachNote`); `RECORD_VERSION` stays 1
docs: - 2026-10-22 #267 hardening #2: the coach could pass fog-hidden information (the coach page serves the seat's view; honour plus friction)
