# Playing and watching: the web client, rules and game settings

What players and spectators see in the web client, the rules the engine implements, and every host-selectable
setting. The settings table is a summary: the source of truth is `OPTION_SPECS` in
`packages/engine/src/options.ts` (also served at `GET /api/options` and by the MCP `game_options` tool).
Maps: [maps.md](maps.md). Tournaments: [tournaments.md](tournaments.md).

## Starting a game

For a game right away, enter a name and press **Quick play** (pick the seats and fog beside it): you wait at most
about a minute for other players asking for the same game, then you are seated with them in a fresh room, the empty
seats filled with Zergs. Quick-play games set themselves up automatically and run a per-move turn timer, so nobody
can stall the table; they are not ranked on the leaderboard (house players never count). **Cancel** leaves the queue. Agents use the same queue with the MCP `quick_play` tool.

Open http://localhost:8080, enter a name, press **Create room** (it opens the setup in place: maps as silhouette tiles
with a live preview, settings grouped into Players and setup, Cards and combat, Board twists; the lobby uses the same
groups), add a bot or a **Zerg** (a rushing house bot with a Zerg pun for a name, Mark Zergburg, Elon Zerg, Zergy Mercury and so on, that never attacks a fellow Zerg while anyone else is alive; when only Zergs are left the game ends at once and the strongest Zerg wins; see [zergs.md](zergs.md)) or share the 6-letter join code (or the invite link `?game=CODE`), and press **Start**. The home
page lists open games as tickets (joinable rooms first, then live and finished ones) next to the leaderboard (once a season has been archived, a season picker above it shows past seasons; the current one is the default; when the host has set a season password, an **Archive season** button there archives the season after a password and a confirm; the **Training** toggle beside it switches to the training leaderboard of model-vs-model yardstick games, and the **Tournament** toggle to the tournament leaderboard of finished tournaments; neither counts on the public one) and the **match history**: the most recent finished games, newest first, each with its winner (click the name for their profile), how they won, the room, map, turns, how long it took and every seat's final place. While a finished room is still on the server, **View final board** opens it to watch. Wide screens show the three boards side by side; narrower ones stack the leaderboard and match history beside the open games. Anyone can **watch** a game without playing:
press "Watch" in the game list or open `?game=CODE&spectate=1`. When someone takes a lot in one turn (a sweep of 3+ territories and a quarter of a player's land, a knockout, or a capital), a short pop-up over the map shows it with a line from each side, in the character's voice when the seat plays a character; **💬 Reactions** turns these off (remembered in this browser). Under fog of war only spectators see them, so they never reveal a hidden conquest. The **🔗 Share** button on a game or tournament page
copies its link (on a phone it opens the share sheet); pasted into a chat app, the link shows a preview with the
name, map, seats, status and a picture of the board (owner colours only under fog of war). Spectators see the public board, the
log and chat, a live "watching" count, and which players are online. Next to each player's name a small badge shows
what kind of player it is ("Claude Sonnet", "Delove delove@10", "Zerg", "Bot", "Human", or "?" when the seat did not
say); the seat declares it itself, and only spectators see these badges, never the players. In fog-of-war games they can
see the board as any player sees it (click a player, or "Follow turn") and press **F** ("Hide fog" /
"Show fog") to flip to the whole map and back. Spectators get updates replayed one at a time, so each
conquest in a burst of attacks stays on screen for a moment (the replay speeds up if it falls behind).
Press **Fast-forward** in the spectator bar to drop the replay and all animations and see every move the moment it
happens (handy for long all-AI games); press it again for normal speed. It is spectator-only and resets to normal
speed when you take a seat or reload.

The board sits on animated water: a lit sea that darkens toward the edges, small cream wave marks that drift
and fade in and out, and a soft surf glow that swells along every coast. It is ambient decoration (Fast-forward
does not touch it) and holds still when the system asks for reduced motion.

The territories of the player whose turn it is get a still, glassy sheen (lit from the top, a little darker at the
bottom) so you can see at a glance what they hold. Under fog only the land you can see gets it.

A **capture** pours in like liquid: drops of the new owner's colour run across the border from the attacking
territory, a rippling front fills the captured territory from that side and pushes the old colour out (about a
second), then a white rim flash, a small pop and a ripple from the army badge lock the new colour in. With reduced
motion only the rim flash plays; Fast-forward skips it. Under fog, when you can see the attacker but not the captured
territory, only the drops crossing the border show.

### Features that move a spectator

README hard rule 10: the client moves a spectator to another game only when they turned that on, and never moves a
player; the one exception is runner generation training matches. These are the features that move a spectator:

**Auto-spectate** is a hands-off live stream: press **Auto-Spectate Live Stream** above the game list (shown while a
game is being played) or open `/?spectate=1` with no game. It tunes into a game in progress and, when that game ends
or its room closes, shows a countdown to the next live game, with **Stay here** to keep watching where you are (which
ends auto-spectate). It is opt-in: a game you opened yourself (from the list, a link or a tournament bracket) never
moves you on, players are never moved, and tournament tables are never picked. While waiting it polls the game list
every 2 s, backing off to 10 s. The URL stays `/?spectate=1`, so a reload picks up whatever is live.

**Generation training matches** are the rule's one exception: automatic, with no switch (#95; the owner's call,
2026-10-22). The runner names its rooms
`Generation <tag> Match <n>` (e.g. `Generation 5 Match 3`), and when one ends or closes, every spectator gets a 4 s
countdown to the next one, a running match first, otherwise its lobby (watch it fill and start), with **Stay here** to
remain. Only that exact name counts (a room a person names that way counts too), tournament tables are never picked,
and players are never moved.

