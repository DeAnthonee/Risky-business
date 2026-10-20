import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { viewFor, type GameView } from '@risk/engine';
import type { RiskApi } from '@risk/mcp';
import type { Llm } from '../src/llm.js';
import {
  BOT_END,
  BOT_HEADING,
  BOT_START,
  GameTracker,
  appendResult,
  applyBotSection,
  buildResult,
  computeLeaderboard,
  curateLearnings,
  formatLeaderboard,
  normalizeNote,
  readResults,
  runPostGame,
  validateSection,
  type SeatReport,
} from '../src/postgame.js';
import { playHeadless } from './headless.js';

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});
const tmp = async () => {
  const d = await mkdtemp(path.join(tmpdir(), 'runner-post-'));
  dirs.push(d);
  return d;
};

const HUMAN = '# Shared Risk learnings\n\nAdvice, not rules.\n\n## Capitals\n- Garrison your capital.\n\n## Game log\n- AAR5MR: something.\n';
const TOPICS = ['garrisons rarely fall', 'card sets snowball', 'blizzard borders stall attacks', 'capital rushes beat bonuses'];
const goodSection = (n = 3) => Array.from({ length: n }, (_, i) => `- Lesson ${i}: ${TOPICS[i % 4]} by round ${i + 3} (1 game, last G1)`).join('\n');
const llmReturning = (...replies: (string | Error)[]) => {
  let i = 0;
  const calls: string[] = [];
  const llm: Llm = {
    async chat(m) {
      calls.push(m.map((x) => x.content).join('\n'));
      const r = replies[Math.min(i++, replies.length - 1)];
      if (r instanceof Error) throw r;
      return r;
    },
  };
  return { llm, calls };
};

describe('validateSection / applyBotSection', () => {
  it('accepts bullets with a sub-heading and rejects structural damage', () => {
    expect(validateSection(goodSection())).toContain('Lesson 0');
    expect(validateSection(`${goodSection()}\n\n### Challenges to earlier advice\n- x (1 game, last G1)`)).not.toBeNull();
    expect(validateSection('```md\n' + goodSection() + '\n```')).toBe(goodSection());
    expect(validateSection(`${BOT_HEADING}\n${goodSection()}`)).toBe(goodSection());
    expect(validateSection('')).toBeNull();
    expect(validateSection('Just prose, no bullets.')).toBeNull();
    expect(validateSection(`## Capitals\n${goodSection()}`)).toBeNull();
    expect(validateSection(`# Shared Risk learnings\n${goodSection()}`)).toBeNull();
    expect(validateSection(`${goodSection()}\n${BOT_END}`)).toBeNull();
    expect(validateSection(goodSection(60))).toBeNull();
    expect(validateSection(`- ${'x'.repeat(13_000)}`)).toBeNull();
  });

  it('appends the heading and markers once, then only replaces between them', () => {
    const first = applyBotSection(HUMAN, goodSection())!;
    expect(first.startsWith(HUMAN.trimEnd())).toBe(true);
    expect(first).toContain(`${BOT_HEADING}\n${BOT_START}\n`);
    expect(first.endsWith(`${BOT_END}\n`)).toBe(true);
    const second = applyBotSection(`${first}\n## Epilogue\n- keep me\n`, '- replaced (1 game, last G2)')!;
    expect(second.startsWith(first.slice(0, first.indexOf(BOT_START) + BOT_START.length))).toBe(true);
    expect(second).toContain('replaced');
    expect(second).not.toContain('Lesson 0');
    expect(second).toContain('## Epilogue\n- keep me');
    expect(second.split(BOT_START)).toHaveLength(2);
  });

  it('refuses a file with a start marker but no end marker', () => {
    expect(applyBotSection(`${HUMAN}\n${BOT_START}\n- a\n`, goodSection())).toBeNull();
  });
});

