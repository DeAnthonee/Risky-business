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

## Cycle 2

## c2

### Cycle 2, step 1: micro games (1v1, Four Crowns)

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| mb | 1,920 | branch@1 1084, teacher@2 836 | 18.0 | 0 | 318,096 |
| md | 1,920 | r06-candidate 1040, branch@1 880 | 17.5 | 0 | 294,197 |

**3,840 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 322,053 |
| branched (compared options) | 204,085 (63.4%) |
| simulations run | 4,119,234 (106,272,348 simulated moves) |
| changed the teacher's move | 79,602 (39.0% of branched) |
| average score gain per branched decision | +0.0273 |
| changes by kind | attack 36,087/95,571, place 26,103/60,217, end_turn 4,889/8,585, occupy 4,815/21,683, fortify_from 4,510/10,057, trade 3,198/7,972 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.608 / 0.610 / 0.610 / 0.577 / 0.650 |
| chosen branches that had won / lost within the horizon | 20.3% / 5.3% |

### Cycle 2, step 2: scenario games on Classic (2 players)

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| c2d | 1,500 | r06-candidate 679, branch@1 821 | 21.4 | 0 | 386,314 |
| c2t | 1,500 | branch@1 889, teacher@2 611 | 21.6 | 0 | 392,788 |

**3,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 389,796 |
| branched (compared options) | 208,147 (53.4%) |
| simulations run | 3,737,394 (119,874,188 simulated moves) |
| changed the teacher's move | 65,865 (31.6% of branched) |
| average score gain per branched decision | +0.0167 |
| changes by kind | attack 35,048/116,480, place 19,773/63,031, end_turn 4,448/8,634, fortify_from 4,272/12,603, trade 2,324/7,399 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.604 / 0.612 / 0.606 / 0.560 / 0.645 |
| chosen branches that had won / lost within the horizon | 15.6% / 4.2% |

### Cycle 2, step 3: scenario games on Classic (4 players)

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| c4 | 600 | branch@1 378, teacher@2 63, r06-candidate 90, delove@2 65 | 52.6 | 4 | 394,179 |

**600 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 114,817 |
| branched (compared options) | 65,457 (57.0%) |
| simulations run | 1,177,284 (69,677,251 simulated moves) |
| changed the teacher's move | 24,205 (37.0% of branched) |
| average score gain per branched decision | +0.0242 |
| changes by kind | attack 15,926/41,563, place 5,093/15,312, fortify_from 1,613/4,041, trade 941/2,164, end_turn 632/2,377 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.507 / 0.515 / 0.507 / 0.447 / 0.595 |
| chosen branches that had won / lost within the horizon | 15.2% / 1.8% |

### c2: ladder gate (c2-candidate)

| opponent | players | options | games | score | 95% interval | Elo |
| --- | --- | --- | --- | --- | --- | --- |
| delove@2 | 2 | {} | 800 | 0.510 | 0.483-0.537 | +7 |
| delove@2 | 4 | {} | 200 | 0.583 | 0.517-0.648 | +58 |
| delove@2 | 6 | {} | 200 | 0.575 | 0.506-0.644 | +53 |
| delove@2 | 2 | {"map":"skirmish"} | 200 | 0.540 | 0.478-0.602 | +28 |
| delove-teacher@2 | 2 | {} | 200 | 0.515 | 0.452-0.578 | +10 |
| delove@1 | 2 | {} | 200 | 0.570 | 0.499-0.641 | +49 |

### c2: time per phase (minutes from the start)

| phase | minutes |
| --- | --- |
| start | 0.0 |
| generated classic4 | 4.9 |
| exported classic4 | 5.3 |
| generated classic2 | 10.1 |
| generation done | 10.8 |
| exported classic2 | 10.9 |
| generated micro | 10.9 |
| exported micro | 11.1 |
| exports done | 11.1 |
| trained c2-candidate | 17.7 |
| gates done | 18.9 |
| summary | 18.9 |

**Review:** all branch data so far (2x cycle 1). Better at 4-6 players again, even at 2 players: the branch player is only slightly above the student there.

## Cycle 3

## c3

### Cycle 3, step 1: micro games (1v1, Four Crowns)

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| mb | 600 | branch@1 324, teacher@2 276 | 16.7 | 0 | 96,585 |
| md | 600 | c2-candidate 300, branch@1 300 | 16.0 | 0 | 88,050 |

