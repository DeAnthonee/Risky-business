import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { addPlayer, applyAction, createGame, startGame, viewFor, type GameOptions, type GameState } from '@risk/engine';
import { HttpRiskApi } from '@risk/mcp';
// The real game server, from source (as its own tests use it): the player talks to it over HTTP only.
import { DEFAULT_AI_DIR, createRiskServer } from '../../server/src/app.js';
import { CharacterStore } from '../../server/src/characters.js';
import { Store } from '../../server/src/store.js';
import { OpenAICompatModel, buildDecision, extractJson, parseChoice, parseReflection, playGame, type ChatMessage, type ChatModel } from '../src/index.js';

/** Seeded random for repeatable picks. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe('model replies', () => {
  it('finds the JSON through reasoning blocks, fences and chatter', () => {
    expect(extractJson('<think>maybe {"choice": 9}</think>\nSure! ```json\n{"choice": 2, "say": "hi {there}"}\n``` done')).toEqual({ choice: 2, say: 'hi {there}' });
    expect(extractJson('no json here')).toBeNull();
    expect(extractJson('{broken {"choice": 3}')).toEqual({ choice: 3 });
  });

  it('accepts only an option number in range', () => {
    expect(parseChoice('{"choice": 3, "say": "  Ultron online.  "}', 5)).toEqual({ index: 2, say: 'Ultron online.' });
    expect(parseChoice('{"choice": "1"}', 2)).toEqual({ index: 0, say: '' });
    expect(parseChoice('{"choice": 6}', 5)).toBeNull();
    expect(parseChoice('{"choice": 0}', 5)).toBeNull();
    expect(parseChoice('{"choice": 1.5}', 5)).toBeNull();
    expect(parseChoice('I pick two', 5)).toBeNull();
  });

  it('keeps reflection relationships to players who were at the table, clamped', () => {
    const r = parseReflection(
      JSON.stringify({ title: 'T', text: 'X', relationships: [{ with: 'bot 1', change: -99, note: 'Took my capital.' }, { with: 'Stranger', change: 5, note: 'x' }, { with: 'Bot 1', change: 5, note: '' }] }),
      ['Bot 1', 'Bot 2'],
    );
    expect(r?.relationships).toEqual([{ with: 'Bot 1', change: -30, note: 'Took my capital.' }]);
    expect(parseReflection('{"title": "", "text": "x"}', [])).toBeNull();
  });
});

describe('OpenAI-compatible client', () => {
  it('posts the chat to /chat/completions with the model name and key, and reads the reply', async () => {
    let seen: { url?: string; auth?: string; body?: any } = {};
    const server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        seen = { url: req.url, auth: req.headers.authorization, body: JSON.parse(data) };
        if (seen.body.model === 'missing') {
          res.writeHead(404).end('{"error":"model not found"}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"choice": 1}' } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/`;
    try {
      const reply = await new OpenAICompatModel({ baseUrl: base, model: 'qwen2.5:14b', apiKey: 'k' }).chat([{ role: 'user', content: 'hi' }], { maxTokens: 20 });
      expect(reply).toBe('{"choice": 1}');
      expect(seen).toMatchObject({ url: '/v1/chat/completions', auth: 'Bearer k', body: { model: 'qwen2.5:14b', max_tokens: 20, stream: false, messages: [{ role: 'user', content: 'hi' }] } });
      await expect(new OpenAICompatModel({ baseUrl: base, model: 'missing' }).chat([])).rejects.toThrow(/HTTP 404/);
    } finally {
      server.close();
    }
  });
});

describe('decision options', () => {
  /** Plays whole games on the engine, every seat picking random options: every offered action must be legal. */
  function playOut(options: Partial<GameOptions>, seats: number, seed: number) {
    let state: GameState = createGame('T', { maxPlayers: seats, ...options }, seed);
    for (let i = 0; i < seats; i++) state = addPlayer(state, `p${i}`, `P${i}`);
    state = startGame(state).state;
    const random = rng(seed);
    const kinds = new Set<string>();
    let skipTrade = false;
    let lastPlayer = state.currentPlayer;
    for (let step = 0; step < 6000 && state.phase !== 'finished'; step++) {
      const me = state.currentPlayer!;
      if (me !== lastPlayer) {
        skipTrade = false;
        lastPlayer = me;
      }
      const d = buildDecision(viewFor(state, me), { skipTrade });
      expect(d, `no decision in phase ${state.phase}`).not.toBeNull();
      expect(d!.options.length).toBeGreaterThan(0);
      expect(d!.options.length).toBeLessThanOrEqual(13);
      // Mostly the heuristic's choice, sometimes anything, so long games still end.
      const pick = random() < 0.7 ? d!.options[0] : d!.options[Math.floor(random() * d!.options.length)];
      if (!pick.action) {
        skipTrade = true;
        continue;
      }
      kinds.add(pick.action.type);
      state = applyAction(state, me, pick.action).state;
    }
    return { state, kinds };
  }

  it('offers only legal actions through setup, capitals, trades, conquests, fortifies and the end of the game', () => {
    const classic = playOut({ map: 'classic', autoSetup: false, randomDeal: false }, 3, 1);
    expect(classic.kinds).toEqual(new Set(['place', 'trade', 'attack', 'end_attack', 'fortify', 'end_turn']));
    const capitalsFog = playOut({ map: 'skirmish', capitals: true, chooseCapitals: true, fogOfWar: true, autoSetup: true }, 3, 2);
    expect(capitalsFog.kinds.has('choose_capital')).toBe(true);
    expect(capitalsFog.kinds.has('occupy')).toBe(true);
    for (const r of [classic, capitalsFog]) expect(r.state.phase).toBe('finished');
  });
});

