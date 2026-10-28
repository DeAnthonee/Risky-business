/**
 * Leaderboard keys for the runner's own LEADERBOARD.md: versioned seat names (Ronny@13, Delove@3) and unranked aliases
 * (player:jinx) merge into one entry per character. Runner-only on purpose: the engine's ranking.ts is mirrored by
 * Delove's GPU trainer and decides the live site's leaderboard, so it is not changed for this.
 */

export const CANONICAL_LEAGUE_CHARACTERS: Record<string, string> = {
  jinx: 'Jinx',
  shaco: 'Shaco',
  leona: 'Leona',
  tryndamere: 'Tryndamere',
  teemo: 'Teemo',
  shen: 'Shen',
  thresh: 'Thresh',
  darius: 'Darius',
  lux: 'Lux',
  ahri: 'Ahri',
};

/** Named DeLOVE seats that keep one leaderboard entry across model versions. */
const MODEL_SEATS = ['Delove', 'Ronny', 'Joey', 'Hans', 'Demonte', 'Dejean', 'Demario', 'Kai', 'Lauren', 'Diane', 'Jason'];

export function normalizeLeaderboardKey(raw: string): { key: string; name: string; playerId: string } {
  if (!raw) return { key: 'unknown', name: 'Unknown', playerId: 'unknown' };
  const rawClean = raw.trim();
  let clean = rawClean;
  if (clean.startsWith('player:')) clean = clean.slice(7);
  if (clean.startsWith('bot:')) clean = clean.slice(4);
  clean = clean.replace(/@\d+$/, '');
  const lower = clean.toLowerCase();
  const league = lower.startsWith('league/') ? lower.slice(7) : lower;
  if (CANONICAL_LEAGUE_CHARACTERS[league]) {
    return { key: `league/${league}`, name: CANONICAL_LEAGUE_CHARACTERS[league], playerId: `league/${league}` };
  }
  if (lower === 'sensei' || lower === 'delove-teacher') return { key: 'Sensei', name: 'Sensei', playerId: 'sensei' };
  const model = MODEL_SEATS.find((m) => m.toLowerCase() === lower);
  if (model) return { key: model, name: model, playerId: lower };
  return { key: rawClean, name: clean, playerId: lower };
}
