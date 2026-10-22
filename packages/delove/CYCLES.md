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

## Cycle 9

## c9

### Cycle 9, step a1: Classic 4-player

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| c4a | 1,000 | jacob-sensei@1 171, branch@1 493, delove@5 166, jacob-sensei@1 170 | 46.0 | 0 | 619,080 |
| c4b | 1,000 | jacob-sensei@1 90, delove@5 273, jacob-sensei@1 80, branch@1 557 | 34.0 | 0 | 415,692 |
| c4c | 1,000 | jacob-sensei@1 181, branch@1 497, delove@5 170, jacob-sensei@1 147 | 47.3 | 5 | 484,086 |
| c4d | 1,000 | jacob-sensei@1 111, delove@5 272, jacob-sensei@1 103, branch@1 512 | 27.8 | 2 | 310,870 |

**4,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 509,559 |
| branched (compared options) | 322,391 (63.3%) |
| simulations run | 5,794,302 (155,118,123 simulated moves) |
| changed the teacher's move | 103,131 (32.0% of branched) |
| average score gain per branched decision | +0.0155 |
| changes by kind | attack 63,269/199,414, place 24,282/79,760, fortify_from 7,940/20,770, end_turn 4,205/11,949, trade 3,435/10,498 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.396 / 0.420 / 0.409 / 0.349 / 0.494 |
| chosen branches that had won / lost within the horizon | 6.7% / 1.4% |

### Cycle 9, step a2: Classic 2p, Four Crowns 1v1, Classic 6p

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| c2a | 2,000 | branch@1 1317, jacob-sensei@1 682 | 20.3 | 1 | 444,123 |
| c2b | 2,000 | branch@1 1188, delove@5 811 | 3.9 | 1 | 83,143 |
| c2c | 2,000 | jacob-sensei@1 740, branch@1 1260 | 17.8 | 0 | 339,819 |
| c2d | 2,000 | delove@5 815, branch@1 1180 | 5.9 | 5 | 100,503 |
| c6a | 1,000 | jacob-sensei@1 135, delove@5 115, jacob-sensei@1 120, delove@4 90, jacob-sensei@1 125, branch@1 407 | 55.4 | 8 | 545,791 |
| c6b | 1,000 | jacob-sensei@1 82, branch@1 424, delove@5 162, jacob-sensei@1 101, delove@4 133, jacob-sensei@1 94 | 39.1 | 4 | 443,028 |
| mca | 3,000 | branch@1 1933, jacob-sensei@1 1067 | 16.1 | 0 | 406,849 |
| mcb | 3,000 | branch@1 1725, delove@5 1269 | 4.5 | 6 | 93,807 |

**16,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 972,150 |
| branched (compared options) | 641,050 (65.9%) |
| simulations run | 11,509,356 (182,087,190 simulated moves) |
| changed the teacher's move | 202,114 (31.5% of branched) |
| average score gain per branched decision | +0.0206 |
| changes by kind | attack 104,907/355,605, place 51,774/186,060, fortify_from 26,485/57,246, end_turn 11,879/21,949, trade 7,069/20,190 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.534 / 0.560 / 0.556 / 0.503 / 0.608 |
| chosen branches that had won / lost within the horizon | 10.5% / 2.5% |

### Cycle 9, step a3: Europe 8p, USA 10p, Asia 8p

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| as8a | 1,000 | jacob-sensei@1 101, branch@1 364, delove@5 84, jacob-sensei@1 109, delove@4 66, jacob-sensei@1 103, delove@5 69, jacob-sensei@1 104 | 52.6 | 0 | 691,879 |
| as8b | 1,000 | jacob-sensei@1 43, delove@5 150, jacob-sensei@1 52, branch@1 417, delove@4 100, jacob-sensei@1 50, delove@5 133, jacob-sensei@1 55 | 75.7 | 0 | 974,820 |
| eu8a | 1,000 | jacob-sensei@1 116, delove@5 64, jacob-sensei@1 119, delove@4 55, jacob-sensei@1 102, branch@1 345, delove@5 74, jacob-sensei@1 125 | 46.7 | 0 | 587,193 |
| eu8b | 1,000 | jacob-sensei@1 49, delove@5 155, jacob-sensei@1 46, delove@4 80, jacob-sensei@1 43, delove@5 124, jacob-sensei@1 49, branch@1 453 | 65.7 | 1 | 844,010 |
| us10a | 1,000 | jacob-sensei@1 92, delove@5 54, jacob-sensei@1 90, delove@4 53, jacob-sensei@1 92, branch@1 316, delove@5 55, jacob-sensei@1 96, delove@4 58, jacob-sensei@1 94 | 61.1 | 0 | 637,624 |
| us10b | 1,000 | jacob-sensei@1 59, delove@5 115, jacob-sensei@1 63, delove@4 71, jacob-sensei@1 54, delove@5 113, jacob-sensei@1 53, branch@1 339, delove@4 68, jacob-sensei@1 62 | 48.0 | 3 | 568,173 |

**6,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 686,661 |
| branched (compared options) | 426,032 (62.0%) |
| simulations run | 7,650,186 (334,665,627 simulated moves) |
| changed the teacher's move | 131,081 (30.8% of branched) |
| average score gain per branched decision | +0.0145 |
| changes by kind | attack 88,250/274,860, place 29,810/105,719, fortify_from 5,971/17,107, trade 3,533/11,412, end_turn 3,517/16,934 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.359 / 0.367 / 0.361 / 0.305 / 0.429 |
| chosen branches that had won / lost within the horizon | 9.8% / 2.2% |

### Cycle 9, step a4: Bohemia, Nine Realms, World 6p

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| bo4a | 750 | jacob-sensei@1 147, delove@5 129, jacob-sensei@1 127, branch@1 344 | 40.9 | 3 | 313,550 |
| bo4b | 750 | jacob-sensei@1 103, branch@1 371, delove@5 186, jacob-sensei@1 85 | 28.5 | 5 | 228,947 |
| bo6a | 750 | jacob-sensei@1 102, delove@5 86, jacob-sensei@1 106, branch@1 274, delove@4 66, jacob-sensei@1 116 | 46.1 | 0 | 432,834 |
| bo6b | 750 | jacob-sensei@1 64, delove@5 108, jacob-sensei@1 66, delove@4 71, jacob-sensei@1 58, branch@1 383 | 51.3 | 0 | 480,357 |
| nr6a | 750 | jacob-sensei@1 106, delove@5 69, jacob-sensei@1 117, delove@4 62, jacob-sensei@1 110, branch@1 286 | 75.6 | 0 | 636,279 |
| nr6b | 750 | jacob-sensei@1 71, branch@1 343, delove@5 104, jacob-sensei@1 85, delove@4 72, jacob-sensei@1 75 | 49.2 | 0 | 498,924 |
| nr8a | 500 | jacob-sensei@1 57, branch@1 167, delove@5 35, jacob-sensei@1 56, delove@4 41, jacob-sensei@1 50, delove@5 45, jacob-sensei@1 49 | 62.8 | 0 | 442,229 |
| nr8b | 500 | jacob-sensei@1 38, delove@5 45, jacob-sensei@1 55, branch@1 204, delove@4 34, jacob-sensei@1 31, delove@5 52, jacob-sensei@1 41 | 93.4 | 0 | 602,538 |
| w6a | 500 | jacob-sensei@1 61, delove@5 54, jacob-sensei@1 47, branch@1 221, delove@4 56, jacob-sensei@1 61 | 87.8 | 0 | 579,149 |
| w6b | 500 | jacob-sensei@1 55, delove@5 52, jacob-sensei@1 47, delove@4 46, jacob-sensei@1 43, branch@1 257 | 55.6 | 0 | 459,942 |

**6,500 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 928,534 |
| branched (compared options) | 578,478 (62.3%) |
| simulations run | 10,394,928 (375,131,723 simulated moves) |
| changed the teacher's move | 169,672 (29.3% of branched) |
| average score gain per branched decision | +0.0133 |
| changes by kind | attack 108,374/369,309, place 38,721/138,031, fortify_from 11,287/33,553, end_turn 5,754/20,525, trade 5,536/17,060 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.362 / 0.386 / 0.370 / 0.304 / 0.460 |
| chosen branches that had won / lost within the horizon | 7.1% / 1.3% |

### Cycle 9, step b: the huge boards

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| ec6a | 500 | jacob-sensei@1 27, delove@5 103, branch@1 238, jacob-sensei@1 29, delove@4 70, jacob-sensei@1 33 | 111.8 | 0 | 828,323 |
| ec6b | 500 | jacob-sensei@1 66, delove@5 46, jacob-sensei@1 66, delove@4 44, branch@1 223, jacob-sensei@1 55 | 106.7 | 0 | 752,232 |
| fa10a | 500 | branch@1 197, jacob-sensei@1 23, delove@5 55, jacob-sensei@1 24, delove@4 57, jacob-sensei@1 18, delove@5 60, jacob-sensei@1 19, delove@4 26, jacob-sensei@1 21 | 158.4 | 0 | 1,121,507 |
| fa10b | 500 | jacob-sensei@1 56, delove@5 13, branch@1 153, jacob-sensei@1 52, delove@4 10, jacob-sensei@1 52, delove@5 21, jacob-sensei@1 47, delove@4 22, jacob-sensei@1 74 | 138.0 | 0 | 863,625 |
| fa6a | 500 | branch@1 248, jacob-sensei@1 51, delove@5 56, jacob-sensei@1 58, delove@4 35, jacob-sensei@1 52 | 62.5 | 0 | 580,488 |
| fa6b | 500 | jacob-sensei@1 82, delove@5 42, branch@1 202, jacob-sensei@1 64, delove@4 34, jacob-sensei@1 76 | 71.8 | 0 | 708,529 |
| ge10a | 500 | jacob-sensei@1 11, delove@5 69, jacob-sensei@1 22, delove@4 42, jacob-sensei@1 9, delove@5 75, branch@1 179, jacob-sensei@1 18, delove@4 62, jacob-sensei@1 12 | 243.9 | 1 | 1,812,806 |
| ge10b | 500 | jacob-sensei@1 55, delove@5 15, jacob-sensei@1 60, delove@4 14, jacob-sensei@1 50, delove@5 13, jacob-sensei@1 62, delove@4 14, branch@1 168, jacob-sensei@1 49 | 194.7 | 0 | 1,416,331 |
| ge6a | 500 | jacob-sensei@1 45, delove@5 55, branch@1 271, jacob-sensei@1 49, delove@4 44, jacob-sensei@1 36 | 83.8 | 0 | 980,361 |
| ge6b | 500 | jacob-sensei@1 70, delove@5 35, jacob-sensei@1 60, delove@4 31, branch@1 237, jacob-sensei@1 67 | 101.6 | 0 | 1,321,214 |
| w10a | 750 | jacob-sensei@1 44, delove@5 92, branch@1 285, jacob-sensei@1 39, delove@4 67, jacob-sensei@1 23, delove@5 77, jacob-sensei@1 22, delove@4 66, jacob-sensei@1 35 | 116.6 | 0 | 1,203,978 |
| w10b | 750 | jacob-sensei@1 81, delove@5 39, jacob-sensei@1 79, delove@4 35, branch@1 236, jacob-sensei@1 71, delove@5 44, jacob-sensei@1 71, delove@4 28, jacob-sensei@1 65 | 107.3 | 1 | 965,136 |
| wl10a | 500 | jacob-sensei@1 42, delove@5 38, jacob-sensei@1 37, delove@4 26, branch@1 186, jacob-sensei@1 39, delove@5 31, jacob-sensei@1 45, delove@4 22, jacob-sensei@1 34 | 84.5 | 0 | 825,524 |
| wl10b | 500 | jacob-sensei@1 50, delove@5 33, jacob-sensei@1 41, delove@4 21, jacob-sensei@1 62, delove@5 29, branch@1 152, jacob-sensei@1 47, delove@4 20, jacob-sensei@1 45 | 91.2 | 0 | 902,150 |

**7,500 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 2,189,022 |
| branched (compared options) | 1,299,639 (59.4%) |
| simulations run | 23,375,352 (1,438,843,752 simulated moves) |
| changed the teacher's move | 356,569 (27.4% of branched) |
| average score gain per branched decision | +0.0109 |
| changes by kind | attack 255,441/917,522, place 57,969/240,712, fortify_from 21,969/63,549, end_turn 11,022/45,701, trade 10,168/32,155 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.317 / 0.350 / 0.326 / 0.246 / 0.425 |
| chosen branches that had won / lost within the horizon | 4.5% / 0.7% |

### c9: ladder gate (c9-candidate)

