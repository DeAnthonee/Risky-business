export const RULES_TEXT = `
RISK — World Domination (classic rules)

OBJECTIVE
Conquer the world by eliminating every other player. The last player holding territories wins.

THE MAPS
Classic: 42 territories in 6 continents (2-6 players). Continent bonuses: North America 5, South America 2,
Europe 5, Africa 3, Asia 7, Australia 2.
World: 74 territories in 14 regions (2-10 players), bonuses 2-7 per region.
Grand World (world_large): 104 territories in 20 regions (2-10 players), bonuses 2-7 per region.
Europe: 44 territories in 8 regions (2-8 players), bonuses 2-6. USA: 45 territories (US states, small
north-eastern ones merged) in 8 regions (2-10 players), bonuses 3-6; Alaska and Hawaii reach the mainland by sea.
Europe Advanced (europe_classic): 84 territories in 14 regions (2-6 players): Iceland +2, British Empire +3,
Scandinavia +3, Western Europe +4, Central Europe +5, Dinaric Alps +4, Southern Europe +4, South Western Europe +4,
South Eastern Europe +4, Eastern Europe +8, Russian Empire +7, Orient +6, West Africa +6, North Africa +3.
Greater Europe (greater_europe): 116 smaller territories in 15 regions (2-10 players), bonuses 2-7; Iceland to the
Urals, North Africa to the Caucasus, with sea crossings over the Channel, North Sea, Baltic and Mediterranean.
Asia: 49 territories in 7 regions (2-8 players), bonuses 4-6.
Realms of Halvaren ("fantasy"): an original fantasy world, 87 territories in 16 regions (2-10 players), bonuses
2-7 per region. The Grimward Wastes (+7) span the north and border almost everyone; the Inner Sea is crossed via
Mistveil Isle; island chains (Shardsea, Tanuvai, Saltreach, Hrimvald) are linked by sea lanes. It does not wrap.
Four Crowns ("skirmish"): a small, fast original board, 24 territories in 6 regions (2-4 players). Four corner
kingdoms (+2 each) ring the Heartland (+4); each kingdom has one gate into the Heartland and two harbours to the
Waystones (+3), four lone isles that carry the sea lanes from one kingdom to the next. It does not wrap.
Use the "map" tool for the exact territories, regions and adjacency of the map a game is using. On the classic,
World and Grand World maps Alaska and Kamchatka are adjacent (the map wraps); on every map some adjacencies
cross water.

PLAYERS & STARTING ARMIES
Classic: 2 players: 40 each (plus a 40-army Neutral that never attacks). 3: 35. 4: 30. 5: 25. 6: 20.
Every other map: the classic numbers scaled by map size (territories / 42); above 6 players everyone gets an equal
share of the 6-player total (120 armies per 42 territories). Never fewer than 1.5 armies per territory you are dealt.
  World: 2 players 70, 3: 62, 4: 53, 5: 44, 6: 35, 7: 30, 8: 26, 9: 23, 10: 21.
  Grand World: 2: 99, 3: 87, 4: 74, 5: 62, 6: 50, 7: 42, 8: 37, 9: 33, 10: 30.
  Europe Advanced: 2: 80, 3: 70, 4: 60, 5: 50, 6: 40.
  Greater Europe: 2: 110, 3: 97, 4: 83, 5: 69, 6: 55, 7: 47, 8: 41, 9: 37, 10: 33.
  Europe: 2: 42, 3: 37, 4: 31, 5: 26, 6: 21, 7: 18, 8: 16. USA: 2: 43, 3: 38, 4: 32, 5: 27, 6: 21, 7: 18, 8: 16, 9: 14, 10: 13.
  Asia: 2: 47, 3: 41, 4: 35, 5: 29, 6: 23, 7: 20, 8: 18.
  Realms of Halvaren: 2: 83, 3: 73, 4: 62, 5: 52, 6: 41, 7: 36, 8: 31, 9: 28, 10: 25.
  Four Crowns: 2: 23, 3: 20, 4: 17.

SETUP
Territories are dealt randomly (default) and get 1 army each. Then, in turn order, each player places armies on their
own territories until everyone has placed all starting armies. By default you place 1 army per setup turn (option
"setupBatch" lets the host allow more per turn). With the "claim" option instead of random dealing, players take turns
claiming one unowned territory at a time first. With the "autoSetup" option there is no placement phase at all: the
starting armies are scattered randomly over each player's territories and turn 1 begins immediately.

A TURN has three phases:

1. REINFORCE
   You receive armies = max(3, floor(territories you own / 3)) + continent bonuses for every continent you fully control.
   Cards: if you hold 5 or more cards at the start of your turn the game trades a set in for you automatically
   (the most armies, preferring a card for a territory you own and keeping wilds), until you hold 4 or fewer.
   You may trade any valid set during this phase. Place all armies on your own territories to move to the attack phase.

   Round 1 only ("firstRoundBonus", on by default): the Nth player in turn order receives at least N armies
   (1st-3rd their normal 3+, 4th at least 4, 5th at least 5, ... 10th at least 10).

2. ATTACK (optional, as many times as you like)
   Attack an adjacent enemy territory from a territory with at least 2 armies.
   Attacker rolls up to 3 dice (must leave 1 army behind: dice <= armies - 1). Defender rolls up to 2 (dice <= armies),
   or up to 3 when defending a capital in Capital Conquest.
   Highest dice are compared, then second highest. The loser of each comparison loses one army. Ties go to the defender.
   When the defender's last army falls you conquer the territory and must move in at least as many armies as dice you
   rolled (and at most all but one). You may send more. If that player has no territories left they are eliminated and
   you take their cards; if that leaves you with 5+ cards the game trades sets in for you right away, until you hold
   4 or fewer (place those armies, then keep attacking).
   Conquering at least one territory this turn earns you one card at the end of your turn (max one per turn).
   "blitz" keeps rolling until the territory falls or you cannot continue.
   Balanced blitz ("balancedBlitz" setting, off by default): a blitz is rolled 5 times with real dice and the middle
   outcome happens, so blitzes land close to the odds. Single rolls are never balanced.

3. FORTIFY (optional, once)
   Move any number of armies from one of your territories to another, leaving at least 1 behind. Default option
   "connected": the destination must be reachable through territories you own. Option "adjacent": classic, only
   neighbouring territories. Fortifying ends your turn. You may also simply end your turn.

CARDS
One card per territory (Infantry, Cavalry or Artillery) + 2 wilds (territories + 2: 44 on the classic map, 76 on World, 106 on Grand World, 89 on Realms of Halvaren). You earn
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

OPTION: BLIZZARDS
"blizzards" (a number, 0 = off, up to 8, or a sixth of the map on bigger boards): that many random territories are frozen at game start and
stay impassable all game. Nobody owns them; they cannot be attacked, entered, claimed or fortified through. They are
chosen so the open territories stay connected and every continent keeps at least two open territories. To control a
continent you need all of its open (non-blizzard) territories. Blizzards are visible to everyone, even under fog.

OPTIONS: FOG OF WAR AND CAPITALS
"fogOfWar": you only see territories you own and those adjacent to them; everything else shows as hidden
(owner and armies unknown) and events there are reported as "fogged". Spectators always see the whole board.
"capitals" (Capital Conquest): after setup each player's most garrisoned territory becomes their capital (shown with a
star) and 3 extra armies are placed on it. At the start of your turn you get +2 armies for every capital you hold. A capital defends with up to 3 dice
instead of 2 (all three pairs are compared). A captured capital becomes
yours like any territory (with its +2 and its 3-dice defence); losing your capital does not knock you out, you
keep playing with what you hold. The game ends as soon as one player holds every capital, including the capitals
of eliminated players. Eliminating everyone else still wins too.
With "chooseCapitals" on, there is a short capitals phase after setup (whatever the deal and placement settings):
each player in turn order picks one of their own territories with {"type":"choose_capital","territory":"<id>"}.
The chosen capital gets 3 extra armies on the spot (1 army becomes 4). Picks are public, except under fog of war,
where you only learn of capitals you can see. Then turn 1 begins.
`.trim();
