import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpRiskApi } from '@risk/mcp';
import { Store } from '../../server/src/store.js';
import { createRiskServer, type RiskServer } from '../../server/src/app.js';
import { Diplomat } from '../src/diplomat.js';
import type { Llm } from '../src/llm.js';
import { SeatRunner } from '../src/seat.js';
import { LoopControl, runLoop } from '../src/loop.js';
import { createGame } from '../src/setup.js';

let risk: RiskServer;
let api: HttpRiskApi;

beforeAll(async () => {
  risk = createRiskServer(new Store(null), { clientDir: null, sweepIntervalMs: 0 });
  await new Promise<void>((resolve) => risk.server.listen(0, '127.0.0.1', resolve));
  api = new HttpRiskApi(`http://127.0.0.1:${(risk.server.address() as AddressInfo).port}`);
});

afterAll(async () => {
  await risk.shutdown('test');
});

const seats = [{ name: 'Ann' }, { name: 'Bob' }, { name: 'Cy' }];

async function playOut(withChat: boolean) {
  const { gameId, identities } = await createGame(api, seats, { options: { map: 'skirmish' } });
  const llm: Llm = { chat: async () => '{"say":"hi","to":null}' };
  const runners = identities.map(
    (id) =>
      new SeatRunner({
        api,
        gameId,
        playerId: id.playerId,
        token: id.token,
        name: id.name,
        paceMs: 0,
        log: () => {},
        freeChat: true,
        diplomat: withChat ? new Diplomat({ llm, seatName: id.name, playerId: id.playerId, characterMarkdown: null, maxPerTurn: 1, cooldownMs: 0, random: () => 0 }) : null,
      }),
  );
  const views = await Promise.all(runners.map((r) => r.run()));
  return { gameId, final: views.find((v) => v?.phase === 'finished') ?? null };
}

describe('runner against a real server', () => {
  it('plays three seats to a winner without chat', async () => {
    const { gameId, final } = await playOut(false);
    expect(final?.winner).toBeTruthy();
    expect((await api.chat(gameId, 0)).messages).toHaveLength(0);
  }, 90_000);

  it('posts chat within the per-turn cap', async () => {
    const { gameId, final } = await playOut(true);
    expect(final?.winner).toBeTruthy();
    await new Promise((r) => setTimeout(r, 200));
    const { messages } = await api.chat(gameId, 0);
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((m) => m.message === 'hi')).toBe(true);
    // One opening line per own turn at most (maxPerTurn 1, and "hi" mentions nobody).
    expect(messages.length).toBeLessThanOrEqual(final!.turnNumber);
  }, 90_000);
});

