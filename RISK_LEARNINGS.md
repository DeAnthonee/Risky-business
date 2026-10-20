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
    * *Visible Placement Accounting & Positional Anchors Under Fog*:
      Correlating an opponent's public reinforcement income (+N/turn) with where their drafted troops physically appear on visible borders reveals their entire hidden posture:
      1. **The +3 Income 100% Accounted Kill Confirmation**: If an opponent receives +3/turn income (proving $\le 11$ territories, 0 bonuses, 0 extra capitals) and you observe all 3 troops placed onto visible borders, you know with 100% certainty that **zero reinforcements went into the fog**! They have NO hidden interior stacks, NO hidden bonuses, and their hidden lands are neglected 1-army scraps. They are an exceptionally safe, high-confidence elimination target with near-zero ambush risk.
      2. **The +5 Income Single-Position Anchor**: If an opponent receives +5/turn (+2 bonus or capital) and dumps all 5 troops onto a single visible border chokepoint or capital, that position is their **sole strategic lifeline and anchor on the map**; their interior is hollow. Cracking that single position shatters their bonus, collapses their income to +3, and cripples their position.
      3. **Unseen Placement Ambush Warning**: If an opponent receives +5 to +9 income but places only 0-1 troops on visible borders, the remaining troops were placed deep in the fog; do not plunge blindly into their territory.
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
* **Concentrated Spearheads vs. Multi-Pronged Drafting (`placeOn`)**: Deploying draft reinforcements into a single concentrated attack stack (spearhead) on the frontline rather than scattering 1-2 armies across internal territories maximizes break-through odds and minimizes combat casualties against fortified lines. **However, reinforcements do not always need a single concentrated point**: when hunting an elimination target whose remaining territories are spread or disconnected across the map, draft reinforcements across 2–3 launch points simultaneously (`placeOn: ["territory_a", "territory_b"]`) to attack and sweep the player in 2–3 directions to finish them off in a single turn.
* **Sequential Attack Routing (`route`)**: Order attacks along a contiguous path from highest-probability / weakest resistance outward. Take at least one guaranteed territory early to secure the turn's card before attempting high-variance expansion.
* **Interior Pocket Prevention**: Never leave large garrisons (4+ armies) stranded in friendly interior pockets that do not border hostile territories or blizzards. Pushing into a dead-end pocket is completely justified and encouraged when executing an elimination or capturing a capital (stolen cards, placement jump, and kill bounty far outweigh having troops in a corner); peacetime reinforcement is what must avoid friendly interior pockets.
* **Asymmetric Bonus Denial & Griefing**: When holding a geographically secure continent with 1 choke point (e.g. South America or Australia) against a rival holding an exposed continent with 3 choke points (e.g. Europe, North America, or Africa), breaking their bonus is high-leverage griefing: you deny huge recurring income while defending only 1 point.
* **The Golden Kill Rule & Post-Kill Net Armies**:
  * When attacker cards + victim cards $\ge 5$, an immediate trade is guaranteed.
  * Calculate $\text{Net Armies After Kill} = \text{Strike Stack} - \text{Expected Losses} - \text{Conquests} + \text{Immediate Trade Armies}$.
  * If a kill leaves you with $<5$ armies and vulnerable to rivals, it is suicidal. If it leaves you with $\ge 10$ armies, it is a game-winning comeback move that refuels your army, leaps placement tiers, and locks in +1 Elo.
* **Fortify Repositioning (`fortifyTo`)**: At the end of the turn, use the fortify phase to pull back mobile rear armies or advance reserve stacks to frontline defensive chokepoints, border gates, or capital garrisons to protect held continent bonuses from enemy counter-punches.
* **Disciplined Attack Termination vs. The "Bonus Greed Trap"**:
  * You do **NOT** have to exhaust every good attack on your turn! Making every attack that is technically favorable is a classic blunder that leads to rapid defeat.
  * In multi-player Free-For-All (3–6 players), attacking past a newly secured continent bonus into adjacent territories bleeds your breakthrough stack down to 1–2 armies, spreads your forces thin, and leaves your newly captured bonus border undefended.
  * On the very next turn, a neighbor will effortlessly roll over that 1–2 army border, breaking your bonus before you ever collect the income!
  * **The "Take & Hold" Guarantee**: Once you capture or complete your continent bonus and secure your turn's card, **STOP attacking immediately**. Keep your heavy stack (8–15 armies) parked directly on the single doorway chokepoint (or use `fortifyTo` to consolidate back onto the border). An impenetrable 10+ border stack acts as a total deterrent: opponents will refuse to attack into it. Cash in your $+2, +3, +5$ bonus income turn after turn, let rivals bleed their forces fighting each other, and only expand outward once you have banked a massive secondary surplus stack.
* **Situational Attack Termination (When NOT to Stop)**:
  Stopping after securing a bonus is **situational** rather than a rigid rule. The bot continues attacking if any of the following situational conditions apply:
  1. **Lethal / Game-Winning Strike (`winsGame`)**: An adjacent territory ends the game immediately (capturing the final capital or wiping out the last remaining rival). Winning the game always takes precedence over defensive holding.
  2. **High-EV Player Elimination (`kill`)**: A player can be eliminated this turn for their cards or bounty. If an opponent holds 3–5 cards, eliminating them triggers an immediate trade-in yielding +15 to +40 armies, dwarfing any single continent bonus.
  3. **1v1 Heads-Up Endgame (`is1v1`)**: When only two players remain, multi-player restraint turns off completely. Every territory conquered starves the rival's income ($\lfloor N/3 \rfloor$) and strips their bonuses. Break everything you can reach!
  4. **Substantial Army Surplus on the Border Chokepoint**: If your border stack holds a massive troop surplus well beyond the garrison required to defend against visible threats (e.g. 25+ armies when only 7 are needed to guard the choke), push forward with the surplus! Attacks from bonus borders automatically preserve the defensive garrison floor (`borderFloor = guardFor`), ensuring the border is never stripped bare while surplus armies expand the frontline.
  5. **High-Value Opponent Bonus Break**: If a neighbor holds an uncontested $+3$ or $+5$ continent bonus (e.g. Africa, Europe, or North America) with a weak border, breaking it with favorable odds ($\ge 80\%$) denies them massive recurring income.
  6. **Card Conquest Not Yet Secured**: If you started the turn holding a bonus or haven't conquered a territory yet, you must complete at least one favorable conquest to draw your once-per-turn card.
  7. **Explicit Commander Missions**: When the Commander explicitly routes an attack sequence, targets an enemy with `commitArmies`, or selects `winPath === 'kills'`, strategic offensive intent overrides routine bonus holding.
