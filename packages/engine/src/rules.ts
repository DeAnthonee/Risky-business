export const RULES_TEXT = `
RISK — World Domination (classic rules)

OBJECTIVE
Conquer the world by eliminating every other player. The last player holding territories wins.

THE MAPS
Classic: 42 territories in 6 continents (2-6 players). Continent bonuses: North America 5, South America 2,
Europe 5, Africa 3, Asia 7, Australia 2.
World: 74 territories in 14 regions (2-10 players), bonuses 2-7 per region. Use the "map" tool for the exact
territories, regions and adjacency of the map a game is using. On both maps Alaska and Kamchatka are adjacent
(the map wraps) and some adjacencies cross water.

PLAYERS & STARTING ARMIES
Classic: 2 players: 40 each (plus a 40-army Neutral that never attacks). 3: 35. 4: 30. 5: 25. 6: 20.
World: about three armies per territory shared out, between 20 and 60 per player (2 players: 60, 5: 44, 10: 22).

SETUP
Territories are dealt randomly (default) and get 1 army each. Then, in turn order, each player places armies on their
own territories until everyone has placed all starting armies. By default you place 1 army per setup turn (option
"setupBatch" lets the host allow more per turn). With the "claim" option instead of random dealing, players take turns
claiming one unowned territory at a time first. With the "autoSetup" option there is no placement phase at all: the
starting armies are scattered randomly over each player's territories and turn 1 begins immediately.

A TURN has three phases:

1. REINFORCE
   You receive armies = max(3, floor(territories you own / 3)) + continent bonuses for every continent you fully control.
   Cards: if you hold 5 or more cards at the start of your turn you MUST trade a set before placing.
   You may trade any valid set during this phase. Place all armies on your own territories to move to the attack phase.

2. ATTACK (optional, as many times as you like)
   Attack an adjacent enemy territory from a territory with at least 2 armies.
   Attacker rolls up to 3 dice (must leave 1 army behind: dice <= armies - 1). Defender rolls up to 2 (dice <= armies).
   Highest dice are compared, then second highest. The loser of each comparison loses one army. Ties go to the defender.
   When the defender's last army falls you conquer the territory and must move in at least as many armies as dice you
   rolled (and at most all but one). You may send more. If that player has no territories left they are eliminated and
   you take their cards; if that leaves you with 6+ cards you must trade immediately (armies go on the map at once).
   Conquering at least one territory this turn earns you one card at the end of your turn (max one per turn).
   "blitz" keeps rolling until the territory falls or you cannot continue.

3. FORTIFY (optional, once)
   Move any number of armies from one of your territories to another, leaving at least 1 behind. Default option
   "connected": the destination must be reachable through territories you own. Option "adjacent": classic, only
   neighbouring territories. Fortifying ends your turn. You may also simply end your turn.

CARDS
One card per territory (Infantry, Cavalry or Artillery) + 2 wilds (44 on the classic map, 76 on World). You earn
one card at the end of any turn in which you conquered at least one territory, and you take all of a player's
cards when you eliminate them. A set is three of a kind, one of each, or any two plus a wild.
Option "cardValues": "progressive" (default) escalates for the whole game: 4, 6, 8, 10, 12, 15, then +5 each
(20, 25, ...). "fixed": three Infantry = 4, three Cavalry = 6, three Artillery = 8, one of each = 10; a wild
completes the most valuable set it can.
If a traded card shows a territory you own, 2 extra armies are placed there automatically (once per trade).

OPTION: NEUTRAL TERRITORIES
"neutrals" (a number, 0 = off, at most a third of the map) applies to games of 3 or more players: that many random
territories start held by a grey Neutral army with "neutralArmies" armies each (default 2). The rest are dealt to the
players as usual and players keep their normal starting armies. Neutral never attacks, reinforces or moves; you
conquer its territories like any other (it has no cards). Two-player games always use the classic Neutral above.

OPTIONS: FOG OF WAR AND CAPITALS
"fogOfWar": you only see territories you own and those adjacent to them; everything else shows as hidden
(owner and armies unknown) and events there are reported as "fogged". Spectators always see the whole board.
"capitals" (Capital Conquest): after setup each player's most garrisoned territory becomes their capital (shown with a
star). At the start of your turn you get +2 armies for every capital you hold. Capturing a player's own capital takes
over that player: all their territories, troops and cards become yours and they are out. Hold every capital to win.
`.trim();
