import { useCallback, useState } from 'react';
import type { BigMoveMessage } from '../api';

const KEY = 'risk.reactions';

/** The "Reactions" toggle: on by default, remembered in this browser. */
export function useReactionsToggle(): [boolean, () => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(KEY) !== 'off';
    } catch {
      return true;
    }
  });
  const toggle = useCallback(() => {
    setOn((v) => {
      try {
        localStorage.setItem(KEY, v ? 'off' : 'on');
      } catch {
        /* private mode: just this page */
      }
      return !v;
    });
  }, []);
  return [on, toggle];
}

const TITLE: Record<BigMoveMessage['kind'], (m: BigMoveMessage, place: string) => string> = {
  sweep: (m, place) => `${m.attacker.name} takes ${m.taken} from ${m.victim.name}, down to ${place}`,
  knockout: (m) => `${m.attacker.name} knocks out ${m.victim.name}`,
  capital: (m, place) => `${m.attacker.name} takes ${m.victim.name}'s capital, ${place}`,
};

/**
 * A big move's pop-up on the map (server reactions.ts): what happened, a line from the attacker and the victim's
 * reply. The server only sends it to views that already show the whole board, so it reveals nothing hidden by fog.
 */
export function ReactionPopup({ reaction, colorOf, placeName }: { reaction: BigMoveMessage; colorOf: (id: string) => string; placeName: (id: string) => string }) {
  return (
    <div className="reaction-popup" role="status" aria-live="polite" key={`${reaction.version}:${reaction.victim.id}`}>
      <div className="reaction-title">{TITLE[reaction.kind](reaction, placeName(reaction.anchor))}</div>
      <div className="reaction-line">
        <span className="swatch" style={{ background: colorOf(reaction.attacker.id) }} />
        <strong>{reaction.attacker.name}:</strong> {reaction.line}
      </div>
      <div className="reaction-line">
        <span className="swatch" style={{ background: colorOf(reaction.victim.id) }} />
        <strong>{reaction.victim.name}:</strong> {reaction.reply}
      </div>
    </div>
  );
}
