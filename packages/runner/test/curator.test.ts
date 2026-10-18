import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Llm } from '../src/llm.js';
import { curateLearnings, enforceCuration, humanOutline, parseBullets, validateSection } from '../src/postgame.js';

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});
const tmp = async () => {
  const d = await mkdtemp(path.join(tmpdir(), 'runner-cur-'));
  dirs.push(d);
  return d;
};

const HUMAN = '# Shared Risk learnings\n\nAdvice, not rules.\n\n## Capitals\n- Garrison your capital.\n';

describe('enforceCuration (the stricter curator)', () => {
  const ctx = (over: Partial<Parameters<typeof enforceCuration>[1]> = {}) => ({
    gameId: 'G9',
    previous: '',
    human: HUMAN,
    names: ['Shen', 'Lux', 'classic'],
    ...over,
  });
  const oldSection = [
    '- Blizzard borders stall attacks, so count entry points before a bonus push (2 games, last G7)',
    '- Card sets snowball once three players hold five cards (1 game, last G8)',
  ].join('\n');
  const fresh = (i: number) =>
    [
      '- Lux held Oceania from round 3, but Teemo broke the Siam chokepoint (1 game, last G9)',
      '- Shen won after trading 4 card sets while Lux sat idle (1 game, last G9)',
      '- Tryndamere out-waited 5 rivals in the north and lost the capital in round 12 (1 game, last G9)',
      '- Jinx stacked 30 armies on Kamchatka by round 8 and never attacked (1 game, last G9)',
      '- Leona survived to round 14 by whispering truces to every neighbour (1 game, last G9)',
    ][i];

  it('keeps at most 3 new bullets: more than 3 means the old section plus the first 3 new', () => {
    const raw = [oldSection, fresh(0), fresh(1), fresh(2), fresh(3), fresh(4)].join('\n');
    const lines: string[] = [];
    const out = enforceCuration(raw, ctx({ previous: oldSection, log: (l) => lines.push(l) }))!;
    expect(out.split('\n')).toEqual([...oldSection.split('\n'), fresh(0), fresh(1), fresh(2)]);
    expect(lines.join('\n')).toContain('5 new bullets');
    const three = [oldSection, fresh(0), fresh(1), fresh(2)].join('\n');
    expect(enforceCuration(three, ctx({ previous: oldSection }))).toBe(three);
  });

  it('does not count a bullet that restates an existing one as new, and raises its count by at most one', () => {
    const reworded = [
      '- Blizzard borders stall attacks, so count the entry points before a bonus push (9 games, last G9)',
      '- Card sets snowball once three players hold five cards (2 games, last G9)',
      fresh(0),
      fresh(1),
      fresh(2),
    ].join('\n');
    const out = enforceCuration(reworded, ctx({ previous: oldSection }))!;
    const bullets = parseBullets(out);
    expect(bullets).toHaveLength(5);
    expect(bullets[0]).toMatchObject({ games: 3, last: 'G9' }); // 2 -> 3, not 9
    expect(bullets[1]).toMatchObject({ games: 2, last: 'G9' });
    const lower = enforceCuration('- Blizzard borders stall attacks, so count entry points before a bonus push (1 game, last G9)', ctx({ previous: oldSection }))!;
    expect(parseBullets(lower)[0]).toMatchObject({ games: 2, last: 'G7' }); // a count never falls
  });

  it('requires the evidence tag with this game id on a new bullet', () => {
    const noTag = '- Lux held Oceania from round 4 and Teemo broke it';
    const wrongGame = '- Lux held Oceania from round 4 and Teemo broke it (1 game, last G1)';
    const many = '- Lux held Oceania from round 4 and Teemo broke it (4 games, last G9)';
    for (const bad of [noTag, wrongGame, many]) expect(enforceCuration(`${oldSection}\n${bad}`, ctx({ previous: oldSection }))).toBe(oldSection);
  });

  it('requires concrete evidence (names, rounds, numbers) in a new bullet', () => {
    const vague = '- Being careful with garrisons usually pays off in the long run (1 game, last G9)';
    expect(enforceCuration(`${oldSection}\n${vague}`, ctx({ previous: oldSection }))).toBe(oldSection);
    expect(enforceCuration(`${oldSection}\n- Shen hoarded garrisons and still won (1 game, last G9)`, ctx({ previous: oldSection }))).toContain('Shen hoarded');
    expect(enforceCuration(`${oldSection}\n- Garrisons of 12 armies held (1 game, last G9)`, ctx({ previous: oldSection }))).toContain('12 armies');
  });

  it('never restates human-written advice: near-duplicate text or lead phrase is dropped (Jaccard >= 0.6)', () => {
    const human = '# Learnings\n\n## Capitals\n- Garrison your capital with at least ten armies: capitals fall fast\n- Never attack the leader early\n';
    const dup = '- Garrison your capital with at least ten armies, because capitals fall fast in round 6 (1 game, last G9)';
    const leadDup = '- Garrison your capital with at least ten armies: Shen lost 3 games without it (1 game, last G9)';
    const exact = '- Never attack the leader early in round 2 (1 game, last G9)';
    const original = '- Teemo hid 25 armies in Egypt and won by round 14 (1 game, last G9)';
    for (const bad of [dup, leadDup, exact]) expect(enforceCuration(`${oldSection}\n${bad}`, ctx({ previous: oldSection, human }))).toBe(oldSection);
    expect(enforceCuration(`${oldSection}\n${original}`, ctx({ previous: oldSection, human }))).toContain('Teemo hid 25 armies');
  });

  it('allows "Challenges to earlier advice" only for patterns seen in 3 or more games', () => {
    const base = '- Blizzard borders stall attacks, so count entry points before a bonus push';
    const old = `${base} (3 games, last G8)\n- Card sets snowball once three players hold five cards (1 game, last G8)`;
    const oneGame = `${old}\n\n### Challenges to earlier advice\n- "Garrison your capital" cost Shen the game in round 7 (1 game, last G9)`;
    const out1 = enforceCuration(oneGame, ctx({ previous: old }))!;
    expect(out1).not.toContain('Challenges');
    expect(out1).not.toContain('Garrison your capital');
    const three = `- Card sets snowball once three players hold five cards (1 game, last G8)

### Challenges to earlier advice
${base} (4 games, last G9)`;
    const out3 = enforceCuration(three, ctx({ previous: old }))!;
    expect(out3).toContain('### Challenges to earlier advice');
    expect(parseBullets(out3).find((b) => b.challenge)).toMatchObject({ games: 4, last: 'G9' });
    const oldTwo = old.replace('(3 games', '(1 game');
    const two = `${oldTwo}\n\n### Challenges to earlier advice\n${base} (2 games, last G9)`;
    expect(enforceCuration(two, ctx({ previous: oldTwo }))).not.toContain('Challenges');
  });

  it('caps the section at 40 bullets', () => {
    const words = ['alpha', 'bravo', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india'];
    const forty = Array.from({ length: 40 }, (_, i) => `- Entry ${i} about ${words[i % 8]} topic${i} matter (2 games, last G8)`).join('\n');
    expect(enforceCuration(forty, ctx({ previous: forty }))).not.toBeNull();
    expect(validateSection(`${forty}\n- one more (1 game, last G9)`)).toBeNull();
    const thirtyNine = forty.split('\n').slice(0, 39).join('\n');
    const reply = [...forty.split('\n').slice(0, 36), fresh(0), fresh(1), fresh(2), fresh(3)].join('\n');
    const out = enforceCuration(reply, ctx({ previous: thirtyNine }))!;
    expect(parseBullets(out)).toHaveLength(40); // the old section plus only as many new bullets as fit
  });

  it('lists human headings and bullet lead phrases for the prompt', () => {
    const out = humanOutline('# T\n\n## Capitals\n- **Garrison your capital**: it decides the game. Long explanation follows.\n- Never attack early; wait.');
    expect(out).toContain('## Capitals');
    expect(out).toContain('- Garrison your capital');
    expect(out).toContain('- Never attack early');
    expect(out).not.toContain('Long explanation');
  });

  it('is applied by curateLearnings, with the human outline and the rules in the prompt', async () => {
    const dir = await tmp();
    const human = '# Shared Risk learnings\n\n## Capitals\n- Garrison your capital: it decides the game\n';
    await writeFile(path.join(dir, 'RISK_LEARNINGS.md'), human, 'utf8');
    const calls: string[] = [];
    const reply = [fresh(0), fresh(1), fresh(2), fresh(3), '- Garrison your capital: it decides the game in round 5 (1 game, last G9)'].join('\n');
    const llm: Llm = { chat: async (m) => (calls.push(m.map((x) => x.content).join('\n')), reply) };
    const res = await curateLearnings({ llm, learningsDir: dir, gameId: 'G9', notes: [{ name: 'Shen', text: '# Shen learnings G9' }], leaderboard: 'LB', log: () => {} });
    expect(res).toBe('updated');
    const file = await readFile(path.join(dir, 'RISK_LEARNINGS.md'), 'utf8');
    expect(file).toContain('Lux held Oceania');
    expect(file).toContain('Shen won after trading');
    expect(file).toContain('Tryndamere out-waited');
    expect(file).not.toContain('Jinx stacked'); // the 4th new bullet
    expect(file).not.toContain('it decides the game in round 5'); // restates the human advice
    expect(calls[0]).toMatch(/At most 3 NEW bullets/);
    expect(calls[0]).toContain('- Garrison your capital'); // lead phrase of the human bullet
    expect(calls[0]).toContain('## Capitals');
    expect(calls[0]).toMatch(/winners/);
    expect(calls[0]).toMatch(/3 or more games/);
  });
});
