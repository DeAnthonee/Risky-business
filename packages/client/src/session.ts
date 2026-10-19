export interface Session {
  gameId: string;
  playerId: string;
  token: string;
  name: string;
}

const NAME_KEY = 'risk.name';
const sessionKey = (gameId: string) => `risk.session.${gameId.toUpperCase()}`;

export function getName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setName(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* ignore */
  }
}

export function getSession(gameId: string): Session | null {
  try {
    const raw = localStorage.getItem(sessionKey(gameId));
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: Session) {
  try {
    localStorage.setItem(sessionKey(s.gameId), JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function clearSession(gameId: string) {
  try {
    localStorage.removeItem(sessionKey(gameId));
  } catch {
    /* ignore */
  }
}

export function gameIdFromUrl(): string | null {
  const u = new URL(window.location.href);
  const g = u.searchParams.get('game');
  return g ? g.toUpperCase() : null;
}

export function spectateFromUrl(): boolean {
  const v = new URL(window.location.href).searchParams.get('spectate');
  return v === '1' || v === 'true';
}

export function tournamentIdFromUrl(): string | null {
  const t = new URL(window.location.href).searchParams.get('tournament');
  return t ? t.toUpperCase() : null;
}

export function setTournamentInUrl(id: string | null) {
  const u = new URL(window.location.href);
  if (id) u.searchParams.set('tournament', id);
  else u.searchParams.delete('tournament');
  window.history.replaceState({}, '', u.toString());
}

/** Your entrant token for a tournament on this browser. */
const entrantKey = (id: string) => `risk.tournament.${id.toUpperCase()}`;
export function getEntrantToken(id: string): string | null {
  try {
    return localStorage.getItem(entrantKey(id));
  } catch {
    return null;
  }
}
export function saveEntrantToken(id: string, token: string | null) {
  try {
    if (token) localStorage.setItem(entrantKey(id), token);
    else localStorage.removeItem(entrantKey(id));
  } catch {
    /* ignore */
  }
}

export function setGameInUrl(gameId: string | null, spectate = false) {
  const u = new URL(window.location.href);
  if (gameId) u.searchParams.set('game', gameId);
  else u.searchParams.delete('game');
  if (spectate) u.searchParams.set('spectate', '1');
  else u.searchParams.delete('spectate');
  window.history.replaceState({}, '', u.toString());
}

export function spectateLink(gameId: string): string {
  return `${window.location.origin}${window.location.pathname}?game=${gameId}&spectate=1`;
}
