import { describe, expect, it, vi } from 'vitest';
import { finalPlacements, type GameState } from '@risk/engine';

// Bots move at once here, so a whole game plays out in the test (set before the store module loads).
vi.hoisted(() => {
  process.env.RISK_BOT_DELAY_MS = '0';
});

const { Store } = await import('../src/store.js');

async function until(check: () => boolean, ms = 120_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('a live game ends when only Zergs are left (owner rule A)', () => {
  it('8 Zergs + 2 bots: the game ends the moment the last bot falls, as it stands, with no surrenders', async () => {
    const store = new Store(null);
    const players = [
      { name: 'Bot One', isBot: true },
      { name: 'Bot Two', isBot: true },
      ...['Mamba', 'Viper', 'Cobra', 'Gecko', 'Skink', 'Komodo', 'Caiman', 'Basilisk'].map((name) => ({ name, isBot: true, kind: 'zerg' as const })),
    ];
    const { room } = store.createTable('Swarm test', { map: 'world', maxPlayers: 10, autoSetup: true }, players, 'TSWARM');
    const commits: { before: GameState; next: GameState; action: { type: string; note?: string } }[] = [];
    room.on('commit', (c) => commits.push(c));
    await until(() => room.state.phase === 'finished');
    room.stopBot();

    const s = room.state;
    expect(s.winner).toMatch(/^zerg_/);
    // No Zerg surrendered: only bots were knocked out, and every Zerg is still in.
    expect(room.history.some((h) => h.action?.type === 'surrender')).toBe(false);
    const zergs = s.players.filter((p) => p.id.startsWith('zerg_'));
    expect(zergs.every((p) => p.alive)).toBe(true);
    expect(s.players.filter((p) => !p.isNeutral && !p.id.startsWith('zerg_')).every((p) => !p.alive)).toBe(true);

    // The last step is the swarm's ending: a system note and game_over, the board exactly as the step before it.
    const last = commits.at(-1)!;
    expect(last.action).toMatchObject({ type: 'system', note: expect.stringMatching(/only Zergs are left/) });
    expect(room.history.at(-1)!.events).toEqual([{ type: 'game_over', winner: s.winner }]);
    expect(last.next.territories).toEqual(last.before.territories);
    // ...and it comes right after the step that knocked out the last bot, or right after that step's occupy when the
    // attack left armies to move in (the game never ends mid-conquest).
    const lastBot = room.eliminationOrder.at(-1)!;
    const knockedOut = (h: (typeof room.history)[number]) => h.events.some((e) => e.type === 'eliminated' && e.player === lastBot);
    const previous = room.history.at(-2)!;
    if (previous.action?.type === 'occupy') expect(knockedOut(room.history.at(-3)!)).toBe(true);
    else expect(knockedOut(previous)).toBe(true);
    expect(last.before.pendingConquest).toBeNull();
    expect(room.chat.at(-1)!.message).toMatch(/swarm has won/);

    // Places follow the standing: the winner first, then the other Zergs by territories and armies, then the bots.
    const places = finalPlacements(s, room.eliminationOrder);
    expect(places[0].id).toBe(s.winner);
    const land = (id: string) => Object.values(s.territories).filter((t) => t.owner === id).length;
    const zergPlaces = places.filter((p) => p.id.startsWith('zerg_')).map((p) => land(p.id));
    expect(zergPlaces.slice(1)).toEqual([...zergPlaces.slice(1)].sort((a, b) => b - a));
    expect(places.slice(-2).every((p) => !p.id.startsWith('zerg_'))).toBe(true);
    store.stopTimers();
  }, 180_000);

  it('a table seated with Zergs only ends right after the deal, decided by standing (owner)', () => {
    const store = new Store(null);
    const { room } = store.createTable('Zerg table', { map: 'classic', maxPlayers: 3, autoSetup: true }, ['Mamba', 'Viper', 'Cobra'].map((name) => ({ name, isBot: true, kind: 'zerg' as const })), 'TZERG');
    expect(room.state.phase).toBe('finished');
    expect(room.state.winner).toMatch(/^zerg_/);
    expect(room.history.some((h) => h.action?.type === 'surrender')).toBe(false);
    expect(room.state.players.every((p) => p.isNeutral || p.alive)).toBe(true);
    store.stopTimers();
  });

  it('the last non-Zerg falling to an attack without occupy: the minimum moves in, then the game ends, never with a 0-army territory', async () => {
    const { getMap } = await import('@risk/engine');
    const store = new Store(null);
    const { room, playerId: human } = store.create('Mid-conquest', { map: 'classic', maxPlayers: 3, autoSetup: true }, 'Ada');
    const z1 = room.addBot('zerg').playerId;
    room.addBot('zerg');
    room.start();
    room.stopBot();
    // Lay the board out by hand: Ada holds one territory with 1 army, next to z1's stack of 30; the Zergs hold the rest.
    const s = room.state;
    const map = getMap('classic');
    const last = map.territoryIds[0];
    const from = map.adjacency[last][0];
    const zergIds = s.players.filter((p) => !p.isNeutral && p.id !== human).map((p) => p.id);
    map.territoryIds.forEach((t, i) => (s.territories[t] = { owner: zergIds[i % zergIds.length], armies: 2 }));
    s.territories[last] = { owner: human, armies: 1 };
    s.territories[from] = { owner: z1, armies: 30 };
    s.currentPlayer = z1;
    s.phase = 'attack';
    s.pendingConquest = null;
    for (const p of s.players) p.armiesToPlace = 0;

    room.act(z1, { type: 'attack', from, to: last, blitz: true });
    room.stopBot();
    // Ada is out. The game did not end on the attack (armies still to move in): z1 occupied with the minimum, as an
    // ordinary move, and the game ended on that occupy.
    expect(room.state.players.find((p) => p.id === human)!.alive).toBe(false);
    expect(room.state.phase).toBe('finished');
    expect(room.state.pendingConquest).toBeNull();
    expect(Object.values(room.state.territories).every((t) => t.owner === null || t.armies > 0)).toBe(true);
    expect(room.state.territories[last].owner).toBe(z1);
    const [attack, occupy, end] = room.history.slice(-3);
    expect(attack).toMatchObject({ playerId: z1, action: { type: 'attack' } });
    expect(attack.events.some((e) => e.type === 'game_over')).toBe(false);
    expect(occupy).toMatchObject({ playerId: z1, action: { type: 'occupy' } });
    expect(end.action).toMatchObject({ type: 'system', note: expect.stringMatching(/only Zergs are left/) });
    // Nobody surrendered on the way.
    expect(room.history.some((h) => h.action?.type === 'surrender')).toBe(false);
    store.stopTimers();
  });

  it('a game with people never ends this way while a person is in', () => {
    const store = new Store(null);
    const { room } = store.createTable('Mixed', { map: 'classic', maxPlayers: 3, autoSetup: true }, [{ name: 'Ada', isBot: false }, { name: 'Mamba', isBot: true, kind: 'zerg' }, { name: 'Viper', isBot: true, kind: 'zerg' }], 'TMIX');
    expect(room.state.phase).not.toBe('finished');
    store.stopTimers();
  });
});
