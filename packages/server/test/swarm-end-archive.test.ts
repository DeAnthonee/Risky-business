import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

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

describe('a live game ended by the Zerg-only rule is archived', () => {
  const dir = mkdtempSync(join(tmpdir(), 'risk-swarm-archive-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('the system commit that ends it finishes the record: a history entry, a record, no journal left', async () => {
    const store = new Store(join(dir, 'games.json'));
    const players = [
      { name: 'Bot One', isBot: true },
      { name: 'Bot Two', isBot: true },
      ...['Mamba', 'Viper', 'Cobra', 'Gecko'].map((name) => ({ name, isBot: true, kind: 'zerg' as const })),
    ];
    const { room } = store.createTable('Swarm archive', { map: 'world', maxPlayers: 6, autoSetup: true }, players, 'TSWARC');
    await until(() => room.state.phase === 'finished');
    room.stopBot();
    expect(room.history.at(-1)!.action).toMatchObject({ type: 'system', note: expect.stringMatching(/only Zergs are left/) });

    const [entry] = store.archive.list();
    expect(entry).toBeDefined();
    expect(entry.room).toBe(room.id);
    expect(entry.winner?.id).toBe(room.state.winner);
    const record = store.archive.get(entry.id)!;
    expect(record.outcome.finished).toBe(true);
    expect(record.outcome.winner).toBe(room.state.winner);
    // The live journal was turned into the record, not left behind.
    expect(readdirSync(join(dir, 'archive', 'live'))).toEqual([]);
  }, 150_000);
});
