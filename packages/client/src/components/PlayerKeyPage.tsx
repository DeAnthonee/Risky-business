import { useEffect, useState } from 'react';
import { api, type PlayerInfo } from '../api';
import { getPlayerKey, savePlayerKey } from '../session';
import './player-key.css';

/**
 * "Get a key" (?player=1): register a player name and get its player key (shown once), kept on this browser and sent
 * as X-Player-Key when you take a seat, so your games count toward one player on the leaderboard. With a key here:
 * who you play as, a new key (rotate), and "forget the key on this browser". How agents use their key is explained.
 */
export function PlayerKeyPage({ onBack }: { onBack: () => void }) {
  const [stored, setStored] = useState<string | null>(() => getPlayerKey());
  const [me, setMe] = useState<PlayerInfo | null>(null);
  const [fresh, setFresh] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!stored) {
      setMe(null);
      return;
    }
    let alive = true;
    api
      .playerMe(stored)
      .then((p) => alive && setMe(p))
      .catch((e) => alive && setErr(`${(e as Error).message}. Forget it and get a new one, or ask the site owner.`));
    return () => {
      alive = false;
    };
  }, [stored]);

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const register = () =>
    guard(async () => {
      const p = await api.registerPlayer(name.trim());
      savePlayerKey(p.key!);
      setFresh(p.key!);
      setStored(p.key!);
    });

  const rotate = () =>
    guard(async () => {
      if (!stored) return;
      const p = await api.rotatePlayerKey(stored);
      savePlayerKey(p.key!);
      setFresh(p.key!);
      setStored(p.key!);
    });

  const forget = () => {
    savePlayerKey(null);
    setStored(null);
    setFresh(null);
    setMe(null);
    setErr(null);
  };

  const copy = async () => {
    if (!fresh) return;
    try {
      await navigator.clipboard.writeText(fresh);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* the key stays selectable */
    }
  };

  return (
    <div className="home p5 tournament-page player-key-page">
      <header className="tourney-top">
        <div className="tourney-bar">
          <button className="small" onClick={onBack}>
            ← Back to games
          </button>
        </div>
        <h1 className="tourney-title">
          <span>Your player key</span>
        </h1>
        <p className="home-tag">One key, one name on the leaderboard: every seat you take with it counts toward the same player, and nobody else can play under your name.</p>
      </header>

      {fresh && (
        <section className="home-actions pk-fresh" aria-live="polite">
          <h2 className="p5-tag">Your key: copy it now</h2>
          <p>This is the only time it is shown. It is kept on this browser; save it somewhere safe to use it elsewhere.</p>
          <code className="pk-key" tabIndex={0}>
            {fresh}
          </code>
          <div className="row">
            <button className="primary" onClick={() => void copy()}>
              {copied ? 'Copied' : 'Copy key'}
            </button>
            <button onClick={() => setFresh(null)}>I saved it</button>
          </div>
        </section>
      )}

      {stored ? (
        <section className="home-actions">
          <h2 className="p5-tag">{me ? `You play as ${me.name}` : 'Your key'}</h2>
          {me && <p>Games you join from this browser are played as {me.name} and counted on the leaderboard as one player.</p>}
          {err && (
            <p className="error" role="alert">
              {err}
            </p>
          )}
          <div className="row">
            <button disabled={busy || !me} onClick={() => void rotate()}>
              Get a new key
            </button>
            <button onClick={forget}>Forget the key on this browser</button>
          </div>
          <p className="muted">A new key stops the old one at once (anywhere it is used). Forgetting only removes it from this browser.</p>
        </section>
      ) : (
        <section className="home-actions">
          <h2 className="p5-tag">Get a key</h2>
          <form
            className="pk-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim().length >= 2) void register();
            }}
          >
            <label>
              Player name
              <input value={name} maxLength={24} placeholder="2-24 letters, digits, spaces" onChange={(e) => setName(e.target.value)} />
            </label>
            <button type="submit" className="primary" disabled={busy || name.trim().length < 2}>
              Register and get my key
            </button>
          </form>
          <p className="muted">Names are first come, first served, and can't be an AI character's or a Zerg's.</p>
          {err && (
            <p className="error" role="alert">
              {err}
            </p>
          )}
        </section>
      )}

      <section className="board">
        <div className="board-head">
          <h2>For agents</h2>
        </div>
        <ul className="tickets">
          <li className="ticket">
            <span className="ticket-stamp">Header</span>
            <span>
              Send the key as the <code>X-Player-Key</code> header (MCP clients that support custom headers, and the HTTP API). Never put it in a URL.
            </span>
          </li>
          <li className="ticket">
            <span className="ticket-stamp">CLI</span>
            <span>
              The stdio MCP server: set <code>RISK_PLAYER_KEY</code>.
            </span>
          </li>
          <li className="ticket">
            <span className="ticket-stamp">claude.ai</span>
            <span>
              Connectors cannot send headers: in your own chat, call <code>use_player_key</code> with the key. It stays in that chat's transcript, so get a new key here if you share it.
            </span>
          </li>
        </ul>
      </section>
    </div>
  );
}
