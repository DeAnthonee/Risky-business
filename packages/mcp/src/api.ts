import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Action, GameEvent, GameOptions, GameView } from '@risk/engine';

/** A player's seat in one game. */
export interface Identity {
  gameId: string;
  playerId: string;
  token: string;
  name: string;
}

export interface GameInfo {
  state: GameView;
  host: string;
  name: string;
  playerId: string | null;
}

export interface JoinResult {
  gameId: string;
  playerId: string;
  token: string;
  state: GameView;
}

export interface WaitResult {
  reason: string;
  yourTurn: boolean;
  state: GameView;
  events: { version: number; events: GameEvent[]; playerId: string | null }[];
}

export interface EventsResult {
  version: number;
  entries: { version: number; at: number; playerId: string | null; events: GameEvent[] }[];
}

/** A tournament as the server describes it (see the server's TournamentView). */
export interface TournamentInfo {
  id: string;
  name: string;
  status: 'registering' | 'running' | 'finished';
  map: string;
  groupSize: number;
  maxEntrants: number;
  fillBots: boolean;
  entrants: { id: string; name: string; isBot: boolean; status: string }[];
  rounds: {
    round: number;
    deadline?: number;
    endedAt?: number;
    matches: { gameId: string | null; status: string; players: { entrantId: string; name: string }[]; winner: string | null; map?: string; standing?: { order: string[]; rolls: Record<string, number[]> } }[];
  }[];
  champion: { entrantId: string; name: string } | null;
  version: number;
  format?: 'knockout' | 'nested';
  nested?: { finalMap: string | null; territoriesPerSeat: number; roundMinutes: number; finishShare: number; botDelayMs?: number | null; plan: number[][] | null; zergs: number };
  you?: { entrantId: string; name: string; status: string; match: { gameId: string; playerId: string; token: string; round: number } | null };
}

export interface TournamentSpec {
  name?: string;
  options?: Partial<GameOptions>;
  groupSize?: number;
  maxEntrants?: number;
  fillBots?: boolean;
  format?: 'knockout' | 'nested';
  finalMap?: string;
  territoriesPerSeat?: number;
  roundMinutes?: number;
  finishShare?: number;
  botDelayMs?: number;
}

export interface ChatResult {
  /** `to`/`toName`: a whisper, readable only by its two players and spectators. */
  messages: { id: number; name: string; message: string; at: number; spectator?: boolean; to?: string; toName?: string }[];
}

/** A character profile an AI player can play as ("marvel/iron-man"). Version 0 is the repo's starting profile. */
export interface CharacterSummary {
  id: string;
  universe: string;
  name: string;
  version: number;
  /** When the latest version was saved; null for the repo's starting profile. */
  updatedAt: string | null;
  source: 'repo' | 'saved';
}

export interface CharacterProfile extends CharacterSummary {
  markdown: string;
}

export interface CharacterVersion {
  version: number;
  at: string | null;
  note?: string;
}

/** Either the whole profile (markdown) or one "## " section (section + content). */
export interface CharacterUpdate {
  markdown?: string;
  section?: string;
  content?: string;
  /** Reject the save if the profile changed since this version was read. */
  expectedVersion?: number;
  note?: string;
}

export interface ModelInfoDoc {
  file: string;
  markdown: string;
}

export const GAME_OUTCOMES = ['won', 'lost', 'eliminated', 'surrendered', 'abandoned'] as const;
export type GameOutcome = (typeof GAME_OUTCOMES)[number];

/** What an agent writes after a game (or about any moment worth remembering). */
export interface DiaryInput {
  title: string;
  text: string;
  gameId?: string;
  /** Set for a finished game, so it counts in the character's record. */
  outcome?: GameOutcome;
  map?: string;
  /** Other players in that game (names or character ids). */
  opponents?: string[];
  /** The plan in a few words, e.g. "hold Australia, late card sweep"; the record groups results by it. */
  strategy?: string;
  /** Who won, when it was not this character. */
  winner?: string;
}

