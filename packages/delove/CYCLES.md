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

## Cycle 6

## c6

### Cycle 6, step 4: big tables on every map (2-10 players, Jacob Sensei)

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| as8a | 500 | branch@1 222, jacob-sensei@1 63, delove@3 19, jacob-sensei@1 56, delove@2 16, jacob-sensei@1 58, delove@3 13, jacob-sensei@1 53 | 48.1 | 0 | 310,200 |
| as8b | 500 | branch@1 195, jacob-sensei@1 61, delove@3 23, jacob-sensei@1 54, delove@2 21, jacob-sensei@1 59, delove@3 28, jacob-sensei@1 59 | 55.5 | 0 | 362,576 |
| c6a | 500 | jacob-sensei@1 58, delove@3 19, jacob-sensei@1 71, delove@2 14, branch@1 264, jacob-sensei@1 74 | 36.3 | 0 | 210,800 |
| c6b | 500 | jacob-sensei@1 81, delove@3 38, jacob-sensei@1 82, delove@2 19, branch@1 205, jacob-sensei@1 75 | 50.0 | 0 | 313,817 |
| ec6a | 500 | jacob-sensei@1 47, branch@1 265, delove@3 51, jacob-sensei@1 45, delove@2 36, jacob-sensei@1 56 | 110.2 | 0 | 777,089 |
| ec6b | 500 | jacob-sensei@1 56, branch@1 244, delove@3 32, jacob-sensei@1 71, delove@2 21, jacob-sensei@1 76 | 117.1 | 0 | 820,687 |
| eu8a | 500 | jacob-sensei@1 57, delove@3 19, jacob-sensei@1 49, branch@1 240, jacob-sensei@1 61, delove@2 13, jacob-sensei@1 47, delove@3 14 | 40.9 | 0 | 257,401 |
| eu8b | 500 | jacob-sensei@1 50, delove@3 22, jacob-sensei@1 74, branch@1 182, jacob-sensei@1 66, delove@2 22, jacob-sensei@1 56, delove@3 28 | 49.1 | 0 | 304,301 |
| fa10a | 500 | jacob-sensei@1 45, delove@3 10, jacob-sensei@1 41, jacob-sensei@1 40, branch@1 209, jacob-sensei@1 55, delove@2 4, jacob-sensei@1 55, jacob-sensei@1 31, delove@3 10 | 74.2 | 0 | 634,185 |
| fa10b | 500 | jacob-sensei@1 40, delove@3 17, jacob-sensei@1 56, jacob-sensei@1 56, branch@1 157, jacob-sensei@1 42, delove@2 10, jacob-sensei@1 59, jacob-sensei@1 48, delove@3 15 | 79.9 | 0 | 663,508 |
| fa6a | 500 | branch@1 259, jacob-sensei@1 49, delove@3 34, jacob-sensei@1 53, delove@2 39, jacob-sensei@1 66 | 112.2 | 0 | 806,573 |
| fa6b | 500 | branch@1 217, jacob-sensei@1 77, delove@3 28, jacob-sensei@1 69, delove@2 33, jacob-sensei@1 76 | 118.9 | 0 | 830,232 |
| ge10a | 500 | branch@1 160, jacob-sensei@1 54, delove@3 1, jacob-sensei@1 47, jacob-sensei@1 67, delove@2 3, jacob-sensei@1 62, delove@3 7, jacob-sensei@1 51, jacob-sensei@1 48 | 209.2 | 0 | 1,464,449 |
| ge10b | 500 | branch@1 233, jacob-sensei@1 41, delove@3 7, jacob-sensei@1 35, jacob-sensei@1 37, delove@2 8, jacob-sensei@1 55, delove@3 8, jacob-sensei@1 40, jacob-sensei@1 36 | 103.3 | 0 | 1,088,776 |
| ge2 | 500 | branch@1 348, jacob-sensei@1 152 | 33.1 | 0 | 267,926 |
| ge6a | 500 | delove@3 28, jacob-sensei@1 59, jacob-sensei@1 77, branch@1 267, delove@2 11, jacob-sensei@1 58 | 110.9 | 0 | 1,419,687 |
| ge6b | 500 | delove@3 48, jacob-sensei@1 36, jacob-sensei@1 45, branch@1 271, delove@2 57, jacob-sensei@1 43 | 156.0 | 0 | 1,210,575 |
| us10a | 500 | jacob-sensei@1 29, jacob-sensei@1 27, delove@3 26, jacob-sensei@1 34, delove@2 12, jacob-sensei@1 30, branch@1 238, jacob-sensei@1 37, delove@3 31, jacob-sensei@1 36 | 70.4 | 0 | 462,723 |
| us10b | 500 | jacob-sensei@1 42, jacob-sensei@1 54, delove@3 14, jacob-sensei@1 50, delove@2 9, jacob-sensei@1 62, branch@1 157, jacob-sensei@1 48, delove@3 18, jacob-sensei@1 46 | 62.2 | 0 | 324,984 |
| w10a | 750 | branch@1 234, jacob-sensei@1 69, delove@3 15, jacob-sensei@1 70, jacob-sensei@1 77, delove@2 12, jacob-sensei@1 89, delove@3 17, jacob-sensei@1 84, jacob-sensei@1 83 | 75.9 | 0 | 877,866 |
| w10b | 750 | branch@1 365, jacob-sensei@1 45, delove@3 34, jacob-sensei@1 56, jacob-sensei@1 36, delove@2 31, jacob-sensei@1 50, delove@3 36, jacob-sensei@1 48, jacob-sensei@1 49 | 117.9 | 0 | 1,193,883 |
| w6a | 500 | jacob-sensei@1 71, delove@3 32, branch@1 235, jacob-sensei@1 69, delove@2 32, jacob-sensei@1 60 | 97.9 | 1 | 623,467 |
| w6b | 500 | jacob-sensei@1 58, delove@3 17, branch@1 298, jacob-sensei@1 60, delove@2 16, jacob-sensei@1 51 | 57.9 | 0 | 449,923 |
| wl10a | 500 | jacob-sensei@1 58, jacob-sensei@1 39, delove@3 12, jacob-sensei@1 42, branch@1 181, jacob-sensei@1 46, delove@2 14, jacob-sensei@1 43, delove@3 13, jacob-sensei@1 52 | 98.8 | 0 | 973,851 |
| wl10b | 500 | jacob-sensei@1 50, jacob-sensei@1 36, delove@3 18, jacob-sensei@1 42, branch@1 185, jacob-sensei@1 37, delove@2 24, jacob-sensei@1 49, delove@3 19, jacob-sensei@1 40 | 162.3 | 0 | 1,124,274 |