**1,200 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 90,218 |
| branched (compared options) | 49,783 (55.2%) |
| simulations run | 893,040 (9,268,624 simulated moves) |
| changed the teacher's move | 16,293 (32.7% of branched) |
| average score gain per branched decision | +0.0159 |
| changes by kind | attack 8,159/25,913, place 4,928/16,389, end_turn 1,406/2,663, fortify_from 1,222/2,912, trade 578/1,906 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.574 / 0.580 / 0.583 / 0.542 / 0.629 |
| chosen branches that had won / lost within the horizon | 9.0% / 1.7% |

### Cycle 3, step 2: scenario games on Classic (2 players)

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| c2c | 2,000 | c2-candidate 934, branch@1 1066 | 19.9 | 0 | 479,597 |
| c2d | 2,000 | branch@1 1090, delove@2 910 | 20.6 | 0 | 492,864 |
| c2t | 2,000 | branch@1 1149, teacher@2 851 | 20.7 | 0 | 505,994 |

**6,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 757,268 |
| branched (compared options) | 395,729 (52.3%) |
| simulations run | 7,099,734 (89,623,920 simulated moves) |
| changed the teacher's move | 111,930 (28.3% of branched) |
| average score gain per branched decision | +0.0111 |
| changes by kind | attack 58,195/221,119, place 29,088/114,748, end_turn 10,122/18,601, fortify_from 9,170/26,503, trade 5,355/14,758 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.587 / 0.599 / 0.595 / 0.549 / 0.636 |
| chosen branches that had won / lost within the horizon | 7.8% / 1.2% |

### Cycle 3, step 3: scenario games on Classic (4 players)

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| c4 | 600 | branch@1 283, teacher@2 81, c2-candidate 142, delove@2 85 | 60.0 | 9 | 430,909 |

**600 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 122,364 |
| branched (compared options) | 71,238 (58.2%) |
| simulations run | 1,280,946 (29,846,252 simulated moves) |
| changed the teacher's move | 21,631 (30.4% of branched) |
| average score gain per branched decision | +0.0127 |
| changes by kind | attack 13,992/42,343, place 4,475/18,021, fortify_from 1,699/4,899, end_turn 820/3,732, trade 645/2,243 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.420 / 0.446 / 0.437 / 0.390 / 0.527 |
| chosen branches that had won / lost within the horizon | 5.5% / 0.7% |

### c3: ladder gate (c3-candidate)

| opponent | players | options | games | score | 95% interval | Elo |
| --- | --- | --- | --- | --- | --- | --- |
| delove@2 | 2 | {} | 800 | 0.525 | 0.498-0.552 | +17 |
| delove@2 | 4 | {} | 200 | 0.560 | 0.491-0.629 | +42 |
| delove@2 | 6 | {} | 200 | 0.580 | 0.513-0.647 | +56 |
| delove@2 | 2 | {"map":"skirmish"} | 200 | 0.535 | 0.465-0.605 | +24 |
| c2-candidate | 2 | {} | 400 | 0.490 | 0.455-0.525 | -7 |
| delove-teacher@2 | 2 | {} | 200 | 0.575 | 0.514-0.636 | +53 |

### c3: time per phase (minutes from the start)

| phase | minutes |
| --- | --- |
| start | 0.0 |
| generated classic4 | 6.4 |
| exported classic4 | 6.8 |
| generated micro | 8.9 |
| exported micro | 9.0 |
| generation done | 9.0 |
| generated classic2 | 9.0 |
| exported classic2 | 9.5 |
| exports done | 9.5 |
| trained c3-candidate | 16.0 |
| gates done | 17.2 |
| summary | 17.2 |

**Before this cycle, 2,000-game branch tests against delove@2:** horizon 2 0.561, horizon 1 0.5675 at half the time, horizon 3 0.529, value-head blend 0.3: 0.5615 (0.5: 0.544, and 60% slower), margin 0.01: 0.567. Cycle 3 used horizon 1 and margin 0.01 for 4x the 2-player volume.

**Review:** 2-player crept up (0.510 to 0.525). The student matched the branch player only 62-71% of the time: a capacity limit.

## Cycle 4

## c4

### Cycle 4, step 1: micro games (1v1, Four Crowns)

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| mb | 600 | branch@1 345, teacher@2 255 | 17.2 | 0 | 99,598 |
| md | 600 | c3-candidate 318, branch@1 282 | 15.9 | 0 | 89,139 |

