import { describe, expect, it } from 'vitest';
import { addPlayer, createGame, startGame, viewFor, type GameView } from '@risk/engine';
import { cleanChat, Diplomat, parseReply, type ChatMsg } from '../src/diplomat.js';
import { boardFacts } from '../src/facts.js';
import type { Llm } from '../src/llm.js';

function makeView(turn = 1): GameView {
  let s = createGame('D', { maxPlayers: 3 }, 4);
  for (const [id, name] of [['a', 'Ultron'], ['b', 'Batman'], ['c', 'Tony']]) s = addPlayer(s, id, name, true);
  s = startGame(s).state;
  return { ...viewFor(s, 'a'), turnNumber: turn };
}

const fakeLlm = (reply: string) => {
  const calls: string[] = [];
  const llm: Llm = {
    async chat(messages) {
      calls.push(messages.map((m) => m.content).join('\n'));
      return reply;
    },
  };
  return { llm, calls };
};

let nextId = 1;
const msg = (name: string, message: string, extra: Partial<ChatMsg> = {}): ChatMsg => ({ id: nextId++, name, message, at: 0, ...extra });

function diplomat(llm: Llm, extra: Partial<ConstructorParameters<typeof Diplomat>[0]> = {}) {
  let t = 0;
  const d = new Diplomat({ llm, seatName: 'Ultron', playerId: 'a', characterMarkdown: null, cooldownMs: 0, now: () => t, random: () => 0, whisperReplyChance: 0, ...extra });
  return { d, advance: (ms: number) => (t += ms) };
}

describe('parseReply', () => {
  it('reads plain, fenced and surrounded JSON', () => {
    expect(parseReply('{"say":"hi","to":null}')).toEqual({ say: 'hi', to: null });
    expect(parseReply('```json\n{"say":"yo","to":"Batman"}\n```')).toEqual({ say: 'yo', to: 'Batman' });
    expect(parseReply('Sure! {"say":"x","to":null} done')).toEqual({ say: 'x', to: null });
  });
  it('falls back to the whole text', () => {
    expect(parseReply('Just words')).toEqual({ say: 'Just words', to: null });
  });
});

describe('boardFacts', () => {
  it('stays compact and names players', () => {
    const f = boardFacts(makeView(), 'a');
    expect(f.length).toBeLessThan(1200);
    expect(f).toContain('Batman');
    expect(f).toContain('(you)');
  });
});

