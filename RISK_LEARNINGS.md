# Risk Rules & Strategic Learnings

Fundamental rules, mechanics, and tournament scoring for the Risk engine, followed by empirical strategic findings discovered through AI self-play.

---

## Objective & Ranked Tournament Scoring

* **Primary Goal**: Maximize tournament Elo rating and climb the ranked leaderboard over multiple games.
* **1st Priority — Winning (1st Place)**: Winning the match yields the highest Elo gain (+3 placement points in 6-player matches). Playing to win 1st place is always the single biggest deal.
* **2nd Priority — Securing Kills (Eliminations)**: Eliminating an opponent awards an immediate permanent **+1 kill point** on the leaderboard, permanently steals their entire card hand (often triggering mid-turn card trades for massive reinforcement armies), and leapfrogs placement tiers.
* **Crucial Elo Constraint — Surviving / Not Losing**: Placement points are NOT permanent across games; finishing in bottom placements incurs heavy negative penalties (-1 for 4th, -2 for 5th, -3 for 6th place). If a player gains points in one game but finishes in last place in another, their cumulative rating suffers a net negative drop! Therefore, **not losing and avoiding early elimination is a big deal**. Placement preservation matters: do not take reckless, suicidal gambles or leave home territories undefended early. Balance hunting kills with disciplined survival and placement defense.

---

## Game Rules & Mechanical Foundations

### 1. Turn Structure & Phases
1. **Draft (Reinforcement)**:
   * **Base Income**: Calculated as $\max(3, \lfloor \text{territories} / 3 \rfloor)$.
   * **Continent Bonuses**: Additional fixed armies awarded for controlling all territories within a named region/continent.
   * **Capitals Bonus**: In Capitals Conquest, holding capitals grants +2 reinforcement armies per capital per turn.
   * **Card Trades**: Redeeming a valid card set provides additional draft armies.
   * All drafted troops must be deployed onto friendly territories before attacking.
2. **Attack Phase**:
   * Attacks may be launched from any friendly territory with 2 or more armies into adjacent enemy territories.
   * **Combat Dice**: Attacker rolls up to 3 dice; defender rolls up to 2 dice (or 3 dice when defending a Capital).
   * **Resolution**: The highest attacking die is compared against the highest defending die; the second-highest attacking die is compared against the second-highest defending die. Defender wins ties.
   * **Territory Conquest**: Upon eliminating the final defending army, the attacker must advance at least the number of attacking dice used (leaving at least 1 army behind on the source territory).
3. **Fortify Phase**:
   * Move any number of armies between friendly territories, leaving at least 1 army behind on the origin territory.
   * Allowed movement paths depend on the game's Fortify setting (Connected path, Adjacent-only, or Single move).

### 2. Cards & Escalating Spoils
* **Earning Cards**: Capturing at least one enemy territory during your turn guarantees 1 card at the end of the turn.
* **Valid Card Sets**: 3 Infantry, 3 Cavalry, 3 Artillery, or 1 of each (mixed set). Wildcards match any unit type.
* **Hand Limit**: A player holding 5 or more cards must trade a set on their draft phase. Mid-turn card inheritance from an eliminated player triggers immediate reinforcement deployment.
* **Fixed Cards**:
  * Set values remain constant throughout the game: 4 for 3 Infantry, 6 for 3 Cavalry, 8 for 3 Artillery, 10 for Mixed or Wildcard set.
  * *Strategic Reality*: Because trade values never escalate, continental bonuses (+2 to +7 armies/turn) and territory income are the primary reinforcement drivers. There are no sudden 50+ army card bailouts. Players win through permanent border fortification, continental attrition, and preventing opponents from securing regional monopolies.
* **Progressive Cards**:
  * Set values escalate table-wide as more sets are traded: 4, 6, 8, 10, 12, 15, then +5 per trade (20, 25, 30, 35, 40, etc.).
  * *Strategic Reality*: In late game, single card trades provide massive 30-60+ army drops that dwarf all continental bonuses combined. Earning a card every single turn and eliminating players holding 3+ cards to steal their hands and chain mid-turn trades is the dominant path to victory.