/** n counts from 1 over the whole diary (repo entries first). at is null for undated repo entries. */
export interface DiaryEntry extends DiaryInput {
  n: number;
  at: string | null;
  source: 'repo' | 'saved';
}

export interface RelationshipNote {
  at: string | null;
  gameId?: string;
  /** How much this moment moved rapport. */
  change: number;
  note: string;
}

/** How a character feels about another player: rapport from -100 (enemy) to 100 (trusted ally). */
export interface Relationship {
  with: string;
  rapport: number;
  notes: RelationshipNote[];
}

export interface RelationshipInput {
  with: string;
  /** Add to rapport (e.g. -20 after a betrayal). */
  change?: number;
  /** Or set rapport outright. */
  rapport?: number;
  note: string;
  gameId?: string;
}

export interface RecordLine {
  games: number;
  won: number;
}

/** Everything a character remembers beyond its profile, summarised for the start of a game. */
export interface CharacterMemory {
  id: string;
  record: RecordLine & { byStrategy: Record<string, RecordLine>; byMap: Record<string, RecordLine>; vsOpponent: Record<string, RecordLine> };
  relationships: Relationship[];
  diaryEntries: number;
  recentDiary: { n: number; at: string | null; title: string; outcome?: GameOutcome }[];
}

/**
 * Everything the MCP tools need from a Risk game server. Implemented over HTTP by
 * `HttpRiskApi` (stdio MCP talking to a remote server) and directly over the in-memory
 * store when the MCP endpoint is embedded in the game server itself.
 */
/** One row of the tournament leaderboard (GET /rankings?board=tournament). */
export interface TournamentRowInfo {
  key: string;
  name: string;
  rank: number;
  points: number;
  tournaments: number;
  championships: number;
  finals: number;
  tablesWon: number;
  kills: number;
  bestFinish: string;
}

/** One leaderboard season as GET /rankings/seasons lists it. */
export interface RankingSeasonInfo { id: string; season: number; current: boolean; games: number }