* **The Aggressive "One-More-Attack" Neighbor Bonus Break**:
  * For aggressive commanders (`aggression >= 0.6`, e.g. Darius, Tryndamere, Draven), securing your own continent bonus is only step one.
  * If an adjacent neighbor also completed or holds a continent bonus (even a $+2$ or $+3$ bonus), launching **exactly one more surgical attack** across the border specifically to break their bonus is exceptionally high value!
  * It completely strips their $+2, +3,$ or $+5$ reinforcement income for their upcoming turn, solidifying your relative production dominance.
  * *Discipline Rule*: Once the neighbor's bonus is broken, immediately stop and hold your new frontline. Do not greedily chase further into their territory unless you have a massive surplus!
* **Avoid List Discipline & The "Free Kill" Blunder**:
  * In the tactical engine, `avoid` is a hard non-aggression constraint.
  * **The Blunder**: When an LLM picks a target (e.g. `target: "Shaco"`), models reflexively dump all other players into `avoid: ["Shen", "Thresh", "Teemo"]`. If one of those non-target players (like Thresh) later becomes crippled down to 1–2 territories with 1 army and 4 cards, the bot's hard `avoid` constraint forbids attacking them — causing the bot to blindly pass up a completely free kill and card cash-in!
  * **The Rule**: `avoid` must NEVER protect an opponent from an outright elimination. If taking a territory eliminates a player, `avoid` is automatically overridden. Commanders must only use `avoid` for active peace treaties, leaving it empty `[]` when hunting kills.
* **Dice Modes & Mathematical Win Percentages (Balanced Blitz vs. True Random Blitz vs. Single Dice)**:
  * Risk features three distinct combat mechanics with radically different mathematical probability distributions:
  * **1. Balanced Blitz (`balancedBlitz: true`)**:
    * Rolls the median of 5 complete simulated blitzes ($n = 5$).
    * Governed by the binomial median formula:
      $$P_{\text{balanced}}(p) = \sum_{k=3}^5 \binom{5}{k} p^k (1-p)^{5-k} = 10p^3(1-p)^2 + 5p^4(1-p) + p^5$$
    * Creates an amplified S-curve:
      * $90\%$ random $\to \mathbf{99.1\%}$ balanced
      * $85\%$ random $\to \mathbf{97.3\%}$ balanced
      * $80\%$ random $\to \mathbf{94.2\%}$ balanced
      * $70\%$ random $\to \mathbf{83.7\%}$ balanced
      * $50\%$ random $\to 50.0\%$ balanced
      * $30\%$ random $\to \mathbf{16.3\%}$ balanced
      * $20\%$ random $\to \mathbf{5.8\%}$ balanced
    * *Strategic Rule*: High-probability attacks ($\ge 80\%$) are near-guaranteed locks with minimal casualties; catastrophic freak wipes are eliminated. Conversely, underdog attacks ($< 40\%$) almost never succeed; never attempt desperate underdog gambles under Balanced Blitz.
  * **2. True Random Blitz (`balancedBlitz: false`)**:
    * Unfiltered Markov-chain dice sequence without median smoothing.
    * High variance and fat tails: an 80% attack still has a real 20% failure rate, and bad luck can wipe out large stacks.
    * *Strategic Rule*: Always maintain a safety margin of at least $+3$ to $+5$ extra armies beyond the basic requirement before committing to an attack.
  * **3. Single Random Dice (Manual 1–3 Dice Rolls)**:
    * Standard single-roll combat where attacker rolls 1–3 dice vs defender 1–2 dice.
    * Ties go to the defender (giving defender $\approx 56\%$ win rate on equal 2v2 dice pairs).
    * *Strategic Rule*: Single rolling is strictly for minimal 1-roll probes or micro-stopping at an exact army count without committing the whole stack.

### 8. Geographic Viability & Early Bonus Selection (Small Chokepoints vs. Sprawling Traps)
* **Starting Geography Dictates Advantage**: Starting randomized territory allocations and initial troop concentrations dictate early-game advantage paths. Always survey where your starting troop stacks and territory clusters are placed. Never attempt to expand into distant regions where you have zero local presence.
* **Prioritize Small, Tight Bonuses Early**: Base reinforcement income starts at only +3/turn. Securing a small continent bonus (+2 or +3/turn) doubles your reinforcement rate immediately. Small continents (2 to 4 territories, e.g. Iceland, Australia, South America) can often be completed on turn 1 or 2 with minimal casualties.
* **Chokepoint Defensibility (Holdability)**:
  * *1 Border Entry (Exceptional)*: Continents with a single entry point (e.g. Australia/Siam, Iceland) allow parking 100% of defensive armies on a single border stack, making them virtually impregnable early on.
  * *2 Border Entries (Strong)*: Continents with two entry points (e.g. South America) require only two guard stacks, offering an optimal ratio of bonus income to defense cost.
  * *4+ Border Entries (Sprawling Traps)*: Continents with 4 to 6 entry points (e.g. Russia, Asia, Europe) are fatal early-game traps on rounds 1–4. Attempting to hold them spreads armies paper-thin across too many borders, invites breaches, and drains reinforcements into endless defense.

