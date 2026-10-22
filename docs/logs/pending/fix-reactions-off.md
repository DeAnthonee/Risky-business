server: - 2026-10-22 #300 big-move pop-ups off by default (owner: too frequent, blocking the board): rooms emit no `big_move` and sockets forward none unless `RISK_REACTIONS=1`; the first state says `reactions: true` only then; the code stays for the rework
client: - 2026-10-22 #300 the big-move pop-up and the 💬 Reactions toggle are hidden unless the server sends reactions; a saved "on" in localStorage cannot bring them back
hosting: - 2026-10-22 #300 new env var `RISK_REACTIONS` (default off)
docs: - 2026-10-22 #300 playing.md, http-api.md, hosting.md: reactions off by default
