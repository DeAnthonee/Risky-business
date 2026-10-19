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
* **Progressive Cards**: Cash-in values escalate table-wide as more sets are traded (4, 6, 8, 10, 12, 15, 20, 25, 30, 35, 40, etc.). Late-game progressive card sets provide game-ending attack stacks.
* **Fixed Cards**: Set values remain constant throughout the game (4 for Infantry, 6 for Cavalry, 8 for Artillery, 10 for Mixed/Wildcard).
* **Hand Limit**: A player holding 5 or more cards must trade a set on their draft phase. Mid-turn card inheritance from an eliminated player triggers immediate reinforcement deployment.

### 3. Game Modes & Win Conditions
* **World Domination**: Eliminate all rival players and control 100% of territories on the board.
* **Capitals Conquest**:
  * Each player starts with a designated Capital territory.
  * Capitals defend with 3 dice instead of 2, making them significantly harder to capture.
  * Win condition: Capture and hold all Capitals on the map while defending your own Capital.

### 4. Fog of War & Information Control
* **Non-Fog of War (Visible)**: All player army garrisons, territory boundaries, and turn incomes are publicly visible to all participants.
* **Fog of War (Hidden)**:
  * Only territories directly adjacent to friendly borders are visible.
  * Enemy stacks, interior movements, and bonus completions within the fog are hidden.
  * Probing/scouting attacks reveal neighboring garrison counts.

### 5. Map Geography, Bonuses & Blizzards
* **Continent / Regional Bonuses**: Holding every territory in an unbroken continent provides recurring turn income. Entry chokepoints determine defensive cost.
* **Blizzards**: Random impassable territories and blocked connections that alter standard map topography and create unique chokepoints.

### 6. Table Communication & Diplomacy
* Players may communicate via public table-wide chat or private whispers.
* **Deals**: Truces, Joint Attacks, Non-Aggression pacts, and Coalition calls against dominant leaders.
* Deals are strategic non-binding agreements; bots may negotiate, propose, honor, or break deals when it serves their path to victory.

---

## Findings from AI self-play games
<!-- bot-findings:start -->
### Non-Fog of War
- **Failing to form coalitions against a dominant player leads to isolation.** Bot3 failed to form alliances or coordinate attacks against Bot2, allowing Bot2 to dominate the game and eliminate them. (7 games, last H7NVFC)
- **Failing to leverage held bonuses can leave players vulnerable to aggressive opponents.** Bot1 held the hrimvald, gloamfen, and mistveil bonuses but failed to use them effectively, contributing to their elimination by Bot6. (2 games, last C6KXT6)
- **Avoiding direct conflict with dominant players until they are significantly weakened can be a strategic advantage.** Bot3 avoided direct conflict with Bot8 for most of the game, only engaging them in the final rounds when it was clear Bot8 was the dominant threat. (2 games, last H7NVFC)
- **Aggressive expansion without securing key bonuses can be countered by opponents targeting those bonuses.** Bot10 broke multiple continent bonuses, including British Isles, Scandinavia, and France, which significantly reduced Bot3’s reinforcement income and contributed to their elimination. (2 games, last KS7ET2)
- **High reinforcement income from key bonuses can be offset by poor capital control.** Bot10 had a +114/turn reinforcement income but lost the game because their unprotected territories were overwhelmed by Bot6. (2 games, last CDCU2S)
- **Holding all capitals provides a massive reinforcement income and makes it nearly impossible for opponents to contest key regions.** Bot2 held all capitals, contributing to their +104/turn reinforcement income and decisive victory. (2 games, last CDCU2S)
- **Holding all capitals provides a massive reinforcement income and makes it nearly impossible for opponents to contest key regions.** Bot2 held all capitals, contributing to their +104/turn reinforcement income and decisive victory. (2 games, last CDCU2S)
- **Maintaining strong connectivity between territories prevents leaving interior pockets vulnerable.** Bot3's fragmented territory holdings made defense impossible once Bot10 launched a concentrated attack, leading to Bot3's elimination. (1 game, last D5HXP4)
- **Aggressive expansion without securing key bonuses can be countered by opponents targeting those bonuses.** Bot6 broke Bot1’s Scandinavia and Dinaric Alps bonuses, reducing Bot1’s reinforcement income and contributing to their elimination. (1 game, last YLFZU9)
- **Avoiding interior pockets with stranded troops helps prevent resource drain.** Bot3 left large garrisons trapped behind friendly lines without hostile borders, wasting armies that should have been reinforcing frontlines. (3 games, last PTJ76F)

### Non-Fog of War (Public Armies & Troop Budgeting)
- **Troop commitments must match visible budgets.** In non-fog lobbies where armies and incomes are public, bluffing impossible troop offers fails; proposals exceeding armyCount plus income are rejected. (1 game, last 4J2YAV)
- **Multi-way alliances against runaway leaders require all-chat.** Whispering between two players cannot coordinate a 3-way or 4-way response against a dominant player; public coalition calls coordinate joint pressure. (1 game, last X3T6U8)
- **Failing to form coalitions against a dominant player leads to isolation.** Divided rivals who negotiate separate truces while a leader snowballs get rolled up one by one. (1 game, last X3T6U8)
- **Not engaging in deals can be a strategic advantage if it avoids the risk of betrayal.** Bot4 did not make any deals during the game, allowing them to focus on expansion and defense without the risk of betrayal. (6 games, last H7NVFC)
- **Maintaining a high reinforcement income through territory control is crucial for long-term survival.** Bot4's control over key bonuses and territories provided a +45/turn reinforcement income, allowing them to withstand attacks and maintain a strong position. (4 games, last H7NVFC)
- **High reinforcement income from key bonuses can offset lack of capital control.** Bot9 secured multiple continental bonuses, out-producing capital holders (+114/turn) and overwhelming them through sheer army count. (3 games, last H7NVFC)