**Follow the action** on a nested tournament's page (see [Watching a nested tournament](#watching-a-nested-tournament)):
an opt-in switch, off by default, that moves the view between that tournament's tables by itself, inside the tournament page only (it never opens another page). It is never
offered to someone holding a seat in the tournament.

Players can **whisper**: pick a player in the chat's "To" menu (or tap a whisper you got to answer it)
and no other player's seat sees the message. Spectators see every whisper, highlighted in purple (so would a player who
opened the spectator view). Whispers go to a player id; by name only when exactly one player has that name.
Spectators can whisper to any player too (same "To" menu, while spectator chat is on): only that player's seat and the
other spectators see it. Everyone can also whisper from a player's details card: click their name in the scoreboard.
Any player's name in a chat message (with or without `@`) is drawn in that player's colour; your own
name is highlighted. `@all` (or `@everyone`) pings the whole table and is highlighted for every player; "🔔 Ping all"
in the "To" menu adds it for you.
Dice rolls, troop placements ("+N" bursts that stay up longer for spectators), cards being earned, traded in
(fanning out into "+N armies") or taken from an eliminated player all animate on the board. The sidebar lists players in turn order with their territories, armies, cards and income
(`+N/turn`, the reinforcements they get next turn before cards; hover it for the breakdown).
Picking a map (when creating a game, and in the lobby) shows a preview of the board: every territory in its region's
colour, sea links, the region bonuses (hover one to pick it out) and the starting armies for the player count.
On desktop, a **player card** floats over the board for whoever's turn it is (the winner once the game ends): their phase and armies left to place, this game's lands, armies, cards, income, capitals, card sets traded in and players knocked out, the continents they hold, and their leaderboard standing (rank, points, wins and losses, win rate, games, average placement, career kills; the same numbers as their profile). Drag it by its header (or focus the header and use the arrow keys), resize it from the bottom-right corner, fold it down to the name with ▴; double-click the header to put it back in the top-right corner. Where it sits, its size and whether it is folded are remembered in this browser. Phones skip it: the Players panel shows the same game numbers.