**1,200 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 93,097 |
| branched (compared options) | 51,601 (55.4%) |
| simulations run | 925,476 (9,800,884 simulated moves) |
| changed the teacher's move | 16,829 (32.6% of branched) |
| average score gain per branched decision | +0.0163 |
| changes by kind | attack 8,460/26,995, place 5,210/17,016, end_turn 1,480/2,778, fortify_from 1,144/2,888, trade 535/1,924 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.578 / 0.584 / 0.587 / 0.542 / 0.635 |
| chosen branches that had won / lost within the horizon | 9.0% / 1.5% |

### Cycle 4, step 2: scenario games on Classic (2 players)

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| c2c | 2,000 | c3-candidate 943, branch@1 1057 | 19.6 | 0 | 475,085 |
| c2d | 2,000 | branch@1 1113, delove@2 887 | 20.2 | 0 | 485,108 |
| c2t | 2,000 | branch@1 1145, teacher@2 855 | 20.5 | 0 | 502,675 |

**6,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 730,359 |
| branched (compared options) | 380,170 (52.1%) |
| simulations run | 6,817,428 (85,489,995 simulated moves) |
| changed the teacher's move | 109,038 (28.7% of branched) |
| average score gain per branched decision | +0.0115 |
| changes by kind | attack 55,842/211,633, place 27,848/109,460, end_turn 10,546/18,573, fortify_from 9,835/26,450, trade 4,967/14,054 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.585 / 0.600 / 0.595 / 0.548 / 0.636 |
| chosen branches that had won / lost within the horizon | 7.6% / 1.1% |

### Cycle 4, step 3: scenario games on Classic (4 players)

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| c4 | 600 | branch@1 275, teacher@2 93, c3-candidate 121, delove@2 95 | 65.4 | 16 | 438,389 |

**600 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 126,847 |
| branched (compared options) | 74,369 (58.6%) |
| simulations run | 1,337,160 (31,153,116 simulated moves) |
| changed the teacher's move | 22,989 (30.9% of branched) |
| average score gain per branched decision | +0.0136 |
| changes by kind | attack 14,486/43,387, place 4,580/18,438, fortify_from 1,926/5,245, trade 1,207/2,822, end_turn 790/4,477 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.413 / 0.440 / 0.431 / 0.397 / 0.521 |
| chosen branches that had won / lost within the horizon | 5.2% / 0.7% |

### c4: ladder gate (c4-candidate)

| opponent | players | options | games | score | 95% interval | Elo |
| --- | --- | --- | --- | --- | --- | --- |
| delove@2 | 2 | {} | 800 | 0.541 | 0.513-0.569 | +29 |
| delove@2 | 4 | {} | 200 | 0.600 | 0.534-0.666 | +70 |
| delove@2 | 6 | {} | 200 | 0.610 | 0.541-0.679 | +78 |
| delove@2 | 2 | {"map":"skirmish"} | 200 | 0.542 | 0.475-0.610 | +30 |
| c3-candidate | 2 | {} | 400 | 0.527 | 0.488-0.567 | +19 |
| delove-teacher@2 | 2 | {} | 200 | 0.560 | 0.502-0.618 | +42 |

### c4: time per phase (minutes from the start)

| phase | minutes |
| --- | --- |
| start | 0.0 |
| generated classic2 | 8.8 |
| generated micro | 8.9 |
| exported micro | 8.9 |
| exported classic2 | 9.3 |
| generation done | 10.1 |
| generated classic4 | 10.1 |
| exported classic4 | 10.2 |
| exports done | 10.2 |
| trained c4-candidate | 42.7 |
| gates done | 44.6 |
| summary | 44.6 |

**Review:** a fresh, larger network (hidden 192, 6 rounds; 2 epochs on every branch decision so far) is the first candidate statistically better than delove@2 at 2 players (0.541, 95% interval 0.513-0.569), and +70/+78 Elo at 4/6 players. It misses the 0.55 promotion bar at 2 players by 0.009.