### Capitals Conquest
- **Securing key bonuses early provides long-term reinforcement benefits.** Bot8 secured multiple continent bonuses early in the game, which contributed to their high reinforcement income and strategic expansion. (3 games, last H7NVFC)
- **Capitals defend with 3 dice and require overwhelming odds.** Bot7’s concentrated garrisons on key territories withstood attacks from multiple opponents, who had 0 capitals and were major threats. (5 games, last DGS35N)
- **Holding all capitals provides a massive reinforcement income and makes it nearly impossible for opponents to contest key regions.** Bot8’s control over all capitals allowed them to withstand attacks and maintain a strong reinforcement income, which was critical to their victory. (4 games, last ZYW8N8)
- **Holding all capitals provides massive reinforcement income and prevents comebacks.** Securing capitals early creates an insurmountable reinforcement stream that locks opponents out. (3 games, last DGS35N)
- **Controlling all capitals early provides a massive reinforcement income and makes it nearly impossible for opponents to contest key regions.** Bot3 held all capitals from the beginning, which allowed them to withstand attacks and maintain a strong position. (2 games, last CDCU2S)
- **Failing to secure capitals leaves you vulnerable to sudden elimination.** Holding raw territories without a secure capital base leaves players exposed once larger rivals mobilize. Bot2 had 0 capitals and was eliminated by Bot9. (4 games, last H7NVFC)

### Eliminations & Leaderboard Climbing
- **High reinforcement income is a decisive advantage.** Bot8's +100/turn reinforcement income allowed them to rapidly expand and overwhelm opponents like Bot7, Bot9, Bot2, Bot1, and Bot5. (3 games, last CYK7GV)
- **Eliminations award permanent Elo points and placement jumps.** Bot8's elimination of Bot7, Bot9, Bot2, Bot1, and Bot5 contributed significantly to their Elo gain and tournament standing. (5 games, last H7NVFC)
- **Focusing on eliminating weaker opponents early can lead to long-term dominance.** Bot8 prioritized eliminating Bot7, Bot9, Bot2, Bot1, and Bot5 early, allowing them to dominate the game and finish in 1st place. (5 games, last H7NVFC)
- **Early bonus control can be critical for survival.** Shen and Tryndamere completed regional bonuses early, providing steady income that built strong territorial bases. (2 games, last 45K9US)
- **Avoiding stranded troops and focusing on efficient reinforcement and movement can minimize losses.** Planning multi-turn attack paths ensures frontline stacks remain mobile and offensive momentum is preserved. (1 game, last VX6C5F)
- **Aggressive early attacks can be countered with disciplined defense and reinforcement management.** Bot3 absorbed an early rush by consolidating onto high-defense choke points and counter-attacked once the aggressor depleted their forces. (1 game, last 8ESC69)

### Multi-Party Alliances & Global Coalitions
- **Alliances are risky if not enforced.** Multiple players, including Bot9, made alliance proposals or truce offers, but these were often broken or ignored, leaving players vulnerable to attacks. (3 games, last 6VNSVQ)
- **Alliance talk never became terms.** Players discussed teaming up all game, but no message set a round, a border or a target, so everyone kept attacking at random. (2 games, last CDCU2S)
- **Truces with aggressive players can be risky if not enforced.** Shen made multiple truce proposals with Shaco and Lux, but these were not honored, allowing Shaco to break Shen's bonuses and weaken their position. (2 games, last CDCU2S)

### Fog of War
- **Scouting with card-taking attacks reveals critical enemy garrison counts.** Bot9 used single-territory probes to reveal enemy garrison counts before launching major offensives, allowing them to prepare for the scale of the attack. (2 games, last T9DCQW)
- **Small border garrisons can project false weakness.** Opponents often assume lightly defended fog borders indicate an empty interior; keep mobile strike stacks one step behind the frontline. (1 game, last MVAPM8)
- **Maintaining strong reinforcement income is crucial for long-term survival under fog.** Bot9 maintained a high reinforcement income (+91/turn) despite losing several key territories, which contributed to their survival and elimination of multiple opponents. (1 game, last 8VALR5)
- **Judging hidden threats by income is a reliable strategy.** Bot9 used enemy turn income as a reliable estimate of rival strength to target weaker opponents effectively. (1 game, last 8SR5HD)

### Progressive Cards & Escalating Spoils
- **Time your trades to fund immediate eliminations.** Sitting on complete card sets while opponents trade escalating spoils allows rivals to build overwhelming attack stacks; trade when armies convert directly into a kill or capital. Bot2 timed their card trades effectively to fund their elimination of Bot8, Bot10, Bot1, Bot9, and Bot5. (2 games, last CDCU2S)
- **Elimination chains accelerate endgame conquest.** Inheriting cards from an eliminated player can push the attacker to 5+ cards, triggering a mid-turn trade that finances the next elimination on the same turn. (2 games, last CDCU2S)
- **Failing to engage in card trades can limit strategic advantages.** Delaying card trades too long in progressive lobbies allows opponents to escalate trade values and overwhelm static defenses. Bot4's delayed card trades limited their ability to counter Bot6's expansion. (2 games, last CDCU2S)
- **Eliminations funded the winners.** Lux knocked out Darius (round 4), Shaco (round 6) and Leona (round 38) and survived to 2nd; Ahri swept every capital. The three first players out (Darius, Shaco, Thresh) never made a kill. (1 game, last MVAPM8)
- **Focusing on card acquisition without securing territory is a losing strategy.** Bot6 focused on gathering cards but failed to secure any bonuses or capitals, making him an easy target for elimination. (1 game, last PMNH5H)
<!-- bot-findings:end -->