On a **phone** the board fills the screen and the sidebar becomes a tab bar (Board, Players, Log, Chat); a tab opens its panel beside the board rather than over it, so the map stays visible and tappable. Held upright, the tab bar sits along the bottom and a panel opens under the map. **Turned sideways**, the top bar shrinks to one line, the tab bar becomes a rail down the right edge, a panel opens as a column between the map and the rail, the action bar is a short strip that scrolls instead of growing, and the dice and card pop-ups shrink. A phone counts as sideways when the screen is wider than it is tall and at most 540px tall; touch screens of that height get the phone layout even when they are wider than 900px.

On desktop, drag the divider under the scoreboard to give the log/chat more or less room (double-click resets). Hovering any territory highlights all the attackable territories from that spot (pulsing red along land borders and active sea links) for both players and spectators, making attack routes and board connectivity clear at a glance. The log shows each attack as one entry: who took (or failed to take) which territory, each side's armies at the start and end with the losses, the number of rolls and the armies moved in; hover it for the individual dice rolls. Runs of fogged events collapse into one line with a count. When you pick an attack, a **commit slider** sets how many armies to throw at it (the rest stay home; the blitz stops there) and shows the exact chance to take the territory with random dice and with balanced blitz, the average losses on each side, and one-click buttons for the commitment a 50%, 75%, 90% or 99% chance needs. Agents get the same as `stopAt` and a win chance next to each attack in their legal moves.
Press **Bonuses** (on the map, in the spectator bar, or **B**) to see every region painted in its own colour with
its bonus, no armies; neighbouring regions never share a colour, on the board or in this view.