| opponent | players | options | games | score | 95% interval | Elo | points | opp. points | points diff (95%) | place | kills | turn limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| delove@5 | 2 | {} | 800 | 0.529 | 0.501-0.558 | +20 | +0.59 | +0.41 | +0.18 (-0.01 to +0.36) | 1.47 | 0.53 | 1 |
| delove@5 | 4 | {} | 200 | 0.507 | 0.452-0.563 | +5 | +0.07 | +0.09 | -0.02 (-0.34 to +0.30) | 2.50 | 0.57 | 49 |
| delove@5 | 6 | {} | 200 | 0.525 | 0.465-0.585 | +17 | +0.41 | +0.26 | +0.15 (-0.13 to +0.43) | 3.46 | 0.81 | 26 |
| delove@5 | 6 | {"map":"world"} | 200 | 0.627 | 0.559-0.696 | +91 | +1.13 | +0.50 | +0.63 (+0.24 to +1.02) | 3.38 | 1.00 | 1 |
| delove@5 | 10 | {"map":"world"} | 200 | 0.560 | 0.496-0.624 | +42 | +1.05 | +0.75 | +0.29 (-0.13 to +0.72) | 5.44 | 0.98 | 0 |
| delove@5 | 6 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"progressive","capitals":true,"blizzards":8} | 200 | 0.550 | 0.493-0.607 | +35 | -0.27 | -0.45 | +0.17 (-0.09 to +0.44) | 3.45 | 0.49 | 54 |
| delove@5 | 6 | {"map":"world","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"fixed","capitals":true} | 200 | 0.555 | 0.487-0.623 | +38 | +0.47 | +0.19 | +0.28 (-0.09 to +0.65) | 3.46 | 0.50 | 6 |
| delove@5 | 4 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"exponential","blizzards":8} | 200 | 0.522 | 0.459-0.586 | +16 | +0.48 | +0.28 | +0.20 (-0.10 to +0.50) | 2.46 | 0.69 | 27 |
| delove@5 | 2 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"exponential","blizzards":8} | 400 | 0.536 | 0.497-0.576 | +25 | +0.56 | +0.34 | +0.22 (+0.03 to +0.41) | 1.45 | 0.52 | 13 |
| delove@5 | 6 | {"map":"bohemia","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"progressive"} | 200 | 0.525 | 0.460-0.590 | +17 | +0.78 | +0.73 | +0.05 (-0.28 to +0.38) | 3.49 | 0.85 | 4 |
| delove@5 | 8 | {"map":"nine_realms","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"fixed","capitals":true} | 200 | 0.422 | 0.361-0.484 | -54 | -0.14 | +0.21 | -0.34 (-0.62 to -0.07) | 4.61 | 0.50 | 25 |
| jacob-sensei@1 | 6 | {"map":"world"} | 200 | 0.355 | 0.291-0.419 | -104 | +0.46 | +1.21 | -0.75 (-1.18 to -0.32) | 3.56 | 0.53 | 0 |
| delove-teacher@2 | 2 | {} | 400 | 0.613 | 0.567-0.658 | +80 | +0.84 | +0.16 | +0.68 (+0.36 to +0.99) | 1.39 | 0.61 | 0 |

**Recheck of Nine Realms 8p** (the one table significantly below 0): 400 more games with fresh seeds gave 0.519 and
**+0.29 ± 0.24** points per seat. Over all 600 games that's about +0.08, so the first 200 games' -0.34 was chance:
with 9 tables, one interval missing by chance is likely about 1 time in 3.

### c9: time per phase

| phase | where | minutes |
| --- | --- | --- |
| all 40,000 games (5 steps, 42 configurations) | 10 rented RunPod RTX 4090s, 1 process each, 0 bad pods | **47.9** (5.14 pod-hours, $4.57) |
| training (22,991 steps, `--amp`) | home GPU | 29.8 |
| gates (13 matches) | home CPU | 15.1 |
| **whole cycle** | | **1 h 33 min** (cycle 8: about 2 h 10 min; cycle 6: 6 h 41 min) |

Two earlier attempts at the cloud run failed on one bad pod each (an upload that dropped, then a pod never reachable
over SSH) and aborted the whole run, $3.85 in all. #128 now replaces a bad pod instead, and this run needed none. A
start at home in between was moved to the cloud at the owner's request; its partial output is kept in
`runs/delove/c9-home-partial`.

**Review: promoted to `delove@6`.** Against `delove@5` it is better at 2 players (0.529, 95% 0.501-0.558; league 2p
+0.22 points per seat, significant) and on leaderboard points at 4-10 players: pooled over the 9 multiplayer tables
about +0.16 per seat (95% +0.05 to +0.27), with World 6p +0.63 (significant) and every other table at or above 0
once the Nine Realms recheck is counted. It beats Sensei 2 0.613. Jacob Sensei still beats it 0.645 at World 6p, so
the stronger teacher (network-played rollouts, in progress) remains the next lever.

## Cycle 10

## c10

### Cycle 10, step a1: Classic 4-player

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| c4a | 1,000 | jacob-sensei@1 133, branch@1 545, delove@6 166, jacob-sensei@1 154 | 45.2 | 2 | 587,494 |
| c4b | 1,000 | jacob-sensei@1 68, delove@6 275, jacob-sensei@1 63, branch@1 594 | 31.3 | 0 | 379,557 |
| c4c | 1,000 | jacob-sensei@1 145, branch@1 503, delove@6 181, jacob-sensei@1 159 | 49.3 | 12 | 491,293 |
| c4d | 1,000 | jacob-sensei@1 97, delove@6 267, jacob-sensei@1 99, branch@1 537 | 26.4 | 0 | 296,883 |

**4,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 490,647 |
| branched (compared options) | 309,726 (63.1%) |
| simulations run | 7,376,748 (194,993,878 simulated moves) |
| changed the teacher's move | 115,757 (37.4% of branched) |
| average score gain per branched decision | +0.0188 |
| changes by kind | attack 68,810/194,508, place 28,132/71,009, fortify_from 8,600/20,146, trade 5,140/11,435, end_turn 5,075/12,628 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.405 / 0.436 / 0.421 / 0.363 / 0.532 |
| chosen branches that had won / lost within the horizon | 7.8% / 0.9% |

### Cycle 10, step a2: Classic 2p, Four Crowns 1v1, Classic 6p

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| c2a | 2,000 | branch@1 1335, jacob-sensei@1 665 | 19.3 | 0 | 416,369 |
| c2b | 2,000 | branch@1 1223, delove@6 777 | 3.6 | 0 | 81,007 |
| c2c | 2,000 | jacob-sensei@1 734, branch@1 1266 | 17.5 | 0 | 331,296 |
| c2d | 2,000 | delove@6 688, branch@1 1307 | 6.0 | 5 | 99,199 |
| c6a | 1,000 | jacob-sensei@1 113, delove@6 123, jacob-sensei@1 108, delove@5 114, jacob-sensei@1 114, branch@1 418 | 57.1 | 10 | 547,274 |
| c6b | 1,000 | jacob-sensei@1 83, branch@1 453, delove@6 179, jacob-sensei@1 69, delove@5 135, jacob-sensei@1 74 | 40.6 | 7 | 430,217 |
| mca | 3,000 | branch@1 1893, jacob-sensei@1 1107 | 16.3 | 0 | 409,218 |
| mcb | 3,000 | branch@1 1776, delove@6 1222 | 4.2 | 2 | 91,576 |

**16,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 946,739 |
| branched (compared options) | 621,680 (65.7%) |
| simulations run | 14,740,302 (235,896,549 simulated moves) |
| changed the teacher's move | 227,878 (36.7% of branched) |
| average score gain per branched decision | +0.0242 |
| changes by kind | attack 115,647/354,895, place 63,030/168,028, fortify_from 29,365/57,456, end_turn 11,093/20,333, trade 8,743/20,968 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.537 / 0.569 / 0.565 / 0.511 / 0.627 |
| chosen branches that had won / lost within the horizon | 11.2% / 1.9% |

### Cycle 10, step a3: Europe 8p, USA 10p, Asia 8p

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| as8a | 1,000 | jacob-sensei@1 81, branch@1 387, delove@6 66, jacob-sensei@1 98, delove@5 88, jacob-sensei@1 89, delove@6 88, jacob-sensei@1 103 | 52.3 | 0 | 694,382 |
| as8b | 1,000 | jacob-sensei@1 39, delove@6 160, jacob-sensei@1 32, branch@1 426, delove@5 133, jacob-sensei@1 41, delove@6 132, jacob-sensei@1 36 | 75.7 | 1 | 955,459 |
| eu8a | 1,000 | jacob-sensei@1 107, delove@6 82, jacob-sensei@1 91, delove@5 56, jacob-sensei@1 108, branch@1 350, delove@6 94, jacob-sensei@1 111 | 47.4 | 1 | 592,599 |
| eu8b | 1,000 | jacob-sensei@1 47, delove@6 125, jacob-sensei@1 45, delove@5 104, jacob-sensei@1 45, delove@6 131, jacob-sensei@1 37, branch@1 462 | 68.3 | 4 | 850,757 |
| us10a | 1,000 | jacob-sensei@1 88, delove@6 65, jacob-sensei@1 81, delove@5 51, jacob-sensei@1 97, branch@1 329, delove@6 66, jacob-sensei@1 91, delove@5 55, jacob-sensei@1 77 | 62.5 | 0 | 642,648 |
| us10b | 1,000 | jacob-sensei@1 52, delove@6 128, jacob-sensei@1 61, delove@5 86, jacob-sensei@1 56, delove@6 113, jacob-sensei@1 39, branch@1 316, delove@5 104, jacob-sensei@1 44 | 49.8 | 1 | 573,993 |

**6,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 674,356 |
| branched (compared options) | 418,466 (62.1%) |
| simulations run | 9,948,180 (436,869,295 simulated moves) |
| changed the teacher's move | 149,692 (35.8% of branched) |
| average score gain per branched decision | +0.0168 |
| changes by kind | attack 98,452/273,690, place 36,689/99,831, fortify_from 6,049/16,384, trade 4,834/12,258, end_turn 3,668/16,303 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.369 / 0.380 / 0.375 / 0.314 / 0.453 |
| chosen branches that had won / lost within the horizon | 10.4% / 1.6% |

### Cycle 10, step a4: Bohemia, Nine Realms, World 6p

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| bo4a | 750 | jacob-sensei@1 121, delove@6 139, jacob-sensei@1 106, branch@1 382 | 39.7 | 2 | 306,030 |
| bo4b | 750 | jacob-sensei@1 75, branch@1 405, delove@6 195, jacob-sensei@1 72 | 25.8 | 3 | 205,688 |
| bo6a | 750 | jacob-sensei@1 104, delove@6 65, jacob-sensei@1 98, branch@1 321, delove@5 67, jacob-sensei@1 93 | 46.4 | 2 | 427,111 |
| bo6b | 750 | jacob-sensei@1 46, delove@6 127, jacob-sensei@1 50, delove@5 98, jacob-sensei@1 47, branch@1 382 | 51.1 | 0 | 472,742 |
| nr6a | 750 | jacob-sensei@1 93, delove@6 82, jacob-sensei@1 86, delove@5 86, jacob-sensei@1 77, branch@1 324 | 74.6 | 2 | 628,120 |
| nr6b | 750 | jacob-sensei@1 64, branch@1 351, delove@6 112, jacob-sensei@1 67, delove@5 95, jacob-sensei@1 58 | 49.0 | 3 | 483,414 |
| nr8a | 500 | jacob-sensei@1 38, branch@1 178, delove@6 31, jacob-sensei@1 42, delove@5 41, jacob-sensei@1 68, delove@6 41, jacob-sensei@1 60 | 63.0 | 1 | 443,136 |
| nr8b | 500 | jacob-sensei@1 26, delove@6 51, jacob-sensei@1 38, branch@1 201, delove@5 53, jacob-sensei@1 32, delove@6 65, jacob-sensei@1 34 | 90.0 | 0 | 586,062 |
| w6a | 500 | jacob-sensei@1 51, delove@6 45, jacob-sensei@1 57, branch@1 232, delove@5 59, jacob-sensei@1 52 | 89.0 | 4 | 569,353 |
| w6b | 500 | jacob-sensei@1 38, delove@6 71, jacob-sensei@1 24, delove@5 42, jacob-sensei@1 40, branch@1 285 | 53.1 | 0 | 436,946 |

**6,500 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 916,248 |
| branched (compared options) | 568,862 (62.1%) |
| simulations run | 13,543,776 (491,114,198 simulated moves) |
| changed the teacher's move | 195,934 (34.4% of branched) |
| average score gain per branched decision | +0.0160 |
| changes by kind | attack 122,373/371,888, place 47,960/127,329, fortify_from 12,635/33,160, trade 7,350/18,027, end_turn 5,616/18,458 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.380 / 0.413 / 0.392 / 0.320 / 0.505 |
| chosen branches that had won / lost within the horizon | 8.3% / 0.9% |

### Cycle 10, step b: the huge boards

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| ec6a | 500 | jacob-sensei@1 21, delove@6 95, branch@1 255, jacob-sensei@1 21, delove@5 78, jacob-sensei@1 30 | 101.5 | 0 | 754,766 |
| ec6b | 500 | jacob-sensei@1 52, delove@6 60, jacob-sensei@1 65, delove@5 40, branch@1 235, jacob-sensei@1 46 | 104.8 | 2 | 738,798 |
| fa10a | 500 | branch@1 223, jacob-sensei@1 18, delove@6 46, jacob-sensei@1 14, delove@5 40, jacob-sensei@1 14, delove@6 62, jacob-sensei@1 17, delove@5 47, jacob-sensei@1 19 | 149.3 | 0 | 1,052,470 |
| fa10b | 500 | jacob-sensei@1 49, delove@6 21, branch@1 168, jacob-sensei@1 52, delove@5 16, jacob-sensei@1 52, delove@6 16, jacob-sensei@1 56, delove@5 15, jacob-sensei@1 53 | 139.0 | 2 | 877,518 |
| fa6a | 500 | branch@1 254, jacob-sensei@1 47, delove@6 59, jacob-sensei@1 37, delove@5 54, jacob-sensei@1 49 | 60.4 | 0 | 560,079 |
| fa6b | 500 | jacob-sensei@1 66, delove@6 43, branch@1 221, jacob-sensei@1 72, delove@5 31, jacob-sensei@1 67 | 70.3 | 0 | 700,500 |
| ge10a | 500 | jacob-sensei@1 13, delove@6 68, jacob-sensei@1 22, delove@5 33, jacob-sensei@1 11, delove@6 70, branch@1 211, jacob-sensei@1 15, delove@5 47, jacob-sensei@1 10 | 232.0 | 0 | 1,738,346 |
| ge10b | 500 | jacob-sensei@1 64, delove@6 22, jacob-sensei@1 61, delove@5 19, jacob-sensei@1 55, delove@6 9, jacob-sensei@1 35, delove@5 12, branch@1 164, jacob-sensei@1 58 | 193.3 | 1 | 1,418,004 |
| ge6a | 500 | jacob-sensei@1 49, delove@6 47, branch@1 274, jacob-sensei@1 39, delove@5 45, jacob-sensei@1 46 | 78.9 | 0 | 916,805 |
| ge6b | 500 | jacob-sensei@1 70, delove@6 35, jacob-sensei@1 59, delove@5 26, branch@1 265, jacob-sensei@1 45 | 97.1 | 0 | 1,255,636 |
| w10a | 750 | jacob-sensei@1 27, delove@6 96, branch@1 276, jacob-sensei@1 32, delove@5 71, jacob-sensei@1 22, delove@6 94, jacob-sensei@1 34, delove@5 68, jacob-sensei@1 30 | 112.5 | 0 | 1,159,611 |
| w10b | 750 | jacob-sensei@1 59, delove@6 39, jacob-sensei@1 71, delove@5 37, branch@1 258, jacob-sensei@1 71, delove@6 44, jacob-sensei@1 68, delove@5 30, jacob-sensei@1 72 | 104.9 | 1 | 948,871 |
| wl10a | 500 | jacob-sensei@1 28, delove@6 33, jacob-sensei@1 29, delove@5 27, branch@1 212, jacob-sensei@1 44, delove@6 29, jacob-sensei@1 41, delove@5 27, jacob-sensei@1 30 | 81.8 | 0 | 802,011 |
| wl10b | 500 | jacob-sensei@1 54, delove@6 34, jacob-sensei@1 36, delove@5 30, jacob-sensei@1 40, delove@6 34, branch@1 153, jacob-sensei@1 54, delove@5 22, jacob-sensei@1 43 | 88.2 | 0 | 869,810 |

**7,500 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 2,132,740 |
| branched (compared options) | 1,262,352 (59.2%) |
| simulations run | 30,168,138 (1,839,891,869 simulated moves) |
| changed the teacher's move | 409,494 (32.4% of branched) |
| average score gain per branched decision | +0.0130 |
| changes by kind | attack 291,197/906,300, place 71,374/220,293, fortify_from 22,932/60,908, trade 13,124/32,992, end_turn 10,867/41,859 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.330 / 0.370 / 0.341 / 0.255 / 0.464 |
| chosen branches that had won / lost within the horizon | 5.2% / 0.6% |

### c10: ladder gate (c10-candidate)

| opponent | players | options | games | score | 95% interval | Elo | points | opp. points | points diff (95%) | place | kills | turn limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| delove@6 | 2 | {} | 800 | 0.500 | 0.472-0.528 | 0 | +0.50 | +0.50 | +0.00 (-0.19 to +0.19) | 1.50 | 0.50 | 0 |
| delove@6 | 4 | {} | 200 | 0.517 | 0.461-0.574 | +12 | +0.24 | +0.08 | +0.16 (-0.24 to +0.57) | 2.48 | 0.64 | 43 |
| delove@6 | 6 | {} | 200 | 0.573 | 0.511-0.634 | +51 | +0.63 | +0.46 | +0.17 (-0.21 to +0.55) | 3.51 | 0.89 | 15 |
| delove@6 | 6 | {"map":"world"} | 200 | 0.505 | 0.434-0.576 | +3 | +0.86 | +0.73 | +0.13 (-0.20 to +0.47) | 3.45 | 0.82 | 2 |
| delove@6 | 10 | {"map":"world"} | 200 | 0.547 | 0.478-0.617 | +33 | +1.18 | +0.57 | +0.61 (+0.13 to +1.08) | 5.32 | 1.00 | 1 |
| delove@6 | 6 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"progressive","capitals":true,"blizzards":8} | 200 | 0.570 | 0.519-0.621 | +49 | -0.72 | -1.16 | +0.43 (+0.11 to +0.76) | 3.33 | 0.44 | 86 |
| delove@6 | 6 | {"map":"world","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"fixed","capitals":true} | 200 | 0.583 | 0.517-0.648 | +58 | +0.47 | +0.22 | +0.25 (-0.06 to +0.55) | 3.45 | 0.51 | 5 |
| delove@6 | 4 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"exponential","blizzards":8} | 200 | 0.570 | 0.508-0.632 | +49 | +0.59 | +0.14 | +0.45 (+0.02 to +0.87) | 2.42 | 0.74 | 28 |
| delove@6 | 2 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"exponential","blizzards":8} | 400 | 0.512 | 0.472-0.553 | +9 | +0.47 | +0.40 | +0.07 (-0.17 to +0.32) | 1.49 | 0.49 | 18 |
| delove@6 | 6 | {"map":"bohemia","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"progressive"} | 200 | 0.515 | 0.442-0.588 | +10 | +0.71 | +0.80 | -0.08 (-0.46 to +0.29) | 3.55 | 0.86 | 4 |
| delove@6 | 8 | {"map":"nine_realms","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"fixed","capitals":true} | 200 | 0.552 | 0.492-0.613 | +37 | -0.16 | -0.14 | -0.01 (-0.33 to +0.30) | 4.52 | 0.61 | 33 |
| jacob-sensei@1 | 6 | {"map":"world"} | 200 | 0.393 | 0.323-0.462 | -76 | +0.45 | +1.18 | -0.73 (-0.98 to -0.49) | 3.56 | 0.54 | 1 |
| delove-teacher@2 | 2 | {} | 400 | 0.650 | 0.609-0.691 | +108 | +0.94 | +0.04 | +0.90 (+0.63 to +1.17) | 1.35 | 0.65 | 4 |

### c10: time per phase (minutes from the start)

| phase | minutes |
| --- | --- |
| start | 0.0 |
| generation done | 0.0 |
| generated and exported the GPU steps (remote, 10 GPUs) | 48.0 |
| exports done | 48.0 |
| trained c10-candidate | 84.6 |
| gates done | 97.0 |
| summary | 97.0 |

**Recheck: none needed.** No multiplayer table is below 0 beyond noise (Bohemia -0.08, Nine Realms -0.01, both
intervals across 0).

### c10: stage games for Mid / Close Range (#137, `c10s.cycle`)

`#137` merged while the main games were already playing, so its stage tables (`scripts/stage/mid.jobs`, `close.jobs`,
4,300 games each, `delove@6` seats, same branch settings, seed 3101) ran as a second, generate-only run on the home
GPU: the pod planner prices stage tables as whole games (about 16 GPU-hours, $14) and refused its cap. At home: 3 alive
(`c10-sm`, 11 maps) 2 h 00 wall (45 min of play; it shared the GPU with the candidate's and Long Range's training),
2 alive (`c10-sc`) 27 min. Cycle 11 times them on pods from these logs (`REMOTE_TIMINGS`).

### c10: the first range specialists (`c10-specialists.sh`)

Each fine-tuned from `delove@6` with its own objective (`train.py --range`, #132), 1.5 epochs, on cycle 10's games plus
cycle 9's at 0.4; Mid adds `c10-sm`, Close `c10-sm` and `c10-sc`. Measured with `npm run delove:stages` (seed 1,
default tables) against the **current base `delove@7`**:

| specialist | rows trained | stage result vs `delove@7` (95%) | vs `delove@6` | verdict |
| --- | --- | --- | --- | --- |
| Long Range (`c10-long`, 4-10 alive) | 4.68M | points -0.06 (-0.37 to +0.25), P(top 3) +0.006, 200 positions | points **+0.30 (+0.01 to +0.58)** | even |
| Mid Range (`c10-mid`, 3 alive) | 0.97M | P(top 2) +0.002 (-0.039 to +0.043), points -0.02, 300 positions | P(top 2) -0.004 | even |
| Close Range (`c10-close`, 2 alive) | 2.01M | win +0.004 (-0.033 to +0.040), 800 games; Classic 4p +0.07 (+0.01 to +0.13) | | even |
| routed trio (full games) | | points -0.07 (-0.34 to +0.20), 400 games; Classic 2p win -0.175 (80 games), Classic 4p +0.69 points | | even |

**Not promoted:** each is even with `delove@7`, which gained as much as Long Range did from the same games. Each line
starts again in cycle 11, from `delove@7`.

### c10: time per phase

| phase | where | minutes |
| --- | --- | --- |
| all 40,000 games (5 steps) | 10 rented RunPod RTX 4090s, 0 bad pods | **47.9** (5.00 pod-hours, **$4.45**) |
| training (22,736 steps, `--amp`) | home GPU | 36.6 |
| gates (13 matches) | home CPU | 12.4 |
| **candidate cycle** | | **1 h 37 min** |
| stage games (8,600) | home GPU, alongside | 2 h 27 min, $0 |
| three specialists | home GPU | 26 + 9 + 9 |
| stage yardstick (4 calls vs `delove@7`, 3 vs `delove@6`) | home CPU | about 35 |

**Review: promoted to `delove@7`.** Against `delove@6` it is clearly better on leaderboard points at 4-10 players:
pooled over the 9 multiplayer tables about **+0.23 per seat (95% +0.11 to +0.36)**, with World 10p +0.61, league
Classic 6p +0.43 and league Classic 4p +0.45 significant and no table clearly below 0; even at 2 players (0.500 over 800
games, league 2p +0.07). 0.650 vs Sensei 2; **0.393 vs Jacob Sensei** at World 6p (`delove@6`: 0.355): the student
still trails the teacher in multiplayer, which cycle 12's soft targets aim at. The 4-option search (#141) changed the
teacher's move on 37% of branched decisions.

## Cycle 11

## c11

### Cycle 11, step a1: Classic 4-player

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| c4a | 1,000 | jacob-sensei@1 136, branch@1 534, delove@7 184, jacob-sensei@1 146 | 43.8 | 0 | 581,680 |
| c4b | 1,000 | jacob-sensei@1 69, delove@7 324, jacob-sensei@1 67, branch@1 540 | 30.0 | 0 | 365,529 |
| c4c | 1,000 | jacob-sensei@1 138, branch@1 504, delove@7 204, jacob-sensei@1 147 | 46.2 | 7 | 472,702 |
| c4d | 1,000 | jacob-sensei@1 82, delove@7 282, jacob-sensei@1 80, branch@1 552 | 27.4 | 4 | 295,486 |

**4,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 472,010 |
| branched (compared options) | 298,669 (63.3%) |
| simulations run | 8,795,280 (234,860,515 simulated moves) |
| changed the teacher's move | 121,012 (40.5% of branched) |
| average score gain per branched decision | +0.0201 |
| changes by kind | attack 71,665/189,535, place 30,871/67,574, fortify_from 8,453/19,215, trade 5,209/11,014, end_turn 4,814/11,331 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.415 / 0.450 / 0.433 / 0.367 / 0.553 |
| chosen branches that had won / lost within the horizon | 8.5% / 0.9% |

### Cycle 11, step a2: Classic 2p, Four Crowns 1v1, Classic 6p

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| c2a | 2,000 | branch@1 1350, jacob-sensei@1 650 | 19.4 | 0 | 421,447 |
| c2b | 2,000 | branch@1 1193, delove@7 807 | 3.4 | 0 | 75,439 |
| c2c | 2,000 | jacob-sensei@1 674, branch@1 1326 | 17.2 | 0 | 322,233 |
| c2d | 2,000 | delove@7 777, branch@1 1221 | 5.0 | 2 | 91,031 |
| c6a | 1,000 | jacob-sensei@1 119, delove@7 144, jacob-sensei@1 105, delove@6 100, jacob-sensei@1 105, branch@1 423 | 53.8 | 4 | 533,960 |
| c6b | 1,000 | jacob-sensei@1 68, branch@1 404, delove@7 227, jacob-sensei@1 68, delove@6 153, jacob-sensei@1 69 | 42.2 | 11 | 434,265 |
| mca | 3,000 | branch@1 1910, jacob-sensei@1 1088 | 16.7 | 2 | 415,670 |
| mcb | 3,000 | branch@1 1693, delove@7 1305 | 4.4 | 2 | 89,846 |

**16,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 940,272 |
| branched (compared options) | 619,343 (65.9%) |
| simulations run | 18,070,500 (292,907,921 simulated moves) |
| changed the teacher's move | 246,328 (39.8% of branched) |
| average score gain per branched decision | +0.0264 |
| changes by kind | attack 125,695/359,115, place 69,850/163,934, fortify_from 29,911/56,237, end_turn 10,692/18,246, trade 10,180/21,811 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.545 / 0.581 / 0.576 / 0.516 / 0.650 |
| chosen branches that had won / lost within the horizon | 11.5% / 1.6% |

### Cycle 11, step a3: Europe 8p, USA 10p, Asia 8p

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| as8a | 1,000 | jacob-sensei@1 92, branch@1 335, delove@7 108, jacob-sensei@1 88, delove@6 95, jacob-sensei@1 84, delove@7 107, jacob-sensei@1 91 | 51.8 | 0 | 678,464 |
| as8b | 1,000 | jacob-sensei@1 33, delove@7 174, jacob-sensei@1 25, branch@1 398, delove@6 131, jacob-sensei@1 22, delove@7 171, jacob-sensei@1 43 | 74.3 | 3 | 921,222 |
| eu8a | 1,000 | jacob-sensei@1 115, delove@7 92, jacob-sensei@1 74, delove@6 55, jacob-sensei@1 100, branch@1 358, delove@7 98, jacob-sensei@1 108 | 46.6 | 0 | 583,765 |
| eu8b | 1,000 | jacob-sensei@1 34, delove@7 155, jacob-sensei@1 30, delove@6 129, jacob-sensei@1 36, delove@7 172, jacob-sensei@1 31, branch@1 412 | 65.1 | 1 | 816,868 |
| us10a | 1,000 | jacob-sensei@1 71, delove@7 88, jacob-sensei@1 85, delove@6 57, jacob-sensei@1 83, branch@1 334, delove@7 77, jacob-sensei@1 78, delove@6 58, jacob-sensei@1 68 | 62.9 | 1 | 641,245 |
| us10b | 1,000 | jacob-sensei@1 46, delove@7 127, jacob-sensei@1 44, delove@6 111, jacob-sensei@1 52, delove@7 127, jacob-sensei@1 44, branch@1 308, delove@6 90, jacob-sensei@1 45 | 53.3 | 6 | 592,832 |

**6,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 653,177 |
| branched (compared options) | 407,573 (62.4%) |
| simulations run | 11,962,164 (539,632,529 simulated moves) |
| changed the teacher's move | 157,621 (38.7% of branched) |
| average score gain per branched decision | +0.0184 |
| changes by kind | attack 102,544/266,666, place 39,660/96,711, fortify_from 5,899/15,604, trade 5,776/12,702, end_turn 3,742/15,890 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.364 / 0.376 / 0.371 / 0.312 / 0.450 |
| chosen branches that had won / lost within the horizon | 10.5% / 1.8% |

### Cycle 11, step a4: Bohemia, Nine Realms, World 6p

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| bo4a | 750 | jacob-sensei@1 117, delove@7 172, jacob-sensei@1 109, branch@1 351 | 36.7 | 1 | 296,156 |
| bo4b | 750 | jacob-sensei@1 89, branch@1 396, delove@7 196, jacob-sensei@1 65 | 26.3 | 4 | 208,904 |
| bo6a | 750 | jacob-sensei@1 82, delove@7 89, jacob-sensei@1 87, branch@1 321, delove@6 81, jacob-sensei@1 89 | 45.3 | 1 | 417,809 |
| bo6b | 750 | jacob-sensei@1 44, delove@7 121, jacob-sensei@1 51, delove@6 108, jacob-sensei@1 55, branch@1 371 | 49.9 | 0 | 458,404 |
| nr6a | 750 | jacob-sensei@1 87, delove@7 98, jacob-sensei@1 83, delove@6 79, jacob-sensei@1 80, branch@1 316 | 77.5 | 7 | 633,367 |
| nr6b | 750 | jacob-sensei@1 59, branch@1 340, delove@7 137, jacob-sensei@1 47, delove@6 105, jacob-sensei@1 62 | 48.0 | 0 | 479,983 |
| nr8a | 500 | jacob-sensei@1 59, branch@1 178, delove@7 31, jacob-sensei@1 44, delove@6 44, jacob-sensei@1 51, delove@7 52, jacob-sensei@1 41 | 60.4 | 0 | 424,127 |
| nr8b | 500 | jacob-sensei@1 36, delove@7 65, jacob-sensei@1 31, branch@1 202, delove@6 46, jacob-sensei@1 31, delove@7 57, jacob-sensei@1 31 | 86.8 | 1 | 560,496 |
| w6a | 500 | jacob-sensei@1 42, delove@7 69, jacob-sensei@1 51, branch@1 222, delove@6 60, jacob-sensei@1 54 | 85.2 | 2 | 554,207 |
| w6b | 500 | jacob-sensei@1 35, delove@7 78, jacob-sensei@1 37, delove@6 47, jacob-sensei@1 44, branch@1 258 | 53.9 | 1 | 435,870 |

**6,500 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 880,335 |
| branched (compared options) | 548,709 (62.3%) |
| simulations run | 16,142,424 (587,931,805 simulated moves) |
| changed the teacher's move | 205,843 (37.5% of branched) |
| average score gain per branched decision | +0.0175 |
| changes by kind | attack 127,319/360,094, place 51,678/120,676, fortify_from 12,173/31,468, trade 8,701/18,600, end_turn 5,972/17,871 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.379 / 0.413 / 0.391 / 0.319 / 0.512 |
| chosen branches that had won / lost within the horizon | 8.4% / 1.0% |

### Cycle 11, step b: the huge boards

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| ec6a | 500 | jacob-sensei@1 19, delove@7 108, branch@1 253, jacob-sensei@1 19, delove@6 83, jacob-sensei@1 18 | 97.0 | 0 | 722,218 |
| ec6b | 500 | jacob-sensei@1 41, delove@7 68, jacob-sensei@1 46, delove@6 40, branch@1 245, jacob-sensei@1 59 | 101.3 | 1 | 724,381 |
| fa10a | 500 | branch@1 180, jacob-sensei@1 20, delove@7 48, jacob-sensei@1 18, delove@6 51, jacob-sensei@1 21, delove@7 65, jacob-sensei@1 21, delove@6 43, jacob-sensei@1 32 | 154.1 | 1 | 1,094,797 |
| fa10b | 500 | jacob-sensei@1 47, delove@7 15, branch@1 174, jacob-sensei@1 48, delove@6 22, jacob-sensei@1 50, delove@7 23, jacob-sensei@1 51, delove@6 21, jacob-sensei@1 48 | 134.5 | 1 | 849,426 |
| fa6a | 500 | branch@1 265, jacob-sensei@1 42, delove@7 68, jacob-sensei@1 40, delove@6 52, jacob-sensei@1 33 | 58.3 | 0 | 535,030 |
| fa6b | 500 | jacob-sensei@1 50, delove@7 39, branch@1 228, jacob-sensei@1 70, delove@6 42, jacob-sensei@1 71 | 69.1 | 0 | 686,016 |
| ge10a | 500 | jacob-sensei@1 14, delove@7 78, jacob-sensei@1 9, delove@6 45, jacob-sensei@1 14, delove@7 64, branch@1 199, jacob-sensei@1 19, delove@6 49, jacob-sensei@1 9 | 231.1 | 0 | 1,737,293 |
| ge10b | 500 | jacob-sensei@1 59, delove@7 23, jacob-sensei@1 63, delove@6 14, jacob-sensei@1 54, delove@7 21, jacob-sensei@1 55, delove@6 12, branch@1 154, jacob-sensei@1 43 | 191.3 | 2 | 1,387,466 |
| ge6a | 500 | jacob-sensei@1 30, delove@7 54, branch@1 299, jacob-sensei@1 32, delove@6 42, jacob-sensei@1 43 | 76.5 | 0 | 880,965 |
| ge6b | 500 | jacob-sensei@1 60, delove@7 41, jacob-sensei@1 51, delove@6 35, branch@1 272, jacob-sensei@1 41 | 93.5 | 0 | 1,195,550 |
| w10a | 750 | jacob-sensei@1 30, delove@7 102, branch@1 295, jacob-sensei@1 27, delove@6 64, jacob-sensei@1 23, delove@7 115, jacob-sensei@1 25, delove@6 51, jacob-sensei@1 18 | 109.1 | 0 | 1,115,460 |
| w10b | 750 | jacob-sensei@1 51, delove@7 51, jacob-sensei@1 69, delove@6 30, branch@1 289, jacob-sensei@1 61, delove@7 41, jacob-sensei@1 68, delove@6 37, jacob-sensei@1 53 | 102.6 | 0 | 926,256 |
| wl10a | 500 | jacob-sensei@1 39, delove@7 34, jacob-sensei@1 34, delove@6 26, branch@1 214, jacob-sensei@1 36, delove@7 24, jacob-sensei@1 39, delove@6 28, jacob-sensei@1 26 | 79.6 | 0 | 779,116 |
| wl10b | 500 | jacob-sensei@1 41, delove@7 31, jacob-sensei@1 44, delove@6 32, jacob-sensei@1 39, delove@7 30, branch@1 175, jacob-sensei@1 43, delove@6 23, jacob-sensei@1 41 | 86.1 | 1 | 830,887 |

**7,500 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 2,075,128 |
| branched (compared options) | 1,231,646 (59.4%) |
| simulations run | 36,564,894 (2,218,554,269 simulated moves) |
| changed the teacher's move | 438,942 (35.6% of branched) |
| average score gain per branched decision | +0.0145 |
| changes by kind | attack 310,528/889,483, place 77,855/208,918, fortify_from 23,193/58,072, trade 16,081/34,615, end_turn 11,285/40,558 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.334 / 0.379 / 0.347 / 0.259 / 0.485 |
| chosen branches that had won / lost within the horizon | 5.8% / 0.5% |

### c11: ladder gate (c11-candidate)

| opponent | players | options | games | score | 95% interval | Elo | points | opp. points | points diff (95%) | place | kills | turn limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| delove@7 | 2 | {} | 800 | 0.505 | 0.479-0.531 | +3 | +0.52 | +0.48 | +0.03 (-0.10 to +0.16) | 1.50 | 0.51 | 0 |
| delove@7 | 4 | {} | 200 | 0.527 | 0.467-0.588 | +19 | +0.48 | +0.22 | +0.27 (-0.09 to +0.63) | 2.43 | 0.69 | 29 |
| delove@7 | 6 | {} | 200 | 0.550 | 0.489-0.611 | +35 | +0.63 | +0.19 | +0.44 (+0.04 to +0.83) | 3.43 | 0.83 | 22 |
| delove@7 | 6 | {"map":"world"} | 200 | 0.588 | 0.524-0.651 | +61 | +1.07 | +0.48 | +0.60 (+0.10 to +1.10) | 3.37 | 0.95 | 3 |
| delove@7 | 10 | {"map":"world"} | 200 | 0.630 | 0.568-0.692 | +92 | +1.40 | +0.40 | +1.01 (+0.58 to +1.44) | 5.24 | 1.11 | 0 |
| delove@7 | 6 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"progressive","capitals":true,"blizzards":8} | 200 | 0.568 | 0.522-0.613 | +47 | -1.30 | -1.54 | +0.24 (+0.03 to +0.45) | 3.52 | 0.35 | 113 |
| delove@7 | 6 | {"map":"world","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"fixed","capitals":true} | 200 | 0.613 | 0.543-0.682 | +80 | +0.53 | +0.24 | +0.29 (-0.03 to +0.62) | 3.41 | 0.46 | 1 |
| delove@7 | 4 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"exponential","blizzards":8} | 200 | 0.555 | 0.495-0.615 | +38 | +0.76 | +0.47 | +0.28 (-0.17 to +0.74) | 2.43 | 0.79 | 10 |
| delove@7 | 2 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"exponential","blizzards":8} | 400 | 0.512 | 0.474-0.551 | +9 | +0.52 | +0.44 | +0.07 (-0.16 to +0.31) | 1.49 | 0.51 | 6 |
| delove@7 | 6 | {"map":"bohemia","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"progressive"} | 200 | 0.515 | 0.441-0.589 | +10 | +0.70 | +0.81 | -0.11 (-0.76 to +0.53) | 3.56 | 0.86 | 4 |
| delove@7 | 8 | {"map":"nine_realms","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"fixed","capitals":true} | 200 | 0.613 | 0.549-0.676 | +80 | +0.04 | -0.20 | +0.24 (-0.00 to +0.49) | 4.54 | 0.65 | 31 |
| jacob-sensei@1 | 6 | {"map":"world"} | 200 | 0.445 | 0.370-0.520 | -38 | +0.71 | +0.96 | -0.25 (-0.58 to +0.07) | 3.44 | 0.61 | 0 |
| delove-teacher@2 | 2 | {} | 400 | 0.690 | 0.651-0.729 | +139 | +1.03 | -0.11 | +1.14 (+0.83 to +1.45) | 1.31 | 0.68 | 10 |

### c11: time per phase (minutes from the start)

| phase | minutes |
| --- | --- |
| start | 0.0 |
| generation done | 0.0 |
| generated and exported the GPU steps (remote, 10 GPUs) | 47.8 |
| exports done | 47.8 |
| trained c11-candidate | 73.6 |
| gates done | 83.8 |
| summary | 83.8 |

### c11: phases and review

| phase | where | minutes |
| --- | --- | --- |
| all 40,000 games (5 steps) | 10 rented RunPod RTX 4090s, 0 bad pods | **47.8** (5.26 pod-hours, **$4.69**) |
| training (22,107 steps, `--amp`) | home GPU | 25.8 |
| gates (13 matches) | home CPU | 10.2 |
| **whole cycle** | | **1 h 24 min** |

Base model only (research plan): cycle 10's specialists were even with the base, so no stage games or specialists
this cycle. Teacher Jacob Sensei 1: Jacob Sensei 2 (#144) was still in its GPU re-verify at launch. The pod steps
write `branch_q.npy` (#145), unused here, kept for cycle 12's soft targets.

**Review: promoted to `delove@8`.** Against `delove@7`, with the search comparing **5 options** per decision: pooled
over the 9 multiplayer tables about **+0.36 leaderboard points per seat (95% +0.22 to +0.50)**, with Classic 6p +0.44,
World 6p +0.60, World 10p +1.01 and league Classic 6p +0.24 significant and no table clearly below 0 (Bohemia -0.11,
Nine Realms +0.24); even at 2 players (0.505 over 800 games). 0.690 vs Sensei 2; **0.445 vs Jacob Sensei** at World 6p
(cycles 9-11: 0.355, 0.393, 0.445).

## Cycle 12

## c12

### Cycle 12, step a1: Classic 4-player

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| c4a | 1,000 | jacob-sensei@1 115, branch@1 560, delove@8 194, jacob-sensei@1 131 | 41.7 | 0 | 551,791 |
| c4b | 1,000 | jacob-sensei@1 52, delove@8 383, jacob-sensei@1 57, branch@1 507 | 29.8 | 1 | 360,768 |
| c4c | 1,000 | jacob-sensei@1 145, branch@1 459, delove@8 246, jacob-sensei@1 142 | 45.7 | 8 | 457,697 |
| c4d | 1,000 | jacob-sensei@1 82, delove@8 358, jacob-sensei@1 82, branch@1 476 | 26.2 | 2 | 291,606 |

**4,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 457,360 |
| branched (compared options) | 288,799 (63.1%) |
| simulations run | 8,487,780 (221,758,724 simulated moves) |
| changed the teacher's move | 112,727 (39.0% of branched) |
| average score gain per branched decision | +0.0200 |
| changes by kind | attack 65,660/183,316, place 28,569/64,364, fortify_from 7,936/19,044, end_turn 5,460/11,383, trade 5,102/10,692 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.416 / 0.455 / 0.438 / 0.373 / 0.550 |
| chosen branches that had won / lost within the horizon | 9.1% / 1.1% |

### Cycle 12, step a2: Classic 2p, Four Crowns 1v1, Classic 6p

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| c2a | 2,000 | branch@1 1317, jacob-sensei@1 683 | 19.2 | 0 | 424,374 |
| c2b | 2,000 | branch@1 1177, delove@8 823 | 3.3 | 0 | 73,764 |
| c2c | 2,000 | jacob-sensei@1 686, branch@1 1314 | 17.2 | 0 | 329,468 |
| c2d | 2,000 | delove@8 811, branch@1 1184 | 5.9 | 5 | 94,234 |
| c6a | 1,000 | jacob-sensei@1 115, delove@8 148, jacob-sensei@1 107, delove@7 126, jacob-sensei@1 93, branch@1 399 | 55.6 | 12 | 524,441 |
| c6b | 1,000 | jacob-sensei@1 44, branch@1 396, delove@8 247, jacob-sensei@1 40, delove@7 200, jacob-sensei@1 67 | 39.0 | 6 | 419,545 |
| mca | 3,000 | branch@1 1791, jacob-sensei@1 1209 | 16.2 | 0 | 406,398 |
| mcb | 3,000 | branch@1 1683, delove@8 1303 | 7.9 | 14 | 119,330 |

**16,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 946,921 |
| branched (compared options) | 629,252 (66.5%) |
| simulations run | 18,335,082 (297,239,678 simulated moves) |
| changed the teacher's move | 250,514 (39.8% of branched) |
| average score gain per branched decision | +0.0274 |
| changes by kind | attack 127,475/362,289, place 72,587/170,277, fortify_from 29,025/53,758, end_turn 10,940/21,117, trade 10,487/21,811 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.538 / 0.573 / 0.570 / 0.513 / 0.639 |
| chosen branches that had won / lost within the horizon | 11.5% / 3.2% |

### Cycle 12, step a3: Europe 8p, USA 10p, Asia 8p

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| as8a | 1,000 | jacob-sensei@1 67, branch@1 421, delove@8 116, jacob-sensei@1 76, delove@7 75, jacob-sensei@1 71, delove@8 109, jacob-sensei@1 65 | 49.2 | 0 | 633,687 |
| as8b | 1,000 | jacob-sensei@1 22, delove@8 186, jacob-sensei@1 21, branch@1 349, delove@7 145, jacob-sensei@1 26, delove@8 215, jacob-sensei@1 32 | 69.9 | 4 | 868,043 |
| eu8a | 1,000 | jacob-sensei@1 85, delove@8 85, jacob-sensei@1 93, delove@7 79, jacob-sensei@1 85, branch@1 387, delove@8 94, jacob-sensei@1 92 | 45.1 | 0 | 557,911 |
| eu8b | 1,000 | jacob-sensei@1 39, delove@8 190, jacob-sensei@1 36, delove@7 114, jacob-sensei@1 32, delove@8 186, jacob-sensei@1 32, branch@1 364 | 63.6 | 7 | 776,548 |
| us10a | 1,000 | jacob-sensei@1 64, delove@8 89, jacob-sensei@1 80, delove@7 60, jacob-sensei@1 55, branch@1 344, delove@8 79, jacob-sensei@1 85, delove@7 79, jacob-sensei@1 64 | 61.1 | 1 | 618,476 |
| us10b | 1,000 | jacob-sensei@1 32, delove@8 145, jacob-sensei@1 35, delove@7 95, jacob-sensei@1 25, delove@8 132, jacob-sensei@1 28, branch@1 364, delove@7 111, jacob-sensei@1 28 | 52.8 | 5 | 584,149 |

**6,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 636,737 |
| branched (compared options) | 395,985 (62.2%) |
| simulations run | 11,590,254 (520,067,970 simulated moves) |
| changed the teacher's move | 142,807 (36.1% of branched) |
| average score gain per branched decision | +0.0179 |
| changes by kind | attack 90,216/258,927, place 37,995/94,751, trade 5,669/11,928, fortify_from 5,181/14,566, end_turn 3,746/15,813 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.388 / 0.403 / 0.398 / 0.343 / 0.473 |
| chosen branches that had won / lost within the horizon | 13.7% / 2.5% |

### Cycle 12, step a4: Bohemia, Nine Realms, World 6p

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| bo4a | 750 | jacob-sensei@1 116, delove@8 166, jacob-sensei@1 120, branch@1 347 | 36.8 | 1 | 296,001 |
| bo4b | 750 | jacob-sensei@1 58, branch@1 357, delove@8 262, jacob-sensei@1 73 | 22.7 | 0 | 191,410 |
| bo6a | 750 | jacob-sensei@1 78, delove@8 86, jacob-sensei@1 102, branch@1 323, delove@7 81, jacob-sensei@1 80 | 44.1 | 0 | 415,586 |
| bo6b | 750 | jacob-sensei@1 61, delove@8 151, jacob-sensei@1 40, delove@7 145, jacob-sensei@1 42, branch@1 310 | 48.5 | 1 | 448,424 |
| nr6a | 750 | jacob-sensei@1 91, delove@8 91, jacob-sensei@1 79, delove@7 86, jacob-sensei@1 78, branch@1 318 | 74.6 | 7 | 625,026 |
| nr6b | 750 | jacob-sensei@1 52, branch@1 312, delove@8 135, jacob-sensei@1 67, delove@7 132, jacob-sensei@1 51 | 45.9 | 1 | 466,974 |
| nr8a | 500 | jacob-sensei@1 45, branch@1 180, delove@8 51, jacob-sensei@1 54, delove@7 33, jacob-sensei@1 50, delove@8 50, jacob-sensei@1 37 | 58.2 | 0 | 409,843 |
| nr8b | 500 | jacob-sensei@1 38, delove@8 61, jacob-sensei@1 32, branch@1 189, delove@7 75, jacob-sensei@1 23, delove@8 63, jacob-sensei@1 17 | 84.8 | 2 | 553,815 |
| w6a | 500 | jacob-sensei@1 23, delove@8 97, jacob-sensei@1 37, branch@1 230, delove@7 70, jacob-sensei@1 42 | 80.4 | 1 | 531,597 |
| w6b | 500 | jacob-sensei@1 26, delove@8 94, jacob-sensei@1 26, delove@7 67, jacob-sensei@1 38, branch@1 248 | 51.0 | 1 | 411,174 |

**6,500 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 846,441 |
| branched (compared options) | 525,782 (62.1%) |
| simulations run | 15,433,932 (550,094,482 simulated moves) |
| changed the teacher's move | 186,191 (35.4% of branched) |
| average score gain per branched decision | +0.0162 |
| changes by kind | attack 113,157/346,413, place 47,727/113,058, fortify_from 11,601/31,430, trade 8,439/17,732, end_turn 5,267/17,149 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.383 / 0.420 / 0.398 / 0.327 / 0.517 |
| chosen branches that had won / lost within the horizon | 9.3% / 1.1% |

### Cycle 12, step b: the huge boards

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| ec6a | 500 | jacob-sensei@1 17, delove@8 133, branch@1 209, jacob-sensei@1 26, delove@7 91, jacob-sensei@1 24 | 92.4 | 0 | 695,381 |
| ec6b | 500 | jacob-sensei@1 51, delove@8 72, jacob-sensei@1 46, delove@7 54, branch@1 236, jacob-sensei@1 40 | 99.1 | 1 | 712,092 |
| fa10a | 500 | branch@1 183, jacob-sensei@1 17, delove@8 73, jacob-sensei@1 13, delove@7 56, jacob-sensei@1 17, delove@8 58, jacob-sensei@1 15, delove@7 54, jacob-sensei@1 13 | 141.4 | 1 | 1,004,565 |
| fa10b | 500 | jacob-sensei@1 56, delove@8 21, branch@1 178, jacob-sensei@1 38, delove@7 28, jacob-sensei@1 48, delove@8 24, jacob-sensei@1 46, delove@7 15, jacob-sensei@1 46 | 130.9 | 0 | 830,786 |
| fa6a | 500 | branch@1 246, jacob-sensei@1 34, delove@8 74, jacob-sensei@1 44, delove@7 62, jacob-sensei@1 40 | 56.6 | 0 | 522,319 |
| fa6b | 500 | jacob-sensei@1 74, delove@8 46, branch@1 225, jacob-sensei@1 60, delove@7 34, jacob-sensei@1 60 | 67.2 | 1 | 660,309 |
| ge10a | 500 | jacob-sensei@1 6, delove@8 73, jacob-sensei@1 10, delove@7 59, jacob-sensei@1 10, delove@8 67, branch@1 197, jacob-sensei@1 11, delove@7 53, jacob-sensei@1 14 | 223.0 | 0 | 1,675,631 |
| ge10b | 500 | jacob-sensei@1 38, delove@8 20, jacob-sensei@1 56, delove@7 12, jacob-sensei@1 60, delove@8 15, jacob-sensei@1 49, delove@7 13, branch@1 183, jacob-sensei@1 53 | 185.1 | 1 | 1,354,514 |
| ge6a | 500 | jacob-sensei@1 31, delove@8 77, branch@1 266, jacob-sensei@1 36, delove@7 59, jacob-sensei@1 31 | 73.1 | 0 | 839,000 |
| ge6b | 500 | jacob-sensei@1 50, delove@8 33, jacob-sensei@1 54, delove@7 36, branch@1 274, jacob-sensei@1 53 | 90.0 | 0 | 1,147,611 |
| w10a | 750 | jacob-sensei@1 15, delove@8 117, branch@1 249, jacob-sensei@1 17, delove@7 87, jacob-sensei@1 19, delove@8 130, jacob-sensei@1 13, delove@7 88, jacob-sensei@1 12 | 107.2 | 3 | 1,103,751 |
| w10b | 750 | jacob-sensei@1 53, delove@8 58, jacob-sensei@1 50, delove@7 49, branch@1 272, jacob-sensei@1 57, delove@8 58, jacob-sensei@1 53, delove@7 50, jacob-sensei@1 49 | 99.8 | 1 | 910,337 |
| wl10a | 500 | jacob-sensei@1 29, delove@8 36, jacob-sensei@1 25, delove@7 31, branch@1 223, jacob-sensei@1 29, delove@8 31, jacob-sensei@1 33, delove@7 34, jacob-sensei@1 29 | 75.3 | 0 | 716,404 |
| wl10b | 500 | jacob-sensei@1 40, delove@8 33, jacob-sensei@1 31, delove@7 30, jacob-sensei@1 34, delove@8 28, branch@1 203, jacob-sensei@1 34, delove@7 24, jacob-sensei@1 43 | 82.9 | 0 | 808,473 |

**7,500 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 1,966,809 |
| branched (compared options) | 1,167,999 (59.4%) |
| simulations run | 34,616,070 (2,032,867,413 simulated moves) |
| changed the teacher's move | 397,921 (34.1% of branched) |
| average score gain per branched decision | +0.0139 |
| changes by kind | attack 274,256/838,479, place 74,515/198,744, fortify_from 21,496/57,041, trade 15,655/33,393, end_turn 11,999/40,342 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.342 / 0.387 / 0.355 / 0.271 / 0.490 |
| chosen branches that had won / lost within the horizon | 7.3% / 0.7% |

### c12: ladder gate (c12-candidate)

| opponent | players | options | games | score | 95% interval | Elo | points | opp. points | points diff (95%) | place | kills | turn limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| delove@8 | 2 | {} | 800 | 0.497 | 0.471-0.524 | -2 | +0.49 | +0.51 | -0.01 (-0.15 to +0.12) | 1.50 | 0.50 | 0 |
| delove@8 | 4 | {} | 200 | 0.522 | 0.459-0.586 | +16 | +0.62 | +0.47 | +0.15 (-0.07 to +0.38) | 2.48 | 0.74 | 15 |
| delove@8 | 6 | {} | 200 | 0.588 | 0.525-0.650 | +61 | +0.74 | +0.43 | +0.31 (-0.09 to +0.72) | 3.46 | 0.90 | 13 |
| delove@8 | 6 | {"map":"world"} | 200 | 0.613 | 0.539-0.686 | +80 | +1.13 | +0.50 | +0.63 (+0.44 to +0.82) | 3.40 | 1.01 | 1 |
| delove@8 | 10 | {"map":"world"} | 200 | 0.552 | 0.489-0.616 | +37 | +1.05 | +0.69 | +0.36 (-0.08 to +0.79) | 5.42 | 0.97 | 1 |
| delove@8 | 6 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"progressive","capitals":true,"blizzards":8} | 200 | 0.507 | 0.461-0.554 | +5 | -1.43 | -1.63 | +0.19 (-0.16 to +0.55) | 3.35 | 0.30 | 119 |
| delove@8 | 6 | {"map":"world","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"fixed","capitals":true} | 200 | 0.555 | 0.486-0.624 | +38 | +0.58 | +0.35 | +0.23 (-0.28 to +0.73) | 3.45 | 0.51 | 0 |
| delove@8 | 4 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"exponential","blizzards":8} | 200 | 0.550 | 0.491-0.609 | +35 | +0.65 | +0.35 | +0.30 (-0.14 to +0.74) | 2.45 | 0.79 | 18 |
| delove@8 | 2 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"exponential","blizzards":8} | 400 | 0.525 | 0.486-0.564 | +17 | +0.52 | +0.36 | +0.15 (-0.02 to +0.32) | 1.48 | 0.51 | 16 |
| delove@8 | 6 | {"map":"bohemia","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"progressive"} | 200 | 0.530 | 0.464-0.596 | +21 | +0.91 | +0.60 | +0.31 (-0.14 to +0.76) | 3.43 | 0.88 | 4 |
| delove@8 | 8 | {"map":"nine_realms","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"fixed","capitals":true} | 200 | 0.547 | 0.483-0.612 | +33 | +0.34 | +0.09 | +0.25 (+0.01 to +0.49) | 4.48 | 0.67 | 19 |
| jacob-sensei@1 | 6 | {"map":"world"} | 200 | 0.590 | 0.521-0.659 | +63 | +1.05 | +0.62 | +0.43 (+0.02 to +0.84) | 3.32 | 0.82 | 0 |
| delove-teacher@2 | 2 | {} | 400 | 0.614 | 0.571-0.657 | +80 | +0.82 | +0.14 | +0.68 (+0.47 to +0.90) | 1.39 | 0.61 | 5 |

### c12: time per phase (minutes from the start)

| phase | minutes |
| --- | --- |
| start | 0.0 |
| generation done | 0.0 |
| generated and exported the GPU steps (remote, 7 GPUs) | 57.0 |
| exports done | 57.0 |
| trained c12-candidate | 91.1 |
| gates done | 102.2 |
| summary | 102.2 |

### c12: the first attempt (lost)

The first launch (07:49, 10 pods, all steps including the specialists' stage and ratio games, `REMOTE_MAX_GPU_HOURS=11`)
delivered nothing and cost **$9.20** (10.34 pod-hours). RunPod had no RTX 4090s free, so the pods only started
playing at about 08:03. `remote.py`'s single time limit (cap / pods = 66 min, counted from launch) then cut every
lane, many at 99%, and a cut lane kept nothing. Issue #152, fixed in #153 (per-pod limits from each pod's creation,
finished configurations kept, a RunPod stock check). The rerun put the main games on 7 pods (a 77 min limit for
about 17 min of games) and the specialists' games on the home GPU (`c12x.cycle`).

### c12: hard labels vs soft targets (#145), same games

Three base candidates from `delove@8` on the same data. Cycles 11-12 carry `branch_q.npy`; cycle 10's rows train on
hard labels in every variant. The soft variants ran as `c121-candidate` / `c122-candidate`: the agent registry loads
only `[rc]N-candidate` names, so `c12-soft5` failed every gate chunk on the first try.

| candidate | flags | pooled points per seat at 4-10p vs `delove@8` (95%) | 2p | vs Jacob Sensei, World 6p |
| --- | --- | --- | --- | --- |
| **`c12-candidate`** | hard labels | **+0.30 (+0.18 to +0.43)** | 0.497 | **0.590** |
| `c121-candidate` | `--soft-targets 5` | +0.22 (+0.10 to +0.34) | 0.509 | 0.495 |
| `c122-candidate` | `--soft-targets 5 --soft-scale 0.05` | +0.04 (about ±0.13) | 0.507 | 0.560 |

`c121-candidate` (`--soft-targets 5`):

| opponent | players | options | games | score | 95% interval | Elo | points | opp. points | points diff (95%) | place | kills | turn limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| delove@8 | 2 | {} | 800 | 0.509 | 0.481-0.536 | +6 | +0.53 | +0.47 | +0.05 (-0.11 to +0.22) | 1.49 | 0.51 | 0 |
| delove@8 | 4 | {} | 200 | 0.520 | 0.458-0.582 | +14 | +0.66 | +0.56 | +0.10 (-0.24 to +0.43) | 2.48 | 0.76 | 10 |
| delove@8 | 6 | {} | 200 | 0.487 | 0.417-0.558 | -9 | +0.47 | +0.39 | +0.09 (-0.23 to +0.40) | 3.50 | 0.77 | 21 |
| delove@8 | 6 | {"map":"world"} | 200 | 0.603 | 0.532-0.673 | +72 | +1.10 | +0.53 | +0.56 (+0.08 to +1.05) | 3.36 | 0.95 | 1 |
| delove@8 | 10 | {"map":"world"} | 200 | 0.570 | 0.500-0.640 | +49 | +1.20 | +0.48 | +0.71 (+0.29 to +1.13) | 5.29 | 1.01 | 2 |
| delove@8 | 6 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"progressive","capitals":true,"blizzards":8} | 200 | 0.535 | 0.492-0.578 | +24 | -1.74 | -1.95 | +0.21 (+0.02 to +0.39) | 3.50 | 0.24 | 136 |
| delove@8 | 6 | {"map":"world","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"fixed","capitals":true} | 200 | 0.552 | 0.484-0.621 | +37 | +0.44 | +0.42 | +0.01 (-0.32 to +0.34) | 3.50 | 0.46 | 1 |
| delove@8 | 4 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"exponential","blizzards":8} | 200 | 0.530 | 0.463-0.597 | +21 | +0.58 | +0.47 | +0.11 (-0.35 to +0.57) | 2.48 | 0.73 | 16 |
| delove@8 | 2 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"exponential","blizzards":8} | 400 | 0.527 | 0.488-0.567 | +19 | +0.55 | +0.38 | +0.17 (-0.03 to +0.36) | 1.48 | 0.52 | 10 |
| delove@8 | 6 | {"map":"bohemia","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"progressive"} | 200 | 0.502 | 0.433-0.572 | +2 | +0.72 | +0.76 | -0.04 (-0.40 to +0.32) | 3.53 | 0.82 | 5 |
| delove@8 | 8 | {"map":"nine_realms","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"fixed","capitals":true} | 200 | 0.560 | 0.499-0.621 | +42 | -0.06 | -0.29 | +0.22 (-0.05 to +0.50) | 4.43 | 0.64 | 36 |
| jacob-sensei@1 | 6 | {"map":"world"} | 200 | 0.495 | 0.424-0.566 | -3 | +0.74 | +0.92 | -0.18 (-0.43 to +0.07) | 3.45 | 0.67 | 0 |
| delove-teacher@2 | 2 | {} | 400 | 0.621 | 0.578-0.664 | +86 | +0.80 | +0.07 | +0.73 (+0.59 to +0.87) | 1.38 | 0.60 | 17 |


`c122-candidate` (`--soft-targets 5 --soft-scale 0.05`):

| opponent | players | options | games | score | 95% interval | Elo | points | opp. points | points diff (95%) | place | kills | turn limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| delove@8 | 2 | {} | 800 | 0.507 | 0.480-0.534 | +5 | +0.52 | +0.48 | +0.04 (-0.13 to +0.21) | 1.49 | 0.51 | 1 |
| delove@8 | 4 | {} | 200 | 0.560 | 0.504-0.616 | +42 | +0.69 | +0.43 | +0.26 (-0.23 to +0.75) | 2.44 | 0.77 | 14 |
| delove@8 | 6 | {} | 200 | 0.510 | 0.443-0.577 | +7 | +0.72 | +0.56 | +0.16 (-0.18 to +0.50) | 3.45 | 0.81 | 10 |
| delove@8 | 6 | {"map":"world"} | 200 | 0.555 | 0.487-0.623 | +38 | +0.80 | +0.80 | +0.00 (-0.18 to +0.18) | 3.53 | 0.90 | 2 |
| delove@8 | 10 | {"map":"world"} | 200 | 0.490 | 0.423-0.557 | -7 | +0.82 | +0.98 | -0.15 (-0.68 to +0.37) | 5.55 | 0.89 | 0 |
| delove@8 | 6 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"progressive","capitals":true,"blizzards":8} | 200 | 0.490 | 0.443-0.537 | -7 | -1.57 | -1.54 | -0.03 (-0.31 to +0.25) | 3.52 | 0.24 | 120 |
| delove@8 | 6 | {"map":"world","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"fixed","capitals":true} | 200 | 0.520 | 0.455-0.585 | +14 | +0.45 | +0.44 | +0.01 (-0.31 to +0.33) | 3.49 | 0.44 | 0 |
| delove@8 | 4 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"exponential","blizzards":8} | 200 | 0.522 | 0.456-0.589 | +16 | +0.56 | +0.64 | -0.09 (-0.39 to +0.22) | 2.55 | 0.74 | 11 |
| delove@8 | 2 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"exponential","blizzards":8} | 400 | 0.507 | 0.469-0.546 | +5 | +0.48 | +0.44 | +0.04 (-0.17 to +0.26) | 1.50 | 0.49 | 10 |
| delove@8 | 6 | {"map":"bohemia","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"progressive"} | 200 | 0.527 | 0.463-0.592 | +19 | +0.79 | +0.61 | +0.18 (-0.22 to +0.59) | 3.46 | 0.85 | 7 |
| delove@8 | 8 | {"map":"nine_realms","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"fixed","capitals":true} | 200 | 0.542 | 0.479-0.606 | +30 | +0.12 | +0.10 | +0.02 (-0.32 to +0.35) | 4.56 | 0.67 | 23 |
| jacob-sensei@1 | 6 | {"map":"world"} | 200 | 0.560 | 0.494-0.626 | +42 | +0.88 | +0.79 | +0.10 (-0.23 to +0.42) | 3.41 | 0.76 | 0 |
| delove-teacher@2 | 2 | {} | 400 | 0.610 | 0.564-0.656 | +78 | +0.79 | +0.13 | +0.66 (+0.45 to +0.87) | 1.39 | 0.59 | 12 |


### c12: the range specialists (`c12-specialists.sh`)

Each from `delove@9` with its own objective (`train.py --range`) and hard labels (the base winner). Long Range trains on
cycle 12 + cycle 11 at 0.4. Mid Range adds the 3-alive ratio scenarios (#146, `c12-rm`, 40,004 games) and stage games
(#137, `c12-sm`). Close Range adds the 2-alive ratio scenarios at 0.5 (`c12-rc`, 49,990) and stage games (`c12-sc`).
All of these played on the home GPU with `delove@8` seats: 8,600 stage games in 2 h 25 min, 90,000 ratio games in
4 h 06 min, $0. Measured with `npm run delove:stages` (seed 1, default tables) against the base they were trained from
and against the current base, `delove@10` (cycle 13, promoted meanwhile):

| specialist | vs `delove@9` (95%) | vs `delove@10` (95%) |
| --- | --- | --- |
| Long Range | points +0.15 (-0.14 to +0.44), even | -0.13 (-0.42 to +0.17), even |
| Mid Range | P(top 2) +0.007 (-0.033 to +0.046), even | +0.020 (-0.021 to +0.061), even |
| Close Range | **win +0.038 (+0.001 to +0.074), better**; Classic 2p duels +0.10 | +0.026 (-0.011 to +0.064), even |
| routed trio (full games) | **points +0.33 (+0.07 to +0.60), better** (Classic 6p +0.97) | +0.05 (-0.24 to +0.34), even |

**Not promoted:** the rule is better than the *current* base, now `delove@10`. Close Range and the trio did beat the
base they were trained from, the first specialists to do so: the stage and ratio lessons work for duels, and the
base caught up within a cycle. Cycle 14's lines start from `delove@10`.

### c12: phases and review

| phase | where | minutes |
| --- | --- | --- |
| all 40,000 games, second attempt | 7 rented RTX 4090s | 57.0 (4.09 pod-hours, **$3.64**; the lost first attempt: $9.20) |
| training, three candidates (21,423 steps each) | home GPU, one after another | 34 + 58 + 56 (shared with the home games) |
| gates, three candidates | home CPU | 11 + 21 + 21 |
| stage and ratio games (98,600) | home GPU | about 6 h 30 min, $0 |
| three specialists + 8 stage calls | home GPU / CPU | 33 + 17 + 14, about 40 |

**Review: promoted to `delove@9`** (hard labels). Against `delove@8`: pooled over the 9 multiplayer tables about
**+0.30 points per seat (95% +0.18 to +0.43)**; World 6p +0.63 and Nine Realms +0.25 significant; no table below 0;
even at 2p. First cycle with **Jacob Sensei 2** rollouts (#144). **0.590 vs Jacob Sensei** at World 6p (+0.43 points):
the first Delove to beat its teacher there (cycles 9-12: 0.355, 0.393, 0.445, 0.590). Soft targets did not beat hard
labels.

## Cycle 13

## c13

### Cycle 13, step a1: Classic 4-player

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| c4a | 1,000 | jacob-sensei@1 149, branch@1 480, delove@9 244, jacob-sensei@1 127 | 41.3 | 0 | 554,599 |
| c4b | 1,000 | jacob-sensei@1 68, delove@9 422, jacob-sensei@1 68, branch@1 442 | 28.1 | 0 | 343,725 |
| c4c | 1,000 | jacob-sensei@1 145, branch@1 433, delove@9 270, jacob-sensei@1 144 | 44.0 | 8 | 444,495 |
| c4d | 1,000 | jacob-sensei@1 72, delove@9 407, jacob-sensei@1 63, branch@1 456 | 25.4 | 2 | 276,596 |

**4,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 436,709 |
| branched (compared options) | 276,212 (63.2%) |
| simulations run | 8,114,736 (210,150,178 simulated moves) |
| changed the teacher's move | 107,911 (39.1% of branched) |
| average score gain per branched decision | +0.0196 |
| changes by kind | attack 63,110/175,717, place 27,291/60,863, fortify_from 8,022/18,867, trade 5,216/10,476, end_turn 4,272/10,289 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.410 / 0.449 / 0.432 / 0.368 / 0.547 |
| chosen branches that had won / lost within the horizon | 8.5% / 1.2% |

### Cycle 13, step a2: Classic 2p, Four Crowns 1v1, Classic 6p

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| c2a | 2,000 | branch@1 1348, jacob-sensei@1 652 | 19.0 | 0 | 420,055 |
| c2b | 2,000 | branch@1 1134, delove@9 865 | 3.5 | 1 | 73,979 |
| c2c | 2,000 | jacob-sensei@1 682, branch@1 1318 | 16.7 | 0 | 320,886 |
| c2d | 2,000 | delove@9 858, branch@1 1141 | 4.4 | 1 | 84,301 |
| c6a | 1,000 | jacob-sensei@1 96, delove@9 171, jacob-sensei@1 75, delove@8 156, jacob-sensei@1 91, branch@1:range 405 | 51.7 | 6 | 498,795 |
| c6b | 1,000 | jacob-sensei@1 44, branch@1:range 361, delove@9 269, jacob-sensei@1 50, delove@8 223, jacob-sensei@1 45 | 39.4 | 8 | 407,811 |
| mca | 3,000 | branch@1 1804, jacob-sensei@1 1194 | 16.4 | 2 | 409,051 |
| mcb | 3,000 | branch@1 1543, delove@9 1448 | 7.3 | 9 | 111,499 |

**16,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 936,817 |
| branched (compared options) | 620,486 (66.2%) |
| simulations run | 18,749,220 (335,539,238 simulated moves) |
| changed the teacher's move | 250,954 (40.4% of branched) |
| average score gain per branched decision | +0.0301 |
| changes by kind | attack 129,836/363,584, place 71,462/162,659, fortify_from 28,303/53,106, trade 10,950/22,302, end_turn 10,403/18,835 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.540 / 0.577 / 0.574 / 0.522 / 0.640 |
| chosen branches that had won / lost within the horizon | 12.2% / 2.5% |

### Cycle 13, step a3: Europe 8p, USA 10p, Asia 8p

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| as8a | 1,000 | jacob-sensei@1 60, branch@1:range 445, delove@9 130, jacob-sensei@1 64, delove@8 89, jacob-sensei@1 56, delove@9 108, jacob-sensei@1 48 | 48.3 | 0 | 621,710 |
| as8b | 1,000 | jacob-sensei@1 13, delove@9 234, jacob-sensei@1 22, branch@1:range 285, delove@8 183, jacob-sensei@1 23, delove@9 220, jacob-sensei@1 18 | 62.9 | 2 | 808,530 |
| eu8a | 1,000 | jacob-sensei@1 93, delove@9 94, jacob-sensei@1 60, delove@8 89, jacob-sensei@1 79, branch@1:range 428, delove@9 105, jacob-sensei@1 52 | 43.8 | 0 | 540,290 |
| eu8b | 1,000 | jacob-sensei@1 25, delove@9 202, jacob-sensei@1 25, delove@8 172, jacob-sensei@1 20, delove@9 179, jacob-sensei@1 21, branch@1:range 351 | 56.8 | 5 | 709,486 |
| us10a | 1,000 | jacob-sensei@1 60, delove@9 87, jacob-sensei@1 65, delove@8 72, jacob-sensei@1 54, branch@1:range 370, delove@9 95, jacob-sensei@1 53, delove@8 86, jacob-sensei@1 56 | 59.6 | 2 | 595,649 |
| us10b | 1,000 | jacob-sensei@1 25, delove@9 147, jacob-sensei@1 23, delove@8 128, jacob-sensei@1 28, delove@9 148, jacob-sensei@1 25, branch@1:range 299, delove@8 143, jacob-sensei@1 27 | 52.4 | 7 | 584,573 |

**6,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 647,161 |
| branched (compared options) | 400,832 (61.9%) |
| simulations run | 13,305,720 (618,779,408 simulated moves) |
| changed the teacher's move | 143,737 (35.9% of branched) |
| average score gain per branched decision | +0.0286 |
| changes by kind | attack 93,051/266,148, place 37,108/93,601, trade 5,631/12,307, fortify_from 4,788/14,258, end_turn 3,159/14,518 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.399 / 0.404 / 0.405 / 0.363 / 0.455 |
| chosen branches that had won / lost within the horizon | 15.5% / 2.9% |

### Cycle 13, step a4: Bohemia, Nine Realms, World 6p

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| bo4a | 750 | jacob-sensei@1 102, delove@9 228, jacob-sensei@1 95, branch@1 323 | 37.5 | 2 | 290,594 |
| bo4b | 750 | jacob-sensei@1 55, branch@1 337, delove@9 301, jacob-sensei@1 56 | 24.2 | 1 | 199,621 |
| bo6a | 750 | jacob-sensei@1 87, delove@9 93, jacob-sensei@1 91, branch@1:range 330, delove@8 84, jacob-sensei@1 65 | 43.1 | 0 | 405,915 |
| bo6b | 750 | jacob-sensei@1 60, delove@9 191, jacob-sensei@1 42, delove@8 146, jacob-sensei@1 31, branch@1:range 280 | 45.7 | 0 | 427,911 |
| nr6a | 750 | jacob-sensei@1 95, delove@9 132, jacob-sensei@1 98, delove@8 84, jacob-sensei@1 68, branch@1:range 269 | 71.8 | 4 | 605,751 |
| nr6b | 750 | jacob-sensei@1 43, branch@1:range 282, delove@9 182, jacob-sensei@1 38, delove@8 145, jacob-sensei@1 60 | 44.8 | 0 | 461,541 |
| nr8a | 500 | jacob-sensei@1 39, branch@1:range 199, delove@9 46, jacob-sensei@1 33, delove@8 44, jacob-sensei@1 40, delove@9 58, jacob-sensei@1 41 | 57.7 | 0 | 408,784 |
| nr8b | 500 | jacob-sensei@1 41, delove@9 71, jacob-sensei@1 26, branch@1:range 162, delove@8 64, jacob-sensei@1 22, delove@9 80, jacob-sensei@1 32 | 79.9 | 2 | 529,100 |
| w6a | 500 | jacob-sensei@1 42, delove@9 105, jacob-sensei@1 34, branch@1:range 205, delove@8 77, jacob-sensei@1 37 | 77.8 | 0 | 523,990 |
| w6b | 500 | jacob-sensei@1 38, delove@9 104, jacob-sensei@1 26, delove@8 75, jacob-sensei@1 31, branch@1:range 226 | 49.9 | 0 | 411,759 |

**6,500 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 834,504 |
| branched (compared options) | 520,028 (62.3%) |
| simulations run | 16,950,384 (661,340,453 simulated moves) |
| changed the teacher's move | 186,603 (35.9% of branched) |
| average score gain per branched decision | +0.0226 |
| changes by kind | attack 114,525/342,099, place 47,082/112,873, fortify_from 10,376/29,334, trade 8,369/17,759, end_turn 6,251/17,963 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.385 / 0.414 / 0.396 / 0.341 / 0.498 |
| chosen branches that had won / lost within the horizon | 10.8% / 1.6% |

### Cycle 13, step b: the huge boards

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| ec6a | 500 | jacob-sensei@1 22, delove@9 150, branch@1:range 152, jacob-sensei@1 17, delove@8 130, jacob-sensei@1 29 | 88.3 | 0 | 671,514 |
| ec6b | 500 | jacob-sensei@1 35, delove@9 100, jacob-sensei@1 45, delove@8 63, branch@1:range 218, jacob-sensei@1 39 | 94.4 | 0 | 687,072 |
| fa10a | 500 | branch@1:range 161, jacob-sensei@1 19, delove@9 72, jacob-sensei@1 17, delove@8 76, jacob-sensei@1 14, delove@9 64, jacob-sensei@1 12, delove@8 42, jacob-sensei@1 23 | 135.8 | 0 | 983,903 |
| fa10b | 500 | jacob-sensei@1 37, delove@9 32, branch@1:range 210, jacob-sensei@1 35, delove@8 19, jacob-sensei@1 29, delove@9 26, jacob-sensei@1 50, delove@8 19, jacob-sensei@1 43 | 124.5 | 0 | 788,737 |
| fa6a | 500 | branch@1:range 244, jacob-sensei@1 27, delove@9 100, jacob-sensei@1 28, delove@8 72, jacob-sensei@1 29 | 56.0 | 0 | 518,860 |
| fa6b | 500 | jacob-sensei@1 55, delove@9 59, branch@1:range 230, jacob-sensei@1 54, delove@8 46, jacob-sensei@1 56 | 65.7 | 0 | 648,465 |
| ge10a | 500 | jacob-sensei@1 11, delove@9 81, jacob-sensei@1 11, delove@8 61, jacob-sensei@1 12, delove@9 93, branch@1:range 170, jacob-sensei@1 4, delove@8 48, jacob-sensei@1 9 | 211.7 | 0 | 1,605,406 |
| ge10b | 500 | jacob-sensei@1 41, delove@9 27, jacob-sensei@1 47, delove@8 7, jacob-sensei@1 34, delove@9 23, jacob-sensei@1 41, delove@8 21, branch@1:range 230, jacob-sensei@1 28 | 180.7 | 1 | 1,309,742 |
| ge6a | 500 | jacob-sensei@1 26, delove@9 87, branch@1:range 279, jacob-sensei@1 25, delove@8 61, jacob-sensei@1 22 | 70.0 | 0 | 797,538 |
| ge6b | 500 | jacob-sensei@1 47, delove@9 51, jacob-sensei@1 32, delove@8 36, branch@1:range 281, jacob-sensei@1 53 | 86.5 | 0 | 1,085,764 |
| w10a | 750 | jacob-sensei@1 13, delove@9 126, branch@1:range 186, jacob-sensei@1 15, delove@8 119, jacob-sensei@1 8, delove@9 143, jacob-sensei@1 10, delove@8 113, jacob-sensei@1 17 | 99.7 | 0 | 1,044,854 |
| w10b | 750 | jacob-sensei@1 61, delove@9 63, jacob-sensei@1 45, delove@8 42, branch@1:range 289, jacob-sensei@1 33, delove@9 72, jacob-sensei@1 47, delove@8 51, jacob-sensei@1 47 | 95.0 | 0 | 866,096 |
| wl10a | 500 | jacob-sensei@1 26, delove@9 49, jacob-sensei@1 23, delove@8 23, branch@1:range 225, jacob-sensei@1 29, delove@9 45, jacob-sensei@1 19, delove@8 40, jacob-sensei@1 21 | 73.9 | 0 | 719,439 |
| wl10b | 500 | jacob-sensei@1 28, delove@9 39, jacob-sensei@1 44, delove@8 31, jacob-sensei@1 37, delove@9 41, branch@1:range 195, jacob-sensei@1 29, delove@8 29, jacob-sensei@1 27 | 81.3 | 0 | 786,682 |

**7,500 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 1,960,315 |
| branched (compared options) | 1,163,563 (59.4%) |
| simulations run | 37,755,612 (2,361,905,548 simulated moves) |
| changed the teacher's move | 406,199 (34.9% of branched) |
| average score gain per branched decision | +0.0210 |
| changes by kind | attack 286,278/842,159, place 74,463/195,907, fortify_from 18,544/52,789, trade 15,739/33,465, end_turn 11,175/39,243 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.355 / 0.389 / 0.362 / 0.290 / 0.481 |
| chosen branches that had won / lost within the horizon | 8.9% / 1.0% |

### c13: ladder gate (c13-candidate)

| opponent | players | options | games | score | 95% interval | Elo | points | opp. points | points diff (95%) | place | kills | turn limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| delove@9 | 2 | {} | 800 | 0.513 | 0.488-0.538 | +9 | +0.54 | +0.46 | +0.08 (-0.07 to +0.23) | 1.49 | 0.51 | 1 |
| delove@9 | 4 | {} | 200 | 0.492 | 0.429-0.556 | -5 | +0.51 | +0.58 | -0.07 (-0.42 to +0.28) | 2.50 | 0.69 | 15 |
| delove@9 | 6 | {} | 200 | 0.532 | 0.472-0.593 | +23 | +0.77 | +0.48 | +0.29 (-0.00 to +0.58) | 3.45 | 0.85 | 11 |
| delove@9 | 6 | {"map":"world"} | 200 | 0.570 | 0.497-0.643 | +49 | +1.11 | +0.56 | +0.55 (+0.15 to +0.95) | 3.37 | 0.96 | 0 |
| delove@9 | 10 | {"map":"world"} | 200 | 0.585 | 0.521-0.649 | +60 | +1.23 | +0.57 | +0.66 (+0.22 to +1.09) | 5.32 | 1.02 | 0 |
| delove@9 | 6 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"progressive","capitals":true,"blizzards":8} | 200 | 0.477 | 0.425-0.530 | -16 | -1.30 | -1.15 | -0.16 (-0.34 to +0.02) | 3.56 | 0.31 | 103 |
| delove@9 | 6 | {"map":"world","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"fixed","capitals":true} | 200 | 0.530 | 0.458-0.602 | +21 | +0.56 | +0.42 | +0.13 (-0.15 to +0.41) | 3.49 | 0.55 | 0 |
| delove@9 | 4 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"exponential","blizzards":8} | 200 | 0.515 | 0.451-0.579 | +10 | +0.69 | +0.43 | +0.26 (-0.02 to +0.54) | 2.46 | 0.77 | 14 |
| delove@9 | 2 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"exponential","blizzards":8} | 400 | 0.537 | 0.501-0.574 | +26 | +0.56 | +0.34 | +0.23 (+0.01 to +0.44) | 1.47 | 0.52 | 14 |
| delove@9 | 6 | {"map":"bohemia","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"progressive"} | 200 | 0.472 | 0.402-0.543 | -19 | +0.73 | +0.90 | -0.17 (-0.56 to +0.21) | 3.56 | 0.83 | 1 |
| delove@9 | 8 | {"map":"nine_realms","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"fixed","capitals":true} | 200 | 0.482 | 0.422-0.543 | -12 | +0.29 | +0.36 | -0.07 (-0.51 to +0.37) | 4.54 | 0.65 | 15 |
| jacob-sensei@1 | 6 | {"map":"world"} | 200 | 0.630 | 0.567-0.693 | +92 | +1.12 | +0.55 | +0.56 (+0.20 to +0.92) | 3.32 | 0.89 | 0 |
| jacob-sensei@2 | 6 | {"map":"world"} | 200 | 0.475 | 0.407-0.543 | -17 | +0.76 | +0.91 | -0.14 (-0.47 to +0.18) | 3.46 | 0.70 | 0 |
| jacob-sensei@2 | 2 | {} | 400 | 0.588 | 0.542-0.633 | +61 | +0.76 | +0.23 | +0.53 (+0.25 to +0.80) | 1.41 | 0.58 | 2 |
| delove-teacher@2 | 2 | {} | 400 | 0.662 | 0.623-0.702 | +117 | +0.96 | -0.02 | +0.97 (+0.73 to +1.22) | 1.34 | 0.65 | 8 |

### c13: time per phase (minutes from the start)

| phase | minutes |
| --- | --- |
| start | 0.0 |
| generation done | 0.0 |
| generated and exported the GPU steps (remote, 7 GPUs) | 72.9 |
| exports done | 72.9 |
| trained c13-candidate | 120.8 |
| gates done | 133.1 |
| summary | 133.1 |

### c13: recheck of the three tables below 0

400 more games each with fresh seeds (913000+), pooled with the gate's 200:

| table | recheck alone | all 600 (95%) | kills per game |
| --- | --- | --- | --- |
| League Classic 6p (progressive, capitals, blizzards) | +0.11 | +0.02 (-0.11 to +0.14) | 0.37 |
| Bohemia 6p | +0.04 | -0.03 (-0.24 to +0.18) | 0.84 |
| Nine Realms 8p | -0.11 | -0.10 (-0.32 to +0.12) | 0.67 |

### c13: phases and review

| phase | where | minutes |
| --- | --- | --- |
| all 40,000 games | 7 rented RTX 4090s, #153's per-pod limits, RunPod stock "Low" | 72.9 (5.39 pod-hours, **$4.79**) |
| training (21,081 steps) | home GPU | 47.9 (shared with the home ratio games) |
| gates (15 matches) + recheck (1,200 games) | home CPU | 12.3 + about 15 |

New in cycle 13: at every 6-10 player table the branch seat scores its rollouts by the range objectives
(`delove-branch@1:range`, #148). The 2-4 player tables keep the share score. `cycle.sh` now passes the config's
`export_agents` to the GPU steps (`--export-agents`); before this, a GPU step exported only `delove-branch@1`, so the
`:range` seats would have played and exported nothing (checked on 8 World 6p games: 1,872 decisions exported).

**Review: promoted to `delove@10`.** Against `delove@9`: pooled over the 9 multiplayer tables about +0.16 points per
seat (95% +0.04 to +0.27) on the gate's games, about +0.19 with the recheck. World 6p +0.55 and World 10p +0.66
are significant, where the range scorer's kill credit pays; the recheck shows the capitals and small-map tables
even, not below. Even at 2p (league 2p +0.23, significant). Against the teachers: 0.630 vs Jacob Sensei 1; **even
with Jacob Sensei 2** at World 6p (0.475, -0.14, interval across 0); **0.588 vs Jacob Sensei 2 at Classic 2p**.

## Cycle 14

## c14

### Cycle 14, step a1: Classic 4-player

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| c4a | 1,000 | jacob-sensei@1 109, branch@1 491, delove@10 281, jacob-sensei@1 119 | 41.4 | 0 | 556,316 |
| c4b | 1,000 | jacob-sensei@1 49, delove@10 403, jacob-sensei@1 52, branch@1 495 | 28.3 | 1 | 343,767 |
| c4c | 1,000 | jacob-sensei@1 129, branch@1 434, delove@10 307, jacob-sensei@1 127 | 41.9 | 3 | 438,220 |
| c4d | 1,000 | jacob-sensei@1 61, delove@10 402, jacob-sensei@1 63, branch@1 473 | 25.0 | 1 | 272,179 |

**4,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 442,497 |
| branched (compared options) | 279,480 (63.2%) |
| simulations run | 8,204,538 (214,355,098 simulated moves) |
| changed the teacher's move | 109,663 (39.2% of branched) |
| average score gain per branched decision | +0.0195 |
| changes by kind | attack 64,733/179,137, place 27,666/61,022, fortify_from 7,925/19,066, trade 5,277/10,681, end_turn 4,062/9,574 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.416 / 0.455 / 0.437 / 0.370 / 0.554 |
| chosen branches that had won / lost within the horizon | 8.7% / 1.1% |

### Cycle 14, step a2: Classic 2p, Four Crowns 1v1, Classic 6p

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| c2a | 2,000 | branch@1 1392, jacob-sensei@1 608 | 18.8 | 0 | 410,655 |
| c2b | 2,000 | branch@1 1139, delove@10 861 | 3.3 | 0 | 71,462 |
| c2c | 2,000 | jacob-sensei@1 695, branch@1 1304 | 17.0 | 1 | 322,966 |
| c2d | 2,000 | delove@10 877, branch@1 1119 | 5.5 | 4 | 91,961 |
| c6a | 1,000 | jacob-sensei@1 96, delove@10 172, jacob-sensei@1 77, delove@9 191, jacob-sensei@1 100, branch@1:range 357 | 52.0 | 7 | 497,708 |
| c6b | 1,000 | jacob-sensei@1 35, branch@1:range 328, delove@10 263, jacob-sensei@1 64, delove@9 268, jacob-sensei@1 35 | 39.0 | 7 | 412,159 |
| mca | 3,000 | branch@1 1842, jacob-sensei@1 1155 | 16.9 | 3 | 420,206 |
| mcb | 3,000 | branch@1 1450, delove@10 1538 | 9.5 | 12 | 133,480 |

**16,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 945,719 |
| branched (compared options) | 632,174 (66.8%) |
| simulations run | 19,010,988 (339,351,847 simulated moves) |
| changed the teacher's move | 258,782 (40.9% of branched) |
| average score gain per branched decision | +0.0311 |
| changes by kind | attack 134,577/366,579, place 74,102/169,649, fortify_from 27,987/52,905, trade 11,640/22,929, end_turn 10,476/20,112 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.536 / 0.573 / 0.572 / 0.523 / 0.637 |
| chosen branches that had won / lost within the horizon | 12.0% / 3.4% |

### Cycle 14, step a3: Europe 8p, USA 10p, Asia 8p

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| as8a | 1,000 | jacob-sensei@1 50, branch@1:range 416, delove@10 110, jacob-sensei@1 76, delove@9 100, jacob-sensei@1 55, delove@10 129, jacob-sensei@1 64 | 47.9 | 0 | 616,227 |
| as8b | 1,000 | jacob-sensei@1 22, delove@10 202, jacob-sensei@1 19, branch@1:range 291, delove@9 232, jacob-sensei@1 22, delove@10 202, jacob-sensei@1 8 | 57.6 | 2 | 757,542 |
| eu8a | 1,000 | jacob-sensei@1 72, delove@10 102, jacob-sensei@1 74, delove@9 73, jacob-sensei@1 75, branch@1:range 417, delove@10 109, jacob-sensei@1 78 | 43.4 | 0 | 540,339 |
| eu8b | 1,000 | jacob-sensei@1 22, delove@10 174, jacob-sensei@1 26, delove@9 211, jacob-sensei@1 27, delove@10 182, jacob-sensei@1 23, branch@1:range 332 | 52.2 | 3 | 670,073 |
| us10a | 1,000 | jacob-sensei@1 49, delove@10 104, jacob-sensei@1 57, delove@9 83, jacob-sensei@1 55, branch@1:range 355, delove@10 99, jacob-sensei@1 43, delove@9 101, jacob-sensei@1 52 | 54.6 | 2 | 566,065 |
| us10b | 1,000 | jacob-sensei@1 33, delove@10 144, jacob-sensei@1 31, delove@9 132, jacob-sensei@1 35, delove@10 147, jacob-sensei@1 23, branch@1:range 290, delove@9 132, jacob-sensei@1 23 | 49.1 | 10 | 570,928 |

**6,000 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 606,799 |
| branched (compared options) | 375,354 (61.9%) |
| simulations run | 12,533,748 (581,193,843 simulated moves) |
| changed the teacher's move | 135,260 (36.0% of branched) |
| average score gain per branched decision | +0.0297 |
| changes by kind | attack 87,539/250,084, place 35,167/87,774, trade 5,004/10,900, fortify_from 4,485/13,156, end_turn 3,065/13,440 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.404 / 0.410 / 0.411 / 0.368 / 0.462 |
| chosen branches that had won / lost within the horizon | 15.8% / 2.8% |

### Cycle 14, step a4: Bohemia, Nine Realms, World 6p

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| bo4a | 750 | jacob-sensei@1 102, delove@10 227, jacob-sensei@1 113, branch@1 305 | 36.6 | 3 | 284,544 |
| bo4b | 750 | jacob-sensei@1 59, branch@1 356, delove@10 278, jacob-sensei@1 57 | 22.1 | 0 | 186,112 |
| bo6a | 750 | jacob-sensei@1 75, delove@10 108, jacob-sensei@1 59, branch@1:range 339, delove@9 96, jacob-sensei@1 72 | 43.8 | 1 | 407,512 |
| bo6b | 750 | jacob-sensei@1 42, delove@10 199, jacob-sensei@1 41, delove@9 186, jacob-sensei@1 34, branch@1:range 245 | 45.3 | 3 | 411,981 |
| nr6a | 750 | jacob-sensei@1 79, delove@10 145, jacob-sensei@1 61, delove@9 126, jacob-sensei@1 80, branch@1:range 259 | 67.5 | 0 | 584,382 |
| nr6b | 750 | jacob-sensei@1 35, branch@1:range 277, delove@10 168, jacob-sensei@1 56, delove@9 168, jacob-sensei@1 46 | 45.0 | 0 | 466,300 |
| nr8a | 500 | jacob-sensei@1 35, branch@1:range 221, delove@10 63, jacob-sensei@1 25, delove@9 41, jacob-sensei@1 36, delove@10 43, jacob-sensei@1 36 | 56.4 | 0 | 394,501 |
| nr8b | 500 | jacob-sensei@1 35, delove@10 74, jacob-sensei@1 34, branch@1:range 145, delove@9 75, jacob-sensei@1 31, delove@10 72, jacob-sensei@1 32 | 78.5 | 2 | 522,183 |
| w6a | 500 | jacob-sensei@1 51, delove@10 95, jacob-sensei@1 42, branch@1:range 170, delove@9 110, jacob-sensei@1 31 | 78.1 | 1 | 521,919 |
| w6b | 500 | jacob-sensei@1 30, delove@10 101, jacob-sensei@1 28, delove@9 108, jacob-sensei@1 28, branch@1:range 205 | 48.8 | 0 | 398,376 |

**6,500 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 822,320 |
| branched (compared options) | 512,717 (62.4%) |
| simulations run | 16,673,058 (653,766,599 simulated moves) |
| changed the teacher's move | 185,854 (36.2% of branched) |
| average score gain per branched decision | +0.0228 |
| changes by kind | attack 114,208/338,071, place 47,291/110,736, fortify_from 10,847/29,641, trade 8,470/17,668, end_turn 5,038/16,601 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.382 / 0.409 / 0.392 / 0.341 / 0.493 |
| chosen branches that had won / lost within the horizon | 10.8% / 1.7% |

### Cycle 14, step b: the huge boards

| table | games | seat wins | mean turns | turn limit | decisions |
| --- | --- | --- | --- | --- | --- |
| ec6a | 500 | jacob-sensei@1 19, delove@10 166, branch@1:range 136, jacob-sensei@1 16, delove@9 142, jacob-sensei@1 21 | 87.8 | 0 | 671,732 |
| ec6b | 500 | jacob-sensei@1 41, delove@10 88, jacob-sensei@1 44, delove@9 83, branch@1:range 208, jacob-sensei@1 36 | 92.6 | 0 | 668,715 |
| fa10a | 500 | branch@1:range 154, jacob-sensei@1 12, delove@10 58, jacob-sensei@1 15, delove@9 88, jacob-sensei@1 9, delove@10 60, jacob-sensei@1 23, delove@9 63, jacob-sensei@1 18 | 130.5 | 0 | 955,048 |
| fa10b | 500 | jacob-sensei@1 39, delove@10 26, branch@1:range 203, jacob-sensei@1 24, delove@9 25, jacob-sensei@1 39, delove@10 45, jacob-sensei@1 39, delove@9 28, jacob-sensei@1 32 | 122.2 | 0 | 772,146 |
| fa6a | 500 | branch@1:range 225, jacob-sensei@1 27, delove@10 95, jacob-sensei@1 34, delove@9 85, jacob-sensei@1 34 | 54.2 | 0 | 496,799 |
| fa6b | 500 | jacob-sensei@1 66, delove@10 72, branch@1:range 221, jacob-sensei@1 49, delove@9 46, jacob-sensei@1 46 | 65.5 | 0 | 645,456 |
| ge10a | 500 | jacob-sensei@1 8, delove@10 82, jacob-sensei@1 6, delove@9 70, jacob-sensei@1 7, delove@10 88, branch@1:range 147, jacob-sensei@1 7, delove@9 78, jacob-sensei@1 6 | 211.2 | 1 | 1,603,460 |
| ge10b | 500 | jacob-sensei@1 44, delove@10 24, jacob-sensei@1 41, delove@9 15, jacob-sensei@1 34, delove@10 25, jacob-sensei@1 36, delove@9 17, branch@1:range 225, jacob-sensei@1 39 | 176.7 | 0 | 1,273,770 |
| ge6a | 500 | jacob-sensei@1 30, delove@10 69, branch@1:range 261, jacob-sensei@1 35, delove@9 72, jacob-sensei@1 33 | 71.8 | 0 | 832,601 |
| ge6b | 500 | jacob-sensei@1 41, delove@10 57, jacob-sensei@1 59, delove@9 49, branch@1:range 262, jacob-sensei@1 32 | 87.6 | 0 | 1,108,336 |
| w10a | 750 | jacob-sensei@1 18, delove@10 136, branch@1:range 169, jacob-sensei@1 7, delove@9 123, jacob-sensei@1 18, delove@10 117, jacob-sensei@1 19, delove@9 123, jacob-sensei@1 20 | 95.5 | 0 | 1,025,657 |
| w10b | 750 | jacob-sensei@1 57, delove@10 49, jacob-sensei@1 34, delove@9 70, branch@1:range 272, jacob-sensei@1 50, delove@10 63, jacob-sensei@1 55, delove@9 58, jacob-sensei@1 41 | 95.0 | 1 | 872,783 |
| wl10a | 500 | jacob-sensei@1 23, delove@10 45, jacob-sensei@1 14, delove@9 49, branch@1:range 222, jacob-sensei@1 25, delove@10 43, jacob-sensei@1 19, delove@9 40, jacob-sensei@1 20 | 73.3 | 0 | 719,921 |
| wl10b | 500 | jacob-sensei@1 31, delove@10 37, jacob-sensei@1 25, delove@9 24, jacob-sensei@1 21, delove@10 56, branch@1:range 215, jacob-sensei@1 32, delove@9 29, jacob-sensei@1 30 | 80.3 | 0 | 781,624 |

**7,500 games.**

| branch and score | |
| --- | --- |
| branching player's decisions | 1,898,990 |
| branched (compared options) | 1,128,161 (59.4%) |
| simulations run | 36,727,140 (2,344,528,407 simulated moves) |
| changed the teacher's move | 397,210 (35.2% of branched) |
| average score gain per branched decision | +0.0210 |
| changes by kind | attack 280,033/816,209, place 71,823/188,931, fortify_from 18,886/51,909, trade 15,401/32,582, end_turn 11,067/38,530 |
| chosen branches, 2 rounds on: share of armies / income / territories / cards / continents | 0.353 / 0.386 / 0.360 / 0.290 / 0.476 |
| chosen branches that had won / lost within the horizon | 8.9% / 1.0% |

### c14: ladder gate (c14-candidate)

| opponent | players | options | games | score | 95% interval | Elo | points | opp. points | points diff (95%) | place | kills | turn limit |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| delove@10 | 2 | {} | 800 | 0.495 | 0.467-0.523 | -3 | +0.48 | +0.51 | -0.03 (-0.17 to +0.11) | 1.50 | 0.49 | 4 |
| delove@10 | 4 | {} | 480 | 0.501 | 0.465-0.537 | +1 | +0.63 | +0.72 | -0.09 (-0.26 to +0.08) | 2.53 | 0.73 | 13 |
| delove@10 | 6 | {} | 480 | 0.515 | 0.471-0.558 | +10 | +0.85 | +0.72 | +0.12 (-0.19 to +0.44) | 3.47 | 0.85 | 6 |
| delove@10 | 6 | {"map":"world"} | 480 | 0.558 | 0.519-0.598 | +41 | +0.97 | +0.69 | +0.28 (+0.02 to +0.54) | 3.45 | 0.91 | 0 |
| delove@10 | 10 | {"map":"world"} | 480 | 0.531 | 0.485-0.577 | +22 | +1.05 | +0.75 | +0.30 (+0.08 to +0.53) | 5.40 | 0.94 | 0 |
| delove@10 | 6 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"progressive","capitals":true,"blizzards":8} | 480 | 0.515 | 0.479-0.550 | +10 | -0.45 | -0.49 | +0.05 (-0.13 to +0.23) | 3.51 | 0.49 | 148 |
| delove@10 | 6 | {"map":"world","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"fixed","capitals":true} | 480 | 0.533 | 0.491-0.576 | +23 | +0.64 | +0.37 | +0.27 (+0.09 to +0.45) | 3.44 | 0.56 | 0 |
| delove@10 | 4 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"exponential","blizzards":8} | 480 | 0.517 | 0.473-0.560 | +12 | +0.67 | +0.64 | +0.03 (-0.26 to +0.32) | 2.50 | 0.75 | 16 |
| delove@10 | 2 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"exponential","blizzards":8} | 680 | 0.491 | 0.463-0.520 | -6 | +0.43 | +0.49 | -0.05 (-0.22 to +0.11) | 1.51 | 0.48 | 18 |
| delove@10 | 6 | {"map":"bohemia","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"progressive"} | 480 | 0.526 | 0.478-0.574 | +18 | +0.89 | +0.76 | +0.12 (-0.12 to +0.36) | 3.49 | 0.88 | 1 |
| delove@10 | 8 | {"map":"nine_realms","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"fixed","capitals":true} | 480 | 0.450 | 0.408-0.492 | -35 | +0.43 | +0.53 | -0.10 (-0.29 to +0.08) | 4.54 | 0.68 | 24 |
| jacob-sensei@1 | 6 | {"map":"world"} | 200 | 0.595 | 0.523-0.667 | +67 | +0.97 | +0.69 | +0.28 (-0.02 to +0.58) | 3.40 | 0.85 | 0 |
| jacob-sensei@2 | 6 | {"map":"world"} | 200 | 0.515 | 0.445-0.585 | +10 | +0.93 | +0.74 | +0.19 (-0.26 to +0.64) | 3.34 | 0.72 | 0 |
| jacob-sensei@2 | 2 | {} | 400 | 0.626 | 0.583-0.670 | +90 | +0.85 | +0.10 | +0.76 (+0.53 to +0.99) | 1.38 | 0.62 | 7 |
| delove-teacher@2 | 2 | {} | 400 | 0.650 | 0.608-0.692 | +108 | +0.91 | +0.01 | +0.90 (+0.70 to +1.10) | 1.35 | 0.64 | 12 |
| delove@6 | 6 | {"map":"world"} | 200 | 0.743 | 0.690-0.795 | +184 | +1.57 | +0.06 | +1.52 (+1.05 to +1.98) | 3.21 | 1.21 | 1 |
| delove@6 | 2 | {} | 400 | 0.575 | 0.534-0.616 | +53 | +0.72 | +0.28 | +0.45 (+0.14 to +0.76) | 1.43 | 0.57 | 0 |
| delove@3 | 6 | {"map":"world"} | 200 | 0.860 | 0.812-0.908 | +315 | +1.79 | -0.20 | +1.98 (+1.60 to +2.37) | 3.12 | 1.33 | 2 |
| jacob-sensei@1 | 6 | {"map":"world"} | 200 | 0.665 | 0.604-0.726 | +119 | +1.30 | +0.37 | +0.93 (+0.59 to +1.27) | 3.22 | 0.95 | 0 |
| jacob-sensei@2 | 6 | {"map":"world"} | 200 | 0.530 | 0.460-0.600 | +21 | +0.89 | +0.78 | +0.11 (-0.35 to +0.58) | 3.36 | 0.70 | 0 |
| jacob-sensei@2 | 2 | {} | 400 | 0.636 | 0.596-0.676 | +97 | +0.88 | +0.07 | +0.82 (+0.55 to +1.08) | 1.36 | 0.63 | 7 |
| delove-teacher@2 | 2 | {} | 400 | 0.660 | 0.620-0.700 | +115 | +0.94 | -0.03 | +0.96 (+0.66 to +1.26) | 1.34 | 0.65 | 12 |

### c14: paired statistics (mirrored pairs) and SPRT

| opponent | players | options | games | pairs | points diff per seat (paired 95%) |
| --- | --- | --- | --- | --- | --- |
| delove@10 | 2 | {} | 800 | 400 | -0.03 (-0.19 to +0.13) |
| delove@10 | 4 | {} | 480 | 240 | -0.09 (-0.31 to +0.13) |
| delove@10 | 6 | {} | 480 | 240 | +0.12 (-0.13 to +0.38) |
| delove@10 | 6 | {"map":"world"} | 480 | 240 | +0.28 (+0.04 to +0.52) |
| delove@10 | 10 | {"map":"world"} | 480 | 240 | +0.30 (+0.02 to +0.58) |
| delove@10 | 6 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"progressive","capitals":true,"blizzards":8} | 480 | 240 | +0.05 (-0.14 to +0.24) |
| delove@10 | 6 | {"map":"world","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"fixed","capitals":true} | 480 | 240 | +0.27 (+0.04 to +0.50) |
| delove@10 | 4 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"exponential","blizzards":8} | 480 | 240 | +0.03 (-0.23 to +0.29) |
| delove@10 | 2 | {"autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"exponential","blizzards":8} | 680 | 340 | -0.05 (-0.22 to +0.11) |
| delove@10 | 6 | {"map":"bohemia","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"progressive"} | 480 | 240 | +0.12 (-0.14 to +0.38) |
| delove@10 | 8 | {"map":"nine_realms","autoSetup":true,"balancedBlitz":true,"chooseCapitals":true,"cardValues":"fixed","capitals":true} | 480 | 240 | -0.10 (-0.32 to +0.11) |
| jacob-sensei@1 | 6 | {"map":"world"} | 200 | 100 | +0.28 (-0.10 to +0.66) |
| jacob-sensei@2 | 6 | {"map":"world"} | 200 | 100 | +0.19 (-0.19 to +0.57) |
| jacob-sensei@2 | 2 | {} | 400 | 200 | +0.76 (+0.50 to +1.02) |
| delove-teacher@2 | 2 | {} | 400 | 200 | +0.90 (+0.65 to +1.15) |
| delove@6 | 6 | {"map":"world"} | 200 | 100 | +1.52 (+1.18 to +1.86) |
| delove@6 | 2 | {} | 400 | 200 | +0.45 (+0.20 to +0.70) |
| delove@3 | 6 | {"map":"world"} | 200 | 100 | +1.98 (+1.64 to +2.33) |
| jacob-sensei@1 | 6 | {"map":"world"} | 200 | 100 | +0.93 (+0.54 to +1.31) |
| jacob-sensei@2 | 6 | {"map":"world"} | 200 | 100 | +0.11 (-0.25 to +0.48) |
| jacob-sensei@2 | 2 | {} | 400 | 200 | +0.82 (+0.58 to +1.06) |
| delove-teacher@2 | 2 | {} | 400 | 200 | +0.96 (+0.72 to +1.20) |

**SPRT vs delove@10** (pooled 9 tables at 4-10p, each weighted equally; H0 <= 0, H1 >= 0.15 points per seat, alpha 0.05, beta 0.05): pooled +0.11 (95% +0.03 to +0.19), LLR 3.01 (bounds -2.94 / 2.94): **better (H1 accepted)**; 2p: -0.03, -0.05 (not significantly worse)

### c14: time per phase (minutes from the start)

| phase | minutes |
| --- | --- |
| start | 0.0 |
| generation done | 0.1 |
| generated and exported the GPU steps (remote, 7 GPUs) | 38.5 |
| exports done | 38.5 |
| trained c14-candidate | 75.8 |
| gates done | 122.2 |
| summary | 122.2 |

### c14: the first attempt and the rerun

The first generation (16:30, 7 pods) played every configuration, but unpacking the pods' results failed with "No space
left on device": the training PC's C: drive was full (1.9 TB). $5.63 billed, nothing merged. After the owner's cleanup
(old training data and the partial downloads), the rerun reused 24 of 42 finished configurations kept by #153's salvage
(`OUT/remote/units/`) and replayed the other 18 on 7 pods for $3.11. Cycle 14 in all: **$8.74**.

### c14: candidate (b), grown to 8 message-passing rounds (#161)

`c14-grow.cycle`: the same games, data and flags plus `train.py --grow-rounds 8` (`delove@10` grown from 6 to 8 rounds,
the new rounds starting as pass-throughs, about 25% more parameters), named `c141-candidate`. After 7 extra SPRT rounds it
stood at **+0.08 points per seat pooled at 4-10p (95% -0.01 to +0.16), LLR 0.04**, heading for the 800-game cap without
separating from (a); the run was stopped (research plan). **Even with the plain fine-tune in one cycle; growth not worth
it yet.** The checkpoint is kept.

### c14: Close Range (`c14-specialists.sh`)

From `delove@11` (`--range close`, hard labels) on cycle 14's games + cycle 12's 2-alive ratio scenarios at 0.5 and stage
games. Close stage vs `delove@11`: win +0.011 (-0.029 to +0.051) over 800 games; the trio `delove@11,delove@11,c14-close`
in full games: +0.05 points (-0.07 to +0.17), 178 of 200 positions decided the same. **Even, not promoted.** Since cycle
12 Close Range has beaten the base it was trained from but not the next one. Specialist training is paused from cycle 15
(owner decision); resume when the base gains less than +0.10 over two cycles.

### c14: review

**Promoted to `delove@11`** (candidate (a), hard labels, the first cycle gated with the SPRT and the fixed reference
panel, #160). Against `delove@10`: pooled over the 9 multiplayer tables **+0.11 points per seat (95% +0.03 to +0.19),
SPRT accepted**; World 6p +0.28, World 10p +0.30 and league World 6p +0.27 significant; no table significantly below 0
(Nine Realms 8p -0.10, -0.32 to +0.11); 2p not worse (-0.03). Panel: +1.52 points per seat vs `delove@6` and +1.98 vs
`delove@3` at World 6p; vs Jacob Sensei 2: +0.11 at World 6p, **+0.76 to +0.82 at Classic 2p**.