* **Exponential Cards**:
  * Each player possesses an independent, personal trade counter. Set values start at 5 armies and scale exponentially by $\lceil \text{previous} \times 1.3 \rceil$ (5, 7, 10, 13, 17, 23, 30, 39, 51, 67...).
  * *Strategic Reality*: Because progression is personal rather than table-wide, monitoring your personal next trade value relative to opponents' trade counts dictates timing an unstoppable personal surge turn.

### 3. Game Modes & Win Conditions
* **World Domination**: Eliminate all rival players and control 100% of territories on the board.
* **Capitals Conquest**:
  * Each player starts with a designated Capital territory.
  * Capitals defend with 3 dice instead of 2, making them significantly harder to capture.
  * Holding capitals grants +2 reinforcement armies per capital per turn.
  * **Doorway Choke Point Capital Placement**: Placing the initial capital on an outward-facing doorway choke point protects continent bonuses with 3-dice defense while maintaining offensive attack routes in multiple directions. Never bury a capital in an interior pocket where armies are trapped and 3-dice defense is wasted.
  * **The Cap Run Mechanics**: Winning via Capitals is strictly a **late-game calculation** when enemy capitals are under-defended and your primary strike stack can conquer all remaining capitals in a single turn for the instant win. You NEVER play for a cap run on turn 1 or early game; in early/mid game, hold your doorway capital defensively (+2 armies/turn) while pursuing bonuses and kills.
  * Win condition: Capture and hold all Capitals on the map while defending your own Capital.

### 4. Fog of War & Information Control
* **Non-Fog of War (Visible)**:
  * All player army garrisons, territory boundaries, and turn incomes are publicly visible to all participants.
  * Full visibility enables exact combat calculations and public table alliances to counter snowballing leaders.
* **Fog of War (Hidden)**:
  * Only territories directly adjacent to friendly borders are visible.
  * Opponents' total territory counts and total army counts are strictly hidden (`null`).
  * Turn reinforcement income (+N/turn) and card count (number of cards held) are publicly announced at turn start and provide the only reliable estimate of hidden rival strength.
  * **Deducing Hidden Army Strength**:
    * *Starting Troops + Cumulative Income*: Tracking initial troop allocations (e.g. 20 for 6p, 25 for 5p, 30 for 4p, 35 for 3p) and adding public turn incomes (+N/turn) provides an exact upper bound on total historical troops.
    * *Attack & Conquest Counts*: Every attack and conquest made by any player (even behind fog) is logged. Repeated attacks cost the attacker ~1.2 armies on average per roll, and each conquest leaves 1 army behind. An opponent with +3/turn income holds at most 11 territories and 0 bonuses.
    * *Capital Capture Alerts*: Capturing a capital grants +2 armies/turn. When an opponent's income jumps or capital capture events occur, track their capital holdings behind fog.
  * Scouting/probing attacks reveal neighboring garrison counts.
  * Staging reserve stacks 1 territory behind the visible frontline prevents rivals from discovering your primary strike force.

### 5. Map Geography, Bonuses & Blizzards
* **Continent / Regional Bonuses**: Holding every territory in an unbroken continent provides recurring turn income. Entry chokepoints determine defensive cost.
* **Blizzards**: Random impassable territories and blocked connections that alter standard map topography and create unique chokepoints.

### 6. Table Communication & Diplomacy
* Players may communicate via public table-wide chat or private whispers.
* **Deals**: Truces, Joint Attacks, Non-Aggression pacts, and Coalition calls against dominant leaders.
* **Diplomacy with Intention**: Alliances must directly serve your current Advantage Plan. Never propose aimless alliances. Early game (Rounds 1-4), securing a continent bonus is vital — without a bonus, base income of +3/turn means falling behind.
  * *Obstacle Awareness*: If an opponent holds territories inside the continent bonus you are claiming, NEVER propose a truce or border deal with them; they are an obstacle to conquer!
  * *The Good Neighbor Policy*: Adjacent continent holders (e.g. South America and North America) agreeing to mutual non-aggression across their shared border allows both players to consolidate a single outward front, cementing top-2 placement.
  * *Single-Target Focus*: Never "bad neighbor" multiple rivals at once by attacking in all directions. Pick ONE target to pressure, maintain peaceful Good Neighbor borders with the rest, and focus combat force on that single front.
  * *The Endgame Backstab (3-Player Dynamics)*: Alliances are temporary ladders to reach the endgame. When 3 players remain, scheming and executing the backstab against the leader or neighbor is required to take 1st place (+3 Elo).