**13,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 3,117,569 |
| branched (compared options) | 1,864,583 (59.8%) |
| simulations run | 33,536,610 (1,854,313,986 simulated moves) |
| changed the teacher's move | 497,858 (26.7% of branched) |
| average score gain per branched decision | +0.0108 |
| changes by kind | attack 354,161/1,309,198, place 91,510/368,438, fortify_from 26,919/84,940, trade 13,012/44,916, end_turn 12,256/57,091 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.349 / 0.384 / 0.361 / 0.284 / 0.457 |
| chosen branches that had won / lost within the horizon | 5.9% / 1.0% |

### Cycle 6, step 3: scenario games on Classic (4 players)

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| c4a | 750 | branch@1 415, jacob-sensei@1 116, delove@3 87, jacob-sensei@1 132 | 48.5 | 0 | 473,175 |
| c4b | 750 | jacob-sensei@1 130, branch@1 501, delove@3 72, delove@2 47 | 31.6 | 0 | 251,444 |
| c4c | 750 | delove@3 66, jacob-sensei@1 127, branch@1 409, jacob-sensei@1 148 | 49.2 | 0 | 380,424 |
| c4d | 750 | jacob-sensei@1 124, delove@2 32, jacob-sensei@1 131, branch@1 463 | 25.7 | 0 | 221,883 |

**3,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 381,112 |
| branched (compared options) | 240,574 (63.1%) |
| simulations run | 4,325,916 (113,512,291 simulated moves) |
| changed the teacher's move | 71,261 (29.6% of branched) |
| average score gain per branched decision | +0.0142 |
| changes by kind | attack 46,037/150,925, place 16,447/60,123, fortify_from 4,321/13,678, end_turn 2,476/8,367, trade 1,980/7,481 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.408 / 0.434 / 0.420 / 0.356 / 0.508 |
| chosen branches that had won / lost within the horizon | 7.7% / 1.1% |

### Cycle 6, step 2: scenario games on Classic (2 players)

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| c2d3a | 2,000 | delove@3 578, branch@1 1420 | 24.8 | 2 | 428,976 |
| c2d3b | 2,000 | delove@3 172, branch@1 1828 | 2.6 | 0 | 43,850 |
| c2ja | 2,000 | branch@1 1354, jacob-sensei@1 646 | 20.7 | 0 | 455,541 |
| c2jb | 2,000 | branch@1 1411, jacob-sensei@1 589 | 4.6 | 0 | 101,977 |

**8,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 553,607 |
| branched (compared options) | 362,848 (65.5%) |
| simulations run | 6,516,654 (84,016,145 simulated moves) |
| changed the teacher's move | 98,944 (27.3% of branched) |
| average score gain per branched decision | +0.0148 |
| changes by kind | attack 54,029/205,171, place 23,716/106,148, fortify_from 11,701/31,768, end_turn 5,834/8,174, trade 3,664/11,587 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.575 / 0.620 / 0.611 / 0.559 / 0.658 |
| chosen branches that had won / lost within the horizon | 10.6% / 1.4% |

### Cycle 6, step 1: micro games (1v1, Four Crowns)

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| mbja | 1,500 | branch@1 986, jacob-sensei@1 514 | 16.3 | 0 | 204,711 |
| mbjb | 1,500 | branch@1 1142, jacob-sensei@1 358 | 4.0 | 0 | 52,539 |
| md3a | 1,500 | delove@3 580, branch@1 916 | 18.6 | 4 | 187,017 |
| md3b | 1,500 | delove@3 243, branch@1 1256 | 3.5 | 1 | 35,123 |

