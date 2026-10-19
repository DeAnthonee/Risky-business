# Delove training cycles

### Cycle 1, step 1: micro games (1v1, Four Crowns)

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| mb | 1,000 | branch@1 553, teacher@2 447 | 18.2 | 0 | 167,068 |
| mbr | 1,000 | teacher@2 482, branch@1 518 | 18.2 | 0 | 167,299 |
| md | 1,000 | branch@1 480, delove@2 520 | 17.6 | 0 | 158,504 |

**3,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 245,839 |
| branched (compared options) | 175,499 (71.4%) |
| simulations run | 3,872,082 (100,074,630 simulated moves) |
| changed the teacher's move | 68,749 (39.2% of branched) |
| average score gain per branched decision | +0.0273 |
| changes by kind | attack 28,758/72,785, place 22,596/48,509, occupy 7,436/33,632, fortify_from 3,667/8,159, end_turn 3,413/5,776, trade 2,879/6,638 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.626 / 0.628 / 0.627 / 0.590 / 0.672 |
| chosen branches that had won / lost within the horizon | 22.5% / 5.0% |

### Cycle 1, steps 2-3: scenario games on Classic (2 and 4 players)

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| c2d | 800 | delove@2 374, branch@1 426 | 21.3 | 0 | 198,218 |
| c2t | 800 | branch@1 439, teacher@2 361 | 21.8 | 0 | 206,769 |
| c4 | 600 | branch@1 421, teacher@2 72, delove@2 88, risky@1 19 | 51.7 | 0 | 407,970 |

**2,200 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 328,987 |
| branched (compared options) | 247,077 (75.1%) |
| simulations run | 5,369,484 (236,145,048 simulated moves) |
| changed the teacher's move | 86,516 (35.0% of branched) |
| average score gain per branched decision | +0.0207 |
| changes by kind | attack 41,043/108,190, place 19,848/48,073, occupy 15,219/66,716, fortify_from 4,445/11,111, trade 3,284/7,439, end_turn 2,677/5,548 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.601 / 0.610 / 0.602 / 0.531 / 0.669 |
| chosen branches that had won / lost within the horizon | 19.4% / 2.9% |

### Cycle 1, step 4: training
From delove@2, 1.5 epochs on the branch player's decisions (Four Crowns 260k x2, Classic 2p 215k x3, Classic 4p 130k x3)
plus Sensei 2's 2-player games (2.75M) as an anchor. Held-out agreement with the branch player's choices: 62% (micro),
65% (Classic 2p), 57% (Classic 4p); with Sensei 2: 78%.

### Cycle 1, step 5: ladder gate (r06-candidate)
| opponent | table | games | score |
| --- | --- | --- | --- |
| delove@2 | Classic 2p | 800 | 0.524 (not significant) |
| delove@2 | Classic 4p | 200 | 0.565 (+45 Elo) |
| delove@2 | Classic 6p | 200 | 0.595 (+67 Elo) |
| delove@2 | Four Crowns 2p | 200 | 0.59 (+63 Elo) |
| delove-teacher@2 | Classic 2p | 200 | 0.56 (+42 Elo) |
| delove@1 | Classic 2p | 200 | 0.655 (+111 Elo) |

Not promoted: the 2-player gate (0.55 over the combined 800 games) was missed. Better with more players and on the
small map, even head to head. Cycle 2 builds on it (no worse anywhere) and is gated against delove@2.
