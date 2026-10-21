import { describe, expect, it } from 'vitest';
import { addPlayer, createGame, startGame, viewFor, getMap, type GameView } from '@risk/engine';
import { formatPing, isModelName, parsePing, type PingAction } from '../src/pings.js';
import { Commander, parsePlanReply, areContinentsAdjacent, getPrimaryTargetContinent } from '../src/commander.js';
import { DEFAULT_OPTIONS } from '../src/presets.js';
import type { Llm } from '../src/llm.js';

function makeView(): GameView {
  let s = createGame('PINGS_TEST', { ...DEFAULT_OPTIONS, maxPlayers: 3, map: 'classic', chooseCapitals: false }, 42);
  s = addPlayer(s, 'a', 'Shen', true);
  s = addPlayer(s, 'b', 'Ahri', true);
  s = addPlayer(s, 'c', 'Ronny@3', true);
  s = startGame(s).state;
  return viewFor(s, 'a');
}

function makeView4(): GameView {
  let s = createGame('PINGS_TEST_4', { ...DEFAULT_OPTIONS, maxPlayers: 4, map: 'classic', chooseCapitals: false }, 42);
  s = addPlayer(s, 'a', 'Shen', true);
  s = addPlayer(s, 'b', 'Ahri', true);
  s = addPlayer(s, 'c', 'Leona', true);
  s = addPlayer(s, 'd', 'Ronny@3', true);
  s = startGame(s).state;
  return viewFor(s, 'a');
}

const llmReturning = (...replies: string[]) => {
  let i = 0;
  const llm: Llm = {
    async chat() {
      return replies[Math.min(i++, replies.length - 1)];
    },
  };
  return llm;
};

