import type { GameView } from '@risk/engine';
import type { ChatResult, GameOutcome, RiskApi } from '@risk/mcp';
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
 * table never waits on a broken model.
 */
export async function playGame(o: PlayOptions): Promise<GameSummary> {
  const { api, model, gameId, token } = o;
  const log = o.log ?? (() => {});
  const maxCalls = o.maxCallsPerTurn ?? 40;
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

  let view: GameView = (await api.getGame(gameId, token)).state;
  let lastTurn = -1;
  let left = false;
  for (;;) {
    if (view.phase === 'finished') break;
    if (!view.legal?.yourTurn) {
      const w = await api.wait(gameId, token, undefined, 60_000);
      view = w.state;
      continue;
    }
    if (view.turnNumber !== lastTurn) {
      lastTurn = view.turnNumber;
      if (o.maxTurns !== undefined && stats.turns >= o.maxTurns) {
        log(`reached ${o.maxTurns} turns: leaving the game`);
        await api.leave(gameId, token);
        left = true;
        view = (await api.getGame(gameId, token)).state;
        break;
      }
      stats.turns++;
    }
    view = await playTurn(o, ctx, view, stats, maxCalls, readChat, chat, log);
  }

  const me = view.players.find((p) => p.id === view.you);
  const outcome: GameOutcome = view.winner && view.winner === view.you ? 'won' : left ? 'surrendered' : me && !me.alive ? 'eliminated' : 'lost';
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
  readChat: () => Promise<void>,
  chat: () => string[],
  log: (line: string) => void,
): Promise<GameView> {
  const { api, model, gameId, token } = o;
  let view = start;
  let skipTrade = false;
  let spoke = false;
  let calls = 0;
  await readChat();
  while (view.legal?.yourTurn && view.phase !== 'finished') {
    const decision = buildDecision(view, { skipTrade });
    if (!decision || !decision.options.length) break;
    stats.decisions++;
    let index = 0;
    let say = '';
    if (decision.options.length > 1 && calls < maxCalls) {
      calls++;
      stats.modelCalls++;
      try {
        const picked = parseChoice(await model.chat(decisionMessages(ctx, view, decision, chat())), decision.options.length);
        if (picked) ({ index, say } = picked);
        else stats.fallbacks++;
      } catch (err) {
        stats.fallbacks++;
        log(`model failed, playing option 1: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const option = decision.options[index];
    if (!option.action) {
      skipTrade = true;
      continue;
    }
    try {
      view = (await api.act(gameId, token, option.action)).state;
    } catch (err) {
      // The options come from the engine's legal moves, so this should not happen; recover with the default.
      log(`"${option.label}" was refused (${err instanceof Error ? err.message : String(err)})`);
      const fallback = decision.options.find((x, i) => i !== index && x.action);
      if (!fallback?.action) return (await api.getGame(gameId, token)).state;
      stats.fallbacks++;
      view = (await api.act(gameId, token, fallback.action)).state;
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
