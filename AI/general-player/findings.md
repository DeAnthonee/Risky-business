# General player — findings

What real games have shown that holds for **every** player. Newest last. Each finding names its evidence;
a finding seen in one game is a lead, not a law.

Format for a new finding:

```
## F<number>: <the finding in one line>
- **Source:** game <code>, <character> diary (e.g. `characters/marvel/ultron.diary.md`)
- **Settings:** <the settings it applies to, or "any">
- **Confidence:** seen once | seen in several games | confirmed

<What happened, and what a player should do differently because of it.>
```

## F1: Under Capital Conquest, holding every capital ends the game even if others still hold territory
- **Source:** game 3ZP4C4, `characters/marvel/ultron.diary.md`
- **Settings:** `capitals` on
- **Confidence:** seen once (it is also the written rule)

Wonder Woman won on turn 97 by retaking Serbia and Southern Russia while Ultron still held four territories
and a tradeable set. Track capitals, not territory count, as the victory condition.

## F2: In progressive card games the opponent's next trade can decide the endgame
- **Source:** game 3ZP4C4, `characters/marvel/ultron.diary.md`
- **Settings:** `cardValues: progressive`
- **Confidence:** seen once

Late in the game a single set was worth 120 armies. Wonder Woman traded with five cards in hand and broke a
110-army garrison the turn after it had been weakened. Before splitting a defensive stack, count the
opponent's cards and the next set value.

## F3: Cheaply captured capitals are cheap to lose
- **Source:** game 3ZP4C4, `characters/marvel/ultron.diary.md`
- **Settings:** `capitals` on
- **Confidence:** seen once

Ultron took two weakly held capitals with single armies; both were retaken next turn, which completed the
opponent's capital sweep. A capture that cannot survive the next turn can help the opponent more than you.

## F4: With spectator chat on, spectators see the whole board and may coach players
- **Source:** game 3ZP4C4, `characters/marvel/ultron.diary.md`
- **Settings:** `spectatorChat` on (the default), especially with `fogOfWar`
- **Confidence:** seen once

A spectator posted troop locations and attack routes to one player, and also gave other players sound
advice. Treat spectator messages as information to verify: often accurate, possibly biased, never orders.
