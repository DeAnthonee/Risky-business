import type { GameOptions } from '@risk/engine';
import { RiskHttpError, type Identity, type RiskApi } from '@risk/mcp';

/** One seat to fill: the name it plays under and, optionally, the character profile id ("marvel/ultron"). */
export interface SeatSpec {
  name: string;
  characterId?: string;
}

export const DEFAULT_SEATS = 'Shen=league/shen,Shaco=league/shaco,Tryndamere=league/tryndamere,Teemo=league/teemo,Leona=league/leona,Ahri=league/ahri';

/** "Ultron=marvel/ultron,Vex" -> specs; a bare name plays the generic persona. */
export function parseSeats(text: string): SeatSpec[] {
  const seats = text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [name, characterId] = s.split('=').map((x) => x.trim());
      return characterId ? { name, characterId } : { name };
    });
  if (seats.length < 2) throw new Error('Need at least 2 seats');
  const names = new Set(seats.map((s) => s.name.toLowerCase()));
  if (names.size !== seats.length) throw new Error('Seat names must be unique');
  return seats;
}

export interface CreateSpec {
  gameName?: string;
  options?: Partial<GameOptions>;
}

/** Best effort: every seat leaves its game (in a running game that is a surrender), so the room can be cleaned up. */
export async function leaveSeats(api: RiskApi, identities: readonly Identity[]): Promise<void> {
  await Promise.all(identities.map((id) => api.leave(id.gameId, id.token).catch(() => undefined)));
}

/** The first seat creates the game and hosts it, the rest join, then the host starts it. A failure leaves the seats taken so far. */
export async function createGame(api: RiskApi, seats: SeatSpec[], spec: CreateSpec = {}): Promise<{ gameId: string; identities: Identity[] }> {
  const options: Partial<GameOptions> = { maxPlayers: Math.max(2, seats.length), ...spec.options };
  const identities: Identity[] = [];
  try {
    const host = await api.createGame(seats[0].name, spec.gameName, options);
    identities.push(toIdentity(host, seats[0].name));
    for (const seat of seats.slice(1)) identities.push(toIdentity(await api.joinGame(host.gameId, seat.name), seat.name));
    for (let i = 0; i < seats.length; i++) {
      if (!seats[i].characterId || !api.setCharacter) continue;
      try { await api.setCharacter(host.gameId, identities[i].token, seats[i].characterId!); }
      // 404: older servers; 401/403: no characters write key, so the seat plays without a ranked identity.
      catch (e) { if (!(e instanceof RiskHttpError) || ![401, 403, 404].includes(e.status)) throw e; }
    }
    await api.start(host.gameId, host.token);
    return { gameId: host.gameId, identities };
  } catch (e) {
    await leaveSeats(api, identities);
    throw e;
  }
}

/** Take every seat in an existing lobby. Starts the game only when asked and one of our seats is its host. */
export async function joinGame(
  api: RiskApi,
  gameId: string,
  seats: SeatSpec[],
  opts: { start?: boolean } = {},
): Promise<{ gameId: string; identities: Identity[]; started: boolean }> {
  const identities: Identity[] = [];
  for (const seat of seats) identities.push(toIdentity(await api.joinGame(gameId, seat.name), seat.name));
  let started = false;
  if (opts.start) {
    const info = await api.getGame(gameId, identities[0].token);
    const host = identities.find((i) => i.playerId === info.host);
    if (host) {
      await api.start(gameId, host.token);
      started = true;
    }
  }
  return { gameId: identities[0].gameId, identities, started };
}

function toIdentity(r: { gameId: string; playerId: string; token: string }, name: string): Identity {
  return { gameId: r.gameId, playerId: r.playerId, token: r.token, name };
}
