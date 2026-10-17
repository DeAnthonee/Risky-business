#!/usr/bin/env node
/**
 * Risky Business MCP server over stdio, for Claude Code / Claude Desktop / any local MCP client.
 *
 *   RISK_SERVER_URL        base URL of the game server (default http://localhost:8080)
 *   RISK_PLAYER_NAME       default display name for this agent (default "Agent")
 *   RISK_MCP_SESSION_FILE  where per-game identities are persisted (default ~/.risk-mcp/sessions.json)
 *   RISK_CHARACTERS_KEY    the server's characters write key, so this agent can save profiles, diaries, relationships
 *
 * (Hosted servers also expose the same tools remotely at <server>/mcp for claude.ai connectors.)
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FileIdentityStore, HttpRiskApi, defaultSessionFile } from './api.js';
import { createRiskMcpServer } from './tools.js';

const SERVER_URL = (process.env.RISK_SERVER_URL ?? 'http://localhost:8080').replace(/\/+$/, '');
const api = new HttpRiskApi(SERVER_URL, process.env.RISK_CHARACTERS_KEY || undefined);
const server = createRiskMcpServer({
  api,
  identities: new FileIdentityStore(SERVER_URL, defaultSessionFile()),
  defaultName: process.env.RISK_PLAYER_NAME ?? 'Agent',
  serverLabel: SERVER_URL,
});

await server.connect(new StdioServerTransport());