### 9. Outpost Defensive Deterrence, Contiguous Consolidation & Leader Counterplay
* **The Outpost Defensive Deterrence Principle (Defending > Attacking for the Sake of Attacking)**:
  * Making attacks from detached outposts (e.g. attacking into Africa when your main strategic bonus is Canada/North America) that do not break an enemy bonus or capture a capital is an expensive blunder.
  * *Why Pointless Attacks Bleed You*: When an outpost attacks a neighboring 1- or 2-army territory (e.g. 3v1 or 3v2), the attacker suffers combat attrition, destroys its own single defensive stack, and leaves behind a fragile trail of 1s and 2s that any neighboring opponent can sweep up for free.
  * *The 2-Dice Defender Advantage*: In Risk, defending with 2 dice gives a decisive statistical edge because **the defender wins all ties**. An attacker rolling 3 dice vs 2 defending dice loses both armies whenever the rolls tie.
  * *Deterrence Value*: When an outpost outside your focus area **stays stacked** (4–8 armies), opponents need 8–12+ armies to roll through it and will incur heavy casualties. Consequently, rational players will leave it completely alone. Keep secondary outposts thick and let opponents waste their armies trying to dislodge them! Once your turn's card is earned, secondary outposts must NEVER attack non-strategically.
* **Carving One Piece of the Map (Corner Consolidation vs. Sprawling Thin)**:
  * Spreading initial reinforcements across 3–4 disconnected continents early game dilutes draft power and leaves every single border under-defended and vulnerable to counter-attacks.
  * High-level play dictates picking one corner or defensible starting stronghold (e.g. Australia, South America, Scandinavia, or Southern Africa) and working outward contiguously from there.
  * Clear local borders outward one by one, consolidating a single solid continental block with minimal exterior border chokepoints before expanding into adjacent regions.
* **Card-Block Defense (The 1–2 Position Rule)**:
  * While consolidating a single regional core, players in high-level games (especially under Fog of War) must maintain **1 or 2 solid secondary anchor positions/outposts** on the broader map.
  * If a player retreats 100% of their troops into a single sealed corner behind one choke point, a rival can park a massive 20+ army guard on that single exit, completely "card-blocking" them. Unable to conquer an enemy territory, the cornered player receives 0 cards per turn and slowly suffocates.
  * Keeping 1–2 secondary outposts ensures you always have a viable, low-cost target to conquer each turn for your card.
