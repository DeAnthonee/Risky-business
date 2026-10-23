server: - 2026-10-22 #PR the house roster has no cap (owner): roster requests sit outside the Delove at-once and per-tournament caps, no startup error; roster seats yield to people (`SeatRequests.makeRoom`, `TournamentManager.removeEntrant`): a person or agent joining a full scheduled tournament takes a roster seat's place and the request asks for one fewer; the pool's own joins no longer count toward the per-joiner cap
hosting: - 2026-10-22 #PR ops note: run the seat pool with `--max-seats 100` for a full house roster
docs: - 2026-10-22 #PR tournaments.md (roster: no cap, seats yield), hosting.md, packages/delove/README.md
delove: - 2026-10-22 #PR README: `--max-seats 100` for the daily tournament's house roster