describe('curateLearnings', () => {
  const run = async (dir: string, llm: Llm, gameId = 'G1') => {
    const lines: string[] = [];
    const res = await curateLearnings({ llm, learningsDir: dir, gameId, notes: [{ name: 'Shen', text: '# Shen learnings G1\n- x' }], leaderboard: 'Leaderboard', now: () => new Date('2026-01-02T03:04:05.678Z'), log: (l) => lines.push(l) });
    return { res, lines };
  };

  it('writes the section, copies the old file to learnings-history first and never touches the text above', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'RISK_LEARNINGS.md');
    await writeFile(file, HUMAN, 'utf8');
    const { llm, calls } = llmReturning(goodSection());
    expect((await run(dir, llm)).res).toBe('updated');
    const after = await readFile(file, 'utf8');
    expect(after.startsWith(HUMAN.trimEnd())).toBe(true);
    expect(after).toContain('Lesson 2');
    expect(calls[0]).toContain('Leaderboard');
    expect(calls[0]).toContain('# Shen learnings G1');
    const hist = await readdir(path.join(dir, 'learnings-history'));
    expect(hist).toEqual(['RISK_LEARNINGS-2026-01-02T03-04-05-678Z-G1.md']);
    expect(await readFile(path.join(dir, 'learnings-history', hist[0]), 'utf8')).toBe(HUMAN);
    expect((await readdir(dir)).filter((f) => f.includes('.tmp'))).toEqual([]);

    // Second game: the model updates a bullet with G2; the history gets the previous version and older bullets are preserved.
    const { llm: llm2, calls: calls2 } = llmReturning(`- Lesson 0: garrisons rarely fall by round 3 (2 games, last G2)\n\n### Challenges to earlier advice\n- "Garrison your capital" cost Shen a game in round 7 (1 game, last G2)`);
    expect((await run(dir, llm2, 'G2')).res).toBe('updated');
    expect(calls2[0]).toContain('Lesson 1'); // it sees its current section
    const after2 = await readFile(file, 'utf8');
    expect(after2.startsWith(after.slice(0, after.indexOf(BOT_START) + BOT_START.length))).toBe(true);
    expect(after2).not.toContain('Challenges to earlier advice'); // one game never challenges earlier advice
    expect(after2).toContain('Lesson 2'); // older bullets are preserved
    expect(await readdir(path.join(dir, 'learnings-history'))).toHaveLength(2);
  });

  it('keeps the old file (and writes no history) when the reply fails validation or the model errors', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'RISK_LEARNINGS.md');
    const seeded = applyBotSection(HUMAN, goodSection())!;
    await writeFile(file, seeded, 'utf8');
    const bad = ['', 'no bullets at all', `## New heading\n${goodSection()}`, `${HUMAN}\n- sneaky`, goodSection(80), new Error('ollama down')];
    for (const reply of bad) {
      const { res } = await run(dir, llmReturning(reply).llm);
      expect(res).toBe('kept');
      expect(await readFile(file, 'utf8')).toBe(seeded);
    }
    await expect(readdir(path.join(dir, 'learnings-history'))).rejects.toThrow();
  });

  it('leaves a damaged file alone and creates the file when it does not exist yet', async () => {
    const dir = await tmp();
    const file = path.join(dir, 'RISK_LEARNINGS.md');
    const damaged = `${HUMAN}\n${BOT_START}\n- orphan\n`;
    await writeFile(file, damaged, 'utf8');
    expect((await run(dir, llmReturning(goodSection()).llm)).res).toBe('kept');
    expect(await readFile(file, 'utf8')).toBe(damaged);

    const fresh = await tmp();
    expect((await run(fresh, llmReturning(goodSection()).llm)).res).toBe('updated');
    expect(await readFile(path.join(fresh, 'RISK_LEARNINGS.md'), 'utf8')).toContain(BOT_START);
  });
});

describe('notes', () => {
  it('fills in the format when the model leaves parts out', () => {
    const n = normalizeNote('- Took Africa early.\n- Lost the capital.', 'Shen', 'G1', 'WON game G1.', ['- Round 1: hold Africa']);
    expect(n.startsWith('# Shen learnings G1\n')).toBe(true);
    expect(n).toContain('## Result\n\nWON game G1.');
    expect(n).toContain('## Top lessons');
    expect(n).toContain('Plan: Round 1: hold Africa');
    const full = normalizeNote('```md\n# Whatever\n- a\n\n## Result\nLost.\n\n## Top lessons\n- b\n```', 'Shen', 'G1', 'x', []);
    expect(full).toBe('# Shen learnings G1\n\n- a\n\n## Result\n\nLost.\n\n## Top lessons\n\n- b\n');
  });
});

