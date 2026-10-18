#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { parseOptions } from '@risk/engine';
import { HttpRiskApi } from '@risk/mcp';
import { OpenAICompatModel } from './model.js';
import { playGame } from './player.js';

const USAGE = `risk-llm-player: play Risk with a local model (any OpenAI-compatible endpoint), optionally as a character

  --join CODE               join a game a human shared (waits in the lobby until the host starts it)
  --game CODE --token TOK   resume a seat you already hold
  --create                  host a new game: [--bots 2] [--options '{"map":"classic"}'] (starts it right away)

  --character ID            play as a character, e.g. marvel/ultron (default: the general player)
  --name NAME               seat name (default: the character's name, or "Local AI")
  --model NAME              model to ask (env LOCAL_MODEL), e.g. qwen2.5:14b
  --model-url URL           OpenAI-compatible base URL (env LOCAL_MODEL_URL, default http://127.0.0.1:11434/v1 = Ollama)
  --server URL              game server (env RISK_SERVER_URL, default http://localhost:8080)
  --max-turns N             leave after N of your turns     --timeout S    seconds per model answer (default 120)
  --no-chat                 never post to the table chat    --no-reflect   skip the after-game diary
  --check                   ask the model one question and exit (to test the setup)

env: LOCAL_MODEL_API_KEY (hosted endpoints only), RISK_CHARACTERS_KEY (needed to save the diary and relationships)`;

function fail(msg: string): never {
  console.error(`${msg}\n\n${USAGE}`);
  process.exit(2);
}

const { values: a } = parseArgs({
  options: {
    join: { type: 'string' },
    game: { type: 'string' },
    token: { type: 'string' },
    create: { type: 'boolean' },
    bots: { type: 'string' },
    options: { type: 'string' },
    character: { type: 'string' },
    name: { type: 'string' },
    model: { type: 'string' },
    'model-url': { type: 'string' },
    server: { type: 'string' },
    'max-turns': { type: 'string' },
    timeout: { type: 'string' },
    'no-chat': { type: 'boolean' },
    'no-reflect': { type: 'boolean' },
    check: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});
if (a.help) {
  console.log(USAGE);
  process.exit(0);
}

const int = (v: string | undefined, name: string) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) fail(`--${name} must be a non-negative integer`);
  return n;
};
const modelName = a.model ?? process.env.LOCAL_MODEL;
if (!modelName) fail('Say which model to use: --model NAME or LOCAL_MODEL');
const model = new OpenAICompatModel({
  baseUrl: a['model-url'] ?? process.env.LOCAL_MODEL_URL ?? 'http://127.0.0.1:11434/v1',
  model: modelName,
  apiKey: process.env.LOCAL_MODEL_API_KEY || undefined,
  timeoutMs: (int(a.timeout, 'timeout') ?? 120) * 1000,
});
const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);

if (a.check) {
  const started = Date.now();
  const reply = await model.chat([{ role: 'user', content: 'Reply with the JSON {"choice": 2, "say": "ready"} and nothing else.' }], { maxTokens: 50 });
  log(`model ${modelName} answered in ${Date.now() - started} ms: ${reply.trim().slice(0, 200)}`);
  process.exit(0);
}

const charactersKey = process.env.RISK_CHARACTERS_KEY || undefined;
const api = new HttpRiskApi(a.server ?? process.env.RISK_SERVER_URL ?? 'http://localhost:8080', charactersKey);
const characterName = a.character ? (await api.getCharacter(a.character)).name : null;
const seatName = a.name ?? characterName ?? 'Local AI';

let gameId: string;
let token: string;
if (a.create) {
  const bots = int(a.bots, 'bots') ?? 2;
  const options = { maxPlayers: bots + 1, ...(a.options ? parseOptions(JSON.parse(a.options)) : {}) };
  const created = await api.createGame(seatName, undefined, options);
  ({ gameId, token } = created);
  for (let i = 0; i < bots; i++) await api.addBot(gameId, token);
  await api.start(gameId, token);
  log(`created and started game ${gameId}`);
} else if (a.join) {
  ({ gameId, token } = await api.joinGame(a.join.toUpperCase(), seatName));
  log(`joined game ${gameId} as ${seatName}; token ${token} (keep it to resume with --game ${gameId} --token ...)`);
} else if (a.game && a.token) {
  gameId = a.game.toUpperCase();
  token = a.token;
} else {
  fail('Pick a game: --join CODE, --game CODE --token TOKEN, or --create');
}

const summary = await playGame({
  api,
  model,
  gameId,
  token,
  seatName,
  character: a.character,
  charactersKey,
  maxTurns: int(a['max-turns'], 'max-turns'),
  chat: !a['no-chat'],
  reflect: !a['no-reflect'],
  log,
});
console.log(JSON.stringify(summary, null, 2));