describe('Diplomat', () => {
  it('speaks an opening line, strips name prefixes and trims to 280', async () => {
    const { llm } = fakeLlm(JSON.stringify({ say: `Ultron: ${'x'.repeat(400)}`, to: null }));
    const out = await diplomat(llm).d.onTurnStart(makeView());
    expect(out?.message.length).toBe(280);
    expect(out?.message.startsWith('x')).toBe(true);
  });

  it('stays quiet on null or "null" say, and on a lost coin flip', async () => {
    expect(await diplomat(fakeLlm('{"say":null,"to":null}').llm).d.onTurnStart(makeView())).toBeNull();
    expect(await diplomat(fakeLlm('{"say":"null"}').llm).d.onTurnStart(makeView())).toBeNull();
    const { llm, calls } = fakeLlm('{"say":"hi"}');
    expect(await diplomat(llm, { random: () => 0.9 }).d.onTurnStart(makeView())).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('answers plain-text replies', async () => {
    const out = await diplomat(fakeLlm('Back off, Batman.').llm).d.onMessages([msg('Batman', 'ultron, truce?')], makeView());
    expect(out).toEqual({ message: 'Back off, Batman.' });
  });

  it('replies only to mentions or whispers, never to itself', async () => {
    const { llm, calls } = fakeLlm('{"say":"ok","to":null}');
    const { d } = diplomat(llm);
    const v = makeView();
    expect(await d.onMessages([msg('Batman', 'nice weather')], v)).toBeNull();
    expect(await d.onMessages([msg('Ultron', 'Ultron talking to myself')], v)).toBeNull();
    expect(await d.onMessages([msg('Batman', 'Hey ULTRON!')], v)).not.toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('whispers back to a whisper', async () => {
    const out = await diplomat(fakeLlm('{"say":"deal","to":null}').llm).d.onMessages([msg('Tony', 'psst', { to: 'a', toName: 'Ultron' })], makeView());
    expect(out).toEqual({ message: 'deal', to: 'Tony' });
  });

  it('caps messages per turn and honours the cooldown', async () => {
    let n = 0;
    const said = ['Alaska folds first.', 'Peru holds nine armies.', 'Send help to Brazil soon.', 'Kamchatka looks quiet tonight.', 'Egypt will burn by dawn.'];
    const llm: Llm = { chat: async () => JSON.stringify({ say: said[n++] }) };
    const { d, advance } = diplomat(llm, { maxPerTurn: 2, cooldownMs: 1000 });
    const v = makeView(5);
    expect(await d.onMessages([msg('Batman', 'Ultron 1')], v)).not.toBeNull();
    expect(await d.onMessages([msg('Batman', 'Ultron 2')], v)).toBeNull(); // cooldown
    advance(1500);
    expect(await d.onMessages([msg('Batman', 'Ultron 3')], v)).not.toBeNull();
    advance(1500);
    expect(await d.onMessages([msg('Batman', 'Ultron 4')], v)).toBeNull(); // cap
    expect(await d.onMessages([msg('Batman', 'Ultron 5')], makeView(6))).not.toBeNull(); // next turn
  });

  it('puts the plan and its own last five lines in the prompt, with the do-not-copy rule', async () => {
    let n = 0;
    const said = ['Alpha: Kamchatka falls first.', 'Beta: Peru holds nine armies.', 'Gamma: Brazil needs help soon.', 'Delta: Egypt burns by dawn.', 'Epsilon: Siam stays quiet tonight.', 'Zeta: Iceland waits for spring.'];
    const prompts: string[] = [];
    const llm: Llm = {
      async chat(messages) {
        prompts.push(messages.map((m) => m.content).join(' '));
        return JSON.stringify({ say: said[n++] });
      },
    };
    const { d } = diplomat(llm, { getPlan: () => 'break the Asia bonus; avoid Batman' });
    const v = makeView(2);
    for (let i = 0; i < 7; i++) await d.onMessages([msg('Batman', `Ultron, offer ${i}?`)], { ...v, turnNumber: 100 + i });
    expect(prompts[0]).toContain('break the Asia bonus');
    expect(prompts[0]).toMatch(/never copy or echo/i);
    expect(prompts[0]).not.toContain('Your own last lines');
    const last = prompts[6];
    expect(last).toContain('Zeta: Iceland waits for spring.');
    expect(last).toContain('Beta: Peru holds nine armies.');
    expect(last).not.toContain('Alpha: Kamchatka falls first.'); // only the last five
  });

  it('stays quiet rather than repeat itself or copy another player', async () => {
    const { d } = diplomat(fakeLlm('{"say":"Hold your borders, Batman."}').llm);
    const v = makeView(2);
    expect(await d.onMessages([msg('Batman', 'Ultron, truce?')], v)).not.toBeNull();
    expect(await d.onMessages([msg('Batman', 'Ultron, truce again?')], v)).toBeNull(); // same line as before
    const copycat = diplomat(fakeLlm('{"say":"Ultron, a truce for the north?"}').llm).d;
    expect(await copycat.onMessages([msg('Batman', 'Ultron, a truce for the north?')], v)).toBeNull(); // parrots the trigger
  });

  it('answers spectators once per turn', async () => {
    const { d } = diplomat(fakeLlm('{"say":"hello fan"}').llm);
    const v = makeView(3);
    expect(await d.onMessages([msg('Fan', 'Ultron you rock', { spectator: true })], v)).not.toBeNull();
    expect(await d.onMessages([msg('Fan2', 'Ultron again', { spectator: true })], v)).toBeNull();
  });
});

describe('cleanChat', () => {
  it('removes em and en dashes and doubled punctuation', () => {
    expect(cleanChat('Back off — or burn.')).toBe('Back off, or burn.');
    expect(cleanChat('No—wait.')).toBe('No, wait.');
    expect(cleanChat('Done. – Next.')).toBe('Done. Next.');
    expect(cleanChat('Take 3–5 armies , ,  now!!!!')).toBe('Take 3 to 5 armies, now!!');
    expect(cleanChat('Wait — .')).toBe('Wait.');
    const out = cleanChat('a — b – c —— d');
    expect(out).not.toMatch(/[–—]/);
    expect(cleanChat(out)).toBe(out);
  });
  it('is applied to what the diplomat returns', async () => {
    const out = await diplomat(fakeLlm('{"say":"Hold Alaska — or else","to":null}').llm).d.onTurnStart(makeView());
    expect(out?.message).toBe('Hold Alaska, or else');
  });
});

describe('Diplomat whispers and repetition', () => {
  it('opens with a whisper to a chosen player', async () => {
    const out = await diplomat(fakeLlm('{"say":"Join me against Tony.","to":null}').llm).d.onTurnStart(makeView());
    expect(out?.to).toBeTruthy();
    expect(['Batman', 'Tony']).toContain(out!.to);
  });

  it('whispers back to public messages when the chance says so', async () => {
    const out = await diplomat(fakeLlm('{"say":"Fine.","to":null}').llm, { whisperReplyChance: 1 }).d.onMessages([msg('Batman', 'Ultron, truce?')], makeView());
    expect(out).toEqual({ message: 'Fine.', to: 'Batman' });
  });

  it('rejects a line that starts with the same four words as one of its last five', async () => {
    let n = 0;
    const lines = ["Scout's honour, Tryndamere, I never touched Peru.", "Scout's honour, Tryndamere, Brazil is yours.", 'A different start altogether about Alaska.'];
    const llm: Llm = { chat: async () => JSON.stringify({ say: lines[n++] }) };
    const { d } = diplomat(llm);
    const v = makeView(2);
    expect(await d.onMessages([msg('Batman', 'Ultron, one')], v)).not.toBeNull();
    expect(await d.onMessages([msg('Batman', 'Ultron, two')], v)).toBeNull();
    expect(await d.onMessages([msg('Batman', 'Ultron, three')], v)).not.toBeNull();
  });

  it('asks for whispers and no dashes in the system prompt', async () => {
    const { llm, calls } = fakeLlm('{"say":"x1 about Alaska"}');
    await diplomat(llm).d.onTurnStart(makeView());
    expect(calls[0]).toMatch(/em dashes or en dashes/);
    expect(calls[0]).toMatch(/well over half/);
  });
});

describe('sentence-level repetition guard', () => {
  const FAMILY = [
    'I prefer my explosions with a little chaos and a lot of fire.',
    'I prefer my explosions with a little patience and a lot of armies.',
    'My explosions come with a little chaos and plenty of fire, friend.',
    'Give me a little chaos and a lot of fire in my explosions.',
  ];
  const seq = (lines: string[]) => {
    let n = 0;
    return fakeLlmSeq(() => lines[n++]);
  };
  function fakeLlmSeq(next: () => string): Llm {
    return { chat: async () => JSON.stringify({ say: next() }) };
  }

  it('rejects a template reused with other nouns swapped in (Jaccard >= 0.55)', async () => {
    const { d } = diplomat(seq(FAMILY));
    const v = makeView(2);
    expect(await d.onMessages([msg('Batman', 'Ultron, one')], v)).not.toBeNull();
    for (const probe of ['two', 'three', 'four']) expect(await d.onMessages([msg('Batman', `Ultron, ${probe}`)], v)).toBeNull();
  });

  it('rejects a line that shares a five-word run with the table, names ignored', async () => {
    const lines = ['Batman, march your armies through Peru tonight.', 'Nobody expects it, so march your armies through Peru before dawn!'];
    let n = 0;
    const { d } = diplomat(fakeLlmSeq(() => lines[n++]));
    const v = makeView(2);
    expect(await d.onMessages([msg('Tony', 'Ultron, what now?'), msg('Batman', 'Everyone should march your armies through Peru')], v)).toBeNull(); // shares the run with Batman's line
    expect(n).toBe(1);
  });

  it('rejects a repeated sentence inside a longer line, and checks the last ten own lines', async () => {
    const lines = ['Hold Alaska for me. Kamchatka belongs to the north now, truly.', 'The tide turns at noon. Hold Alaska for me.'];
    let n = 0;
    const { d, advance } = diplomat(fakeLlmSeq(() => lines[n++]));
    const v = makeView(2);
    expect(await d.onMessages([msg('Batman', 'Ultron, a')], v)).not.toBeNull();
    advance(100);
    expect(await d.onMessages([msg('Batman', 'Ultron, b')], v)).toBeNull(); // "Hold Alaska for me" is only 4 words: Jaccard needs 4+, equal here -> repeated sentence
  });

  it('lets genuinely different lines through and ignores deal tags when comparing', async () => {
    const lines = ['Peru is mine by round five. [deal S1: truce Ultron+Batman until round 9]', 'Egypt trembles, Batman, because forty armies sit behind its walls.'];
    let n = 0;
    const { d } = diplomat(fakeLlmSeq(() => lines[n++]));
    const v = makeView(2);
    expect(await d.onMessages([msg('Batman', 'Ultron, a')], v)).not.toBeNull();
    expect(await d.onMessages([msg('Tony', 'Ultron, b')], v)).not.toBeNull();
  });
});


describe('round freshness and expired offers', () => {
  const at = (round: number) => ({ ...makeView(round * 6), version: round, round });
  it('puts the authoritative round after old chat and suppresses expired natural-language offers', async () => {
    const { llm, calls } = fakeLlm(JSON.stringify({ say: "Batman, let's make a truce until round 6." }));
    const { d } = diplomat(llm);
    expect(await d.onMessages([msg('Batman', 'Ultron, truce until round 6?')], at(10))).toBeNull();
    expect(calls[0]).toContain('Current round: 10');
    expect(calls[0]).toContain('AUTHORITATIVE NOW: round 10');
    expect(calls[0]).toContain('earliest future end is 11');
  });
  it('suppresses the whole message when structured proposal validation rejects it', async () => {
    const { d } = diplomat(fakeLlm(JSON.stringify({say:'Batman, let us hold our border.',deal:{kind:'truce',with:'Batman',untilRound:6}})).llm);
    expect(await d.onTurnStart(at(10))).toBeNull();
  });
  it('does not accept a nonexistent or expired agreement just because the model says yes', async () => {
    const { d } = diplomat(fakeLlm(JSON.stringify({say:'Batman, I agree to your truce.',respond:{dealId:'OLD',answer:'accept'}})).llm);
    expect(await d.onMessages([msg('Batman','Ultron, [deal OLD: truce Ultron+Batman until round 6]')],at(10))).toBeNull();
  });
  it('rebuilds a queued prompt using the latest round before generation starts', async () => {
    let release!: () => void;
    let prompt = '';
    const llm:Llm={chat:async(messages,opts)=>{
      await new Promise<void>(r=>{release=r;});
      prompt=(opts?.prepare?.() ?? messages).map(m=>m.content).join('\n');
      return JSON.stringify({say:'Batman, truce until round 12.',deal:{kind:'truce',with:'Batman',untilRound:12}});
    }};
    const {d}=diplomat(llm);
    const pending=d.onTurnStart(at(6));
    d.observe(at(10));
    release();
    const out=await pending;
    expect(prompt).toContain('AUTHORITATIVE NOW: round 10');
    expect(out?.message).toContain('until round 12');
    expect(d.contextFor(out!)).toMatchObject({round:10});
  });
  it('drops a response if the round advances while the model generates it', async () => {
    let release!:()=>void;
    const llm:Llm={chat:async(_messages,opts)=>{
      opts?.prepare?.();
      await new Promise<void>(r=>{release=r;});
      return JSON.stringify({say:'Batman, truce until round 9.',deal:{kind:'truce',with:'Batman',untilRound:9}});
    }};
    const {d}=diplomat(llm);
    const pending=d.onTurnStart(at(6));
    d.observe(at(10));
    release();
    expect(await pending).toBeNull();
  });
  it('checks the server before posting, and allows factual recollections of an expired truce', async () => {
    const {d}=diplomat(fakeLlm(JSON.stringify({say:'Batman, truce until round 12.'})).llm);
    d.setViewRefresher(async()=>at(10),()=>{});
    expect(await d.onTurnStart(at(6))).toBeNull();
    const {d:historian}=diplomat(fakeLlm(JSON.stringify({say:'Our truce until round 6 expired, Batman.'})).llm);
    expect((await historian.onTurnStart(at(10)))?.message).toContain('expired');
    const {d:confused}=diplomat(fakeLlm(JSON.stringify({say:'Round 6 is still ahead.'})).llm);
    expect(await confused.onTurnStart(at(10))).toBeNull();
  });
});