function finishedGame() {
  const r = playHeadless({ seed: 21, map: 'classic', seats: Array(6).fill('planned') });
  expect(r.state.phase).toBe('finished');
  const final = viewFor(r.state, null) as GameView;
  const seats = r.state.players.map((p, i) => ({ name: p.name, playerId: p.id, characterId: `league/c${i}` }));
  return { final, seats, state: r.state };
}

describe('results and leaderboard', () => {
  it('builds one record per seat with distinct placements, appends and re-reads it', async () => {
    const { final, seats } = finishedGame();
    const tracker = new GameTracker();
    tracker.observe(final);
    const result = buildResult(final, seats, tracker, { gameId: 'G1', date: new Date('2026-01-01T00:00:00Z') });
    expect(result.seats).toHaveLength(6);
    expect(result.seats.map((s) => s.placement).sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.seats[0].name).toBe(result.winner);
    expect(result.seats[0].character).toMatch(/^league\/c/);
    expect(['capitals', 'domination']).toContain(result.reason);
    expect(result.map).toBe('classic');
    expect(result.options.fogOfWar).toBe(true);
    for (const s of result.seats) expect(s.alive || s.eliminatedRound !== null).toBe(true);
    const dir = await tmp();
    await appendResult(dir, result);
    await appendResult(dir, { ...result, gameId: 'G2', map: 'europe' });
    await writeFile(path.join(dir, 'results.jsonl'), `${await readFile(path.join(dir, 'results.jsonl'), 'utf8')}not json\n`, 'utf8');
    const back = await readResults(dir);
    expect(back.map((r) => r.gameId)).toEqual(['G1', 'G2']);
    const lb = computeLeaderboard(back);
    expect(lb.games).toBe(2);
    expect(lb.byCharacter.reduce((n, r) => n + r.wins, 0)).toBe(2);
    expect(lb.byCharacter.every((r) => r.games === 2)).toBe(true);
    expect(lb.byMap.map((m) => m.map).sort()).toEqual(['classic', 'europe']);
    const killsIn = (name: string) => result.seats.filter((v) => v.eliminatedBy === name).length;
    for (const row of lb.byCharacter) {
      const seat = result.seats.find((s) => s.character === row.key)!;
      expect(row.kills).toBe(2 * killsIn(seat.name));
    }
    expect(lb.byCharacter.reduce((n, r) => n + r.kills, 0)).toBe(2 * result.seats.filter((v) => v.eliminatedBy).length);
    expect(lb.byCharacter.reduce((n, r) => n + r.kills, 0)).toBeGreaterThan(0);
    expect(formatLeaderboard(lb)).toContain(" points ");
    expect(formatLeaderboard(lb)).toContain('By map:');
    expect(formatLeaderboard(computeLeaderboard([]))).toContain('no games');
  });
});

