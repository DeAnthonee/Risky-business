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

/** The host token of a tournament created on this browser (it starts the tournament); private, never shown to others. */
const hostKey = (id: string) => `risk.tournament-host.${id.toUpperCase()}`;
export function getHostToken(id: string): string | null {
  try {
    return localStorage.getItem(hostKey(id));
  } catch {
    return null;
  }
}
export function saveHostToken(id: string, token: string) {
  try {
    localStorage.setItem(hostKey(id), token);
  } catch {
    /* ignore */
  }
}

/** ?host=1: the Create tournament form. */
export function hostFormFromUrl(): boolean {
  return new URL(window.location.href).searchParams.get('host') === '1';
}
export function setHostFormInUrl(on: boolean) {
  const u = new URL(window.location.href);
  if (on) u.searchParams.set('host', '1');
  else u.searchParams.delete('host');
  window.history.replaceState({}, '', u.toString());
}

/**
 * Your player key on this browser (risk.playerKey): sent as X-Player-Key when you take a seat, so you play as your
 * registered player. Kept in localStorage, which any script on the page can read (hardening #12): "Forget" removes it.
 */
const PLAYER_KEY = 'risk.playerKey';
export function getPlayerKey(): string | null {
  try {
    return localStorage.getItem(PLAYER_KEY);
  } catch {
    return null;
  }
}
export function savePlayerKey(key: string | null) {
  try {
    if (key) localStorage.setItem(PLAYER_KEY, key);
    else localStorage.removeItem(PLAYER_KEY);
  } catch {
    /* ignore */
  }
}

/** ?player=1: the player key page. */
/** The recurring tournaments' settings page (?admin=schedule). */
export function scheduleSettingsFromUrl(): boolean {
  return new URL(window.location.href).searchParams.get('admin') === 'schedule';
}
export function setScheduleSettingsInUrl(on: boolean) {
  const u = new URL(window.location.href);
  if (on) u.searchParams.set('admin', 'schedule');
  else u.searchParams.delete('admin');
  window.history.replaceState({}, '', u.toString());
}

export function playerPageFromUrl(): boolean {
  return new URL(window.location.href).searchParams.get('player') === '1';
}
export function setPlayerPageInUrl(on: boolean) {
  const u = new URL(window.location.href);
  if (on) u.searchParams.set('player', '1');
  else u.searchParams.delete('player');
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
