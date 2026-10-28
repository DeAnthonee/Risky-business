// Mega Earth: Hex Earth on a finer globe (frequency 16: 2562 cells, 674 of them land) where every land hexagon is its own
// territory, for the 100-player mega tournament (owner, 2026-10-28: "all 100 players play on the world map, but i want
// enough territories for the 100"): about 6.7 territories a player, like classic Risk's 42 for 6. Hex Earth's
// territories only name the hexes ("Beringia 3") and its regions group them; its sea lanes join the closest hexes.
// Region bonuses are the builder's classic suggestion (size and entry points). Up to 100 players.
import hexworld from './hexworld.mjs';

export default {
  ...hexworld,
  id: 'mega_earth',
  name: 'Mega Earth',
  maxPlayers: 100,
  frequency: 16,
  cellTerritories: true,
  autoBonus: true,
  badgeGap: 10,
  // Closing ice (the engine's ice.ts): each hex's ring count from either pole, sea counted.
  poleRings: true,
  // Two land hexes the finer grid finds that no Hex Earth site reaches over land: a Malacca shore hex and an Arctic islet.
  sea: [...hexworld.sea, [102.1, 3.8]],
  ice: [...hexworld.ice, [-94, 75.5]],
};