**Promoted to delove@3** (owner's decision, 2026-10-19): statistically better than delove@2 at 2 players (0.541, 95% 0.513-0.569) and at 4 and 6 players, just under the automatic 0.55 bar at 2 players.

## Cycle 5

## c5

### Cycle 5, step 4: big tables on seven maps (2-10 players)

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| as4 | 1,000 | delove@3 219, branch@1 509, teacher@2 112, delove@2 147 | 71.5 | 13 | 1,078,011 |
| as8a | 1,000 | branch@1 393, teacher@2 81, delove@3 84, teacher@2 76, delove@2 70, teacher@2 71, delove@3 104, teacher@2 64 | 100.0 | 57 | 1,292,409 |
| as8b | 1,000 | teacher@2 83, delove@3 109, delove@2 59, teacher@2 64, branch@1 392, teacher@2 54, delove@3 98, teacher@2 76 | 102.8 | 65 | 1,310,072 |
| c6 | 1,000 | branch@1 460, teacher@2 85, delove@3 117, delove@2 110, delove@3 124, teacher@2 95 | 62.7 | 9 | 806,842 |
| eu6 | 1,000 | delove@3 98, teacher@2 99, branch@1 481, delove@2 87, teacher@2 100, delove@3 124 | 64.4 | 11 | 893,096 |
| eu8a | 1,000 | branch@1 398, teacher@2 58, delove@3 108, teacher@2 83, delove@2 53, teacher@2 82, delove@3 93, teacher@2 80 | 83.0 | 45 | 1,053,483 |
| eu8b | 1,000 | teacher@2 74, delove@3 103, teacher@2 66, delove@2 58, branch@1 408, teacher@2 74, delove@3 97, teacher@2 68 | 86.6 | 52 | 1,100,820 |
| fa4 | 800 | delove@2 100, teacher@2 47, branch@1 389, delove@3 145 | 155.4 | 119 | 2,429,241 |
| fa6n | 800 | branch@1 341, delove@3 92, teacher@2 30, delove@2 56, delove@3 75, teacher@2 35 | 191.5 | 171 | 2,804,368 |
| ge2c | 500 | delove@3 227, branch@1 273 | 32.8 | 0 | 331,875 |
| ge2d | 500 | branch@1 319, delove@2 181 | 32.7 | 0 | 326,926 |
| ge2t | 500 | branch@1 339, teacher@2 161 | 35.0 | 0 | 351,135 |
| us10a | 1,000 | branch@1 327, teacher@2 79, delove@3 88, teacher@2 66, delove@2 59, teacher@2 77, delove@3 68, teacher@2 72, delove@2 54, teacher@2 62 | 88.0 | 48 | 1,084,062 |
| us10b | 1,000 | teacher@2 62, delove@3 79, teacher@2 77, delove@2 54, teacher@2 76, branch@1 355, teacher@2 63, delove@3 73, teacher@2 62, delove@2 51 | 88.3 | 48 | 1,087,496 |
| us6 | 1,000 | delove@2 92, teacher@2 109, delove@3 110, branch@1 426, teacher@2 118, delove@3 132 | 68.3 | 13 | 938,254 |
| w6n | 1,000 | delove@3 124, teacher@2 49, delove@2 85, branch@1 465, delove@3 120, teacher@2 55 | 140.7 | 102 | 2,399,921 |
| w8n | 1,500 | branch@1 612, delove@3 158, teacher@2 81, delove@2 116, delove@3 125, teacher@2 80, delove@2 97, teacher@2 72 | 149.5 | 159 | 3,648,054 |

**15,600 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 4,801,884 |
| branched (compared options) | 2,705,281 (56.3%) |
| simulations run | 48,649,062 (1,677,720,416 simulated moves) |
| changed the teacher's move | 809,437 (29.9% of branched) |
| average score gain per branched decision | +0.0125 |
| changes by kind | attack 557,981/1,823,693, place 129,299/525,755, fortify_from 74,553/202,407, trade 24,756/75,008, end_turn 22,848/78,418 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.375 / 0.451 / 0.428 / 0.325 / 0.521 |
| chosen branches that had won / lost within the horizon | 4.5% / 0.4% |

### Cycle 5, step 2: scenario games on Classic (2 players)

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| c2c | 4,000 | delove@3 1910, branch@1 2090 | 19.1 | 0 | 930,161 |
| c2d | 4,000 | branch@1 2238, delove@2 1762 | 20.0 | 0 | 965,555 |
| c2t | 4,000 | branch@1 2361, teacher@2 1638 | 20.4 | 1 | 998,116 |

**12,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 1,487,742 |
| branched (compared options) | 771,097 (51.8%) |
| simulations run | 13,825,044 (172,156,856 simulated moves) |
| changed the teacher's move | 222,654 (28.9% of branched) |
| average score gain per branched decision | +0.0117 |
| changes by kind | attack 114,430/431,588, place 55,940/219,611, end_turn 20,943/37,102, fortify_from 20,941/54,593, trade 10,400/28,203 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.591 / 0.605 / 0.600 / 0.551 / 0.643 |
| chosen branches that had won / lost within the horizon | 7.8% / 1.1% |

### Cycle 5, step 1: micro games (1v1, Four Crowns)

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| m2 | 3,000 | branch@1 1583, delove@2 1417 | 16.9 | 0 | 480,515 |
| mb | 3,000 | branch@1 1734, teacher@2 1266 | 17.0 | 0 | 486,928 |
| md | 3,000 | delove@3 1672, branch@1 1328 | 16.0 | 0 | 451,484 |

**9,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 717,115 |
| branched (compared options) | 397,557 (55.4%) |
| simulations run | 7,129,206 (74,663,834 simulated moves) |
| changed the teacher's move | 130,567 (32.8% of branched) |
| average score gain per branched decision | +0.0165 |
| changes by kind | attack 65,742/207,780, place 39,353/129,919, end_turn 11,287/21,403, fortify_from 9,888/23,419, trade 4,297/15,036 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.578 / 0.585 / 0.587 / 0.543 / 0.639 |
| chosen branches that had won / lost within the horizon | 8.9% / 1.4% |

### Cycle 5, step 3: scenario games on Classic (4 players)

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| c4a | 750 | branch@1 354, teacher@2 128, delove@3 148, delove@2 104 | 62.9 | 16 | 554,855 |
| c4b | 750 | delove@3 161, branch@1 351, delove@2 122, teacher@2 103 | 60.6 | 13 | 542,192 |
| c4c | 750 | delove@2 104, teacher@2 114, branch@1 368, delove@3 152 | 60.6 | 12 | 534,009 |
| c4d | 750 | teacher@2 121, delove@3 163, delove@2 98, branch@1 352 | 63.2 | 16 | 553,165 |

**3,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 625,773 |
| branched (compared options) | 363,974 (58.2%) |
| simulations run | 6,543,276 (152,921,692 simulated moves) |
| changed the teacher's move | 114,788 (31.5% of branched) |
| average score gain per branched decision | +0.0137 |
| changes by kind | attack 72,451/216,368, place 23,223/88,869, fortify_from 9,604/25,498, trade 5,296/13,250, end_turn 4,214/19,989 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.417 / 0.445 / 0.436 / 0.386 / 0.523 |
| chosen branches that had won / lost within the horizon | 5.4% / 0.7% |

### c5: ladder gate (c5-candidate)

| opponent | players | options | games | score | 95% interval | Elo | points | opp. points | points diff (95%) | place | kills | turn limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| delove@3 | 2 | {} | 800 | 0.502 | 0.475-0.530 | +2 | +0.51 | +0.49 | +0.01 (-0.14 to +0.17) | 1.50 | 0.50 | 0 |
| delove@3 | 4 | {} | 200 | 0.480 | 0.422-0.538 | -14 | +0.32 | +0.30 | +0.02 (-0.37 to +0.41) | 2.43 | 0.60 | 32 |
| delove@3 | 6 | {} | 200 | 0.515 | 0.450-0.580 | +10 | +0.78 | +0.81 | -0.03 (-0.46 to +0.40) | 3.52 | 0.86 | 2 |
| delove@3 | 10 | {"map":"world"} | 200 | 0.507 | 0.439-0.576 | +5 | +0.41 | +0.98 | -0.57 (-1.01 to -0.13) | 5.67 | 0.84 | 7 |
| delove@3 | 2 | {"map":"skirmish"} | 400 | 0.495 | 0.452-0.538 | -3 | +0.47 | +0.50 | -0.03 (-0.29 to +0.23) | 1.50 | 0.49 | 4 |
| delove@3 | 6 | {"map":"world"} | 200 | 0.472 | 0.404-0.541 | -19 | +0.27 | +0.82 | -0.55 (-1.01 to -0.08) | 3.66 | 0.70 | 15 |
| delove@3 | 10 | {"map":"greater_europe"} | 200 | 0.482 | 0.440-0.525 | -12 | -3.59 | -3.40 | -0.20 (-0.40 to +0.00) | 5.71 | 0.32 | 149 |
| delove-teacher@2 | 2 | {} | 400 | 0.574 | 0.534-0.614 | +52 | +0.72 | +0.28 | +0.44 (+0.19 to +0.69) | 1.43 | 0.57 | 1 |
| delove@2 | 2 | {} | 400 | 0.547 | 0.506-0.589 | +33 | +0.64 | +0.35 | +0.28 (+0.09 to +0.48) | 1.45 | 0.55 | 2 |

### c5: time per phase

Generation ran the GPU (big tables, then Classic 2-player) and the CPU pool (Four Crowns, Classic 4-player, 21
processes) at the same time.

| phase | where | minutes |
| --- | --- | --- |
| Four Crowns micro, 9,000 games, played and exported | CPU, 21 processes | 24.5 |
| Classic 4-player, 3,000 games | CPU, 21 processes | 33.5 |
| big tables, 15,600 games (17 tables, six maps plus Classic 6p) | GPU, 1,000-2,048 games in flight | 172 |
| Classic 2-player, 12,000 games | GPU | 7.1 |
| **generation, all 37,600 games** | GPU and CPU together | **179** |
| training, 1st try (batch 1024: 1.5 GB spilled out of the 8 GB card, about 0.65 s a step, aborted) | GPU | 8 |
| training (batch 512, 54,781 steps, 2 epochs over 14.75M decisions) | GPU | 76 |
| gates (150 chunks of up to 20 games) | CPU, 21 processes | 32 |

Big tables per map (GPU, games to training arrays): Europe 8p 2,000 games in 8.6 min, Europe 6p 1,000 in 8.4, USA 10p
2,000 in 6.1, USA 6p 1,000 in 4.4, Asia 8p 2,000 in 5.3, Asia 4p 1,000 in 8.3, World 8p 1,500 in 20.4, World 6p 1,000
in 23.0, Fantasy 6p 800 in 30.1, Fantasy 4p 800 in 30.3, Greater Europe 2p 1,500 in 7.0, Classic 6p 1,000. The slow
maps are the stalling ones: their 500-turn games step alone at the end.

**Pilots** (`runs/delove/c5-pilot*`, branch player + `delove@3` + `delove@2` + Sensei 2 in the other seats, 128-256
games each) decided the big tables: turn-limit games Europe 8p 7%, USA 10p 13%, Asia 8p 16%, World 8p 30%, Fantasy
6p 41%, **Greater Europe 10p 92% and 4p 59%**. Greater Europe therefore played 2-player tables only, and World and
Fantasy smaller tables with more network seats; the cycle's big tables ended at 5.8% turn-limit games (Fantasy 15-21%,
World 10%, the rest 1-6%).

