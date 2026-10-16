#!/usr/bin/env node
/**
 * Risky Business MCP server.
 *
 * Exposes a Risk game server to AI agents over the Model Context Protocol (stdio).
 *
 *   RISK_SERVER_URL        base URL of the game server (default http://localhost:8080)
 *   RISK_PLAYER_NAME       default display name for this agent (default "Agent")
 *   RISK_MCP_SESSION_FILE  where per-game identities are persisted (default ~/.risk-mcp/sessions.json)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { Action, GameView } from '@risk/engine';
import { RiskClient, RiskHttpError, defaultSessionFile } from './client.js';
import { formatEvents, formatState } from './format.js';

const SERVER_URL = (process.env.RISK_SERVER_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
const DEFAULT_NAME = process.env.RISK_PLAYER_NAME ?? 'Agent';
const client = new RiskClient(SERVER_URL, defaultSessionFile());

const server = new McpServer(
  { name: 'risky-business', version: '0.1.0' },
  {
    instructions: [
      'You can play the board game Risk (classic world domination rules) against humans, bots and other agents.',
      'Typical flow: rules -> create_game (or join_game with a code) -> optionally add_bot -> start_game -> loop { wait_for_turn -> get_state -> act }.',
      'get_state returns your legal moves; act takes one JSON action. Attacking with blitz:true and occupy:"max" resolves a whole battle in one call.',
      `Server: ${SERVER_URL}`,
    ].join(' '),
  },
);

const gameIdSchema = z.string().min(4).max(12).describe('Game code, e.g. "ABC123"');

const optionsSchema = z
  .object({
    maxPlayers: z.number().int().min(2).max(6).optional().describe('Seats in the game (2-6)'),
    setupBatch: z.number().int().min(1).max(40).optional().describe('Armies each player may place per setup turn (1 = classic, 40 = all at once)'),
    fortifyMode: z.enum(['adjacent', 'connected']).optional().describe('Fortify rule: adjacent (classic) or any connected path'),
    randomDeal: z.boolean().optional().describe('true = territories dealt randomly (default); false = players claim them one by one'),
  })
  .optional();

const actionSchema = z
  .object({
    type: z.enum(['place', 'trade', 'attack', 'occupy', 'end_attack', 'fortify', 'end_turn', 'surrender']),
    placements: z.record(z.number().int().positive()).optional().describe('place: {territoryId: armies}'),
    cardIds: z.array(z.number().int()).optional().describe('trade: exactly 3 card ids'),
    from: z.string().optional().describe('attack/fortify: source territory id'),
    to: z.string().optional().describe('attack/fortify: destination territory id'),
    dice: z.number().int().min(1).max(3).optional().describe('attack: dice to roll (default max)'),
    blitz: z.boolean().optional().describe('attack: keep rolling until the territory falls or you cannot continue'),
    occupy: z.union([z.number().int(), z.literal('min'), z.literal('max')]).optional().describe('attack: if conquered, move this many armies in automatically'),
    armies: z.number().int().optional().describe('occupy/fortify: number of armies to move'),
  })
  .describe('A single game action. See the rules tool for the full list.');

function text(s: string) {
  return { content: [{ type: 'text' as const, text: s }] };
}

function errorText(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  const hint =
    err instanceof RiskHttpError && err.status === 401
      ? ' (no valid identity for this game — join it first, or pass the token you were given)'
      : err instanceof TypeError && /fetch/i.test(msg)
        ? ` (could not reach the game server at ${SERVER_URL}; set RISK_SERVER_URL)`
        : '';
  return { content: [{ type: 'text' as const, text: `Error: ${msg}${hint}` }], isError: true };
}

function tokenFor(gameId: string, override?: string): string | undefined {
  return override ?? client.identity(gameId)?.token;
}

async function stateText(gameId: string, token: string | undefined): Promise<string> {
  const g = await client.getGame(gameId, token);
  return formatState(g.state, g.name);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

server.registerTool(
  'rules',
  { description: 'Return the complete rules of Risk as played on this server, plus the JSON action formats.', inputSchema: {} },
  async () => {
    try {
      const { rules } = await client.rules();
      return text(rules);
    } catch (e) {
      return errorText(e);
    }
  },
);

server.registerTool(
  'map',
  { description: 'Return the static map: territories, continents with bonuses, and adjacency (which territories border which).', inputSchema: {} },
  async () => {
    try {
      const m = await client.map();
      return text(JSON.stringify(m, null, 1));
    } catch (e) {
      return errorText(e);
    }
  },
);

server.registerTool(
  'list_games',
  { description: 'List games on the server: ids, names, phase, players and whether they can be joined.', inputSchema: {} },
  async () => {
    try {
      const { games } = await client.listGames();
      const mine = [...new Set([...(games as { id: string }[]).map((g) => g.id)].filter((id) => client.identity(id)))];
      return text(JSON.stringify({ games, gamesYouAreIn: mine }, null, 1));
    } catch (e) {
      return errorText(e);
    }
  },
);

server.registerTool(
  'create_game',
  {
    description: 'Create a new game and take a seat as its host. Returns the game code to share with other players/agents. Remembers your identity for later calls.',
    inputSchema: {
      playerName: z.string().max(24).optional().describe(`Your display name (default "${DEFAULT_NAME}")`),
      gameName: z.string().max(40).optional(),
      options: optionsSchema,
    },
  },
  async ({ playerName, gameName, options }) => {
    try {
      const name = playerName ?? DEFAULT_NAME;
      const r = await client.createGame(name, gameName, options);
      client.setIdentity({ gameId: r.gameId, playerId: r.playerId, token: r.token, name });
      return text(
        `Created game ${r.gameId}. You are ${name} (${r.playerId}) and the host. Token: ${r.token}\n` +
          `Share the code ${r.gameId} so others can join, add bots with add_bot, then start_game.\n\n${formatState(r.state)}`,
      );
    } catch (e) {
      return errorText(e);
    }
  },
);

server.registerTool(
  'join_game',
  {
    description: 'Join an existing game by code. Remembers your identity for later calls.',
    inputSchema: { gameId: gameIdSchema, playerName: z.string().max(24).optional() },
  },
  async ({ gameId, playerName }) => {
    try {
      const existing = client.identity(gameId);
      if (existing) {
        const g = await client.getGame(gameId, existing.token);
        if (g.playerId === existing.playerId) return text(`You are already in game ${gameId.toUpperCase()} as ${existing.name} (${existing.playerId}).\n\n${formatState(g.state, g.name)}`);
      }
      const name = playerName ?? DEFAULT_NAME;
      const r = await client.joinGame(gameId.toUpperCase(), name);
      client.setIdentity({ gameId: r.gameId, playerId: r.playerId, token: r.token, name });
      return text(`Joined game ${r.gameId} as ${name} (${r.playerId}). Token: ${r.token}\n\n${formatState(r.state)}`);
    } catch (e) {
      return errorText(e);
    }
  },
);

server.registerTool(
  'resume_game',
  {
    description: 'Resume a game with a player token you were given earlier (e.g. by another agent or a human who created the seat for you).',
    inputSchema: { gameId: gameIdSchema, token: z.string(), playerName: z.string().optional() },
  },
  async ({ gameId, token, playerName }) => {
    try {
      const g = await client.getGame(gameId.toUpperCase(), token);
      if (!g.playerId) return errorText(new Error('That token is not valid for this game'));
      const name = playerName ?? g.state.players.find((p) => p.id === g.playerId)?.name ?? DEFAULT_NAME;
      client.setIdentity({ gameId: gameId.toUpperCase(), playerId: g.playerId, token, name });
      return text(`Resumed game ${gameId.toUpperCase()} as ${name} (${g.playerId}).\n\n${formatState(g.state, g.name)}`);
    } catch (e) {
      return errorText(e);
    }
  },
);

server.registerTool(
  'add_bot',
  { description: 'Add a built-in computer player to a game you host (lobby only).', inputSchema: { gameId: gameIdSchema, name: z.string().max(24).optional() } },
  async ({ gameId, name }) => {
    try {
      const token = tokenFor(gameId);
      if (!token) throw new RiskHttpError('Not in this game', 401);
      const r = await client.addBot(gameId.toUpperCase(), token, name);
      return text(`Added bot ${r.playerId}.\n\n${await stateText(gameId.toUpperCase(), token)}`);
    } catch (e) {
      return errorText(e);
    }
  },
);

server.registerTool(
  'set_options',
  { description: 'Change game options (host only, lobby only).', inputSchema: { gameId: gameIdSchema, options: optionsSchema } },
  async ({ gameId, options }) => {
    try {
      const token = tokenFor(gameId);
      if (!token) throw new RiskHttpError('Not in this game', 401);
      const r = await client.setOptions(gameId.toUpperCase(), token, options ?? {});
      return text(formatState(r.state));
    } catch (e) {
      return errorText(e);
    }
  },
);

server.registerTool(
  'start_game',
  { description: 'Start a game you host (needs at least 2 players, bots included).', inputSchema: { gameId: gameIdSchema } },
  async ({ gameId }) => {
    try {
      const token = tokenFor(gameId);
      if (!token) throw new RiskHttpError('Not in this game', 401);
      const r = await client.start(gameId.toUpperCase(), token);
      return text(`Game started.\n\n${formatState(r.state)}`);
    } catch (e) {
      return errorText(e);
    }
  },
);

server.registerTool(
  'get_state',
  {
    description: 'Get the current game state from your point of view, including your cards and the list of legal moves if it is your turn.',
    inputSchema: {
      gameId: gameIdSchema,
      format: z.enum(['text', 'json']).optional().describe('text (default, compact and readable) or json (raw state view)'),
      token: z.string().optional().describe('Override the stored identity'),
    },
  },
  async ({ gameId, format, token }) => {
    try {
      const g = await client.getGame(gameId.toUpperCase(), tokenFor(gameId, token));
      if (format === 'json') return text(JSON.stringify(g.state));
      return text(formatState(g.state, g.name));
    } catch (e) {
      return errorText(e);
    }
  },
);

server.registerTool(
  'wait_for_turn',
  {
    description:
      'Block until it is your turn (or the game ends), up to timeoutSeconds. Returns what happened since you last looked plus the new state. Call again if it returns "timeout".',
    inputSchema: {
      gameId: gameIdSchema,
      timeoutSeconds: z.number().min(1).max(110).optional().describe('Default 60'),
      sinceVersion: z.number().int().optional().describe('If given, also return when the state version passes this number, and include the events since then'),
    },
  },
  async ({ gameId, timeoutSeconds, sinceVersion }) => {
    try {
      const token = tokenFor(gameId);
      const r = await client.wait(gameId.toUpperCase(), token, sinceVersion, (timeoutSeconds ?? 60) * 1000);
      const header =
        r.reason === 'turn'
          ? 'It is your turn.'
          : r.reason === 'finished'
            ? 'The game is over.'
            : r.reason === 'change'
              ? 'The state changed.'
              : 'Timed out while waiting; it is still not your turn. Call wait_for_turn again.';
      const evText = r.events.length ? `\nRecent events:\n${r.events.map((e) => formatEvents(e.events, r.state)).filter(Boolean).join('\n')}\n` : '';
      return text(`${header}${evText}\n${formatState(r.state)}`);
    } catch (e) {
      return errorText(e);
    }
  },
);

server.registerTool(
  'act',
  {
    description:
      'Perform one game action on your turn. Returns the resulting events (dice rolls, conquests...) and the new state with your next legal moves. ' +
      'Examples: {"type":"place","placements":{"alaska":3}} · {"type":"attack","from":"alaska","to":"kamchatka","blitz":true,"occupy":"max"} · {"type":"end_attack"} · {"type":"fortify","from":"peru","to":"brazil","armies":2} · {"type":"end_turn"}',
    inputSchema: { gameId: gameIdSchema, action: actionSchema, token: z.string().optional() },
  },
  async ({ gameId, action, token }) => {
    try {
      const tok = tokenFor(gameId, token);
      if (!tok) throw new RiskHttpError('Not in this game', 401);
      const r = await client.act(gameId.toUpperCase(), tok, action as Action);
      const ev = formatEvents(r.events, r.state);
      return text(`OK.${ev ? `\nEvents:\n${ev}` : ''}\n\n${formatState(r.state)}`);
    } catch (e) {
      return errorText(e);
    }
  },
);

server.registerTool(
  'recent_events',
  {
    description: 'Get the game log since a given state version (what everyone did). Useful to see what opponents did between your turns.',
    inputSchema: { gameId: gameIdSchema, sinceVersion: z.number().int().optional().describe('Default: last 30 entries') },
  },
  async ({ gameId, sinceVersion }) => {
    try {
      const g = await client.getGame(gameId.toUpperCase(), tokenFor(gameId));
      const r = await client.events(gameId.toUpperCase(), sinceVersion ?? 0);
      const entries = sinceVersion === undefined ? r.entries.slice(-30) : r.entries;
      const lines = entries.map((e) => `v${e.version}: ${formatEvents(e.events, g.state as GameView) || JSON.stringify(e.events)}`);
      return text(lines.join('\n') || 'No events yet.');
    } catch (e) {
      return errorText(e);
    }
  },
);

server.registerTool(
  'send_chat',
  { description: 'Send a chat message to everyone in the game (table talk, alliances, trash talk).', inputSchema: { gameId: gameIdSchema, message: z.string().min(1).max(500) } },
  async ({ gameId, message }) => {
    try {
      const token = tokenFor(gameId);
      if (!token) throw new RiskHttpError('Not in this game', 401);
      await client.sendChat(gameId.toUpperCase(), token, message);
      return text('Sent.');
    } catch (e) {
      return errorText(e);
    }
  },
);

server.registerTool(
  'read_chat',
  { description: 'Read chat messages in a game.', inputSchema: { gameId: gameIdSchema, sinceId: z.number().int().optional() } },
  async ({ gameId, sinceId }) => {
    try {
      const { messages } = await client.chat(gameId.toUpperCase(), sinceId ?? 0);
      return text(messages.map((m) => `#${m.id} ${m.name}: ${m.message}`).join('\n') || 'No messages.');
    } catch (e) {
      return errorText(e);
    }
  },
);

server.registerTool(
  'leave_game',
  { description: 'Leave a game: in the lobby you simply leave; in a running game this surrenders.', inputSchema: { gameId: gameIdSchema } },
  async ({ gameId }) => {
    try {
      const token = tokenFor(gameId);
      if (!token) throw new RiskHttpError('Not in this game', 401);
      await client.leave(gameId.toUpperCase(), token);
      client.forget(gameId);
      return text(`Left game ${gameId.toUpperCase()}.`);
    } catch (e) {
      return errorText(e);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