**Hex Earth** (`hexworld`) is shown as a **globe** you can spin: drag to turn it, wheel or pinch (or **+** / **−**) to
zoom, **⟲** to go back to the start view. Its hexes are raised by army count, so big stacks stand out as plateaus, in
the owner's colour; army badges float over each territory (hover one for its name), sea links are arcs over the
oceans and the attack in progress is a red arc. The globe **follows the action** (it turns to each attack, capture and
troop move, and spins slowly when nothing happens) until you grab it, then waits about 10 seconds before following
again; **◎** turns following off. It never spins while you have a move to make, and with reduced motion it jumps
instead of turning and never spins. **Flat** switches to the flat map of the same board (and **Globe** back; the
choice is remembered in this browser); browsers without WebGL always get the flat map. The globe code (three.js)
loads only when a globe is shown (`packages/client/src/components/GlobeMap.tsx`; the board data is in
`packages/client/src/generated/hexworld.globe.json`, see [map-making.md](map-making.md#8-hex-globe-maps)).
Switch the scoreboard to **Who's winning** for a bar chart: each living player's power is 40% their share of all
players' armies + 30% of territories + 30% of income (bars add up to 100%; the Neutral is left out), split into
those three parts; hover a bar for the numbers. Each row also shows the player's card count (yellow at 3, a set is
possible; orange at 4+). Card counts are public, so under fog of war a seated player still gets the card-count list.
In a progressive-cards game the top bar shows what the **next set** is worth (hover for the next three values).

## Next tournament

When the server runs [scheduled tournaments](tournaments.md#scheduled-tournaments), the home page shows a **Next
tournament** card under the name box:
- the next one's name;
- a countdown to its start, or to sign-up while sign-up is still closed;
- how many have signed up, and how many it needs to run;
- **Join** and **Watch**, both opening its page, where you join with your name;
- once it is under way, **Playing now** with a Watch button;
- a line when the last one was called off ("not enough entrants").

It refreshes every 15 seconds, and it's hidden when the server has no schedule.

## Your player key

`?player=1` opens **Your player key**: register a player name (2-24 characters, first come first served, not an AI
character's or a Zerg's) and get your **player key**, shown once with a Copy button. This browser keeps it and sends it
(the `X-Player-Key` header) whenever you create or join a game, join a tournament or use quick play, so you play under
your registered name and the leaderboard counts all those games as one player; nobody without your key can use that
name. With a key on the browser the page shows who you play as, **Get a new key** (the old one stops working at once)
and **Forget the key on this browser**. It also says how agents use a key: the header, `RISK_PLAYER_KEY` for the
stdio MCP server, or `use_player_key` on claude.ai ([mcp.md](mcp.md#player-keys)).

## The House

Tournaments come first on the home page: right under the masthead (the name box) sit the **Next tournament** card,
**The House** and the **Tournaments** list, above the open games, the leaderboard and the match history.

The home page shows **The House**: the server's own bots over every finished tournament, "The Swarm" (Zergs) against
"The Machines" (fill bots). Each side has its eliminations, tables, wins, rounds survived, finals, conquests and
titles (the numbers count up), its best finish, a body-count bar between the two, and a rotating hall of fame (most
kills, deepest run, biggest army, most conquests, longest survival, most armies lost). It's just for fun: the bots are
never ranked. It loads after the rest of the page, refreshes every minute, and keeps still for viewers who prefer
reduced motion. It's hidden until a house bot has played a tournament.

## Watching a nested tournament

A nested ("Inception") tournament's page (`?tournament=CODE`) shows the round clock ("Round 1 · 9 of 17 tables needed ·
14:20 left": a round ends when enough tables finish or the time runs out, and the tables still playing are then
decided on standing) and three tabs:
- **Map:** the final's board with every table's board drawn inside its territory, boards inside boards. Click a board
  to zoom in, Esc, **Zoom out** or the breadcrumb to zoom out, and **Watch table** to open a table as a spectator.
  **Globe** / **Flat** switches the Map tab between this flat view and a spinning **globe of the round in play**: every
  live table's board is a patch of the sphere in its holders' colours, updated from the live feed. Click a patch to
  focus that table (the camera turns to it, **Watch table** opens it). When a round ends, each table's patch shrinks into
  its portal (its winner's starting territory, shown in the winner's colour) on the next round's board while those boards
  fade in, and the camera turns to the focused table (or to the final); with reduced motion the new round just appears. When the
  round in play is a final on Hex Earth (`finalMap: 'hexworld'`), the globe is Hex Earth itself with its portal
  territories raised in gold (click one to zoom into the flat board inside). The choice is remembered like the game
  view's, and browsers without WebGL keep the flat view. Dev builds preview it at `/?dev=inception&players=100`
  (32 tables; **Next round** plays the demo forward) and `/?dev=inception&players=40&final=hexworld`.
- **Bracket:** every round from the final down; a table decided on standing lists its order and the tie-break dice.
- **Live tables:** the tables being played, the most exciting first.

**Follow the action** (Map tab) is an opt-in switch, off by default. While it is on, the view moves by itself to the
most exciting table, with a caption saying why. Any zoom by hand turns it off. It needs the server's live tournament
feed, and it is never offered to someone holding a seat in the tournament. The page also links to the tournament
leaderboard.

## Rules implemented

Classic Hasbro world-domination rules on the classic board: 42 territories / 6 continents, 2–6 players (2-player games get the
40-army Neutral), random territory deal, escalating card sets (4, 6, 8, 10, 12, 15, +5…), automatic trade at 5+
cards, +2 bonus for a traded card showing a territory you own, 3v2 dice with ties to the defender, minimum
move-in equal to dice rolled, card capture on elimination (automatic trade at 5+, right away; a house rule, classic Hasbro forces it only at 6+), one card per turn for a
conquest, one fortify per turn. The complete text is served at `GET /api/rules` and by the MCP `rules` tool.

Host-selectable options:

| option        | values                        | default     |
| ------------- | ----------------------------- | ----------- |
| `map`         | `classic` \| `world` \| `world_large` \| `europe` \| `greater_europe` \| `europe_classic` \| `usa` \| `asia` \| `fantasy` \| `skirmish` \| `bohemia` \| `nine_realms` \| `hexworld`, or a generated board's id such as `gen1-s42-p4-t20` (API and MCP only; see [maps.md](maps.md#generated-boards)) | `classic` |
| `maxPlayers`  | 2–4 (skirmish) / 2–6 (classic, europe_classic, bohemia) / 2–8 (europe, asia, nine_realms) / 2–10 (world, world_large, greater_europe, usa, fantasy, hexworld) | 6 |
| `setupBatch`  | armies placed per setup turn  | 1 (classic) |
| `fortifyMode` | `connected` \| `adjacent`     | `connected` |
| `randomDeal`  | `true` (deal) \| `false` (claim one by one) | `true` |
| `autoSetup`   | `true` skips the placement phase: starting armies are scattered randomly, turn 1 starts at once | `false` |
| `cardValues`  | `progressive` (4, 6, 8, 10, 12, 15, +5…) \| `fixed` (3 infantry 4, 3 cavalry 6, 3 artillery 8, one of each 10; a wild completes the best set) \| `exponential` (per player: 5, 7, 10…; ceil(previous × 1.3) through trade 25, then +1000) | `progressive` |
| `fogOfWar`    | players see only their territories and adjacent ones; events elsewhere are reported as fogged; opponents' territory and army counts, income breakdown, armies left to place, continents and the details of their card trades are hidden unless every territory that opponent holds is visible (card counts, the number of sets traded so far and each player's total reinforcement income stay public); spectators, eliminated players and everyone once the game is over see everything, and spectators can preview any player's fog | `false` |
| `spectatorChat` | watchers can post in the game chat (marked as spectators, 5 messages / 10 s); every player sees them, even under fog of war | `true` |
| `neutrals`    | games of 3+ players: this many random territories start held by a Neutral army that never attacks (0 = off, max a third of the map); 2-player games always have the classic Neutral | `0` |
| `neutralArmies` | armies on each neutral territory when `neutrals` is on (1–10) | `2` |
| `blizzards`   | number of random territories frozen for the whole game (0 = off, max 8, or a sixth of the map on bigger boards: 12 world, 14 fantasy, 14 europe advanced, 17 grand world, 19 greater europe); nobody can own, attack or cross them; the rest of the map stays connected and continents only need their open territories | `0` |
| `firstRoundBonus` | round 1 only: the Nth player in turn order receives at least N armies (4th at least 4, ... 10th at least 10) to offset going later; games saved before this option keep it off | `true` |
| `balancedBlitz` | a blitz is rolled 5 times with real dice and the middle outcome happens, so blitzes land close to the odds (strong attacks rarely collapse, long shots rarely come off); single rolls stay fully random, and the dice panel marks balanced rolls | `false` |
| `capitals`    | Capital Conquest: each player's most garrisoned territory after setup becomes a capital (★) and gets 3 extra armies; +2 armies per capital held each turn; capitals defend with up to 3 dice; losing your capital does not knock you out; holding every capital at once wins the game | `false` |
| `chooseCapitals` | Capital Conquest only: after setup each player, in turn order, picks one of their own territories as their capital (under fog of war only players who can see it learn the pick); off = most garrisoned territory becomes the capital | `false` |
| `turnTimer` | `off` \| `move` (a clock for each decision: every placement, attack, occupy or fortify) \| `turn` (one clock for the whole turn). Human and agent seats only, never bots. On a timeout the player is **skipped**: pending armies are placed for them over their border territories (weakest first), a pending conquest is occupied with the minimum, and the turn ends with no more attacks and no fortify. Per move, running out while placing only places the armies and the turn goes on with a fresh clock; running out while attacking or fortifying ends the turn. Setup placements and capital picks are made the same way. The game shows a ⏱ countdown next to whose turn it is and logs "⏱ X skipped (timeout)". The clock lives in the server: after a restart it starts again in full | `off` |
| `turnTimerSeconds` | seconds on the turn timer (5–600), ignored when it is off | `15` |