**Review.** Not promoted: even with `delove@3` at 2 players (0.502 over 800 games), at 4-6 players and on Four
Crowns, and **worse on World points** (-0.57 per seat at 10p, -0.55 at 6p, both intervals below 0). It still beats
Sensei 2 (0.574) and `delove@2` (0.547).

The teacher was not the problem: the branch player won about 3x its share of the big tables (`delove@3` about 0.75x)
and 0.52 / 0.59 against `delove@3` / Sensei 2 at 2 players. The labels were: on the big tables only 809k of the
branch player's 4.8M decisions (17%) changed Sensei 2's move; the other 83% are Sensei 2's own move (not compared, or
compared and kept). In multiplayer Sensei 2 is weaker than `delove@3` (Jacob Sensei, which beats Sensei 2 0.64-0.83,
beats `delove@3` 0.58-0.82 at 4-10 players), so most of cycle 5 taught the network to play more like a weaker player.
Its search won live; the network only got the labels.

Also seen: networks stall too on Greater Europe 10p (149 of 200 gate games hit the limit) and on Classic 4p (32 of
200). The points value target itself changed little (validation value loss 0.42 on points).

What cycle 6 changes: Jacob Sensei as the teacher (its moves are the default labels and it plays the rollouts; it
never stalls, so Greater Europe and 10-seat tables come back); every GPU decision records what the search did
(`branch_tag.npy`: teacher's move without comparing / compared and kept / changed), and training weights the policy
0.5 / 1 / 2 by it; cycle 5's big tables teach only the value head (`:value`); training runs in mixed precision
(`--amp`: the same validation loss, 1.9x faster) with older cycles as fractions (`#F`).
