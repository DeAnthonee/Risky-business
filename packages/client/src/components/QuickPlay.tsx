import { useEffect, useRef, useState } from 'react';
import { MAP_IDS, getMap, type MapId } from '@risk/engine';
import { api, type QuickPlayTicket } from '../api';
import type { Session } from '../session';

/**
 * Quick play on the home page: join the server's queue (POST /api/queue) and wait to be seated with whoever else is
 * waiting, the empty seats filled with Zergs. The same queue agents use through the MCP quick_play tool.
 */
export function QuickPlay({ name, disabled, onEnter }: { name: string; disabled: boolean; onEnter: (s: Session) => void }) {
  const [map, setMap] = useState<MapId>('classic');
  const [seats, setSeats] = useState(4);
  // Only registered boards (the server rejects anything else); seats up to the board's most.
  const most = getMap(map).maxPlayers;
  const [fog, setFog] = useState(false);
  const [ticket, setTicket] = useState<QuickPlayTicket | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const held = useRef<{ ticket: string; token: string } | null>(null);

  // Leave the queue if the page goes away while waiting.
  useEffect(
    () => () => {
      const h = held.current;
      if (h) void api.quickPlayLeave(h.ticket, h.token).catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    if (!ticket) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticket]);

  const start = async () => {
    setErr(null);
    try {
      const r = await api.quickPlayJoin(name.trim(), map, Math.min(seats, most), fog);
      held.current = { ticket: r.ticket.ticket, token: r.token };
      let t = r.ticket;
      setTicket(t);
      while (held.current && t.status !== 'seated') {
        t = (await api.quickPlayWait(held.current.ticket, held.current.token, 25_000)).ticket;
        if (held.current) setTicket(t);
      }
      if (t.status === 'seated' && t.gameId && t.playerId && t.seatToken) {
        held.current = null;
        onEnter({ gameId: t.gameId, playerId: t.playerId, token: t.seatToken, name: t.name });
      }
    } catch (e) {
      held.current = null;
      setTicket(null);
      setErr((e as Error).message);
    }
  };

  const cancel = () => {
    const h = held.current;
    held.current = null;
    setTicket(null);
    if (h) void api.quickPlayLeave(h.ticket, h.token).catch(() => undefined);
  };

  if (ticket) {
    const left = ticket.startsAt ? Math.max(0, Math.ceil((ticket.startsAt - now) / 1000)) : 0;
    return (
      <div className="quick-play waiting" role="status" aria-live="polite">
        <strong>Finding a game…</strong>
        <span>
          {ticket.waiting} of {ticket.seats} waiting{ticket.fog ? ' · fog' : ''} · starts in {left}s, the empty seats filled with Zergs
        </span>
        <button type="button" onClick={cancel}>
          Cancel
        </button>
      </div>
    );
  }
  return (
    <div className="quick-play">
      <button type="button" className="primary" disabled={disabled} onClick={() => void start()}>
        Quick play
      </button>
      <label>
        Map
        <select value={map} onChange={(e) => setMap(e.target.value as MapId)}>
          {MAP_IDS.map((id) => (
            <option key={id} value={id}>
              {getMap(id).name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Seats
        <select value={Math.min(seats, most)} onChange={(e) => setSeats(Number(e.target.value))}>
          {Array.from({ length: most - 1 }, (_, i) => i + 2).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <label className="quick-fog">
        <input type="checkbox" checked={fog} onChange={(e) => setFog(e.target.checked)} /> Fog
      </label>
      {err && (
        <p className="error" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}
