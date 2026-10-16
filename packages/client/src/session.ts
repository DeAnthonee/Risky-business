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

export function setGameInUrl(gameId: string | null) {
  const u = new URL(window.location.href);
  if (gameId) u.searchParams.set('game', gameId);
  else u.searchParams.delete('game');
  window.history.replaceState({}, '', u.toString());
}
