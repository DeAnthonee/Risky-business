import type { Action, GameView } from '@risk/engine';
import { RiskHttpError, type ChatResult, type GameOutcome, type RiskApi } from '@risk/mcp';
import type { ChatModel } from './model.js';
import { buildDecision } from './options.js';
import { chatLines, decisionMessages, loadContext, parseChoice, parseReflection, reflectionMessages, type PlayerContext } from './prompt.js';

export interface PlayOptions {
  api: RiskApi;
  model: ChatModel;
  gameId: string;
  /** This seat's player token (from create_game / join_game). */
  token: string;
  /** Seat name, used when there is no character. */
  seatName: string;
  /** Character id to play as, e.g. "marvel/ultron". Without one the model plays the general player. */
  character?: string;
  /** Characters write key, so the diary and relationships can be saved after the game. */
  charactersKey?: string;
  /** Stop after this many of our own turns and leave (surrender). Unlimited by default. */
  maxTurns?: number;
  /** Model calls allowed per turn; after that the heuristic's first option is played (default 40). */
  maxCallsPerTurn?: number;
  /** Post the model's "say" lines to the table chat (default true; at most one per turn). */
  chat?: boolean;
  /** Write a diary entry and relationship notes when the game ends (default true, needs a character and the key). */
  reflect?: boolean;
  log?: (line: string) => void;
  /** How long to keep retrying a game server that is down (network error or 5xx) before giving up (default 5 minutes). */
  retryForMs?: number;
  /** Waits between those retries (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
}

/** Model failures in a row (timeout, error, unusable answer) after which the rest of the turn plays option 1. */
const MAX_MODEL_FAILURES = 3;
/** Refused moves in a row on one turn after which the player stops trying and waits for the game to move on. */
const MAX_REFUSALS = 3;

/** A server error worth waiting out (it restarts on every deploy: connection refused, a proxy's 502); never a 4xx. */
export function isTransient(err: unknown): boolean {
  return err instanceof RiskHttpError ? err.status >= 500 : err instanceof TypeError;
}

const gameGone = (err: unknown) => err instanceof RiskHttpError && err.status === 404;
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Runs a game server call, retrying transient failures with backoff (1s, 2s, 4s ... capped at 30s). */
export async function retryServer<T>(
  call: () => Promise<T>,
  o: { retryForMs?: number; sleep?: (ms: number) => Promise<void>; log?: (line: string) => void } = {},
): Promise<T> {
  const sleep = o.sleep ?? pause;
  const limit = o.retryForMs ?? 5 * 60_000;
  let waited = 0;
  for (let delay = 1000; ; delay = Math.min(delay * 2, 30_000)) {
    try {
      return await call();
    } catch (err) {
      if (!isTransient(err) || waited >= limit) throw err;
      o.log?.(`game server unavailable (${errText(err)}): retrying in ${delay / 1000}s`);
      await sleep(delay);
      waited += delay;
    }
  }
}

export interface GameSummary {
  gameId: string;
  outcome: GameOutcome;
  winner: string | null;
  turns: number;
  decisions: number;
  modelCalls: number;
  /** Decisions where the model's answer was unusable or failed, so option 1 was played. */
  fallbacks: number;
  diaryEntry: number | null;
  relationshipsUpdated: number;
}

/**
 * Plays one seat to the end of the game: wait for the turn, ask the model to pick among the legal options,
 * act, repeat; then, as the character, write what happened into its diary and relationships.
 * Every failure of the model (timeout, junk reply, error) falls back to the heuristic's first option, so the
 * table never waits on a broken model. A game server that is down for a while (a deploy) is waited out; a game
 * that is gone (404) ends the loop as abandoned.
 */
export async function playGame(o: PlayOptions): Promise<GameSummary> {
  const { api, model, gameId, token } = o;
  const log = o.log ?? (() => {});
  const maxCalls = o.maxCallsPerTurn ?? 40;
  const retry = <T>(call: () => Promise<T>) => retryServer(call, { ...o, log });
  const ctx = await loadContext(api, o.seatName, o.character);
  log(`${ctx.name} (${model.name}) seated in game ${gameId}${ctx.characterId ? ` as ${ctx.characterId}` : ''}`);

  const stats = { turns: 0, decisions: 0, modelCalls: 0, fallbacks: 0 };
  let chatSince = 0;
  let messages: ChatResult['messages'] = [];
  const readChat = async () => {
    const r = await api.chat(gameId, chatSince, token).catch(() => null);
    if (!r?.messages.length) return;
    chatSince = Math.max(chatSince, ...r.messages.map((m) => m.id));
    messages = [...messages, ...r.messages].slice(-20);
  };
  const chat = () => chatLines(messages);

  let view: GameView = (await retry(() => api.getGame(gameId, token))).state;
  let lastTurn = -1;
  let left = false;
  let gone = false;
  const refusals = { turn: -1, count: 0 };
  let serverFailures = 0;
  try {
    for (;;) {
      if (view.phase === 'finished') break;
      if (!view.legal?.yourTurn) {
        const w = await retry(() => api.wait(gameId, token, undefined, 60_000));
        view = w.state;
        continue;
      }
      // A turn whose moves keep being refused is left to the game (its turn timer) instead of retried forever.
      // (wait returns at once while it is our turn, so poll instead.)
      if (refusals.count >= MAX_REFUSALS && refusals.turn === view.turnNumber) {
        await (o.sleep ?? pause)(30_000);
        view = (await retry(() => api.getGame(gameId, token))).state;
        continue;
      }
      if (view.turnNumber !== lastTurn) {
        lastTurn = view.turnNumber;
        if (o.maxTurns !== undefined && stats.turns >= o.maxTurns) {
          log(`reached ${o.maxTurns} turns: leaving the game`);
          await retry(() => api.leave(gameId, token));
          left = true;
          view = (await retry(() => api.getGame(gameId, token))).state;
          break;
        }
        stats.turns++;
      }
      try {
        view = await playTurn(o, ctx, view, stats, maxCalls, refusals, readChat, chat, log);
        serverFailures = 0;
      } catch (err) {
        if (!isTransient(err) || ++serverFailures > 8) throw err;
        // A move sent while the server went down may or may not have landed: read the game again and decide again.
        log(`game server failed during the turn (${errText(err)}): reading the game again`);
        await (o.sleep ?? pause)(Math.min(1000 * 2 ** (serverFailures - 1), 30_000));
        view = (await retry(() => api.getGame(gameId, token))).state;
      }
    }
  } catch (err) {
    if (!gameGone(err)) throw err;
    log(`game ${gameId} is gone (${errText(err)}): stopping`);
    gone = true;
  }

  const me = view.players.find((p) => p.id === view.you);
  const outcome: GameOutcome =
    view.winner && view.winner === view.you ? 'won' : left ? 'surrendered' : gone ? 'abandoned' : me && !me.alive ? 'eliminated' : 'lost';
  const winner = view.players.find((p) => p.id === view.winner)?.name ?? null;
  log(`game ${gameId} over: ${outcome}${winner ? `, winner ${winner}` : ''} (${stats.turns} turns, ${stats.modelCalls} model calls, ${stats.fallbacks} fallbacks)`);
  await readChat();
  const saved = o.reflect === false ? { diaryEntry: null, relationshipsUpdated: 0 } : await reflect(o, ctx, view, outcome, winner, chat(), log);
  return { gameId, outcome, winner, ...stats, ...saved };
}

async function playTurn(
  o: PlayOptions,
  ctx: PlayerContext,
  start: GameView,
  stats: { decisions: number; modelCalls: number; fallbacks: number },
  maxCalls: number,
  refusals: { turn: number; count: number },
  readChat: () => Promise<void>,
  chat: () => string[],
  log: (line: string) => void,
): Promise<GameView> {
  const { api, model, gameId, token } = o;
  let view = start;
  let skipTrade = false;
  let spoke = false;
  let calls = 0;
  let failures = 0;
  await readChat();
  /** Sends a move; false when the server refused it (4xx). A gone game or a server that is down throws. */
  const send = async (action: Action, label: string) => {
    try {
      view = (await api.act(gameId, token, action)).state;
      refusals.count = 0;
      return true;
    } catch (err) {
      if (!(err instanceof RiskHttpError) || err.status >= 500 || err.status === 404) throw err;
      log(`"${label}" was refused (${err.message})`);
      if (refusals.turn !== view.turnNumber) Object.assign(refusals, { turn: view.turnNumber, count: 0 });
      if (++refusals.count === MAX_REFUSALS) log(`${MAX_REFUSALS} moves refused in a row on turn ${view.turnNumber}: waiting for the game to move on`);
      return false;
    }
  };
  while (view.legal?.yourTurn && view.phase !== 'finished') {
    const decision = buildDecision(view, { skipTrade });
    if (!decision || !decision.options.length) break;
    stats.decisions++;
    let index = 0;
    let say = '';
    if (decision.options.length > 1 && calls < maxCalls && failures < MAX_MODEL_FAILURES) {
      calls++;
      stats.modelCalls++;
      try {
        const picked = parseChoice(await model.chat(decisionMessages(ctx, view, decision, chat())), decision.options.length);
        if (picked) ({ index, say } = picked);
        else stats.fallbacks++;
        failures = picked ? 0 : failures + 1;
      } catch (err) {
        stats.fallbacks++;
        failures++;
        log(`model failed, playing option 1: ${errText(err)}`);
      }
      if (failures === MAX_MODEL_FAILURES) log(`model failed ${MAX_MODEL_FAILURES} times in a row: playing option 1 for the rest of the turn`);
    }
    const option = decision.options[index];
    if (!option.action) {
      skipTrade = true;
      continue;
    }
    if (!(await send(option.action, option.label))) {
      // The options come from the engine's legal moves, so this should not happen; recover with the default.
      const fallback = refusals.count < MAX_REFUSALS ? decision.options.find((x, i) => i !== index && x.action) : undefined;
      if (fallback?.action) stats.fallbacks++;
      if (!fallback?.action || !(await send(fallback.action, fallback.label))) {
        return (await retryServer(() => api.getGame(gameId, token), { ...o, log })).state;
      }
    }
    if (say && !spoke && o.chat !== false) {
      spoke = true;
      await api.sendChat(gameId, token, say).catch(() => {});
    }
  }
  return view;
}

async function reflect(o: PlayOptions, ctx: PlayerContext, view: GameView, outcome: GameOutcome, winner: string | null, chat: string[], log: (line: string) => void) {
  const none = { diaryEntry: null, relationshipsUpdated: 0 };
  if (!ctx.characterId) return none;
  if (!o.charactersKey) {
    log('no characters write key: the diary and relationships are not saved');
    return none;
  }
  const opponents = view.players.filter((p) => p.id !== view.you && !p.isNeutral).map((p) => p.name);
  let reflection = null;
  try {
    reflection = parseReflection(await o.model.chat(reflectionMessages(ctx, view, `${outcome}${winner && outcome !== 'won' ? ` (winner: ${winner})` : ''}`, chat), { maxTokens: 900 }), opponents);
  } catch (err) {
    log(`model failed to write the diary: ${err instanceof Error ? err.message : String(err)}`);
  }
  // A diary entry is written even when the model's reflection is unusable: the record still counts the game.
  const entry = await o.api.addDiaryEntry(
    ctx.characterId,
    {
      title: reflection?.title ?? `Game ${view.id}: ${outcome}`,
      text: reflection?.text ?? `Played game ${view.id} on ${view.options.map}; result: ${outcome}${winner && outcome !== 'won' ? `, ${winner} won` : ''}. (No reflection: the model's answer was unusable.)`,
      gameId: view.id,
      outcome,
      map: view.options.map,
      opponents,
      strategy: reflection?.strategy,
      winner: winner && outcome !== 'won' ? winner : undefined,
    },
    o.charactersKey,
  );
  let relationshipsUpdated = 0;
  for (const r of reflection?.relationships ?? []) {
    await o.api.updateRelationship(ctx.characterId, { with: r.with, change: r.change, note: r.note, gameId: view.id }, o.charactersKey);
    relationshipsUpdated++;
  }
  log(`saved diary entry #${entry.n} and ${relationshipsUpdated} relationship note(s) for ${ctx.characterId}`);
  return { diaryEntry: entry.n, relationshipsUpdated };
}
