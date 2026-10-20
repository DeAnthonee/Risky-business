import { describe, expect, it } from 'vitest';
import { addPlayer, createGame, startGame, viewFor, type GameView } from '@risk/engine';
import { formatPing, isModelName, parsePing, type PingAction } from '../src/pings.js';
import { parsePlanReply } from '../src/commander.js';
import { DEFAULT_OPTIONS } from '../src/presets.js';

function makeView(): GameView {
  let s = createGame('PINGS_TEST', { ...DEFAULT_OPTIONS, maxPlayers: 3, map: 'classic', chooseCapitals: false }, 42);
  s = addPlayer(s, 'a', 'Shen', true);
  s = addPlayer(s, 'b', 'Ahri', true);
  s = addPlayer(s, 'c', 'Ronny@3', true);
  s = startGame(s).state;
  return viewFor(s, 'a');
}

describe('diplomatic ping system', () => {
  it('correctly identifies Delove / neural net model players', () => {
    expect(isModelName('Ronny@3')).toBe(true);
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
    expect(formatPing({ type: 'decline' })).toBe('✋ [decline]');
    expect(formatPing({ type: 'alliance' })).toBe('🛡️ [alliance]');
    expect(formatPing({ type: 'camaraderie' })).toBe('👊 [camaraderie]');
    expect(formatPing({ type: 'anger' })).toBe('💢 [anger]');
    expect(formatPing({ type: 'taunt' })).toBe('😈 [taunt]');
    expect(formatPing({ type: 'attack', target: 'Ahri' })).toBe('⚔️ [attack: Ahri]');
    expect(formatPing({ type: 'attack' })).toBe('⚔️ [attack]');
  });

  it('parses incoming pings across canonical syntax and common aliases', () => {
    expect(parsePing('🤝 [agree]', 'Ahri', false)).toMatchObject({ type: 'agree', from: 'Ahri', isWhisper: false });
    expect(parsePing('[yes]', 'Ahri', true)).toMatchObject({ type: 'agree', from: 'Ahri', isWhisper: true });

    expect(parsePing('✋ [decline]', 'Ahri', false)).toMatchObject({ type: 'decline', from: 'Ahri' });
    expect(parsePing('[no]', 'Ahri', true)).toMatchObject({ type: 'decline', from: 'Ahri' });

    expect(parsePing('🛡️ [alliance]', 'Ahri', true)).toMatchObject({ type: 'alliance', from: 'Ahri', isWhisper: true });
    expect(parsePing('[truce]', 'Ahri', false)).toMatchObject({ type: 'alliance', from: 'Ahri', isWhisper: false });

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
});