describe('diplomatic ping system', () => {
  it('correctly identifies Delove / neural net model players', () => {
    expect(isModelName('Ronny@3')).toBe(true);
    expect(isModelName('Ronny@4')).toBe(true);
    expect(isModelName('Jacob-sensei@3')).toBe(true);
    expect(isModelName('Sensei@3')).toBe(true);
    expect(isModelName('Delove')).toBe(true);
    expect(isModelName('delove-bot')).toBe(true);
    expect(isModelName('Jacob-Sensei')).toBe(true);

    expect(isModelName('Shen')).toBe(false);
    expect(isModelName('Ahri')).toBe(false);
    expect(isModelName('Iron Man')).toBe(false);
    expect(isModelName('DeAnthonee')).toBe(false);
    expect(isModelName('')).toBe(false);
  });

  it('formats ping actions with spectator-friendly emojis and bracketed syntax', () => {
    expect(formatPing({ type: 'agree' })).toBe('🤝 [agree]');
    expect(formatPing({ type: 'agree', target: 'good neighbor' })).toBe('🤝 [agree: good neighbor]');
    expect(formatPing({ type: 'decline' })).toBe('✋ [decline]');
    expect(formatPing({ type: 'decline', target: 'alliance' })).toBe('✋ [decline: alliance]');
    expect(formatPing({ type: 'alliance' })).toBe('🛡️ [alliance]');
    expect(formatPing({ type: 'good_neighbor' })).toBe('🏡 [good neighbor]');
    expect(formatPing({ type: 'camaraderie' })).toBe('👊 [camaraderie]');
    expect(formatPing({ type: 'anger' })).toBe('💢 [anger]');
    expect(formatPing({ type: 'taunt' })).toBe('😈 [taunt]');
    expect(formatPing({ type: 'attack', target: 'Ahri' })).toBe('⚔️ [attack: Ahri]');
    expect(formatPing({ type: 'attack' })).toBe('⚔️ [attack]');
  });

  it('parses incoming pings across canonical syntax and common aliases', () => {
    expect(parsePing('🤝 [agree]', 'Ahri', false)).toMatchObject({ type: 'agree', from: 'Ahri', isWhisper: false });
    expect(parsePing('🤝 [agree: good neighbor]', 'Ahri', true)).toMatchObject({ type: 'agree', target: 'good neighbor', from: 'Ahri', isWhisper: true });
    expect(parsePing('[yes]', 'Ahri', true)).toMatchObject({ type: 'agree', from: 'Ahri', isWhisper: true });

    expect(parsePing('✋ [decline]', 'Ahri', false)).toMatchObject({ type: 'decline', from: 'Ahri' });
    expect(parsePing('✋ [decline: alliance]', 'Ahri', false)).toMatchObject({ type: 'decline', target: 'alliance', from: 'Ahri' });
    expect(parsePing('[no]', 'Ahri', true)).toMatchObject({ type: 'decline', from: 'Ahri' });

    expect(parsePing('🛡️ [alliance]', 'Ahri', true)).toMatchObject({ type: 'alliance', from: 'Ahri', isWhisper: true });
    expect(parsePing('🏡 [good neighbor]', 'Ahri', true)).toMatchObject({ type: 'good_neighbor', from: 'Ahri', isWhisper: true });
    expect(parsePing('[neutral border]', 'Ahri', false)).toMatchObject({ type: 'good_neighbor', from: 'Ahri' });
    expect(parsePing('[truce]', 'Ahri', false)).toMatchObject({ type: 'good_neighbor', from: 'Ahri', isWhisper: false });
    expect(parsePing('[peace]', 'Ahri', false)).toMatchObject({ type: 'good_neighbor', from: 'Ahri', isWhisper: false });

    expect(parsePing('👊 [camaraderie]', 'Ahri', false)).toMatchObject({ type: 'camaraderie', from: 'Ahri' });
    expect(parsePing('[fistbump]', 'Ahri', true)).toMatchObject({ type: 'camaraderie', from: 'Ahri' });
    expect(parsePing('[handshake]', 'Ahri', false)).toMatchObject({ type: 'camaraderie', from: 'Ahri' });

    expect(parsePing('💢 [anger]', 'Zed', false)).toMatchObject({ type: 'anger', from: 'Zed' });
    expect(parsePing('[furious]', 'Zed', true)).toMatchObject({ type: 'anger', from: 'Zed' });

    expect(parsePing('😈 [taunt]', 'Zed', false)).toMatchObject({ type: 'taunt', from: 'Zed' });
    expect(parsePing('[mock]', 'Zed', true)).toMatchObject({ type: 'taunt', from: 'Zed' });

    expect(parsePing('⚔️ [attack: Shaco]', 'Ahri', false)).toMatchObject({ type: 'attack', target: 'Shaco', from: 'Ahri' });
    expect(parsePing('[target: Ahri]', 'Shen', true)).toMatchObject({ type: 'attack', target: 'Ahri', from: 'Shen' });

    // Non-ping messages
    expect(parsePing('Hello everyone!', 'Ahri', false)).toBeNull();
    expect(parsePing('', 'Ahri', false)).toBeNull();
  });

  it('validates and extracts ping actions from commander JSON reply', () => {
    const view = makeView();
    const raw = JSON.stringify({
      winPath: 'hold-chokes',
      placeOn: 'Western Australia',
      route: ['Western Australia', 'Indonesia'],
      fortifyTo: 'Siam',
      ping: { type: 'camaraderie', to: 'Ahri' },
    });
    const parsed = parsePlanReply(raw, view, 'a');
    expect(parsed?.ping).toMatchObject({ type: 'camaraderie', to: 'Ahri' });
  });

  it('strictly filters out pings addressed to model players', () => {
    const view = makeView();
    const raw = JSON.stringify({
      winPath: 'hold-chokes',
      placeOn: 'Western Australia',
      route: ['Western Australia', 'Indonesia'],
      fortifyTo: 'Siam',
      ping: { type: 'alliance', to: 'Ronny@3' },
    });
    const parsed = parsePlanReply(raw, view, 'a');
    // Should be stripped/nullified because Ronny@3 is a model player
    expect(parsed?.ping).toBeNull();
  });

  it('prevents attack pings asking a target to attack themselves by converting to all-chat broadcast', () => {
    const view = makeView();
    // Case 1: to and target both match the victim
    const raw1 = JSON.stringify({
      winPath: 'kills',
      ping: { type: 'attack', target: 'Ahri', to: 'Ahri' },
    });
    const parsed1 = parsePlanReply(raw1, view, 'a');
    expect(parsed1?.ping).toMatchObject({ type: 'attack', target: 'Ahri', to: null });

    // Case 2: target omitted, victim specified as 'to'
    const raw2 = JSON.stringify({
      winPath: 'kills',
      ping: { type: 'attack', to: 'Ahri' },
    });
    const parsed2 = parsePlanReply(raw2, view, 'a');
    expect(parsed2?.ping).toMatchObject({ type: 'attack', target: 'Ahri', to: null });
  });

  it('converts taunts/emotes targeting a model player into all-chat table broadcasts', () => {
    const view = makeView();
    const raw = JSON.stringify({
      winPath: 'kills',
      ping: { type: 'taunt', to: 'Ronny@3' },
    });
    const parsed = parsePlanReply(raw, view, 'a');
    expect(parsed?.ping).toMatchObject({ type: 'taunt', to: null });
  });

  it('strictly limits unsolicited pings to once every 4 turns in Commander', async () => {
    const view = makeView();
    const c = new Commander({
      llm: llmReturning(
        JSON.stringify({ winPath: 'bonuses', plan: 'turn 1', ping: { type: 'taunt', to: null } }),
        JSON.stringify({ winPath: 'bonuses', plan: 'turn 2', ping: { type: 'taunt', to: null } }),
        JSON.stringify({ winPath: 'bonuses', plan: 'turn 3', ping: { type: 'taunt', to: null } }),
        JSON.stringify({ winPath: 'bonuses', plan: 'turn 4', ping: { type: 'taunt', to: null } }),
        JSON.stringify({ winPath: 'bonuses', plan: 'turn 5', ping: { type: 'taunt', to: null } })
      ),
      seatName: 'Shen',
      playerId: 'a',
      learnings: '',
      gameId: 'TEST_RATE_LIMIT',
      scoutingDir: null,
    });

    // Turn 1 (initial unsolicited ping allowed)
    await c.planFor({ ...view, turnNumber: 1 });
    expect(c.popPing()).toMatchObject({ type: 'taunt', to: null });

    // Turn 2 (blocked by 4-turn cooldown: diff = 1)
    await c.planFor({ ...view, turnNumber: 4 });
    expect(c.popPing()).toBeNull();

    // Turn 3 (blocked by 4-turn cooldown: diff = 2)
    await c.planFor({ ...view, turnNumber: 7 });
    expect(c.popPing()).toBeNull();

    // Turn 4 (blocked by 4-turn cooldown: diff = 3)
    await c.planFor({ ...view, turnNumber: 10 });
    expect(c.popPing()).toBeNull();

    // Turn 5 (allowed: diff = 4 >= 4)
    await c.planFor({ ...view, turnNumber: 13 });
    expect(c.popPing()).toMatchObject({ type: 'taunt', to: null });
  });

  it('drops agree/decline when no active proposal exists (e.g. declining a taunt)', async () => {
    const view = makeView();
    const c = new Commander({
      llm: llmReturning(
        JSON.stringify({ winPath: 'bonuses', plan: 'trying to decline a taunt', ping: { type: 'decline', to: 'Ahri' } })
      ),
      seatName: 'Shen',
      playerId: 'a',
      learnings: '',
      gameId: 'TEST_NO_DECLINE_TAUNT',
      scoutingDir: null,
    });

    // Ahri taunts in public chat
    c.onMessages([
      { id: 1, playerId: 'b', name: 'Ahri', message: '😈 [taunt]' },
    ]);

    await c.planFor({ ...view, turnNumber: 1 });
    // Should be DROPPED because Ahri sent a taunt, not an alliance proposal!
    expect(c.popPing()).toBeNull();
  });

  it('allows immediate reply to an incoming alliance proposal bypassing 4-turn cooldown', async () => {
    const view = makeView();
    const c = new Commander({
      llm: llmReturning(
        // Turn 1: Shen pings camaraderie
        JSON.stringify({ winPath: 'bonuses', plan: 'turn 1', ping: { type: 'camaraderie', to: null } }),
        // Turn 2: Shen replies agree to Ahri's alliance proposal
        JSON.stringify({ winPath: 'bonuses', plan: 'turn 2 reply', ping: { type: 'agree', to: 'Ahri' } })
      ),
      seatName: 'Shen',
      playerId: 'a',
      learnings: '',
      gameId: 'TEST_REPLY_EXEMPTION',
      scoutingDir: null,
    });

    // Turn 1
    await c.planFor({ ...view, turnNumber: 1 });
    expect(c.popPing()).toMatchObject({ type: 'camaraderie', to: null });

    // Between turns, Ahri proposes alliance to Shen
    c.onMessages([
      { id: 1, playerId: 'b', name: 'Ahri', message: '🛡️ [alliance]', to: 'a', toName: 'Shen' },
    ]);

    // Turn 2 (even though 4-turn cooldown is active, reply exemption permits agree)
    await c.planFor({ ...view, turnNumber: 4 });
    expect(c.popPing()).toMatchObject({ type: 'agree', to: 'Ahri' });
  });

  it('enforces silence is a rejection: proposal expires if not answered on immediate next turn', async () => {
    const view = makeView();
    const c = new Commander({
      llm: llmReturning(
        // Turn 1: Shen ignores Ahri's proposal (silence)
        JSON.stringify({ winPath: 'bonuses', plan: 'turn 1 silence', ping: null }),
        // Turn 2: Shen late tries to agree to Ahri
        JSON.stringify({ winPath: 'bonuses', plan: 'turn 2 late agree', ping: { type: 'agree', to: 'Ahri' } })
      ),
      seatName: 'Shen',
      playerId: 'a',
      learnings: '',
      gameId: 'TEST_SILENCE_EXPIRY',
      scoutingDir: null,
    });

    // Before turn 1, Ahri proposes alliance
    c.onMessages([
      { id: 1, playerId: 'b', name: 'Ahri', message: '🛡️ [alliance]', to: 'a', toName: 'Shen' },
    ]);

    // Turn 1: Shen remains silent
    await c.planFor({ ...view, turnNumber: 1 });
    expect(c.popPing()).toBeNull();

    // Turn 2: Shen tries to agree, but the proposal has expired due to silence!
    await c.planFor({ ...view, turnNumber: 4 });
    expect(c.popPing()).toBeNull();
  });

  it('rejects Good Neighbor proposals in 3-man endgame to avoid Mexican standoff stalemates', async () => {
    const view = makeView(); // 3 players: 'a', 'b', 'c'
    const c = new Commander({
      llm: llmReturning(
        // Shen tries to propose good neighbor in a 3-man game
        JSON.stringify({ winPath: 'bonuses', plan: 'turn 1', ping: { type: 'good_neighbor', to: 'Ahri' } })
      ),
      seatName: 'Shen',
      playerId: 'a',
      learnings: '',
      gameId: 'TEST_3MAN_STALEMATE_AVOIDANCE',
      scoutingDir: null,
    });

    await c.planFor({ ...view, turnNumber: 1 });
    // In a 3-man game, good_neighbor is rejected/dropped to avoid stalemate!
    expect(c.popPing()).toBeNull();
  });

  it('proposes and establishes Good Neighbor neutral border pacts in 4+ player games', async () => {
    const view = makeView4(); // 4 players
    const c = new Commander({
      llm: llmReturning(
        // Turn 1: Shen proposes good neighbor to Ahri
        JSON.stringify({ winPath: 'bonuses', plan: 'turn 1', ping: { type: 'good_neighbor', to: 'Ahri' } }),
        // Turn 2: Shen maintains plan
        JSON.stringify({ winPath: 'bonuses', plan: 'turn 2', ping: null })
      ),
      seatName: 'Shen',
      playerId: 'a',
      learnings: '',
      gameId: 'TEST_GOOD_NEIGHBOR_4P',
      scoutingDir: null,
    });

    // Turn 1: Shen pings good neighbor to Ahri
    await c.planFor({ ...view, turnNumber: 1 });
    expect(c.popPing()).toMatchObject({ type: 'good_neighbor', to: 'Ahri' });

    // Ahri agrees to the good neighbor pact
    c.onMessages([
      { id: 1, playerId: 'b', name: 'Ahri', message: '🤝 [agree]', to: 'a', toName: 'Shen' },
    ]);

    // On Turn 2, Ahri should now be in avoid (neutral border pact)
    const plan2 = await c.planFor({ ...view, turnNumber: 4 });
    expect(plan2?.avoid).toContain('b');
  });

  it('coordinates joint attack agreements to gang up on targets', async () => {
    const view = makeView(); // 3 players: Shen ('a'), Ahri ('b'), Ronny@3 ('c')
    const c = new Commander({
      llm: llmReturning(
        // Turn 1: Shen agrees to Ahri's call to attack Ronny@3
        JSON.stringify({ winPath: 'kills', plan: 'agree to hit Ronny', ping: { type: 'agree', to: 'Ahri' } })
      ),
      seatName: 'Shen',
      playerId: 'a',
      learnings: '',
      gameId: 'TEST_JOINT_ATTACK',
      scoutingDir: null,
    });

    // Ahri whispers attack call to Shen
    c.onMessages([
      { id: 1, playerId: 'b', name: 'Ahri', message: '⚔️ [attack: Ronny@3]', to: 'a', toName: 'Shen' },
    ]);

    const plan = await c.planFor({ ...view, turnNumber: 1 });
    // Shen agrees to the attack call
    expect(c.popPing()).toMatchObject({ type: 'agree', to: 'Ahri' });
    // Ahri is avoided as a partner, Ronny@3 is targeted!
    expect(plan?.avoid).toContain('b');
    expect(plan?.target).toBe('c');
  });

  it('recognizes mutual good neighbor proposals as an automatic bilateral handshake agreement', async () => {
    const view = makeView4(); // 4 players
    const c = new Commander({
      llm: llmReturning(
        // Turn 1: Shen proposes good neighbor to Ahri
        JSON.stringify({ winPath: 'bonuses', plan: 'turn 1', ping: { type: 'good_neighbor', to: 'Ahri' } }),
        // Turn 2: Shen plays normally
        JSON.stringify({ winPath: 'bonuses', plan: 'turn 2', ping: null })
      ),
      seatName: 'Shen',
      playerId: 'a',
      learnings: '',
      gameId: 'TEST_MUTUAL_HANDSHAKE',
      scoutingDir: null,
    });

    // Turn 1: Shen sends good neighbor to Ahri
    await c.planFor({ ...view, turnNumber: 1 });
    expect(c.popPing()).toMatchObject({ type: 'good_neighbor', to: 'Ahri' });

    // Between turns, Ahri ALSO sends good neighbor to Shen (cross-proposal)
    c.onMessages([
      { id: 1, playerId: 'b', name: 'Ahri', message: '🏡 [good neighbor]', to: 'a', toName: 'Shen' },
    ]);

    // On Turn 2, the mutual handshake should automatically seal the pact, putting Ahri in avoid!
    const plan2 = await c.planFor({ ...view, turnNumber: 5 });
    expect(plan2?.avoid).toContain('b');
  });

  it('correctly computes whether map continents are topologically adjacent across borders', () => {
    const map = getMap('classic');
    expect(areContinentsAdjacent(map, 'north_america', 'south_america')).toBe(true);
    expect(areContinentsAdjacent(map, 'south_america', 'africa')).toBe(true);
    expect(areContinentsAdjacent(map, 'europe', 'africa')).toBe(true);
    expect(areContinentsAdjacent(map, 'europe', 'asia')).toBe(true);
    expect(areContinentsAdjacent(map, 'asia', 'australia')).toBe(true);

    // Non-adjacent continents
    expect(areContinentsAdjacent(map, 'south_america', 'europe')).toBe(false);
    expect(areContinentsAdjacent(map, 'south_america', 'australia')).toBe(false);
    expect(areContinentsAdjacent(map, 'south_america', 'asia')).toBe(false);
    expect(areContinentsAdjacent(map, 'north_america', 'australia')).toBe(false);

    // Same continent
    expect(areContinentsAdjacent(map, 'europe', 'europe')).toBe(false);
  });

  it('rejects Good Neighbor proposals when players are pursuing non-adjacent continent bonuses (e.g. South America vs Europe)', async () => {
    const map = getMap('classic');
    let s = createGame('TEST_REJECT_NON_ADJ', { ...DEFAULT_OPTIONS, fogOfWar: false, maxPlayers: 4, map: 'classic', chooseCapitals: false }, 42);
    s = addPlayer(s, 'a', 'Shen', true);
    s = addPlayer(s, 'b', 'Ahri', true);
    s = addPlayer(s, 'c', 'Leona', true);
    s = addPlayer(s, 'd', 'Darius', true);
    s = startGame(s).state;

    // Shen holds South America
    for (const t of ['brazil', 'venezuela', 'peru', 'argentina']) {
      s.territories[t] = { owner: 'a', armies: 3 };
    }
    // Darius holds Europe
    for (const t of map.continentById['europe'].territories) {
      s.territories[t] = { owner: 'd', armies: 3 };
    }
    // Darius also holds Central America so they are adjacent border neighbors
    s.territories['central_america'] = { owner: 'd', armies: 3 };

    const view = viewFor(s, 'a');

    const c = new Commander({
      llm: llmReturning(
        // Shen attempts to agree to Darius's Good Neighbor proposal
        JSON.stringify({ winPath: 'bonuses', focus: 'south_america', plan: 'hold SA', ping: { type: 'agree', to: 'Darius' } })
      ),
      seatName: 'Shen',
      playerId: 'a',
      learnings: '',
      gameId: 'TEST_REJECT_NON_ADJ',
      scoutingDir: null,
    });

    // Darius proposes Good Neighbor to Shen
    c.onMessages([
      { id: 1, playerId: 'd', name: 'Darius', message: '🏡 [good neighbor]', to: 'a', toName: 'Shen' },
    ]);

    const plan = await c.planFor({ ...view, turnNumber: 1 });
    // Agreement must be strictly rejected/dropped because South America and Europe are non-adjacent bonuses!
    expect(c.popPing()).toBeNull();
    expect(plan?.avoid).not.toContain('d');
  });

  it('accepts Good Neighbor proposals when players are pursuing adjacent continent bonuses (e.g. South America vs Africa)', async () => {
    const map = getMap('classic');
    let s = createGame('TEST_ACCEPT_ADJ', { ...DEFAULT_OPTIONS, fogOfWar: false, maxPlayers: 4, map: 'classic', chooseCapitals: false }, 42);
    s = addPlayer(s, 'a', 'Shen', true);
    s = addPlayer(s, 'b', 'Ahri', true);
    s = addPlayer(s, 'c', 'Leona', true);
    s = addPlayer(s, 'd', 'Darius', true);
    s = startGame(s).state;

    // Shen holds South America
    for (const t of ['brazil', 'venezuela', 'peru', 'argentina']) {
      s.territories[t] = { owner: 'a', armies: 3 };
    }
    // Ahri holds Africa (borders South America across Brazil <-> North Africa)
    for (const t of map.continentById['africa'].territories) {
      s.territories[t] = { owner: 'b', armies: 3 };
    }

    const view = viewFor(s, 'a');

    const c = new Commander({
      llm: llmReturning(
        // Shen agrees to Ahri's Good Neighbor proposal
        JSON.stringify({ winPath: 'bonuses', focus: 'south_america', plan: 'hold SA', ping: { type: 'agree', to: 'Ahri' } })
      ),
      seatName: 'Shen',
      playerId: 'a',
      learnings: '',
      gameId: 'TEST_ACCEPT_ADJ',
      scoutingDir: null,
    });

    // Ahri proposes Good Neighbor to Shen
    c.onMessages([
      { id: 1, playerId: 'b', name: 'Ahri', message: '🏡 [good neighbor]', to: 'a', toName: 'Shen' },
    ]);

    const plan = await c.planFor({ ...view, turnNumber: 1 });
    // Agreement accepted because South America and Africa are adjacent continent bonuses!
    expect(c.popPing()).toMatchObject({ type: 'agree', to: 'Ahri', target: 'good neighbor' });
    expect(plan?.avoid).toContain('b');
  });

  it('rejects Good Neighbor proposals when both players are contesting the SAME continent bonus', async () => {
    let s = createGame('TEST_REJECT_SAME_CONT', { ...DEFAULT_OPTIONS, fogOfWar: false, maxPlayers: 4, map: 'classic', chooseCapitals: false }, 42);
    s = addPlayer(s, 'a', 'Shen', true);
    s = addPlayer(s, 'b', 'Ahri', true);
    s = addPlayer(s, 'c', 'Leona', true);
    s = addPlayer(s, 'd', 'Darius', true);
    s = startGame(s).state;

    // Both Shen and Ahri contest South America
    s.territories['brazil'] = { owner: 'a', armies: 3 };
    s.territories['argentina'] = { owner: 'a', armies: 3 };
    s.territories['peru'] = { owner: 'b', armies: 3 };
    s.territories['venezuela'] = { owner: 'b', armies: 3 };

    const view = viewFor(s, 'a');

    const c = new Commander({
      llm: llmReturning(
        JSON.stringify({ winPath: 'bonuses', focus: 'south_america', plan: 'hold SA', ping: { type: 'agree', to: 'Ahri' } })
      ),
      seatName: 'Shen',
      playerId: 'a',
      learnings: '',
      gameId: 'TEST_REJECT_SAME_CONT',
      scoutingDir: null,
    });

    // Ahri proposes Good Neighbor
    c.onMessages([
      { id: 1, playerId: 'b', name: 'Ahri', message: '🏡 [good neighbor]', to: 'a', toName: 'Shen' },
    ]);

    const plan = await c.planFor({ ...view, turnNumber: 1 });
    // Agreement rejected because both are fighting over the exact same continent bonus!
    expect(c.popPing()).toBeNull();
    expect(plan?.avoid).not.toContain('b');
  });
});
