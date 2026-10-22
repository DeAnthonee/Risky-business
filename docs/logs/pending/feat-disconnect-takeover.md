server: - 2026-10-22 #301 disconnected tournament seats (owner's request, step A): 2 turn-timer timeouts in a row plus no activity for max(2 x move timer, 180 s) (seat-health.ts, RISK_DISCONNECT_*); the seat's token answers 410, the house bot plays it as "<name>-bot" (GameRoom.dropSeat, through commit, a system history entry), the entrant is `dropped`; a stand-in never moves on: the best other seat by standing does, as decided
engine: - 2026-10-22 #301 renameStandIn (seats.ts, not mirrored): rename a seat in a game in progress
client: - 2026-10-22 #301 tournament page: dropped entrants (🔌, status `dropped`, a clear line for the dropped player)
docs: - 2026-10-22 #301 tournaments.md "Disconnected seats", hosting.md (RISK_DISCONNECT_*)