describe('learning loop against a real server', () => {
  it('plays two six-seat games with default options and writes results, notes and the bot section', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'runner-loop-'));
    try {
      const human = '# Shared Risk learnings\n\nAdvice, not rules.\n\n## Capitals\n- Garrison your capital.\n';
      await writeFile(path.join(dir, 'RISK_LEARNINGS.md'), human, 'utf8');
      await mkdir(path.join(dir, 'characters', 'league', 'shen'), { recursive: true });
      await writeFile(path.join(dir, 'characters', 'league', 'shen', 'memory.md'), 'Personal reserve plan from earlier games.');
      await writeFile(path.join(dir, 'characters', 'league', 'shen', 'experience.json'), JSON.stringify({ processed: [], playstyle: 'Negotiate short truces and keep reserves.', relationships: {} }));
      let chatN = 0;
      const planned: string[] = [];
      const llm: Llm = {
        async chat(messages) {
          const sys = messages[0].content;
          if (sys.includes('commander of the Risk player')) {
            planned.push(messages.map(m => m.content).join('\n'));
            return JSON.stringify({ plan: 'Hold a bonus and take a card each turn', focus: null, target: null, avoid: [], aggression: 0.5, capitalGarrison: 5, capital: null, note: 'steady' });
          }
          if (sys.includes('post-game notes')) return '- Played the whole game.\n\n## Result\nSee standings.\n\n## Top lessons\n- Keep a garrison on the capital.';
          if (sys.includes('curator')) { const id = /Game just finished: (\w+)/.exec(messages[1].content)![1]; return `- Garrison the capital: ${id} agrees after 4 rounds (1 game, last ${id})`; }
          return JSON.stringify({ say: `Observation ${++chatN} about the board`, to: null });
        },
      };
      const names = ['Shen', 'Shaco', 'Tryndamere', 'Teemo', 'Leona', 'Ahri'];
      const lines: string[] = [];
      const results = await runLoop({
        api,
        llm,
        seats: names.map((n) => ({ name: n, characterId: `league/${n.toLowerCase()}` })),
        games: 2,
        learningsDir: dir,
        map: 'classic',
        paceMs: 0,
        planTimeoutMs: 5000,
        commander: true,
        learn: true,
        chat: true,
        maxChatPerTurn: 1,
        log: (l) => lines.push(l),
      });
      expect(results).toHaveLength(2);
      expect(results.every((r) => r.winner)).toBe(true);
      expect(results[0].gameId).not.toBe(results[1].gameId);
      for (const result of results) {
        expect(result.options).toMatchObject({ autoSetup: true, cardValues: expect.stringMatching(/^(progressive|fixed|exponential)$/), chooseCapitals: true, balancedBlitz: true, maxPlayers: 6 });
        expect([0, 8]).toContain(result.options.blizzards);
        expect(typeof result.options.fogOfWar).toBe('boolean');
        expect(typeof result.options.capitals).toBe('boolean');
      }
      expect(planned.length).toBeGreaterThan(12);
      expect(planned.some(p => p.includes('Personal reserve plan from earlier games.'))).toBe(true);
      expect(planned.some(p => p.includes('Negotiate short truces and keep reserves.'))).toBe(true);
      expect(planned.some(p => p.includes('Your all-time record and rivals'))).toBe(true);
      expect(planned.some(p => p.includes('THIS GAME ONLY'))).toBe(true);
      expect(planned.some(p => p.includes('Coalition assessment:'))).toBe(true);

      const jsonl = (await readFile(path.join(dir, 'results.jsonl'), 'utf8')).trim().split('\n');
      expect(jsonl).toHaveLength(2);
      expect(JSON.parse(jsonl[0]).seats).toHaveLength(6);

      const notes = await readdir(path.join(dir, 'learnings'));
      expect(notes).toHaveLength(12);
      for (const r of results) for (const n of names) expect(notes).toContain(`${n.toLowerCase()}-${r.gameId}.md`);
      const scouting = await readdir(path.join(dir, 'scouting'));
      expect(scouting).toHaveLength(12);
      expect(await readFile(path.join(dir, 'scouting', scouting[0]), 'utf8')).toContain('Hold a bonus');

      const file = await readFile(path.join(dir, 'RISK_LEARNINGS.md'), 'utf8');
      expect(file.startsWith(human.trimEnd())).toBe(true);
      expect(file).toContain('<!-- bot-findings:start -->');
      expect(file).toContain('## Findings from AI self-play games');
      expect(file).toContain(`agrees`);
      expect(await readdir(path.join(dir, 'learnings-history'))).toHaveLength(2);
      expect(lines.some((l) => l.startsWith('Leaderboard after 2 games'))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 280_000);

  it('first stop request finishes the current game and stops; --no-learn writes nothing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'runner-stop-'));
    try {
      const control = new LoopControl();
      const results = await runLoop({
        api,
        llm: null,
        seats: ['A', 'B', 'C', 'D', 'E', 'F'].map((name) => ({ name })),
        games: 0, // forever
        learningsDir: dir,
        map: 'classic',
        paceMs: 0,
        planTimeoutMs: 1000,
        commander: false,
        learn: false,
        chat: false,
        maxChatPerTurn: 1,
        control,
        log: (l) => {
          if (l.startsWith('Game 1:')) expect(control.request()).toBe(false); // soft stop asked mid-game
        },
      });
      expect(results).toHaveLength(1);
      expect(results[0].winner).toBeTruthy();
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