export interface RiskApi {
  rules(): Promise<{ rules: string }>;
  /** Optional for adapters; HTTP servers advertise supported modes in their options catalogue. */
  cardModes?(): Promise<GameOptions['cardValues'][]>;
  map(mapId?: string): Promise<unknown>;
  listGames(): Promise<{ games: unknown[] }>;
  /** Needs the characters write key: binding credits the character on the leaderboard. */
  setCharacter(gameId: string, token: string, characterId: string, key?: string): Promise<unknown>;
  /** A season's leaderboard by id (from rankingSeasons); the current season when omitted. board "training": the training leaderboard (no seasons). */
  rankings(season?: string, board?: 'training'): Promise<{ board?: 'training'; season?: string; current?: boolean; rankings: import('@risk/engine').RankingRow[] }>;
  /** The tournament leaderboard: one result per entrant per finished tournament, summed. */
  /** houseBots: aggregate fun stats for the fill bots (never ranked) and Zergs. */
  tournamentRankings(): Promise<{ board: 'tournament'; current: true; rankings: TournamentRowInfo[]; houseBots?: unknown }>;
  /** One identity's standing on the tournament leaderboard, with each tournament's finish and points. */
  tournamentProfile(key: string): Promise<{ stats: TournamentRowInfo & { results: { tournamentId: string; name: string; finish: string; points: number }[] }; profile: string | null }>;
  /** Leaderboard seasons: the current one first, then archives newest first. */
  rankingSeasons(): Promise<{ current: number; seasons: RankingSeasonInfo[] }>;
  rankedProfile(key: string, board?: 'training'): Promise<{ stats: import('@risk/engine').RankingRow; profile: string | null }>;
  /** board "training" makes a yardstick game for the training leaderboard; it needs the characters write key. */
  createGame(playerName: string, gameName: string | undefined, options: Partial<GameOptions> | undefined, board?: 'training', key?: string): Promise<JoinResult>;
  joinGame(gameId: string, playerName: string): Promise<JoinResult>;
  /** kind "zerg" seats a Zerg (named from the reptile list, so no name); default "bot", the built-in bot. */
  addBot(gameId: string, token: string, name?: string, kind?: 'bot' | 'zerg'): Promise<{ playerId: string; name?: string }>;
  setOptions(gameId: string, token: string, options: Partial<GameOptions>): Promise<{ state: GameView }>;
  start(gameId: string, token: string): Promise<{ state: GameView }>;
  getGame(gameId: string, token?: string): Promise<GameInfo>;
  act(gameId: string, token: string, action: Action): Promise<{ events: GameEvent[]; state: GameView }>;
  wait(gameId: string, token: string | undefined, since: number | undefined, timeoutMs: number): Promise<WaitResult>;
  events(gameId: string, since: number, token?: string): Promise<EventsResult>;
  /** Pass the reader's token so fog-of-war games hide spectator messages from players. */
  chat(gameId: string, since: number, token?: string): Promise<ChatResult>;
  /** `to`: whisper to one player (name or id) instead of posting to everyone. */
  sendChat(gameId: string, token: string, message: string, to?: string): Promise<unknown>;
  leave(gameId: string, token: string): Promise<unknown>;
  closeGame(gameId: string, token: string): Promise<unknown>;
  listCharacters(): Promise<{ characters: CharacterSummary[] }>;
  /** Latest version unless `version` is given. */
  getCharacter(id: string, version?: number): Promise<CharacterProfile>;
  characterHistory(id: string): Promise<{ id: string; versions: CharacterVersion[] }>;
  /** Writes need the server's characters write key (RISK_CHARACTERS_KEY or the admin token). */
  updateCharacter(id: string, update: CharacterUpdate, key?: string): Promise<CharacterProfile>;
  /** Docs that apply to every model (AI/general-model-info) plus the character template. */
  modelInfo(): Promise<{ docs: ModelInfoDoc[] }>;
  /** Record, relationships and the latest diary titles. */
  characterMemory(id: string): Promise<CharacterMemory>;
  /** The latest `limit` entries (oldest first), or one game's entries. */
  readDiary(id: string, limit?: number, gameId?: string): Promise<{ id: string; total: number; entries: DiaryEntry[] }>;
  addDiaryEntry(id: string, entry: DiaryInput, key?: string): Promise<DiaryEntry>;
  updateRelationship(id: string, update: RelationshipInput, key?: string): Promise<Relationship>;

  listTournaments(): Promise<{ tournaments: unknown[] }>;
  /** Pass your entrant token to get `you` (your status and your current table's seat). */
  getTournament(tournamentId: string, token?: string): Promise<{ tournament: TournamentInfo }>;
  joinTournament(tournamentId: string, playerName: string): Promise<{ entrantId: string; token: string; tournament: TournamentInfo }>;
  /** Long-poll until the tournament changes past `since`. */
  waitTournament(tournamentId: string, token: string | undefined, since: number | undefined, timeoutMs: number): Promise<{ reason: string; tournament: TournamentInfo }>;
  // TEMPORARY (testing): while the server has tournaments open, no admin key is needed to create; otherwise pass the
  // server's admin token. Remove from the MCP tools before launch.
  /** Returns the tournament's host token: it (or the admin key) starts the tournament. */
  createTournament(adminKey: string | undefined, spec: TournamentSpec): Promise<{ hostToken: string; tournament: TournamentInfo }>;
  /** `key`: the tournament's host token or the admin key. */
  startTournament(key: string | undefined, tournamentId: string): Promise<{ tournament: TournamentInfo }>;
}

/** Seats held by one agent connection. Several seats per game are allowed (one chat can run two players). */
export interface IdentityStore {
  /** All seats in a game. */
  seats(gameId: string): Identity[];
  /** A seat in a game by player name (case-insensitive) or by token. */
  find(gameId: string, nameOrToken: string): Identity | undefined;
  set(id: Identity): void;
  forget(gameId: string, token?: string): void;
  gameIds(): string[];
  all(): Identity[];
}

