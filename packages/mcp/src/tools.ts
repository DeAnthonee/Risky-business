import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Action, GameView } from '@risk/engine';
import { RiskHttpError, type IdentityStore, type RiskApi } from './api.js';
import { formatEvents, formatState } from './format.js';

export interface RiskMcpOptions {
  api: RiskApi;
  identities: IdentityStore;
  /** Default display name for this agent. */
  defaultName?: string;
  /** Shown in the server instructions, e.g. the game server URL. */
  serverLabel?: string;
  /** Extra sentence(s) for the instructions (e.g. how identities persist in this transport). */
  identityNote?: string;
}

const gameIdSchema = z.string().min(4).max(12).describe('Game code, e.g. "ABC123"');
const tokenSchema = z.string().optional().describe('Player token, if you were given one and this connection does not remember your seat');

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

/** Build a Risk MCP server. Works over any transport (stdio or Streamable HTTP). */
export function createRiskMcpServer(opts: RiskMcpOptions): McpServer {
  const { api, identities } = opts;
  const DEFAULT_NAME = opts.defaultName ?? 'Agent';
  const label = opts.serverLabel ?? 'Risky Business';

  const server = new McpServer(
    { name: 'risky-business', version: '0.1.0' },
    {
      instructions: [
        'You can play the board game Risk (classic world domination rules) against humans, bots and other agents.',
        'Typical flow: rules -> create_game (or join_game with a code a human shared) -> optionally add_bot -> start_game -> loop { wait_for_turn -> get_state -> act }.',
        'get_state returns your legal moves; act takes one JSON action. Attacking with blitz:true and occupy:"max" resolves a whole battle in one call.',
        opts.identityNote ??
          'Your seat (player token) is remembered for each game you create or join; use resume_game with a token if you need to recover it.',
        `Server: ${label}`,
      ].join(' '),
    },
  );

  const errorText = (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    const hint =
      err instanceof RiskHttpError && err.status === 401
        ? ' (no valid seat for this game on this connection — join_game, or resume_game with your token)'
        : err instanceof TypeError && /fetch/i.test(msg)
          ? ` (could not reach the game server: ${label})`
          : '';
    return { content: [{ type: 'text' as const, text: `Error: ${msg}${hint}` }], isError: true };
  };

  const tokenFor = (gameId: string, override?: string): string | undefined => override ?? identities.get(gameId)?.token;
  const requireToken = (gameId: string, override?: string): string => {
    const t = tokenFor(gameId, override);
    if (!t) throw new RiskHttpError('Not in this game', 401);
    return t;
  };
  const stateText = async (gameId: string, token: string | undefined) => {
    const g = await api.getGame(gameId, token);
    return formatState(g.state, g.name);
  };

  server.registerTool('rules', { description: 'Return the complete rules of Risk as played on this server, plus the JSON action formats.', inputSchema: {} }, async () => {
    try {
      return text((await api.rules()).rules);
    } catch (e) {
      return errorText(e);
    }
  });

  server.registerTool('map', { description: 'Return the static map: territories, continents with bonuses, and adjacency (which territories border which).', inputSchema: {} }, async () => {
    try {
      return text(JSON.stringify(await api.map(), null, 1));
    } catch (e) {
      return errorText(e);
    }
  });

  server.registerTool('list_games', { description: 'List games on the server: ids, names, phase, players and whether they can be joined.', inputSchema: {} }, async () => {
    try {
      const { games } = await api.listGames();
      return text(JSON.stringify({ games, gamesYouAreIn: identities.gameIds() }, null, 1));
    } catch (e) {
      return errorText(e);
    }
  });

  server.registerTool(
    'create_game',
    {
      description: 'Create a new game and take a seat as its host. Returns the game code to share with other players/agents and your player token.',
      inputSchema: {
        playerName: z.string().max(24).optional().describe(`Your display name (default "${DEFAULT_NAME}")`),
        gameName: z.string().max(40).optional(),
        options: optionsSchema,
      },
    },
    async ({ playerName, gameName, options }) => {
      try {
        const name = playerName ?? DEFAULT_NAME;
        const r = await api.createGame(name, gameName, options);
        identities.set({ gameId: r.gameId, playerId: r.playerId, token: r.token, name });
        return text(
          `Created game ${r.gameId}. You are ${name} (${r.playerId}) and the host. Your token: ${r.token}\n` +
            `Share the code ${r.gameId} so others can join (humans use the website), add bots with add_bot, then start_game.\n\n${formatState(r.state)}`,
        );
      } catch (e) {
        return errorText(e);
      }
    },
  );

  server.registerTool(
    'join_game',
    { description: 'Join an existing game by code (the game must still be in its lobby).', inputSchema: { gameId: gameIdSchema, playerName: z.string().max(24).optional() } },
    async ({ gameId, playerName }) => {
      try {
        const id = gameId.toUpperCase();
        const existing = identities.get(id);
        if (existing) {
          const g = await api.getGame(id, existing.token);
          if (g.playerId === existing.playerId) return text(`You are already in game ${id} as ${existing.name} (${existing.playerId}).\n\n${formatState(g.state, g.name)}`);
        }
        const name = playerName ?? DEFAULT_NAME;
        const r = await api.joinGame(id, name);
        identities.set({ gameId: r.gameId, playerId: r.playerId, token: r.token, name });
        return text(`Joined game ${r.gameId} as ${name} (${r.playerId}). Your token: ${r.token}\n\n${formatState(r.state)}`);
      } catch (e) {
        return errorText(e);
      }
    },
  );

  server.registerTool(
    'resume_game',
    {
      description: 'Take back a seat using a player token you were given earlier (after a reconnect, or a seat a human created for you).',
      inputSchema: { gameId: gameIdSchema, token: z.string(), playerName: z.string().optional() },
    },
    async ({ gameId, token, playerName }) => {
      try {
        const id = gameId.toUpperCase();
        const g = await api.getGame(id, token);
        if (!g.playerId) return errorText(new Error('That token is not valid for this game'));
        const name = playerName ?? g.state.players.find((p) => p.id === g.playerId)?.name ?? DEFAULT_NAME;
        identities.set({ gameId: id, playerId: g.playerId, token, name });
        return text(`Resumed game ${id} as ${name} (${g.playerId}).\n\n${formatState(g.state, g.name)}`);
      } catch (e) {
        return errorText(e);
      }
    },
  );

  server.registerTool(
    'add_bot',
    { description: 'Add a built-in computer player to a game you host (lobby only).', inputSchema: { gameId: gameIdSchema, name: z.string().max(24).optional(), token: tokenSchema } },
    async ({ gameId, name, token }) => {
      try {
        const id = gameId.toUpperCase();
        const t = requireToken(id, token);
        const r = await api.addBot(id, t, name);
        return text(`Added bot ${r.playerId}.\n\n${await stateText(id, t)}`);
      } catch (e) {
        return errorText(e);
      }
    },
  );

  server.registerTool(
    'set_options',
    { description: 'Change game options (host only, lobby only).', inputSchema: { gameId: gameIdSchema, options: optionsSchema, token: tokenSchema } },
    async ({ gameId, options, token }) => {
      try {
        const id = gameId.toUpperCase();
        const r = await api.setOptions(id, requireToken(id, token), options ?? {});
        return text(formatState(r.state));
      } catch (e) {
        return errorText(e);
      }
    },
  );

  server.registerTool('start_game', { description: 'Start a game you host (needs at least 2 players, bots included).', inputSchema: { gameId: gameIdSchema, token: tokenSchema } }, async ({ gameId, token }) => {
    try {
      const id = gameId.toUpperCase();
      const r = await api.start(id, requireToken(id, token));
      return text(`Game started.\n\n${formatState(r.state)}`);
    } catch (e) {
      return errorText(e);
    }
  });

  server.registerTool(
    'get_state',
    {
      description: 'Get the current game state from your point of view, including your cards and the list of legal moves if it is your turn.',
      inputSchema: { gameId: gameIdSchema, format: z.enum(['text', 'json']).optional().describe('text (default, compact and readable) or json (raw state view)'), token: tokenSchema },
    },
    async ({ gameId, format, token }) => {
      try {
        const id = gameId.toUpperCase();
        const g = await api.getGame(id, tokenFor(id, token));
        return text(format === 'json' ? JSON.stringify(g.state) : formatState(g.state, g.name));
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
        token: tokenSchema,
      },
    },
    async ({ gameId, timeoutSeconds, sinceVersion, token }) => {
      try {
        const id = gameId.toUpperCase();
        const r = await api.wait(id, tokenFor(id, token), sinceVersion, (timeoutSeconds ?? 60) * 1000);
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
      inputSchema: { gameId: gameIdSchema, action: actionSchema, token: tokenSchema },
    },
    async ({ gameId, action, token }) => {
      try {
        const id = gameId.toUpperCase();
        const r = await api.act(id, requireToken(id, token), action as Action);
        const ev = formatEvents(r.events, r.state);
        return text(`OK.${ev ? `\nEvents:\n${ev}` : ''}\n\n${formatState(r.state)}`);
      } catch (e) {
        return errorText(e);
      }
    },
  );

  server.registerTool(
    'recent_events',
    { description: 'Get the game log since a given state version (what everyone did). Useful to see what opponents did between your turns.', inputSchema: { gameId: gameIdSchema, sinceVersion: z.number().int().optional().describe('Default: last 30 entries') } },
    async ({ gameId, sinceVersion }) => {
      try {
        const id = gameId.toUpperCase();
        const g = await api.getGame(id, tokenFor(id));
        const r = await api.events(id, sinceVersion ?? 0);
        const entries = sinceVersion === undefined ? r.entries.slice(-30) : r.entries;
        return text(entries.map((e) => `v${e.version}: ${formatEvents(e.events, g.state as GameView) || JSON.stringify(e.events)}`).join('\n') || 'No events yet.');
      } catch (e) {
        return errorText(e);
      }
    },
  );

  server.registerTool('send_chat', { description: 'Send a chat message to everyone in the game (table talk, alliances, trash talk).', inputSchema: { gameId: gameIdSchema, message: z.string().min(1).max(500), token: tokenSchema } }, async ({ gameId, message, token }) => {
    try {
      const id = gameId.toUpperCase();
      await api.sendChat(id, requireToken(id, token), message);
      return text('Sent.');
    } catch (e) {
      return errorText(e);
    }
  });

  server.registerTool('read_chat', { description: 'Read chat messages in a game.', inputSchema: { gameId: gameIdSchema, sinceId: z.number().int().optional() } }, async ({ gameId, sinceId }) => {
    try {
      const { messages } = await api.chat(gameId.toUpperCase(), sinceId ?? 0);
      return text(messages.map((m) => `#${m.id} ${m.name}: ${m.message}`).join('\n') || 'No messages.');
    } catch (e) {
      return errorText(e);
    }
  });

  server.registerTool('leave_game', { description: 'Leave a game: in the lobby you simply leave; in a running game this surrenders.', inputSchema: { gameId: gameIdSchema, token: tokenSchema } }, async ({ gameId, token }) => {
    try {
      const id = gameId.toUpperCase();
      await api.leave(id, requireToken(id, token));
      identities.forget(id);
      return text(`Left game ${id}.`);
    } catch (e) {
      return errorText(e);
    }
  });

  return server;
}
