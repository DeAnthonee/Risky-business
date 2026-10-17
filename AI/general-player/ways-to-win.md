# General player — ways to win

How to win under each victory condition and setting on this server. Always confirm the game's settings
first (`get_state` lists them); the rules text (`rules` tool) is the authority. Each section ends with the
findings (`findings.md`) that back it, when there are any.

## Classic: eliminate everyone

The last player holding territories wins. Eliminating a player hands you their cards.

- Build from a defensible continent, then expand where the bonus is cheap to hold.
- Eliminations are worth more than their territory when the victim holds cards: plan the kill for a turn
  where you can finish it.
- Two-player games always include a passive Neutral; it never attacks, so it is a buffer, not a threat.

## Capital Conquest (`capitals`)

Holding **every** capital at once wins immediately, including the capitals of eliminated players.
Losing your own capital does not knock you out, but the game can end while you still hold territories.

- Each capital held gives +2 armies per turn and defends with up to 3 dice: attacking one costs more
  than an ordinary territory.
- Count capitals every turn: who holds how many, and whether anyone can take the rest next turn. That
  is the real victory track, not territory count.
- A captured capital is only worth something if it survives the next turn. Cheap captures of weakly held
  capitals can hand the opponent an easy win when they retake them.
- With `chooseCapitals`, pick a capital you can reinforce and that is hard to reach, not your biggest
  stack on a border.
- Backed by: F1, F3.

## Cards (`cardValues`)

- **Progressive:** each traded set is worth more than the last, so late sets can dwarf a turn's income.
  Earn a card every turn, track every hand, and assume a player with five cards trades this turn.
  The set count matters more as the game goes on: the opponent's next trade can decide the game.
- **Fixed:** sets keep their value; income and continents matter relatively more.
- A traded card showing a territory you own adds 2 armies there.
- Backed by: F2.

## Fog of war (`fogOfWar`)

You see only your territories and their neighbours. A conquest can reveal what lies beyond it, so under
fog leave `occupy` out of attacks and decide the move-in after you see the reveal.

- Scout with cheap attacks before committing large stacks.
- Spectators always see the whole board; see F4 before trusting or dismissing what they say in chat.

## Blizzards and neutrals

- **Blizzards** freeze territories for the whole game: nobody owns, enters or crosses them, and continents
  count only their open territories. They create chokepoints; use them as walls.
- **Neutrals** never attack or move. They are free buffers until you need to break through them.

## Dice settings

- **Balanced blitz** rolls a blitz five times and uses the middle outcome: strong attacks rarely
  collapse, long shots rarely come off. It reduces variance; it does not guarantee a result. Single
  rolls stay fully random.

## Fortify (`fortifyMode`)

- **Connected:** one move along any chain of your territories; you can shift a stack across your whole
  empire, so threats arrive faster too.
- **Adjacent:** classic, neighbours only; position stacks a turn ahead.
