# Playing and watching: the web client, rules and game settings

What players and spectators see in the web client, the rules the engine implements, and every host-selectable
setting. The settings table is a summary: the source of truth is `OPTION_SPECS` in
`packages/engine/src/options.ts` (also served at `GET /api/options` and by the MCP `game_options` tool).
Maps: [maps.md](maps.md). Tournaments: [tournaments.md](tournaments.md).

## Starting a game

Open http://localhost:8080, enter a name, press **Create room** (it opens the setup in place: maps as silhouette tiles
with a live preview, settings grouped into Players and setup, Cards and combat, Board twists; the lobby uses the same
groups), add a bot or share the 6-letter join code (or the invite link `?game=CODE`), and press **Start**. The home
page lists open games as tickets (joinable rooms first, then live and finished ones) next to the leaderboard (once a season has been archived, a season picker above it shows past seasons; the current one is the default; the **Training** toggle beside it switches to the training leaderboard of model-vs-model yardstick games, which never count on the public one) and the **match history**: the most recent finished games, newest first, each with its winner (click the name for their profile), how they won, the room, map, turns, how long it took and every seat's final place. While a finished room is still on the server, **View final board** opens it to watch. Wide screens show the three boards side by side; narrower ones stack the leaderboard and match history beside the open games. Anyone can **watch** a game without playing:
press "Watch" in the game list or open `?game=CODE&spectate=1`. Spectators see the public board, the
log and chat, a live "watching" count, and which players are online. In fog-of-war games they can
see the board as any player sees it (click a player, or "Follow turn") and press **F** ("Hide fog" /
"Show fog") to flip to the whole map and back. Spectators get updates replayed one at a time, so each
conquest in a burst of attacks stays on screen for a moment (the replay speeds up if it falls behind).
Press **Fast-forward** in the spectator bar to drop the replay and all animations and see every move the moment it
happens (handy for long all-AI games); press it again for normal speed. It is spectator-only and resets to normal
speed when you take a seat or reload.

The board sits on animated water: a lit sea that darkens toward the edges, small cream wave marks that drift
and fade in and out, and a soft surf glow that swells along every coast. It is ambient decoration (Fast-forward
does not touch it) and holds still when the system asks for reduced motion.

The territories of the player whose turn it is sit slightly raised: a little larger, with a light rim and a drop
shadow, rocking gently so you can see at a glance what they hold. Under fog only the land you can see is raised;
with reduced motion they stay raised but still.

**Auto-spectate** is a hands-off live stream: press **Auto-Spectate Live Stream** above the game list (shown while a
game is being played) or open `/?spectate=1` with no game. It tunes into a game in progress and, when that game ends
or its room closes, shows a countdown to the next live game, with **Stay here** to keep watching where you are (which
ends auto-spectate). It is opt-in: a game you opened yourself (from the list, a link or a tournament bracket) never
moves you on, players are never moved, and tournament tables are never picked. While waiting it polls the game list
every 2 s, backing off to 10 s. The URL stays `/?spectate=1`, so a reload picks up whatever is live.

**Generation training matches** are the exception to "opt-in" (#95): the runner names its rooms
`Generation <tag> Match <n>` (e.g. `Generation 5 Match 3`), and when one ends or closes, every spectator gets a 4 s
countdown to the next one, a running match first, otherwise its lobby (watch it fill and start), with **Stay here** to
remain. Only that exact name counts (a room a person names that way counts too), tournament tables are never picked,
and players are never moved.

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
Switch the scoreboard to **Who's winning** for a bar chart: each living player's power is 40% their share of all
players' armies + 30% of territories + 30% of income (bars add up to 100%; the Neutral is left out), split into
those three parts; hover a bar for the numbers. Each row also shows the player's card count (yellow at 3, a set is
possible; orange at 4+). Card counts are public, so under fog of war a seated player still gets the card-count list.
In a progressive-cards game the top bar shows what the **next set** is worth (hover for the next three values).

## Rules implemented

Classic Hasbro world-domination rules on the classic board: 42 territories / 6 continents, 2–6 players (2-player games get the
40-army Neutral), random territory deal, escalating card sets (4, 6, 8, 10, 12, 15, +5…), automatic trade at 5+
cards, +2 bonus for a traded card showing a territory you own, 3v2 dice with ties to the defender, minimum
move-in equal to dice rolled, card capture on elimination (automatic trade at 5+, right away; a house rule, classic Hasbro forces it only at 6+), one card per turn for a
conquest, one fortify per turn. The complete text is served at `GET /api/rules` and by the MCP `rules` tool.

Host-selectable options:

| option        | values                        | default     |
| ------------- | ----------------------------- | ----------- |
| `map`         | `classic` \| `world` \| `world_large` \| `europe` \| `greater_europe` \| `europe_classic` \| `usa` \| `asia` \| `fantasy` \| `skirmish` \| `bohemia` \| `nine_realms`, or a generated board's id such as `gen1-s42-p4-t20` (API and MCP only; see [maps.md](maps.md#generated-boards)) | `classic` |
| `maxPlayers`  | 2–4 (skirmish) / 2–6 (classic, europe_classic, bohemia) / 2–8 (europe, asia, nine_realms) / 2–10 (world, world_large, greater_europe, usa, fantasy) | 6 |
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