* **Runaway Leader Dynamics vs. Placement Preservation**:
  * In multi-player games, a player may snowball to dominant board control (e.g. 80–100+ armies and 35+ territories while rivals have 15–25 armies).
  * *Suicidal Solo Attacks*: An underdog launching a solo attack into a runaway leader achieves nothing: it depletes the underdog's remaining armies, angers the leader, invites immediate retaliatory annihilation, and locks the attacker into a 5th or 6th place finish (-2 or -3 Elo).
  * *Coalition Counterplay*: The only way to stop a runaway leader is through coordinated multi-player coalitions via table chat (e.g. all-chat calls to strike the leader's key bonuses simultaneously from multiple borders).
  * *Placement Preservation (Playing for 2nd/3rd)*: If rivals refuse to coordinate a coalition and 1st place is currently unachievable solo, pivot immediately to disciplined placement survival. Fortify your capital and core borders, let other players get eliminated first to secure 2nd or 3rd place (+1 or +2 placement tiers), avoid triggering the leader's wrath, and look for late-game opportunities (e.g. a sudden cap run or an elimination chain) if the leader over-extends.

### 10. The "Hold & Fortify" Blueprint (Card, Fortify Inside-Out, and Sit on It)
* **The Compounding Power of Held Bonuses**:
  * In Fixed Cards mode (and early rounds of Progressive before trade values scale), **continent bonuses are your single biggest engine**.
  * Holding an unbroken continent bonus (even a modest +2 or +3/turn) for just 3–5 rounds generates +10 to +25 extra draft armies. In a game where base income is only +3 to +5/turn, this creates a decisive, uncatchable army lead.
* **The "Hold & Fortify" Loop**:
  1. **Identify the Exact 2–3 Chokepoint Border Holds**: For example, holding Southeast Asia requires guarding only South China, Southwest China, and Myanmar. Holding North Africa requires guarding Algeria and Southern Italy.
  2. **Do NOT Push Into Massive Neighboring Continents**: When you secure Southeast Asia, do NOT push into China or Central Asia! Pushing into a massive 12-territory continent spreads your armies across 5+ borders, fails to secure the new bonus, and leaves your newly conquered continent wide open to counter-attacks.
  3. **The 1-Card Rule**: Each turn, make **one safe attack** on a weak neighboring territory just to earn your turn's card.
  4. **Fortify Inside-Out**: Never leave internal 3-stacks or reserve troops idling behind friendly lines. Use your fortify phase every turn to pull interior troops forward onto your frontline chokepoint stacks.
  5. **Sit on It and Bank Surplus**: Park impenetrable 8–15+ army stacks on the 2–3 chokepoints. Let opponents waste their armies fighting each other. Only think about expanding to a second bonus once you have banked a massive secondary army surplus!

### 11. Multi-Capital Defense & Proportional Garrisoning (Cap-Run Prevention)
* **Under-Defended Capitals Are Irresistible Targets**:
  * Each capital held grants **+2 reinforcement armies per turn permanently**.
  * In Capitals Conquest, leaving any capital—whether your starting home capital or a newly conquered capital—defended by only 1 troop is a catastrophic blunder.
  * To any competent rival, a 1-troop capital is an irresistible prize: capturing it immediately strips +2/turn from you, adds +2/turn to the attacker, and locks in a 3-dice fortress for them.
* **Capital 3-Dice Defense Advantage**:
  * Capitals defend with **3 dice** instead of 2. An attacker must bring overwhelming odds ($\ge 8\text{--}12$ armies) to breach even a modest 4–5 army capital garrison.
  * If a capital has only 1 army, it defends with only 1 die, throwing away the entire 3-dice defensive bonus!
* **Proportional Capital Defense**:
  * You do not need to bury 100% of your forces on every capital, but every held capital must maintain a garrison proportional to your army count (at least 3–5 troops).
  * **Late-Game Cap-Run Deterrence**: In late game (Round 10+), as opponents amass 30–50+ army strike stacks, leaving any capital lightly guarded invites an instant **Cap Run**. Scale capital garrisons upward to ensure no opponent can sweep all capitals in a single turn.
* **Capital Migration (Moving from Back-Pockets to Forward Doorways)**:
  * When a player starts with a capital tucked in a back-pocket (e.g. Algeria with 0 hostile borders) but later captures an active forward capital on a major chokepoint (e.g. Southern Germany), treat the forward capital as your new primary stronghold!
  * Migrate draft reinforcements and surplus fortifies up to the forward capital to anchor your front gate with 3-dice defense.

### 12. Dormant Stack Activation Prevention (Do Not Open a Big Stack)
* **The "Caged" Stack Principle**:
  * In Risk, an opponent's dangerous heavy stack ($\ge 5\text{--}8$ armies) is often locked behind buffer territories or neutral dead ends, with zero direct border connection to you.
  * In this state, the rival stack is **dormant and harmless to your empire**.
* **The Activation Blunder (e.g. Southern France to Northern Spain)**:
  * When an attacker breaks an opponent's bonus (e.g. taking Southern France breaks Western Europe), the strategic objective is complete!
  * Pushing one step further into a buffer territory (e.g. Northern Spain) that borders a dormant 6-stack is fatal: taking Northern Spain leaves a weak 1-army outpost, opening an immediate highway for the 6-stack to roll right through on their next turn!
* **The 1-Turn Delay Advantage**:
  * Even if the rival could theoretically fortify that stack on their fortify phase, **forcing them to fortify delays their attack by at least one full turn** and leaves their rear territory at 1 army.
  * A 1-turn delay gives you an entire round of bonus income, lets you build defenses, or forces the rival to attack another player instead.
  * *The Rule*: Stop at the border! Leave buffer territories intact to keep heavy enemy stacks caged and dormant.

### 13. The "Anti-Blitzkrieg" & Turtling Principle (Preventing Exhaustion Chains)
* **The "Reckless Blitzkrieg" Vulnerability**:
  * In non-fog and fog games alike, attacking through a long chain of 3–5 territories without massive reserve armies is suicidal.
  * Every conquest leaves at least 1 army behind. An army of 15 attacking 4 territories in a row quickly bleeds out through dice attrition and mandatory garrisons, leaving a fragile trail of 1s and 2s that are effortlessly wiped out on the very next enemy turn.
  * **The Classic Darius Blunder**: Charging from Tunisia through Algeria into Southern France, Alps, and Hungary without troop budget exhausts the entire mobile army, loses the core North Africa bonus, and exposes weak outposts to every neighbor on the board.
* **The "Turtle & Consolidate" Counterplay**:
  1. **Identify the Chokepoint Anchor**: For North Africa, sit on Libya and Southern France (or Algeria and Southern Italy).
  2. **Card and Stop**: Take exactly one territory to earn your card for the turn.
  3. **Switch to Turtling for 2–3 Turns**: If advancing does not win the game, eliminate a player, or take a capital, and leaves $< 4$ armies on the conquered territory, **STOP ATTACKING**.
  4. **Bank Reinforcements on the Chokepoints**: Spend 2–3 turns accumulating thick defensive garrisons (8–15+ troops) on your chokepoints before even considering launching another offensive.

### 14. Capital Selection: Doorway Capitals vs. Pocket & Neighbor-Clash Traps
* **The Flaw of Pocket Capitals (e.g. Ireland, Northern England)**:
  * Pocket capitals located in dead-end corners of the map suffer from catastrophic strategic defects:
    * They have minimal board reach and cannot influence the wider game.
    * Troops spawned on pocket capitals must march through multiple bottlenecks just to reach the frontline.
    * They often do not even lock down the surrounding bonus (e.g. Northern England does not secure Great Britain on its own).
* **The "Neighbor-Clash" Capital Trap**:
  * Choosing a capital directly adjacent to an already-claimed enemy capital (e.g. Shen picking Northern England 4th right next to Tryndamere's Ireland) is mutually destructive.
  * Neither player can hold the regional bonus because their capitals are locked in permanent, zero-sum friction.
  * Both players waste armies bludgeoning each other while other players on the map expand freely.
* **The Ideal "Doorway Capital" (e.g. Northern Germany)**:
  * A true Doorway Capital holds a 1-point bottleneck defending an interior bonus (Northern Europe) while remaining highly connected and exposed to the rest of the board.
  * It provides 3-dice defense at your front gate, allows rapid troop deployment anywhere on the map, and acts as an unbreachable launchpad for future expansion.

### 15. The 2v1 Elimination EV Equation (Why Passing Is a Blunder)
* **The Tactical Scenario (e.g. Teemo vs. Shaco on Sri Lanka)**:
  * A victim is reduced to their final territory with 1 defender, and you have an adjacent 2-army stack.
  * The victim holds $\ge 3\text{--}4$ cards. Standard attack thresholds might filter this out because Blitz win probability on 2v1 is $\approx 41.7\%$ (attacker rolls 1 die, defender rolls 1 die, attacker wins if $A > D$).
* **The Mathematical Expected Value (EV)**:
  * **Cost of Failure**: You lose 1 army. That's it ($-1$ troop).
  * **Cost of Passing**: The victim survives with 3–4 cards, cashes in on their immediate next turn, gains $+10$ to $+30$ armies, and potentially eliminates you or wrecks your empire.
  * **Reward of Success**:
    * $+1$ permanent kill point on the tournament leaderboard.
    * Higher tournament placement tier (+1 or +2 tiers).
    * Steal all victim's cards ($\ge 3$ cards).
    * If stolen cards reach $\ge 3$, you trigger an immediate mid-turn trade yielding $\mathbf{+10\text{ to }+30\text{ reinforcement armies}}$ right now!
  * **The EV Equation**:
    $$\text{EV} = (0.417 \times +10\text{ armies}) + (0.583 \times -1\text{ army}) = +4.17 - 0.58 = \mathbf{+3.59\text{ armies net gain}}$$
  * Passing on a 2v1 elimination against a high-card victim is a massive EV blunder. When the bounty has $\ge 3$ cards, a $41.7\%$ gamble with game-winning upside must always be taken!

### 16. The "4–5 Card Bounty Trap" under Fog of War
* **The Public Target on a Foggy Board**:
  * Under Fog of War, players cannot see each other's interior garrisons or exact army deployments.
  * However, **card counts are 100% public information** in the scoreboard at all times!
  * When a player reaches 4 or 5 cards, every competent opponent knows two things:
    1. The target has an immediate trade or forced trade on their next turn.
    2. Eliminating this player yields an instant 4–5 card inheritance, guaranteeing a mid-turn trade for the attacker right now.
* **The Overextension Blunder (e.g. Ahri and Darius in Game 48 on USA)**:
  * In Game 48 (`JPT2FS`), Ahri had 16 armies across 12 territories and was holding 5 cards. Instead of pulling her forces into a tight fortress to protect her cards until her trade turn, she attempted to conquer both Southwest and Rockies simultaneously.
  * Spreading 16 armies across 12 territories left each border defended by only 1–2 troops.
  * Shaco saw the 5-card bounty, punched through the paper-thin perimeter, eliminated Ahri in Round 6, cashed the 5 cards mid-turn, and rolled the board. Darius made the exact same mistake with 4 cards in Round 8 and was eliminated next.
* **The High-Card Survival Protocol**:
  1. **Tighten, Do Not Expand**: When holding 4 or 5 cards, **stop expanding across multi-territory fronts**.
  2. **Fortify into a Single Dense Bastion**: Fortify all mobile troops onto your primary chokepoint or capital to raise the attacker's required troop threshold above what any opponent can bring.
  3. **Trade First, Then Expand**: Wait until your turn to trade your cards for fresh reinforcements; only after the armies are safely in hand should you resume continental conquest.

### 17. Multi-Continent Doorway Defense & Choke-Neutral Bonus Disruption
* **The Doorway Stacking Principle (The Fortress Chokepoint Rule)**:
  * When a player controls an advantageous multi-continent cluster (such as the Americas on World/World Large), the entire empire often connects to the rest of the world through only **two or three bottleneck doorways** (e.g., Alaska–Kamchatka, Greenland–Iceland, and Brazil/Central America–North Africa).
  * **The Blunder (e.g., Jinx in Game YHSFLR)**: Jinx successfully locked down the Americas (Western US, Eastern US, Central America, Northern South America, Southern South America) generating massive continent bonuses. However, Jinx left her 3 exterior doorway chokepoints paper-thin (defended by only 1–2 armies each), while troops were scattered or idling in deep interior territories. 
  * Luckily, opponents failed to punish this immediately. But leaving external doorways undefended is a lethal gamble: any adjacent rival with a medium stack can punch through for 2 troops, break multiple continent bonuses simultaneously, and collapse the empire's income overnight.
  * **The Doorway Garrison Rule**: When holding a multi-continent bloc on 2–3 bottlenecks, **pull every spare interior army to the exterior doorways**. The interior requires only 1 army per territory; the doorways should hold **heavy 15–30+ army fortress stacks**. A player with such geographic superiority must convert it into impenetrable border deterrence.

* **Opponent Obligation: Punishing Ungarrisoned Chokepoints**:
  * If an opponent secures multiple continents but fails to garrison their doorways, **adjacent rivals have a strategic imperative to break them**.
  * In `YHSFLR`, Ahri held North Africa adjacent to Jinx's thin doorway but failed to break Central Africa/South America. Allowing a rival to sit comfortably on 5 continent bonuses without contest guarantees they will out-produce the table and snowball to victory.

* **Choke-Neutral Expansion & Opponent Bonus Disruption**:
  * When holding a secure bottleneck perimeter, evaluate whether an adjacent enemy territory can be taken to **shatter an opponent's lucrative continent bonus without increasing your net doorway exposure**.
  * **The Siberian Disruption Opportunity**: In `YHSFLR`, Delove held a massive Siberian/Russian income bonus. Jinx, sitting in Alaska, had the opportunity to push across the Bering Strait into Kamchatka/Siberia. 
  * By taking that single border territory, Jinx would have:
    1. Instantly broken Delove's +4/+6 Siberia continent bonus.
    2. Earned a card.
    3. **Maintained the exact same 3-doorway bottleneck count** (the doorway simply shifts from Alaska to Kamchatka).
  * **The Choke-Neutral Equation**: Whenever an offensive advance breaks a rival leader's bonus and the resulting defensive perimeter has $\le$ the original number of external chokeholds ($\Delta \text{Chokepoints} \le 0$), **execute the disruption attack immediately**. It starves the leading opponent of armies at zero defensive cost.

### 18. The "Good Neighbor" Fallacy & Active Neighbor Bonus Denial (Never Let a Neighbor Snowball on Your Doorstep)
* **The "Good Neighbor" Bilateral Prerequisite**:
  * The "Good Neighbor" policy—where adjacent continental empires (e.g. South America and North America, or bordering realms on fantasy maps) avoid attacking each other to direct their military expansion outward—is strictly a **bilateral contract**.
  * **The Fallacy**: It only works if **both sides** actively, reliably, and mutually play "good neighbor." Attempting it unilaterally against aggressive bots, neural nets, or ruthless human rivals is a fatal strategic gamble that risks getting backstabbed and ruining your entire game.
  * **The Blunder (e.g., Teemo vs. Delove in Game GJJWQ9)**: Teemo secured his continent bonus and adopted a passive "good neighbor" stance toward adjacent Delove, who also held a continent bonus. Teemo left Delove's bonus completely unmolested. In response, Delove did not play "good neighbor"—Delove collected bonus reinforcements turn after turn, stacked a lethal army directly opposite Teemo's border, and then crashed through to shatter Teemo's bonus. Teemo's unilateral passive indulgence ruined his entire game.

* **The Neighbor Stacking Threat (The Staged Snowball)**:
  * When an adjacent neighbor holds a continent bonus, every single turn they hold it generates surplus reinforcement troops (+2, +3, or +5 armies/turn) deployed directly on your border.
  * If that neighbor is placing draft troops on your shared boundary rather than funneling them elsewhere, their trajectory is mathematically transparent: they are amassing the critical mass to overwhelm your border garrison and conquer your holdings.
  * Passively sitting behind your chokepoint while a neighbor amasses troops on your doorstep is not patience; it is consenting to be overwhelmed.

* **The Break-or-Be-Broken Principle**:
  * You have to recognize that **sometimes it is simply not worth letting a neighbor have a bonus—you have to break it**.
  * Factoring a neighbor bonus break into your turn plan (`target`, `route`, or surgical attack) is overwhelmingly positive expected value:
    1. **Immediate Production Denial**: A single surgical attack into an exposed border territory instantly strips the neighbor of +2, +3, or +5 reinforcement armies on their upcoming turn.
    2. **Halting the Snowball**: By eliminating their bonus income, you prevent them from accumulating the surplus armies needed to assault your chokepoints.
    3. **Taxing Enemy Dice**: Even if the neighbor retakes the territory on their turn, they must spend attacking dice (~1.2 casualties per conquer) and forfeit that round's bonus troops, resetting the border arms race in your favor.
  * **The Rule of Engagement**: If an adjacent neighbor is holding a continent bonus and their border stack is growing, **do not assume peace**. Factor breaking their bonus into your plan for that turn. Break their bonus before they break yours.

### 19. Runaway Leader Asymmetry & The "Punch Through 1s" Net-EV Break (Turtling Is Slow Death Against a Snowballing Leader)
* **The Snowballing Deficit (Why Turtling Guarantees Slow Defeat)**:
  * In Free-For-All Risk without binding diplomacy, when a runaway leader starts dominating the map (e.g., Leona holding Solmara (+5), Odrun (+4), Kethran (+5), Hrimvald (+3) etc., generating +35 to +50+ troops/turn), the mathematical baseline of the game completely changes.
  * For a mid-tier or nearest-neighbor rival (e.g. Darius with 20–25 troops and +3 income), **turtling behind your borders out of fear of thinning your stack is mathematical slow suicide**.
  * If the runaway leader earns +45/turn while you earn +3/turn, every turn of inaction expands the army deficit by 42 troops. After two rounds, the leader has built a massive surplus that sweeps your entire empire effortlessly.
  * Even if a solo attack does not guarantee an immediate path to 1st place, **passively doing nothing guarantees 0% chance to win**. The only viable EV move for the table—and specifically for the nearest neighbor at the doorstep—is aggressively severing the leader's astronomical production lines.

* **The "Punch Through 1s" Net-EV Trade (Dice Math vs. Production Denial)**:
  * Over-expanded runaway leaders frequently leave thin corridors of 1-army territories connecting the frontline to their interior continent bonuses (e.g., a path of three 1-army territories leading directly into a +5 continent like Solmara).
  * **The Dice Cost vs. Value Equation**:
    * Under Balanced Blitz (and standard 3v1 dice math), rolling 3 attacker dice against a 1-army defender has an ~85% win probability and costs only ~0.6–0.8 attacking troops per conquest.
    * Punching through a chain of three 1-army territories costs an attacker approximately **2 to 3 troops total**.
    * A strike stack of 7 armies can comfortably penetrate three 1-army stepping stones and still arrive at the target continent with 4–5 viable armies.
  * **The Return on Investment (ROI)**:
    * Breaking a +5 continent bonus strips 5 reinforcement troops from the leader on their very next turn, and continues denying +5 every subsequent turn until retaken.
    * In addition, the leader is forced to expend more armies and attack dice to reclaim and reconnect the severed region.
    * **Net-Positive EV Calculation**: Spending 2–3 attacking troops to strip 5+ enemy troops *per turn* from the #1 runaway threat is an overwhelmingly positive trade ($\Delta \text{Net Armies} \ge +2$ to $+3$ on turn 1, growing to $+7$ to $+12$ over two turns).
  * **Nearest-Neighbor Strategic Duty**: The closest neighbor holding the doorstep and attack geometry has the clearest duty to deliver the disruption strike. Do not let the fear of leaving a thin border prevent you from shattering the leader's economic engine.

* **Sensei@2's Heuristic (Proactive Disruption Over Turtling)**:
  * In Game `GJJWQ9`, while Darius hesitated with a 7-stack and turtled in fear of thinning his garrison, Sensei@2 recognized the runaway leader threat and drove directly through the thin corridor, breaching Blackscree, Aurum Gate, Sarrach, and Witchmire to shatter Leona's bonuses.
  * Sensei demonstrated the correct strategic heuristic: against a dominant frontrunner, attack through their thin underbelly to break their bonuses, regardless of whether you can permanently hold the conquered ground.

---

### 20. Defensive Elimination & Border Consolidation (Offensive Strikes That Yield Superior Defense)
* **The Elimination Hesitation Blunder**:
  * In Game `GJJWQ9`, Sensei was down to just 5 armies and held 3 cards, directly adjacent to runaway leader Leona, who commanded a massive stack of 30+ troops and held a dominant lead.
  * Rather than swiftly finishing Sensei off, Leona hesitated and diverted attacks elsewhere.
  * This hesitation proved immediately costly: Sensei used those surviving troops to launch a desperate counter-offensive into Wyrmgrave, Hrim Fjord, and Icewake, successfully breaking Leona's Hrimvald (+3) continent bonus before being eliminated a turn later.
  * When an adjacent rival is reduced to a low army count (3–6 troops) and holds cards (3+ cards), **delaying the kill is an unforced error**. Wounded opponents have nothing to lose and will inevitably strike to break your bonuses on their turn.

* **Offense That Improves Defense (Border Geometry Reduction $\Delta \text{Borders} < 0$)**:
  * Eliminating a wounded rival nestled on your perimeter is not just an offensive play for +1 kill point and stolen cards—it is often the **single best defensive move available**.
  * In `GJJWQ9`, Sensei held an awkward salient in the Grimward Wastes that forced Leona to defend along a porous 5-point border.
  * By sweeping through Sensei's remaining 5 troops and occupying Grimward Wastes, Leona's perimeter naturally collapsed into a compact, contiguous 4-point bottleneck!
  * **The Border Reduction Principle**:
    * Whenever an elimination simultaneously:
      1. Costs negligible armies (crushing 5 troops with a 30-stack loses ~1–2 armies).
      2. Steals 3+ cards (refueling your hand for immediate or impending set trades).
      3. Permanently removes a hostile bonus breaker from your doorstep.
      4. **Reduces the total number of external border chokeholds** ($\Delta \text{External Chokepoints} < 0$, e.g., 5 doorways down to 4).
    * It is a double-value imperative: you gain offensive bounty while drastically simplifying and strengthening your defensive posture.

### 21. Progressive Trade Surge Concentration & Multi-Territory Kill Execution (The Cost of Troop Splitting)
* **The Troop Splitting Blunder (Shen in Game 53RVR3)**:
  * In progressive card mode, Shen traded cards for an enormous cash-in of **85 armies**.
  * At turn start, Thresh held several thin territories and 3 cards, with frontline borders directly adjacent to Shen's stacks.
  * Instead of concentrating the 85-army surge into a single, overwhelming spearhead to obliterate Thresh, steal Thresh's 3 cards, and trigger a mid-turn chain-trade, Shen's placement fragmented the 85 armies across **four separate territories** (38 on Oakenford, 20 on Red Mesa, 18 on Mistveil Harbor, 12 on Old Thicket).
  * During the attack phase, Shen pushed through Fernhallow, Stagmere, Brightcrest, Orlenne Keep, and Elmsworth, cutting Thresh down to only **2 territories (Cairnmoor with 1 army, Greystep with 3 armies)**.
  * However, because the armies were scattered across four fronts and because the advance into Fernhallow only moved 3 armies forward (leaving 38 armies stranded on Oakenford), Shen stalled out right at the finish line and passed the turn.
  * On the very next turn, Jinx swept into Cairnmoor and Greystep, easily eliminating Thresh and taking the 3 cards that rightfully belonged to Shen.
* **The Core Rules of Trade Surge Execution**:
  * **Concentrate the Progressive Surge (The 75% Spearhead Rule)**:
    * When receiving a massive reinforcement surge ($\ge 20$ armies from progressive or exponential card trades), **never split the surplus into 3–4 equal fractions**.
    * Allocate at least 70–75% of the surplus directly onto the **primary offensive spearhead**. One colossal stack of 60–80+ armies punches completely through an entire opponent's empire; four 20-stacks run out of momentum and stall after conquering 2 territories each.
  * **Carry the Spearhead to the Dying Victim (Never Leave Troops Behind)**:
    * When an attack chain borders a wounded rival holding cards with $\le 3$ territories, the occupying force must move the **full available ceiling** forward. Leaving 38 armies idling on an interior launch pad while moving only 3 troops into the breakthrough territory starves the frontline of the forces needed to finish the elimination.
  * **Multi-Territory Elimination Ruthlessness**:
    * Do not treat elimination solely as a final-step check ($\text{territories} = 1$). If an opponent with 3+ cards has 2 or 3 territories, every single attack in that chain is an urgent elimination priority. Positive-EV dice gambles (e.g. 2v1 at ~42–50% odds) are overwhelmingly profitable when succeeding steals 3–5 cards and immediately refuels your turn with a trade.

---

## Findings from AI self-play games
<!-- bot-findings:start -->
### Fixed Cards (Continental Attrition & Border Defense)
- **When card trades are fixed, holding unbroken continent bonuses provides the primary reinforcement engine.** Continental bonuses (+2 to +7) make permanent border defense and attrition far more critical than card-hunting. Bot4 held key bonuses with +45/turn and won without card escalation. (4 games, last H7NVFC)
- **Aggressive expansion without securing permanent border garrisons in fixed mode leads to counter-punches.** Darius broke Ahri’s key bonuses, permanently stunting Ahri's fixed income and contributing to their elimination. (2 games, last ZPEAUR)
- **Securing continent bonuses early provides long-term reinforcement benefits.** Shen secured key bonuses by round 3, contributing to their high reinforcement income (+35/turn) and strategic expansion. (8 games, last 8HTXH4)

### Capitals Conquest
- **Holding all capitals provides a massive reinforcement income and makes it nearly impossible for opponents to contest key regions.** Shen held all capitals and had a +24/turn reinforcement income, which was critical to their victory. (8 games, last 9FDQUV)
- **Failing to secure capitals leaves you vulnerable to sudden elimination.** Ahri had 0 capitals and was eliminated by Leona in round 7, despite holding 2 territories and 37 armies. (4 games, last 8HTXH4)
- **Capitals defend with 3 dice and require overwhelming odds.** Jinx’s concentrated garrisons on key territories withstood attacks from multiple opponents, who had 0 capitals and were major threats. (5 games, last DGS35N)
- **Failing to secure capitals leaves you vulnerable to sudden elimination.** Holding raw territories without a secure capital base leaves players exposed once larger rivals mobilize. Bot2 had 0 capitals and was eliminated by Bot9. (4 games, last H7NVFC)
- **High reinforcement income from key bonuses can be offset by poor capital control.** Bot10 had a +114/turn reinforcement income but lost the game because their unprotected territories were overwhelmed by Bot6. (2 games, last CDCU2S)
- **Failing to secure capitals leaves you vulnerable to sudden elimination.** Shaco had 0 capitals and was eliminated in round 14 by Darius, despite inheriting card sets from eliminated players, making them vulnerable to elimination. (3 games, last WP588T)

### Progressive Cards (Escalating Spoils & Chain Eliminations)
- **Time your trades to fund immediate eliminations.** Sitting on complete card sets while opponents trade escalating spoils allows rivals to build overwhelming attack stacks; trade when armies convert directly into a kill or capital. Bot2 timed their card trades effectively to fund their elimination of Bot8, Bot10, Bot1, Bot9, and Bot5. (2 games, last CDCU2S)
- **Failing to engage in card trades can limit strategic advantages.** Delaying card trades too long in progressive lobbies allows opponents to escalate trade values and overwhelm static defenses. Bot4's delayed card trades limited their ability to counter Bot6's expansion. (2 games, last CDCU2S)
- **Eliminations funded the winners.** Lux knocked out Darius (round 4), Shaco (round 6) and Leona (round 38) and survived to 2nd; Ahri swept every capital. The three first players out (Darius, Shaco, Thresh) never made a kill. (1 game, last MVAPM8)
- **Focusing on card acquisition without securing territory is a losing strategy.** Teemo focused on gathering cards but failed to secure any bonuses or capitals, making him an easy target for elimination. (2 games, last UMQD5S)
- **Securing key bonuses early allows for rapid card trade escalation.** Thresh secured 17 bonuses, enabling a high reinforcement income (+87/turn) that funded multiple card trades and eliminations. (1 game, last 7QS4UG)
- **Inheriting cards from eliminated players can accelerate elimination chains.** Ahri inherited cards from Lux and others, which helped fund further eliminations and expansion. (3 games, last 9FDQUV)

### Progressive Cards
- **Elimination chains accelerate endgame conquest.** Inheriting cards from an eliminated player can push the attacker to 5+ cards, triggering a mid-turn trade that finances the next elimination on the same turn. (2 games, last CDCU2S)

### Exponential Cards (Personal Sequences & Surge Timing)
- **Monitor personal trade counts before engaging in card trades.** In exponential games where set values scale independently, timing a high-tier personal set cash-in allows sudden board-clearing strikes that static defenders cannot match. (1 game, last 8VALR5)

### Attack Routing & Troop Staging (Spearheads & Interior Pocket Prevention)
- **Avoiding interior pockets with stranded troops helps prevent resource drain.** Ahri left large garrisons trapped behind friendly lines without hostile borders, wasting armies that should have been reinforcing frontlines. (4 games, last 8HTXH4)
- **Sequential routing preserves offensive momentum.** Teemo ordered attacks along a single chain from weakest resistance outward, preserving attacking stacks and ensuring guaranteed card capture without splitting forces. (1 game, last VX6C5F)
- **End-of-turn fortify pullbacks secure vulnerable borders.** Striking forward with mobile stacks to take territory and then fortifying back onto chokepoints or capitals prevents aggressive counter-attacks. (1 game, last 8ESC69)
- **Maintaining strong connectivity between territories prevents leaving interior pockets vulnerable.** Darius's fragmented territory holdings made defense impossible once Shen launched a concentrated attack, leading to Darius's elimination. (1 game, last D5HXP4)

### Fog of War (Concealed Armies & Income Probing)
- **Scouting with card-taking attacks reveals critical enemy garrison counts.** Jinx used single-territory probes to reveal enemy garrison counts before launching major offensives, allowing them to prepare for the scale of the attack. (3 games, last 8HTXH4)
- **Judging hidden threats by income is a reliable strategy.** Jinx used enemy turn income as a reliable estimate of rival strength to target weaker opponents effectively. (2 games, last 8HTXH4)
- **Maintaining strong reinforcement income is crucial for long-term survival under fog.** Leona maintained a high reinforcement income despite losing several territories, contributing to her survival and elimination of multiple opponents. (3 games, last GURQZ8)
- **Small border garrisons can project false weakness.** Opponents often assume lightly defended fog borders indicate an empty interior; keep mobile strike stacks one step behind the frontline. (1 game, last MVAPM8)

### Non-Fog of War (Public Board & Coalition Counterplay)
- **Troop commitments must match visible budgets.** In non-fog lobbies, proposals exceeding armyCount plus income are rejected, preventing bluffing. (1 game, last 4J2YAV)
- **Multi-way alliances against runaway leaders require all-chat.** Whispering between two players cannot coordinate a 3-way or 4-way response against a dominant player; public coalition calls coordinate joint pressure. (1 game, last X3T6U8)
- **Failing to form coalitions against a dominant player leads to isolation.** Divided rivals who negotiate separate truces while a leader snowballs get rolled up one by one. (7 games, last H7NVFC)
- **Not engaging in deals can be a strategic advantage if it avoids the risk of betrayal.** Darius did not make any deals during the game, allowing them to focus on expansion and defense without the risk of betrayal. (6 games, last H7NVFC)
- **High reinforcement income from key bonuses can offset lack of capital control.** Bot9 secured multiple continental bonuses, out-producing capital holders (+114/turn) and overwhelming them through sheer army count. (3 games, last H7NVFC)
- **Avoiding direct conflict with dominant players until they are significantly weakened can be a strategic advantage.** Bot3 avoided direct conflict with Bot8 for most of the game, only engaging them in the final rounds when it was clear Bot8 was the dominant threat. (2 games, last H7NVFC)
- **Failing to leverage held bonuses can leave players vulnerable to aggressive opponents.** Bot1 held the hrimvald, gloamfen, and mistveil bonuses but failed to use them effectively, contributing to their elimination by Bot6. (2 games, last C6KXT6)

### Eliminations & Leaderboard Climbing
- **Maintaining strong reinforcement income is a decisive advantage.** Tryndamere’s high reinforcement income allowed them to rapidly expand and overwhelm opponents. (6 games, last PP5GYG)
- **Eliminations award permanent Elo points and placement jumps.** Tryndamere’s elimination of multiple opponents contributed significantly to their Elo gain and tournament standing. (7 games, last PP5GYG)
- **Focusing on eliminating weaker opponents early can lead to long-term dominance.** Leona prioritized eliminating Ahri as the primary threat, allowing her to dominate the game and finish in 1st place. (6 games, last GURQZ8)
- **Early bonus control can be critical for survival.** Shen and Tryndamere completed regional bonuses early, providing steady income that built strong territorial bases. (2 games, last 45K9US)
- **Aggressive early attacks can be countered with disciplined defense and reinforcement management.** Bot3 absorbed an early rush by consolidating onto high-defense choke points and counter-attacked once the aggressor depleted their forces. (1 game, last 8ESC69)

### Multi-Party Alliances & Global Coalitions
- **Alliances are risky if not enforced.** Multiple players, including Bot9, made alliance proposals or truce offers, but these were often broken or ignored, leaving players vulnerable to attacks. (3 games, last 6VNSVQ)
- **Alliance talk never became terms.** Players discussed teaming up all game, but no message set a round, a border or a target, so everyone kept attacking at random. (2 games, last CDCU2S)
- **Truces with aggressive players can be risky if not enforced.** Shen made multiple truce proposals with Shaco and Lux, but these were not honored, allowing Shaco to break Shen's bonuses and weaken their position. (2 games, last CDCU2S)
<!-- bot-findings:end -->