**6,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 253,508 |
| branched (compared options) | 174,449 (68.8%) |
| simulations run | 3,130,740 (33,688,566 simulated moves) |
| changed the teacher's move | 51,790 (29.7% of branched) |
| average score gain per branched decision | +0.0216 |
| changes by kind | attack 26,834/87,942, place 14,604/61,158, fortify_from 4,815/13,400, end_turn 3,627/6,052, trade 1,910/5,897 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.583 / 0.610 / 0.613 / 0.566 / 0.666 |
| chosen branches that had won / lost within the horizon | 14.5% / 2.8% |

### c6: ladder gate (c6-candidate)

| opponent | players | options | games | score | 95% interval | Elo | points | opp. points | points diff (95%) | place | kills | turn limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| delove@3 | 2 | {} | 800 | 0.532 | 0.503-0.562 | +23 | +0.60 | +0.40 | +0.20 (+0.01 to +0.38) | 1.47 | 0.53 | 0 |
| delove@3 | 4 | {} | 200 | 0.495 | 0.427-0.563 | -3 | +0.35 | +0.32 | +0.04 (-0.37 to +0.44) | 2.48 | 0.64 | 30 |
| delove@3 | 6 | {} | 200 | 0.522 | 0.451-0.594 | +16 | +0.82 | +0.74 | +0.08 (-0.34 to +0.51) | 3.50 | 0.87 | 3 |
| delove@3 | 6 | {"map":"world"} | 200 | 0.595 | 0.524-0.666 | +67 | +0.94 | +0.73 | +0.21 (-0.07 to +0.48) | 3.46 | 0.91 | 0 |
| delove@3 | 10 | {"map":"world"} | 200 | 0.565 | 0.497-0.633 | +45 | +0.77 | +1.03 | -0.26 (-0.68 to +0.16) | 5.68 | 0.98 | 0 |
| delove@3 | 6 | {"map":"fantasy"} | 100 | 0.560 | 0.462-0.658 | +42 | +0.86 | +0.81 | +0.05 (-0.20 to +0.29) | 3.52 | 0.91 | 0 |
| delove@3 | 2 | {"map":"skirmish"} | 400 | 0.500 | 0.455-0.545 | 0 | +0.48 | +0.48 | +0.00 (-0.33 to +0.33) | 1.50 | 0.49 | 4 |
| delove@3 | 6 | {"map":"greater_europe"} | 100 | 0.530 | 0.434-0.626 | +21 | +0.59 | +0.92 | -0.33 (-1.13 to +0.47) | 3.64 | 0.82 | 2 |
| jacob-sensei@1 | 6 | {"map":"world"} | 200 | 0.330 | 0.261-0.399 | -123 | +0.38 | +1.29 | -0.91 (-1.34 to -0.48) | 3.60 | 0.49 | 0 |
| delove@3 | 6 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"progressive","capitals":true,"blizzards":8} | 200 | 0.728 | 0.668-0.787 | +171 | +0.87 | +0.13 | +0.74 (+0.42 to +1.05) | 3.30 | 0.68 | 3 |
| delove@3 | 6 | {"map":"world","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"fixed","capitals":true} | 200 | 0.645 | 0.576-0.714 | +104 | +0.59 | +0.16 | +0.44 (+0.18 to +0.69) | 3.38 | 0.44 | 0 |
| delove@3 | 2 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"exponential","blizzards":8} | 400 | 0.698 | 0.660-0.735 | +145 | +1.05 | -0.14 | +1.19 (+0.97 to +1.40) | 1.29 | 0.68 | 12 |
| delove-teacher@2 | 2 | {} | 400 | 0.600 | 0.557-0.643 | +70 | +0.80 | +0.20 | +0.60 (+0.34 to +0.86) | 1.40 | 0.60 | 0 |

### c6: time per phase

Generation ran in two GPU lanes (`GPU_LANES=2`): the big tables in one, Classic 4p, Classic 2p and Four Crowns in the
other.

| phase | minutes |
| --- | --- |
| Classic 4p (3,000 games), lane 2 | 20.8 |
| Classic 2p (8,000 games), lane 2 | 13.8 |
| Four Crowns (6,000 games), lane 2 | 8.2 |
| big tables (13,000 games, 26 configurations), lane 1 | **356.6** |
| training (21,442 steps at batch 512, 1.5 epochs over 7.3M decisions, `--amp`) | 27.1 |
| gates (13 matches, CPU) | 17.2 |
| **whole cycle** | **401** |

Big tables per configuration (500 games unless noted; minutes):

