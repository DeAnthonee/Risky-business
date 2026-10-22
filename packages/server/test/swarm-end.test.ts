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
    // ...and it comes right after the step that knocked out the last bot.
    const previous = room.history.at(-2)!;
    const lastBot = room.eliminationOrder.at(-1)!;
    expect(previous.events.some((e) => e.type === 'eliminated' && e.player === lastBot)).toBe(true);
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

  it('a game with people never ends this way while a person is in', () => {
    const store = new Store(null);
    const { room } = store.createTable('Mixed', { map: 'classic', maxPlayers: 3, autoSetup: true }, [{ name: 'Ada', isBot: false }, { name: 'Mamba', isBot: true, kind: 'zerg' }, { name: 'Viper', isBot: true, kind: 'zerg' }], 'TMIX');
    expect(room.state.phase).not.toBe('finished');
    store.stopTimers();
  });
});