export class RiskHttpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = 'RiskHttpError';
  }
}

/** Identities kept in memory only (one MCP session over HTTP). */
export class MemoryIdentityStore implements IdentityStore {
  private byGame = new Map<string, Identity[]>();
  seats(gameId: string) {
    return this.byGame.get(gameId.toUpperCase()) ?? [];
  }
  find(gameId: string, nameOrToken: string) {
    const key = nameOrToken.trim().toLowerCase();
    return this.seats(gameId).find((s) => s.token === nameOrToken || s.name.toLowerCase() === key || s.playerId === nameOrToken);
  }
  set(id: Identity) {
    const g = id.gameId.toUpperCase();
    const list = (this.byGame.get(g) ?? []).filter((s) => s.token !== id.token && s.playerId !== id.playerId);
    list.push({ ...id, gameId: g });
    this.byGame.set(g, list);
  }
  forget(gameId: string, token?: string) {
    const g = gameId.toUpperCase();
    if (!token) {
      this.byGame.delete(g);
      return;
    }
    const left = this.seats(g).filter((s) => s.token !== token);
    if (left.length) this.byGame.set(g, left);
    else this.byGame.delete(g);
  }
  gameIds() {
    return [...this.byGame.keys()];
  }
  all() {
    return [...this.byGame.values()].flat();
  }
}

/** Identities persisted to a JSON file, keyed by server URL, so a restarted stdio agent keeps its seats. */
export class FileIdentityStore extends MemoryIdentityStore {
  constructor(
    private scope: string,
    private file: string | null,
  ) {
    super();
    this.load();
  }
  private load() {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, Identity[] | Record<string, Identity>>;
      const mine = data[this.scope];
      const list = Array.isArray(mine) ? mine : Object.values(mine ?? {});
      for (const id of list) super.set(id);
    } catch {
      /* ignore corrupt file */
    }
  }
  private save() {
    if (!this.file) return;
    try {
      let data: Record<string, unknown> = {};
      if (existsSync(this.file)) data = JSON.parse(readFileSync(this.file, 'utf8'));
      data[this.scope] = this.all();
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(data, null, 2));
    } catch {
      /* ignore */
    }
  }
  override set(id: Identity) {
    super.set(id);
    this.save();
  }
  override forget(gameId: string, token?: string) {
    super.forget(gameId, token);
    this.save();
  }
}

export function defaultSessionFile(): string {
  return process.env.RISK_MCP_SESSION_FILE ?? join(homedir(), '.risk-mcp', 'sessions.json');
}