| map / seats | first half | second half |
| --- | --- | --- |
| World 10p (750 each) | 16.5 | 10.9 |
| World 6p | 6.2 | 5.1 |
| Grand World 10p | 25.2 | 15.6 |
| Greater Europe 10p | 27.5 | 28.0 |
| Greater Europe 6p | 46.2 | 18.7 |
| Greater Europe 2p | 2.1 | – |
| Fantasy 10p | 9.0 | 9.1 |
| Fantasy 6p | 12.5 | 20.0 |
| Europe 8p | 1.4 | 2.9 |
| USA 10p | 3.9 | 3.0 |
| Asia 8p | 2.2 | 2.8 |
| Europe Advanced 6p | 10.2 | 20.0 |
| Classic 6p | 0.7 | 1.5 |

The second lane finished after 43 minutes and stood idle for 5 hours. Some first halves also shared the GPU with a
batched `verify.py`. Lessons for cycle 7: deal the big tables to several lanes by measured cost (`GPU_LANES=N` deals
steps in turn, so split the big step into several); the huge 10-player boards cost 10-50x a Classic 4p game per
decision, so size them by cost, not by games.

**Early read (`c61-candidate`).** One epoch, about 5 minutes, on only the 17,000 small-table games, plus shares of
older data. Against `delove@3`:

| table | games | score | points per seat |
| --- | --- | --- | --- |
| Classic 2p | 400 | 0.540 | +0.24 |
| Classic 4p | 200 | 0.512 | +0.03 |
| Classic 6p | 200 | 0.505 | +0.18 |
| Classic 6p, league settings | 200 | 0.675 | +0.60 |

The method showed up within an hour, while the big tables were still playing.

**Review: promoted to `delove@4`** under the owner's rule. Against `delove@3` it is statistically better at 2 players
(0.532, 95% interval 0.503-0.562; +0.20 points per seat, interval above 0), no table is significantly worse on points,
and the gain is large at the settings the live league plays:

| league-settings table | score | points per seat (95%) |
| --- | --- | --- |
| Classic 6p, capitals + 8 blizzards | 0.728 | +0.74 (+0.42 to +1.05) |
| World 6p, fixed cards + capitals | 0.645 | +0.44 (+0.18 to +0.69) |
| Classic 2p, exponential cards + 8 blizzards | 0.698 | +1.19 (+0.97 to +1.40) |

It scores 0.600 vs Sensei 2 (`delove@3`: 0.560). On World 6p / 10p it wins more (0.595 / 0.565), but the points
differences are not significant. Default Classic 4-6p is even.

What changed against cycle 5, and what it did:
1. **League settings** on every table: the largest effect. Cycles 1-5 trained on the default settings only, while the
   league samples capitals, blizzards, all three card modes and auto setup.
2. **Jacob Sensei** as teacher, for the default moves and the rollouts: 8 turn-limit games in 30,000 (cycle 5: 912 in
   37,600), so every map and table size was playable, and the labels came from a player stronger than `delove@3` in
   multiplayer.
3. **Search-weighted lessons** (`branch_tag.npy`, `--branch-weights 0.5,1,2`) and cycle 5's big tables as value-only
   data (`:value`): cycle 5's data no longer pulls the policy toward Sensei 2.
4. **Mixed precision**: 27 minutes of training for 21k steps.