### 7. Attack Patterns, Tactical Routing & Troop Staging
* **Concentrated Spearheads (`placeOn`)**: Deploying draft reinforcements into a single concentrated attack stack (spearhead) on the frontline rather than scattering 1-2 armies across internal territories maximizes break-through odds and minimizes combat casualties.
* **Sequential Attack Routing (`route`)**: Order attacks along a contiguous path from highest-probability / weakest resistance outward. Take at least one guaranteed territory early to secure the turn's card before attempting high-variance expansion.
* **Interior Pocket Prevention**: Never leave large garrisons (4+ armies) stranded in friendly interior pockets that do not border hostile territories or blizzards. Pushing into a dead-end pocket is completely justified and encouraged when executing an elimination or capturing a capital (stolen cards, placement jump, and kill bounty far outweigh having troops in a corner); peacetime reinforcement is what must avoid friendly interior pockets.
* **Asymmetric Bonus Denial & Griefing**: When holding a geographically secure continent with 1 choke point (e.g. South America or Australia) against a rival holding an exposed continent with 3 choke points (e.g. Europe, North America, or Africa), breaking their bonus is high-leverage griefing: you deny huge recurring income while defending only 1 point.
* **The Golden Kill Rule & Post-Kill Net Armies**:
  * When attacker cards + victim cards $\ge 5$, an immediate trade is guaranteed.
  * Calculate $\text{Net Armies After Kill} = \text{Strike Stack} - \text{Expected Losses} - \text{Conquests} + \text{Immediate Trade Armies}$.
  * If a kill leaves you with $<5$ armies and vulnerable to rivals, it is suicidal. If it leaves you with $\ge 10$ armies, it is a game-winning comeback move that refuels your army, leaps placement tiers, and locks in +1 Elo.
* **Fortify Repositioning (`fortifyTo`)**: At the end of the turn, use the fortify phase to pull back mobile rear armies or advance reserve stacks to frontline defensive chokepoints, border gates, or capital garrisons to protect held continent bonuses from enemy counter-punches.

---

## Findings from AI self-play games
<!-- bot-findings:start -->
### Fixed Cards (Continental Attrition & Border Defense)
- **When card trades are fixed, holding unbroken continent bonuses provides the primary reinforcement engine.** Continental bonuses (+2 to +7) make permanent border defense and attrition far more critical than card-hunting. Bot4 held key bonuses with +45/turn and won without card escalation. (4 games, last H7NVFC)
- **Aggressive expansion without securing permanent border garrisons in fixed mode leads to counter-punches.** Bot6 broke Bot1’s Scandinavia and Dinaric Alps bonuses, permanently stunting Bot1's fixed income and contributing to their elimination. (1 game, last YLFZU9)