/** RiskApi over the game server's HTTP API. */
export class HttpRiskApi implements RiskApi {
  constructor(
    public baseUrl: string,
    /** Default characters write key for saves (a tool's own "key" wins). */
    private charactersKey?: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  private async request<T>(path: string, init: RequestInit = {}, token?: string, charactersKey?: string): Promise<T> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (charactersKey) headers['x-characters-key'] = charactersKey;
    const res = await fetch(`${this.baseUrl}/api${path}`, { ...init, headers });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new RiskHttpError(`Non-JSON response from server (${res.status}): ${text.slice(0, 200)}`, res.status);
    }
    if (!res.ok) throw new RiskHttpError(String(body.error ?? `HTTP ${res.status}`), res.status);
    return body as T;
  }

  rules() {
    return this.request<{ rules: string }>('/rules');
  }
  map(mapId?: string) {
    return this.request<unknown>(`/map${mapId ? `?map=${encodeURIComponent(mapId)}` : ''}`);
  }
  async cardModes(): Promise<GameOptions['cardValues'][]> {
    const catalogue = await this.request<{ options: { key: string; values?: string[] }[] }>('/options', { signal: AbortSignal.timeout(10000) });
    const values = catalogue.options.find(o => o.key === 'cardValues')?.values ?? [];
    return (['progressive', 'fixed', 'exponential'] as const).filter(v => values.includes(v));
  }
  listGames() {
    return this.request<{ games: unknown[] }>('/games');
  }
  createGame(playerName: string, gameName: string | undefined, options: Partial<GameOptions> | undefined, board?: 'training', key?: string) {
    return this.request<JoinResult>('/games', { method: 'POST', body: JSON.stringify({ playerName, gameName, options, ...(board ? { board } : {}) }) }, undefined, board ? key ?? this.charactersKey : undefined);
  }
  joinGame(gameId: string, playerName: string) {
    return this.request<JoinResult>(`/games/${gameId}/join`, { method: 'POST', body: JSON.stringify({ playerName }) });
  }
  addBot(gameId: string, token: string, name?: string, kind?: 'bot' | 'zerg') {
    return this.request<{ playerId: string; name?: string }>(`/games/${gameId}/bots`, { method: 'POST', body: JSON.stringify({ name, ...(kind ? { kind } : {}) }) }, token);
  }
  setOptions(gameId: string, token: string, options: Partial<GameOptions>) {
    return this.request<{ state: GameView }>(`/games/${gameId}/options`, { method: 'POST', body: JSON.stringify({ options }) }, token);
  }
  start(gameId: string, token: string) {
    return this.request<{ state: GameView }>(`/games/${gameId}/start`, { method: 'POST', body: '{}' }, token);
  }
  getGame(gameId: string, token?: string) {
    return this.request<GameInfo>(`/games/${gameId}`, {}, token);
  }
  act(gameId: string, token: string, action: Action) {
    return this.request<{ events: GameEvent[]; state: GameView }>(`/games/${gameId}/actions`, { method: 'POST', body: JSON.stringify({ action }) }, token);
  }
  wait(gameId: string, token: string | undefined, since: number | undefined, timeoutMs: number) {
    const q = new URLSearchParams({ timeoutMs: String(timeoutMs) });
    if (since !== undefined) q.set('since', String(since));
    return this.request<WaitResult>(`/games/${gameId}/wait?${q}`, {}, token);
  }
  events(gameId: string, since: number, token?: string) {
    return this.request<EventsResult>(`/games/${gameId}/events?since=${since}`, {}, token);
  }
  chat(gameId: string, since: number, token?: string) {
    return this.request<ChatResult>(`/games/${gameId}/chat?since=${since}`, {}, token);
  }
  sendChat(gameId: string, token: string, message: string, to?: string) {
    return this.request(`/games/${gameId}/chat`, { method: 'POST', body: JSON.stringify({ message, to }) }, token);
  }
  leave(gameId: string, token: string) {
    return this.request(`/games/${gameId}/leave`, { method: 'POST', body: '{}' }, token);
  }
  closeGame(gameId: string, token: string) {
    return this.request(`/games/${gameId}/close`, { method: 'POST', body: '{}' }, token);
  }
  listCharacters() {
    return this.request<{ characters: CharacterSummary[] }>('/characters');
  }
  setCharacter(gameId: string, token: string, characterId: string, key?: string) {
    return this.request(`/games/${gameId}/character`, { method: 'POST', body: JSON.stringify({ characterId }) }, token, key ?? this.charactersKey);
  }
  rankings(season?: string, board?: 'training') {
    const q = board ? `?board=${board}` : season ? `?season=${encodeURIComponent(season)}` : '';
    return this.request<{ board?: 'training'; season?: string; current?: boolean; rankings: import('@risk/engine').RankingRow[] }>(`/rankings${q}`);
  }
  tournamentRankings() { return this.request<{ board: 'tournament'; current: true; rankings: TournamentRowInfo[]; houseBots?: unknown }>('/rankings?board=tournament'); }
  tournamentProfile(key: string) {
    return this.request<{ stats: TournamentRowInfo & { results: { tournamentId: string; name: string; finish: string; points: number }[] }; profile: string | null }>(`/rankings/profile?key=${encodeURIComponent(key)}&board=tournament`);
  }
  rankingSeasons() { return this.request<{ current: number; seasons: RankingSeasonInfo[] }>('/rankings/seasons'); }
  rankedProfile(key: string, board?: 'training') { return this.request<{ stats: import('@risk/engine').RankingRow; profile: string | null }>(`/rankings/profile?key=${encodeURIComponent(key)}${board ? `&board=${board}` : ''}`); }
  getCharacter(id: string, version?: number) {
    return this.request<CharacterProfile>(`/characters/${characterPath(id)}${version !== undefined ? `?version=${version}` : ''}`);
  }
  characterHistory(id: string) {
    return this.request<{ id: string; versions: CharacterVersion[] }>(`/characters/${characterPath(id)}/history`);
  }
  updateCharacter(id: string, update: CharacterUpdate, key?: string) {
    return this.request<CharacterProfile>(`/characters/${characterPath(id)}`, { method: 'POST', body: JSON.stringify(update) }, undefined, key ?? this.charactersKey);
  }
  modelInfo() {
    return this.request<{ docs: ModelInfoDoc[] }>('/model-info');
  }
  characterMemory(id: string) {
    return this.request<CharacterMemory>(`/characters/${characterPath(id)}/memory`);
  }
  readDiary(id: string, limit?: number, gameId?: string) {
    const q = new URLSearchParams();
    if (limit !== undefined) q.set('limit', String(limit));
    if (gameId) q.set('gameId', gameId);
    return this.request<{ id: string; total: number; entries: DiaryEntry[] }>(`/characters/${characterPath(id)}/diary${q.size ? `?${q}` : ''}`);
  }
  addDiaryEntry(id: string, entry: DiaryInput, key?: string) {
    return this.request<DiaryEntry>(`/characters/${characterPath(id)}/diary`, { method: 'POST', body: JSON.stringify(entry) }, undefined, key ?? this.charactersKey);
  }
  updateRelationship(id: string, update: RelationshipInput, key?: string) {
    return this.request<Relationship>(`/characters/${characterPath(id)}/relationships`, { method: 'POST', body: JSON.stringify(update) }, undefined, key ?? this.charactersKey);
  }
  listTournaments() {
    return this.request<{ tournaments: unknown[] }>('/tournaments');
  }
  getTournament(tournamentId: string, token?: string) {
    return this.request<{ tournament: TournamentInfo }>(`/tournaments/${tournamentId}`, {}, token);
  }
  joinTournament(tournamentId: string, playerName: string) {
    return this.request<{ entrantId: string; token: string; tournament: TournamentInfo }>(`/tournaments/${tournamentId}/join`, { method: 'POST', body: JSON.stringify({ playerName }) });
  }
  waitTournament(tournamentId: string, token: string | undefined, since: number | undefined, timeoutMs: number) {
    const q = new URLSearchParams({ timeoutMs: String(timeoutMs) });
    if (since !== undefined) q.set('since', String(since));
    return this.request<{ reason: string; tournament: TournamentInfo }>(`/tournaments/${tournamentId}/wait?${q}`, {}, token);
  }
  createTournament(adminKey: string | undefined, spec: TournamentSpec) {
    return this.request<{ hostToken: string; tournament: TournamentInfo }>(adminKey ? '/admin/tournaments' : '/tournaments', { method: 'POST', body: JSON.stringify(spec) }, adminKey);
  }
  startTournament(key: string | undefined, tournamentId: string) {
    return this.request<{ tournament: TournamentInfo }>(`/tournaments/${tournamentId}/start`, { method: 'POST', body: '{}' }, key);
  }
}

/** URL-encodes each part of "universe/name"; the slash stays a path separator. */
const characterPath = (id: string) => id.split('/').map(encodeURIComponent).join('/');
