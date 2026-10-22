# Web client: running log

Covers `packages/client` (lobby, board, animations, chat, spectator features). Guide: [docs/playing.md](../playing.md).

Newest first, one line per change: `- YYYY-MM-DD #PR what changed`. Changes from before pull requests carry the
commit hash instead. **Append a line in the same PR** as any change to this area (README hard rule 12).

- 2026-10-22 #PR spectators see a player-type badge next to each name ("Claude Sonnet", "Delove delove@10", "Zerg", "Bot", "Human", "?"); seated players never get labels
- 2026-10-22 #171 lobby: an **Add Zerg** button beside **Add bot** seats a Zerg (no badge; its reptile name tells it apart)
- 2026-10-20 #138 leaderboard: a **Training** toggle beside the season picker shows the training leaderboard (profiles from it too); match history tags training games
- 2026-10-20 #122 home page match history board beside the leaderboard: winner (opens profile), how they won, map, turns, duration, final places, View final board while the room is up; three boards side by side on wide screens
- 2026-10-20 #119 leaderboard season picker (current by default; shown once a season is archived), profiles open with that season's numbers
- 2026-10-20 #109 phone held sideways gets its own layout: one-line top bar, tab rail on the right, panels beside the map, short scrolling action bar; wide touch screens up to 540px tall get the phone layout instead of desktop
- 2026-10-20 #108 the current player's territories sit slightly raised (larger, rim, drop shadow) and rock gently during their turn; still under reduced motion
- 2026-10-20 #104 animated water behind the board: depth gradient, drifting wave marks, coastline surf glow (still under reduced motion)
- 2026-10-20 #103 current player card over the board (desktop): this game's stats and leaderboard standing for whoever's turn it is; draggable, resizable, foldable, remembered per browser
- 2026-10-20 #96 generation-match auto-move actually runs (the name comes from the connection), matches only the runner's exact `Generation <tag> Match <n>` names and skips tournament tables; hard rule 10 and playing.md describe it
- 2026-10-20 #94 Persona orange-cream theme for the game screen, lobby, join pages and dialogs (shared `theme.css`); the board itself is unchanged
- 2026-10-20 #95 auto-refresh into next match lobby for generation training spectators
- 2026-10-20 #90 home page redesign: expanding Create room panel, map tiles, grouped settings (shared with the lobby), game tickets, leaderboard board; fonts bundled
- 2026-10-20 #85 hovering a territory highlights all attackable territories from that spot for both players and spectators
- 2026-10-19 #75 opt-in auto-spectate: move on to the next live game (`/?spectate=1`)
- 2026-10-19 #64 profiles show kills and victims
- 2026-10-18 #60 `@all` pings
- 2026-10-18 #56 reinforcement income in the log and scoreboard under fog
- 2026-10-18 #55 spectators can whisper to any player, also from the player details card
- 2026-10-18 #53 player profiles and the leaderboard; exponential cards in the UI
- 2026-10-17 #46 commit slider with live win odds
- 2026-10-17 #42 log: one entry per attack
- 2026-10-17 #40 tournament bracket page
- 2026-10-17 #38 map preview when creating a game and in the lobby
- 2026-10-17 #36 card counts on the scoreboard; next set value in the top bar
- 2026-10-17 #34 spectator fast-forward
- 2026-10-17 #29 troop placements pop in like the card-trade burst; linger for spectators
- 2026-10-17 #27 consecutive blitz rolls replay fast
- 2026-10-17 #26 Who's winning chart
- 2026-10-17 #25 Bonuses view; distinct colours for neighbouring regions
- 2026-10-17 #24 whispers and player mentions in player colour
- 2026-10-17 #23 mobile layout: map always visible, bottom dock
- 2026-10-17 #22 resizable divider between scoreboard and log/chat
- 2026-10-17 #15 spectators see conquests one at a time
- 2026-10-17 #14 card animations: earn, trade in, take on elimination
- 2026-10-17 #11 player income; scoreboard in turn order
- 2026-10-17 #9 spectators: Hide fog / Show fog toggle (F)
- 2026-10-17 #2 capture sweep animation
- 2026-10-17 8d41b39 spectator hands and fog preview
- 2026-10-17 8e2d796 spectate mode and watch links
- 2026-10-17 333838f board zoom and pan, hover-only names on the dense World map
- 2026-10-16 bc20340 first web client: SVG map, animations, cards, chat, log