describe('runPostGame', () => {
  const fakeApi = () => {
    const diary: unknown[] = [];
    const rel: unknown[] = [];
    const api = {
      addDiaryEntry: async (id: string, entry: unknown, key?: string) => (diary.push({ id, entry, key }), entry),
      updateRelationship: async (id: string, update: unknown, key?: string) => (rel.push({ id, update, key }), update),
    } as unknown as RiskApi;
    return { api, diary, rel };
  };
  const setup = () => {
    const { final, seats } = finishedGame();
    const tracker = new GameTracker();
    tracker.observe(final);
    const reports: SeatReport[] = seats.map((s) => ({ ...s, privateLog: [`- Round 1: ${s.name} plan`], strategy: 'hold a bonus', chat: [] }));
    return { final, reports, tracker };
  };
  const chatLlm: Llm = {
    async chat(m) {
      const sys = m[0].content;
      if (sys.includes('curator')) {
        const id = /Game just finished: (\w+)/.exec(m[1].content)![1];
        return `${goodSection(4).replaceAll('G1', id)}\n- ${id} was a contest in round 9 (1 game, last ${id})`;
      }
      return '- Played a game.\n\n## Result\nDone.\n\n## Top lessons\n- Garrison capitals.';
    },
  };

  it('writes results, six notes and the bot section; saves diary entries only with a key', async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, 'RISK_LEARNINGS.md'), HUMAN, 'utf8');
    const { final, reports, tracker } = setup();
    const { api, diary, rel } = fakeApi();
    const lines: string[] = [];
    const out = await runPostGame({ api, llm: chatLlm, learningsDir: dir, final, gameId: 'GAMEX', seats: reports, tracker, log: (l) => lines.push(l) });
    expect(out.curated).toBe('updated');
    expect((await readdir(path.join(dir, 'learnings'))).sort()).toEqual(reports.map((r) => `${r.name.toLowerCase()}-GAMEX.md`).sort());
    expect(await readFile(path.join(dir, 'learnings', 'p0-GAMEX.md'), 'utf8')).toContain('## Top lessons');
    expect((await readResults(dir)).map((r) => r.gameId)).toEqual(['GAMEX']);
    expect(await readFile(path.join(dir, 'RISK_LEARNINGS.md'), 'utf8')).toContain(BOT_START);
    expect(diary).toHaveLength(0);
    expect(lines.join('\n')).toContain('--characters-key');

    const withKey = await runPostGame({ api, llm: chatLlm, learningsDir: dir, final, gameId: 'GAMEY', seats: reports, tracker, charactersKey: 'k', log: () => {} });
    expect(withKey.curated).toBe('updated');
    expect(diary).toHaveLength(6);
    expect(diary.every((d) => (d as { key: string }).key === 'k')).toBe(true);
    expect(rel.length).toBeGreaterThan(0);
    expect((await readResults(dir)).length).toBe(2);
  });

  it('still writes plain notes when the model is down', async () => {
    const dir = await tmp();
    await mkdir(dir, { recursive: true });
    const { final, reports, tracker } = setup();
    const down: Llm = { chat: async () => { throw new Error('down'); } };
    const out = await runPostGame({ api: fakeApi().api, llm: down, learningsDir: dir, final, gameId: 'GAMEZ', seats: reports, tracker, log: () => {} });
    expect(out.curated).toBe('kept');
    const note = await readFile(path.join(dir, 'learnings', 'p1-GAMEZ.md'), 'utf8');
    expect(note).toContain('## Result');
    expect(note).toContain('Plan: Round 1: P1 plan');
  });

  it('mechanicsOnly mode updates RISK_LEARNINGS.md and mechanics-results.jsonl without touching character memories or diaries', async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, 'RISK_LEARNINGS.md'), HUMAN, 'utf8');
    const { final, reports, tracker } = setup();
    const { api, diary, rel } = fakeApi();
    const out = await runPostGame({
      api,
      llm: chatLlm,
      learningsDir: dir,
      final,
      gameId: 'MECH1',
      seats: reports,
      tracker,
      charactersKey: 'k',
      mechanicsOnly: true,
      log: () => {},
    });
    expect(out.curated).toBe('updated');
    expect(diary).toHaveLength(0);
    expect(rel).toHaveLength(0);
    expect(await readResults(dir)).toEqual([]); // character results.jsonl untouched
    expect(await readFile(path.join(dir, 'mechanics-results.jsonl'), 'utf8')).toContain('MECH1');
    expect(await readFile(path.join(dir, 'RISK_LEARNINGS.md'), 'utf8')).toContain(BOT_START);
  });

  it('filters leaderboard by generation when generation is specified', async () => {
    const dir = await tmp();
    await mkdir(dir, { recursive: true });
    const { final, reports, tracker } = setup();
    const { api } = fakeApi();
    const llm: Llm = { chat: async () => 'advice' };

    await runPostGame({ api, llm, learningsDir: dir, final, gameId: 'G1', seats: reports, tracker, generation: 'gen4', log: () => {} });
    const outGen5 = await runPostGame({ api, llm, learningsDir: dir, final, gameId: 'G2', seats: reports, tracker, generation: 'gen5', log: () => {} });

    expect(outGen5.leaderboard.games).toBe(1);
    const lbMd = await readFile(path.join(dir, 'LEADERBOARD.md'), 'utf8');
    expect(lbMd).toContain('across 1 AI self-play match.');
  });
});