### Progressive Cards (Escalating Spoils & Chain Eliminations)
- **Time your trades to fund immediate eliminations.** Sitting on complete card sets while opponents trade escalating spoils allows rivals to build overwhelming attack stacks; trade when armies convert directly into a kill or capital. Bot2 timed their card trades effectively to fund their elimination of Bot8, Bot10, Bot1, Bot9, and Bot5. (2 games, last CDCU2S)
- **Elimination chains accelerate endgame conquest.** Inheriting cards from an eliminated player can push the attacker to 5+ cards, triggering a mid-turn trade that finances the next elimination on the same turn. (2 games, last CDCU2S)
- **Failing to engage in card trades can limit strategic advantages.** Delaying card trades too long in progressive lobbies allows opponents to escalate trade values and overwhelm static defenses. Bot4's delayed card trades limited their ability to counter Bot6's expansion. (2 games, last CDCU2S)
- **Eliminations funded the winners.** Lux knocked out Darius (round 4), Shaco (round 6) and Leona (round 38) and survived to 2nd; Ahri swept every capital. The three first players out (Darius, Shaco, Thresh) never made a kill. (1 game, last MVAPM8)
- **Focusing on card acquisition without securing territory is a losing strategy.** Bot6 focused on gathering cards but failed to secure any bonuses or capitals, making him an easy target for elimination. (1 game, last PMNH5H)
- **Securing key bonuses early allows for rapid card trade escalation.** Thresh secured 17 bonuses, enabling a high reinforcement income (+87/turn) that funded multiple card trades and eliminations. (1 game, last 7QS4UG)
- **Elimination chains can be triggered by inheriting cards from fallen opponents.** Tryndamere eliminated Jinx (round 11) and Lux (round 12), inheriting their card sets and using them to fund further expansions and eliminations. (1 game, last 7QS4UG)
- **Failing to secure capitals can limit long-term reinforcement income despite card advantages.** Lux had no capitals, which limited their reinforcement income despite inheriting card sets from Jinx, making them vulnerable to elimination. (1 game, last 7QS4UG)

### Exponential Cards (Personal Sequences & Surge Timing)
- **Monitor personal trade counts before engaging.** In exponential games where set values scale by 1.3x independently per player (5, 7, 10, 13, 17, 23...), timing a high-tier personal set cash-in allows sudden board-clearing strikes that static defenders cannot match. (1 game, last 8VALR5)

### Attack Routing & Troop Staging (Spearheads & Interior Pocket Prevention)
- **Avoiding interior pockets with stranded troops helps prevent resource drain.** Bot3 and Bot9 left large garrisons trapped behind friendly lines without hostile borders, wasting armies that should have been reinforcing frontlines. (3 games, last PTJ76F)
- **Sequential routing preserves offensive momentum.** Ordering attacks along a single chain from weakest resistance outward preserves attacking stacks and ensures guaranteed card capture without splitting forces. (1 game, last VX6C5F)
- **End-of-turn fortify pullbacks secure vulnerable borders.** Striking forward with mobile stacks to take territory and then fortifying back onto chokepoints or capitals prevents aggressive counter-attacks. (1 game, last 8ESC69)
- **Maintaining strong connectivity between territories prevents leaving interior pockets vulnerable.** Bot3's fragmented territory holdings made defense impossible once Bot10 launched a concentrated attack, leading to Bot3's elimination. (1 game, last D5HXP4)

### Fog of War (Concealed Armies & Income Probing)
- **Scouting with card-taking attacks reveals critical enemy garrison counts.** Bot9 used single-territory probes to reveal enemy garrison counts before launching major offensives, allowing them to prepare for the scale of the attack. (2 games, last T9DCQW)
- **Small border garrisons can project false weakness.** Opponents often assume lightly defended fog borders indicate an empty interior; keep mobile strike stacks one step behind the frontline. (1 game, last MVAPM8)
- **Maintaining strong reinforcement income is crucial for long-term survival under fog.** Tryndamere maintained a high reinforcement income (+62/turn) despite losing several key territories, which contributed to their survival and elimination of multiple opponents. (1 game, last 8VALR5)
- **Judging hidden threats by income is a reliable strategy.** Lux used enemy turn income as a reliable estimate of rival strength to target weaker opponents effectively. (1 game, last 8SR5HD)