Still open: Jacob Sensei beats `delove@4` 0.67 at World 6p, so imitation has headroom in multiplayer, and default
Classic 4-6p did not move. Next: the range specialists from `delove@4` (#114), faster big-table search (in progress),
cost-balanced lanes and cloud GPUs (#115) for shorter cycles.

## Cycle 7

### c7: the range specialists (no new games)

The owner's plan: three networks fine-tuned from `delove@4`, each on the cycle 5-6 decisions with its number of
players alive (`train.py --alive`), and routed by players alive within one game (`delove-range@1`, #114). Script:
`scripts/cycles/c7-specialists.sh`. Each specialist trained for 1.5 epochs at lr 2e-4 with `--amp` and
`--branch-weights 0.5,1,2`. Cycle 5's multiplayer tables were value-only data.

| specialist | players alive | training decisions (cycle 6 + cycle 5 value-only) | steps | minutes |
| --- | --- | --- | --- | --- |
| Delove Long Range (`c7-long`) | 4-10 | 2.67M + 3.2M | 10,948 | 17.6 |
| Delove Mid Range (`c7-mid`) | 3 | the 3-alive share of the same tables | 2,817 | 4.4 |
| Delove Close Range (`c7-close`) | 2 | 2-alive positions plus Classic 2p and Four Crowns | 6,761 | 8.5 |

### c7: ladder gate (`delove-range@1` vs `delove@4`)

| opponent | players | options | games | score (95%) | points diff per seat (95%) | turn limit |
| --- | --- | --- | --- | --- | --- | --- |
| delove@4 | 2 | {} | 800 | 0.501 ± 0.022 | +0.01 ± 0.13 | 0 |
| delove@4 | 4 | {} | 200 | 0.505 ± 0.054 | +0.08 ± 0.23 | 36 |
| delove@4 | 6 | {} | 200 | 0.480 ± 0.065 | -0.08 ± 0.49 | 6 |
| delove@4 | 6 | World | 200 | 0.515 ± 0.067 | +0.07 ± 0.33 | 0 |
| delove@4 | 10 | World | 200 | 0.490 ± 0.076 | +0.03 ± 0.43 | 0 |
| delove@4 | 6 | league: progressive, capitals, 8 blizzards | 200 | **0.557 ± 0.032** | **+0.53 ± 0.26** | 9 |
| delove@4 | 6 | league: World, fixed cards, capitals | 200 | 0.522 ± 0.060 | +0.05 ± 0.30 | 1 |
| delove@4 | 4 | league: exponential, 8 blizzards | 200 | 0.460 ± 0.055 | -0.26 ± 0.35 | 18 |
| delove@4 | 2 | league: exponential, 8 blizzards | 400 | 0.497 ± 0.035 | -0.02 ± 0.21 | 14 |
| jacob-sensei@1 | 6 | World | 200 | 0.305 ± 0.054 | -0.94 ± 0.19 | 0 |

Time: 31 min of training (GPU) and 11 min of gates (CPU, 24 processes), 42 min in all.

**Review.** Not promoted: the routed trio is even with `delove@4` everywhere but one league table (+0.53 points per
seat at league Classic 6p), and no better on points elsewhere. Splitting the *same* lessons by players alive gives a
network little it hadn't learned from all of them together: `delove@4` already saw every one of these positions.
Mid Range also had the least data. Specialists need different lessons per phase rather than a split of the same
ones: more games that reach 3 players, a duel-focused search or teacher for the 1v1, or phase-specific goals. That
makes them a later experiment. The gap that remains is the teacher: Jacob Sensei still beats every Delove 0.69-0.70 at
World 6p. Next: new games (cycle 8) with the faster big-table search (#117), more GPU lanes and `delove@4` as ranker.

## Cycle 8

## c8

### Cycle 8, step a1: Classic 4-player

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| c4a | 1,000 | jacob-sensei@1 154, branch@1 538, delove@4 143, jacob-sensei@1 164 | 46.8 | 1 | 619,902 |
| c4b | 1,000 | jacob-sensei@1 100, delove@4 186, jacob-sensei@1 102, branch@1 612 | 36.2 | 0 | 439,181 |
| c4c | 1,000 | jacob-sensei@1 173, branch@1 499, delove@4 161, jacob-sensei@1 161 | 48.3 | 6 | 486,850 |
| c4d | 1,000 | jacob-sensei@1 130, delove@4 200, jacob-sensei@1 117, branch@1 552 | 28.8 | 1 | 325,466 |

**4,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 522,544 |
| branched (compared options) | 330,153 (63.2%) |
| simulations run | 5,935,254 (155,468,592 simulated moves) |
| changed the teacher's move | 103,488 (31.3% of branched) |
| average score gain per branched decision | +0.0150 |
| changes by kind | attack 64,210/205,581, place 24,147/81,288, fortify_from 7,640/20,512, end_turn 3,962/11,875, trade 3,529/10,897 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.407 / 0.430 / 0.418 / 0.354 / 0.507 |
| chosen branches that had won / lost within the horizon | 7.1% / 1.1% |

### Cycle 8, step a2: Classic 2p, Four Crowns 1v1, Classic 6p

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| c2a | 2,000 | branch@1 1370, jacob-sensei@1 630 | 20.1 | 0 | 438,105 |
| c2b | 2,000 | branch@1 1238, delove@4 762 | 3.9 | 0 | 83,986 |
| c2c | 2,000 | jacob-sensei@1 737, branch@1 1263 | 17.8 | 0 | 340,733 |
| c2d | 2,000 | delove@4 758, branch@1 1239 | 6.1 | 3 | 107,226 |
| c6a | 1,000 | jacob-sensei@1 144, delove@4 104, jacob-sensei@1 143, delove@3 54, jacob-sensei@1 105, branch@1 448 | 53.9 | 2 | 543,123 |
| c6b | 1,000 | jacob-sensei@1 117, branch@1 474, delove@4 141, jacob-sensei@1 106, delove@3 35, jacob-sensei@1 127 | 36.8 | 0 | 427,661 |
| mca | 3,000 | branch@1 1931, jacob-sensei@1 1069 | 16.3 | 0 | 408,936 |
| mcb | 3,000 | branch@1 1845, delove@4 1149 | 4.5 | 6 | 93,006 |

**16,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 977,880 |
| branched (compared options) | 642,741 (65.7%) |
| simulations run | 11,542,062 (180,844,134 simulated moves) |
| changed the teacher's move | 197,579 (30.7% of branched) |
| average score gain per branched decision | +0.0193 |
| changes by kind | attack 105,005/361,126, place 51,844/186,728, fortify_from 23,224/54,198, end_turn 10,851/20,688, trade 6,655/20,001 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.541 / 0.566 / 0.562 / 0.506 / 0.616 |
| chosen branches that had won / lost within the horizon | 11.0% / 2.6% |

### Cycle 8, step a3: Europe 8p, USA 10p, Asia 8p

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| as8a | 1,000 | jacob-sensei@1 110, branch@1 343, delove@4 78, jacob-sensei@1 108, delove@3 64, jacob-sensei@1 102, delove@4 74, jacob-sensei@1 121 | 54.8 | 0 | 716,553 |
| as8b | 1,000 | jacob-sensei@1 76, delove@4 127, jacob-sensei@1 85, branch@1 425, delove@3 38, jacob-sensei@1 66, delove@4 129, jacob-sensei@1 54 | 76.6 | 0 | 980,563 |
| eu8a | 1,000 | jacob-sensei@1 112, delove@4 62, jacob-sensei@1 104, delove@3 41, jacob-sensei@1 119, branch@1 359, delove@4 66, jacob-sensei@1 136 | 48.1 | 1 | 592,059 |
| eu8b | 1,000 | jacob-sensei@1 61, delove@4 105, jacob-sensei@1 58, delove@3 50, jacob-sensei@1 55, delove@4 114, jacob-sensei@1 61, branch@1 496 | 65.4 | 0 | 843,594 |
| us10a | 1,000 | jacob-sensei@1 103, delove@4 50, jacob-sensei@1 89, delove@3 28, jacob-sensei@1 99, branch@1 335, delove@4 50, jacob-sensei@1 108, delove@3 24, jacob-sensei@1 114 | 63.1 | 0 | 647,837 |
| us10b | 1,000 | jacob-sensei@1 80, delove@4 93, jacob-sensei@1 58, delove@3 22, jacob-sensei@1 76, delove@4 88, jacob-sensei@1 72, branch@1 417, delove@3 25, jacob-sensei@1 68 | 46.3 | 1 | 564,579 |

**6,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 711,153 |
| branched (compared options) | 439,198 (61.8%) |
| simulations run | 7,887,048 (337,067,754 simulated moves) |
| changed the teacher's move | 135,419 (30.8% of branched) |
| average score gain per branched decision | +0.0145 |
| changes by kind | attack 91,802/286,332, place 30,758/106,833, fortify_from 5,811/17,402, end_turn 3,717/17,069, trade 3,331/11,562 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.362 / 0.373 / 0.365 / 0.308 / 0.435 |
| chosen branches that had won / lost within the horizon | 9.9% / 2.0% |

### Cycle 8, step a4: Bohemia, Nine Realms, World 6p

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| bo4a | 750 | jacob-sensei@1 137, delove@4 121, jacob-sensei@1 119, branch@1 368 | 42.9 | 5 | 328,872 |
| bo4b | 750 | jacob-sensei@1 105, branch@1 387, delove@4 144, jacob-sensei@1 111 | 27.7 | 3 | 225,063 |
| bo6a | 750 | jacob-sensei@1 117, delove@4 56, jacob-sensei@1 104, branch@1 315, delove@3 40, jacob-sensei@1 118 | 47.2 | 0 | 434,306 |
| bo6b | 750 | jacob-sensei@1 68, delove@4 85, jacob-sensei@1 63, delove@3 45, jacob-sensei@1 76, branch@1 413 | 51.0 | 0 | 466,872 |
| nr6a | 750 | jacob-sensei@1 112, delove@4 71, jacob-sensei@1 145, delove@3 38, jacob-sensei@1 100, branch@1 284 | 78.9 | 0 | 650,412 |
| nr6b | 750 | jacob-sensei@1 90, branch@1 379, delove@4 90, jacob-sensei@1 91, delove@3 18, jacob-sensei@1 80 | 51.5 | 2 | 498,270 |
| nr8a | 500 | jacob-sensei@1 61, branch@1 196, delove@4 22, jacob-sensei@1 62, delove@3 26, jacob-sensei@1 40, delove@4 38, jacob-sensei@1 55 | 64.5 | 0 | 444,395 |
| nr8b | 500 | jacob-sensei@1 42, delove@4 50, jacob-sensei@1 50, branch@1 205, delove@3 19, jacob-sensei@1 47, delove@4 46, jacob-sensei@1 41 | 95.5 | 0 | 598,791 |
| w6a | 500 | jacob-sensei@1 68, delove@4 58, jacob-sensei@1 90, branch@1 215, delove@3 26, jacob-sensei@1 43 | 93.1 | 0 | 594,785 |
| w6b | 500 | jacob-sensei@1 49, delove@4 53, jacob-sensei@1 63, delove@3 11, jacob-sensei@1 58, branch@1 266 | 58.2 | 0 | 463,951 |

**6,500 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 949,297 |
| branched (compared options) | 591,369 (62.3%) |
| simulations run | 10,628,052 (385,262,268 simulated moves) |
| changed the teacher's move | 172,071 (29.1% of branched) |
| average score gain per branched decision | +0.0132 |
| changes by kind | attack 110,913/378,042, place 39,587/141,953, fortify_from 10,419/33,118, end_turn 5,772/20,861, trade 5,380/17,395 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.361 / 0.388 / 0.371 / 0.306 / 0.461 |
| chosen branches that had won / lost within the horizon | 7.2% / 1.3% |

### Cycle 8, step b: the huge boards (cloud: 8 rented RTX 4090s)

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| ec6a | 500 | jacob-sensei@1 49, delove@4 70, branch@1 248, jacob-sensei@1 42, delove@3 44, jacob-sensei@1 47 | 115.7 | 0 | 815,565 |
| ec6b | 500 | jacob-sensei@1 65, delove@4 49, jacob-sensei@1 83, delove@3 15, branch@1 231, jacob-sensei@1 57 | 112.7 | 0 | 778,108 |
| fa10a | 500 | branch@1 203, jacob-sensei@1 20, delove@4 51, jacob-sensei@1 27, delove@3 24, jacob-sensei@1 26, delove@4 53, jacob-sensei@1 38, delove@3 26, jacob-sensei@1 32 | 166.2 | 0 | 1,127,656 |
| fa10b | 500 | jacob-sensei@1 68, delove@4 17, branch@1 168, jacob-sensei@1 54, delove@3 10, jacob-sensei@1 43, delove@4 17, jacob-sensei@1 61, delove@3 8, jacob-sensei@1 54 | 144.5 | 0 | 868,013 |
| fa6a | 500 | branch@1 271, jacob-sensei@1 47, delove@4 47, jacob-sensei@1 56, delove@3 16, jacob-sensei@1 63 | 65.9 | 0 | 591,012 |
| fa6b | 500 | jacob-sensei@1 91, delove@4 29, branch@1 208, jacob-sensei@1 67, delove@3 35, jacob-sensei@1 70 | 77.1 | 0 | 754,175 |
| ge10a | 500 | jacob-sensei@1 16, delove@4 74, jacob-sensei@1 29, delove@3 31, jacob-sensei@1 21, delove@4 58, branch@1 203, jacob-sensei@1 24, delove@3 27, jacob-sensei@1 16 | 267.8 | 1 | 1,865,832 |
| ge10b | 500 | jacob-sensei@1 78, delove@4 10, jacob-sensei@1 61, delove@3 8, jacob-sensei@1 51, delove@4 20, jacob-sensei@1 48, delove@3 7, branch@1 167, jacob-sensei@1 50 | 206.7 | 0 | 1,441,501 |
| ge6a | 500 | jacob-sensei@1 53, delove@4 33, branch@1 305, jacob-sensei@1 49, delove@3 23, jacob-sensei@1 37 | 92.4 | 0 | 1,032,890 |
| ge6b | 500 | jacob-sensei@1 73, delove@4 34, jacob-sensei@1 55, delove@3 23, branch@1 260, jacob-sensei@1 55 | 110.0 | 0 | 1,369,886 |
| w10a | 750 | jacob-sensei@1 52, delove@4 79, branch@1 289, jacob-sensei@1 43, delove@3 35, jacob-sensei@1 50, delove@4 91, jacob-sensei@1 36, delove@3 29, jacob-sensei@1 46 | 121.3 | 0 | 1,201,265 |
| w10b | 750 | jacob-sensei@1 81, delove@4 36, jacob-sensei@1 70, delove@3 21, branch@1 241, jacob-sensei@1 78, delove@4 37, jacob-sensei@1 91, delove@3 17, jacob-sensei@1 76 | 116.4 | 2 | 1,006,082 |
| wl10a | 500 | jacob-sensei@1 42, delove@4 27, jacob-sensei@1 36, delove@3 6, branch@1 216, jacob-sensei@1 45, delove@4 29, jacob-sensei@1 47, delove@3 7, jacob-sensei@1 45 | 90.4 | 0 | 836,050 |
| wl10b | 500 | jacob-sensei@1 48, delove@4 20, jacob-sensei@1 46, delove@3 12, jacob-sensei@1 49, delove@4 16, branch@1 206, jacob-sensei@1 44, delove@3 8, jacob-sensei@1 51 | 96.6 | 0 | 918,091 |

**7,500 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 2,330,553 |
| branched (compared options) | 1,382,904 (59.3%) |
| simulations run | 24,876,492 (1,596,353,239 simulated moves) |
| changed the teacher's move | 372,940 (27.0% of branched) |
| average score gain per branched decision | +0.0105 |
| changes by kind | attack 271,526/981,416, place 61,519/258,302, fortify_from 20,234/61,970, trade 9,937/33,591, end_turn 9,724/47,625 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.316 / 0.354 / 0.329 / 0.248 / 0.428 |
| chosen branches that had won / lost within the horizon | 4.6% / 0.8% |

### c8: ladder gate (c8-candidate)

| opponent | players | options | games | score | 95% interval | Elo | points | opp. points | points diff (95%) | place | kills | turn limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| delove@4 | 2 | {} | 800 | 0.507 | 0.480-0.535 | +5 | +0.52 | +0.48 | +0.04 (-0.12 to +0.21) | 1.49 | 0.51 | 0 |
| delove@4 | 4 | {} | 200 | 0.522 | 0.461-0.584 | +16 | +0.17 | +0.09 | +0.08 (-0.29 to +0.45) | 2.51 | 0.60 | 45 |
| delove@4 | 6 | {} | 200 | 0.578 | 0.508-0.647 | +54 | +0.67 | +0.27 | +0.40 (-0.01 to +0.80) | 3.40 | 0.86 | 19 |
| delove@4 | 6 | {"map":"world"} | 200 | 0.537 | 0.469-0.606 | +26 | +0.99 | +0.64 | +0.35 (+0.04 to +0.65) | 3.42 | 0.90 | 1 |
| delove@4 | 10 | {"map":"world"} | 200 | 0.515 | 0.445-0.585 | +10 | +0.93 | +0.87 | +0.06 (-0.41 to +0.53) | 5.51 | 0.94 | 0 |
| delove@4 | 6 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"progressive","capitals":true,"blizzards":8} | 200 | 0.630 | 0.569-0.691 | +92 | +0.42 | +0.08 | +0.34 (-0.03 to +0.71) | 3.38 | 0.66 | 20 |
| delove@4 | 6 | {"map":"world","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"fixed","capitals":true} | 200 | 0.477 | 0.405-0.550 | -16 | +0.45 | +0.33 | +0.13 (-0.11 to +0.37) | 3.43 | 0.40 | 3 |
| delove@4 | 4 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"exponential","blizzards":8} | 200 | 0.487 | 0.420-0.555 | -9 | +0.38 | +0.55 | -0.17 (-0.54 to +0.19) | 2.51 | 0.69 | 21 |
| delove@4 | 2 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"exponential","blizzards":8} | 400 | 0.497 | 0.461-0.534 | -2 | +0.42 | +0.44 | -0.01 (-0.21 to +0.18) | 1.50 | 0.47 | 18 |
| delove@4 | 6 | {"map":"bohemia","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"progressive"} | 200 | 0.623 | 0.556-0.689 | +87 | +1.22 | +0.41 | +0.81 (+0.37 to +1.25) | 3.31 | 1.01 | 1 |
| delove@4 | 8 | {"map":"nine_realms","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"fixed","capitals":true} | 200 | 0.625 | 0.562-0.688 | +89 | +0.18 | -0.23 | +0.41 (+0.14 to +0.68) | 4.36 | 0.55 | 26 |
| jacob-sensei@1 | 6 | {"map":"world"} | 200 | 0.315 | 0.250-0.380 | -135 | +0.35 | +1.32 | -0.97 (-1.29 to -0.66) | 3.60 | 0.47 | 0 |
| delove-teacher@2 | 2 | {} | 400 | 0.608 | 0.565-0.650 | +76 | +0.82 | +0.18 | +0.65 (+0.41 to +0.88) | 1.39 | 0.61 | 0 |

### c8: time per phase

Part A (the small and medium boards) played at home on the RTX 4060 with `GPU_LANES=4` and `GENERATE_ONLY=1`, while
part B (the huge boards) played on 8 rented RunPod RTX 4090s through `cloud/remote.py`. Training and gates ran after
both, from the full config.

| phase | where | minutes |
| --- | --- | --- |
| part A: a1 Classic 4p (4,000 games) | home, lane 1 | 31.7 |
| part A: a2 Classic 2p, Four Crowns, Classic 6p (16,000) | home, lane 2 | 42.5 |
| part A: a3 Europe 8p, USA 10p, Asia 8p (6,000) | home, lane 3 | 53.9 |
| part A: a4 Bohemia, Nine Realms, World 6p (6,500) | home, lane 4 | 79.2 |
| part B: huge boards (7,500 games, 14 configurations) | 8 cloud pods, 1 process each | 33 (plus about 10 setup/download), $5.45 |
| training (22,270 steps, `--amp`) | home GPU | 30.2 |
| gates (13 matches) | home CPU | 11.2 |
| **whole cycle**, from the first game to the gate table | | **about 2 h 10 min** (cycle 6: 6 h 41 min) |

Part A's lanes were slowed by the replay proofs of #117 sharing the GPU.

**Review: promoted to `delove@5`.** Against `delove@4` it is even at 2 players (0.507) and better on leaderboard
points at 4-10 players: pooled over the 9 multiplayer tables, about +0.27 points per seat (95% +0.15 to +0.39); on
the original maps alone +0.17 (+0.03 to +0.31). The largest gains are on the two new maps (Bohemia 6p +0.81, Nine
Realms 8p +0.41, both significant), then World 6p (+0.35, significant), Classic 6p (+0.40) and league Classic 6p
(0.630). League Classic 4p with exponential cards was slightly negative (-0.17, n.s.). It also beats Sensei 2 0.608.

What helped: new lessons (cycle 7 re-split old ones and gained nothing), `delove@4` ranking the search's options, and
two new maps in the rotation. Still open: Jacob Sensei beats `delove@5` 0.685 at World 6p, so a stronger teacher
(Delove-played rollouts, more options) is the next lever; then stage-focused games for the range specialists, and
fog of war (section 9 of `docs/delove-status.md`).