describe('playing on a live server', () => {
  const KEY = 'test-characters-key';

  /** A stand-in for the local model: picks options, sometimes answers junk or fails, and writes a reflection. */
  function fakeModel(seed: number) {
    const random = rng(seed);
    const calls: ChatMessage[][] = [];
    const model: ChatModel = {
      name: 'fake',
      async chat(messages) {
        calls.push(messages);
        const user = messages[messages.length - 1].content;
        if (user.includes('Write your diary entry')) {
          return `<think>reflecting</think>{"title": "Lost a skirmish", "text": "Pushed too early. Lesson: hold the border.", "strategy": "early push", "relationships": [{"with": "Bot 1", "change": -12, "note": "Held the line against me."}]}`;
        }
        const r = random();
        if (r < 0.1) return 'I would rather not say.';
        if (r < 0.15) throw new Error('model timed out');
        const count = Number(user.match(/"choice": 1-(\d+)/)![1]);
        return `{"choice": ${1 + Math.floor(random() * count)}, "say": "${r < 0.3 ? 'The vulnerable will be optimized first.' : ''}"}`;
      },
    };
    return { model, calls };
  }

  async function withServer(fn: (api: HttpRiskApi, characters: CharacterStore) => Promise<void>) {
    const characters = new CharacterStore(DEFAULT_AI_DIR, null, [KEY]);
    const risk = createRiskServer(new Store(null), { clientDir: null, sweepIntervalMs: 0, characters });
    await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
    try {
      await fn(new HttpRiskApi(`http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`), characters);
    } finally {
      await risk.shutdown('test');
    }
  }

  it('plays a game as Ultron against a bot, falls back on bad answers, then writes the diary and relationships', async () => {
    await withServer(async (api, characters) => {
      const created = await api.createGame('Ultron', 'llm test', { map: 'skirmish', autoSetup: true, maxPlayers: 2 });
      await api.addBot(created.gameId, created.token);
      await api.start(created.gameId, created.token);
      const { model, calls } = fakeModel(7);
      const lines: string[] = [];
      const summary = await playGame({ api, model, gameId: created.gameId, token: created.token, seatName: 'Ultron', character: 'marvel/ultron', charactersKey: KEY, maxTurns: 12, log: (l) => lines.push(l) });

      expect(['won', 'lost', 'eliminated', 'surrendered']).toContain(summary.outcome);
      expect(summary.turns).toBeGreaterThan(0);
      expect(summary.modelCalls).toBeGreaterThan(5);
      expect(summary.fallbacks).toBeGreaterThan(0);
      // The model saw the layers: general player, the character's profile and memory, framed as data.
      const system = calls[0][0].content;
      expect(system).toContain('<general-player>');
      expect(system).toContain('<character-data id="marvel/ultron">');
      expect(system).toContain('omniscient backseat driver');
      expect(system).toContain('=== MEMORY ===');
      expect(calls[0][1].content).toContain('OPTIONS:\n1. ');
      expect(calls[0][1].content).not.toContain('YOUR LEGAL MOVES');

      // At most one chat line per turn.
      const chat = (await api.chat(created.gameId, 0)).messages.filter((m) => m.name === 'Ultron');
      expect(chat.length).toBeLessThanOrEqual(summary.turns);

      // Diary entry #2 (the repo holds #1) with the game's record, and the relationship note.
      expect(summary.diaryEntry).toBe(2);
      const diary = characters.readDiary('marvel/ultron', 1).entries[0];
      expect(diary).toMatchObject({ n: 2, title: 'Lost a skirmish', gameId: created.gameId, outcome: summary.outcome, map: 'skirmish', opponents: ['Bot 1'], strategy: 'early push' });
      expect(summary.relationshipsUpdated).toBe(1);
      const bot = characters.memorySummary('marvel/ultron').relationships.find((r) => r.with === 'Bot 1');
      expect(bot).toMatchObject({ rapport: -12 });
      expect(lines.some((l) => l.includes('saved diary entry #2'))).toBe(true);
      // Every option the player sent was legal.
      expect(lines.filter((l) => l.includes('was refused'))).toEqual([]);
    });
  }, 60_000);

  it('plays without a character or key and saves nothing', async () => {
    await withServer(async (api, characters) => {
      const created = await api.createGame('Local AI', 'llm test', { map: 'skirmish', autoSetup: true, maxPlayers: 2 });
      await api.addBot(created.gameId, created.token);
      await api.start(created.gameId, created.token);
      const { model, calls } = fakeModel(3);
      const summary = await playGame({ api, model, gameId: created.gameId, token: created.token, seatName: 'Local AI', maxTurns: 3 });
      expect(summary.diaryEntry).toBeNull();
      expect(calls[0][0].content).not.toContain('<character-data');
      expect(characters.readDiary('marvel/ultron').total).toBe(1);
    });
  }, 60_000);
});