### Non-Fog of War (Public Board & Coalition Counterplay)
- **Troop commitments must match visible budgets.** In non-fog lobbies where armies and incomes are public, bluffing impossible troop offers fails; proposals exceeding armyCount plus income are rejected. (1 game, last 4J2YAV)
- **Multi-way alliances against runaway leaders require all-chat.** Whispering between two players cannot coordinate a 3-way or 4-way response against a dominant player; public coalition calls coordinate joint pressure. (1 game, last X3T6U8)
- **Failing to form coalitions against a dominant player leads to isolation.** Divided rivals who negotiate separate truces while a leader snowballs get rolled up one by one. (7 games, last H7NVFC)
- **Not engaging in deals can be a strategic advantage if it avoids the risk of betrayal.** Bot4 did not make any deals during the game, allowing them to focus on expansion and defense without the risk of betrayal. (6 games, last H7NVFC)
- **High reinforcement income from key bonuses can offset lack of capital control.** Bot9 secured multiple continental bonuses, out-producing capital holders (+114/turn) and overwhelming them through sheer army count. (3 games, last H7NVFC)
- **Avoiding direct conflict with dominant players until they are significantly weakened can be a strategic advantage.** Bot3 avoided direct conflict with Bot8 for most of the game, only engaging them in the final rounds when it was clear Bot8 was the dominant threat. (2 games, last H7NVFC)
- **Failing to leverage held bonuses can leave players vulnerable to aggressive opponents.** Bot1 held the hrimvald, gloamfen, and mistveil bonuses but failed to use them effectively, contributing to their elimination by Bot6. (2 games, last C6KXT6)

### Capitals Conquest
- **Capitals defend with 3 dice and require overwhelming odds.** Bot7’s concentrated garrisons on key territories withstood attacks from multiple opponents, who had 0 capitals and were major threats. (5 games, last DGS35N)
- **Holding all capitals provides a massive reinforcement income and makes it nearly impossible for opponents to contest key regions.** Tryndamere held all capitals and had a +62/turn reinforcement income, which was critical to their victory. (4 games, last ZYW8N8)
- **Failing to secure capitals leaves you vulnerable to sudden elimination.** Holding raw territories without a secure capital base leaves players exposed once larger rivals mobilize. Bot2 had 0 capitals and was eliminated by Bot9. (4 games, last H7NVFC)
- **Securing key bonuses early provides long-term reinforcement benefits.** Lux secured multiple continent bonuses early in the game, contributing to their high reinforcement income and strategic expansion. (3 games, last H7NVFC)
- **High reinforcement income from key bonuses can be offset by poor capital control.** Bot10 had a +114/turn reinforcement income but lost the game because their unprotected territories were overwhelmed by Bot6. (2 games, last CDCU2S)
- **Failing to secure capitals leaves you vulnerable to sudden elimination.** Ahri had 0 capitals and was eliminated by Lux in round 8. (1 game, last XG5SYR)

### Eliminations & Leaderboard Climbing
- **Maintaining strong reinforcement income is a decisive advantage.** Thresh's high reinforcement income (+87/turn) allowed them to rapidly expand and overwhelm opponents like Shen and Tryndamere. (3 games, last CYK7GV)
- **Eliminations award permanent Elo points and placement jumps.** Bot8's elimination of Bot7, Bot9, Bot2, Bot1, and Bot5 contributed significantly to their Elo gain and tournament standing. (5 games, last H7NVFC)
- **Focusing on eliminating weaker opponents early can lead to long-term dominance.** Thresh prioritized eliminating Shen and Tryndamere early, allowing them to dominate the game and finish in 1st place. (5 games, last H7NVFC)
- **Early bonus control can be critical for survival.** Shen and Tryndamere completed regional bonuses early, providing steady income that built strong territorial bases. (2 games, last 45K9US)
- **Aggressive early attacks can be countered with disciplined defense and reinforcement management.** Bot3 absorbed an early rush by consolidating onto high-defense choke points and counter-attacked once the aggressor depleted their forces. (1 game, last 8ESC69)

### Multi-Party Alliances & Global Coalitions
- **Alliances are risky if not enforced.** Multiple players, including Bot9, made alliance proposals or truce offers, but these were often broken or ignored, leaving players vulnerable to attacks. (3 games, last 6VNSVQ)
- **Alliance talk never became terms.** Players discussed teaming up all game, but no message set a round, a border or a target, so everyone kept attacking at random. (2 games, last CDCU2S)
- **Truces with aggressive players can be risky if not enforced.** Shen made multiple truce proposals with Shaco and Lux, but these were not honored, allowing Shaco to break Shen's bonuses and weaken their position. (2 games, last CDCU2S)
<!-- bot-findings:end -->
