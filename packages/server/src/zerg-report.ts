// How the Zerg swarm behaved in one game: its discipline (two alarms that must read 0), its trades and its knockouts,
// plus a per-seat table for comparison. Pure: it walks a game's moves in order, the same walk for a live room (fed
// commit by commit) and a finished record (fed its steps). Read-only reporting; rules stay in the engine.
import type { GameEvent, PlayerId } from '@risk/engine';
import { isZergSeat } from './bot.js';

/** One move: who acted, what they did, and what it caused. A room's history entry and a record step both map to it. */
export interface ReportStep {
  player: PlayerId | null;
  action: { type: string };
  events: readonly GameEvent[];
}

export interface ReportPlayer {
  id: PlayerId;
  name: string;
  isNeutral?: boolean;
}

/** A Zerg attacking a fellow Zerg while a non-Zerg was still alive (alarm 1). */
export interface ZergOnZerg {
  step: number;
  attacker: string;
  defender: string;
}

/** A Zerg surrendering: mid-game (a non-Zerg still alive: alarm 2) or in the endgame (by design). */
export interface ZergSurrender {
  step: number;
  player: string;
  midGame: boolean;
  /** Territories it held at its last turn: they turn neutral. */
  landLeft: number;
}

export interface SeatLine {
  id: PlayerId;
  name: string;
  zerg: boolean;
  turns: number;
  attacks: number;
  /** Battle rolls it made as the attacker. */
  rolls: number;
  destroyed: number;
  lost: number;
  conquests: number;
  knockouts: number;
  peakTerritories: number;
  /** "won", "alive", "surrendered", or "knocked out by <name>". */
  ended: string;
}

export interface ZergReport {
  zergs: number;
  attacks: { onPrey: number; onZergs: number; onNeutral: number };
  /** Must be 0: Zerg-on-Zerg attacks while a non-Zerg was alive. */
  zergOnZergWhilePreyAlive: ZergOnZerg[];
  destroyed: { prey: number; zergs: number; neutral: number };
  lost: number;
  /** Armies destroyed ÷ armies lost (null before any loss). */
  tradeRatio: number | null;
  conquests: { fromPrey: number; fromZergs: number; fromNeutral: number };
  knockouts: { bySwarm: number; ofSwarm: number };
  surrenders: { midGame: number; endgame: number; list: ZergSurrender[] };
  /** Alarm 2 count, the same as surrenders.midGame. */
  alarms: { zergOnZerg: number; midGameSurrenders: number };
  seats: SeatLine[];
}

/** Walks a game's moves in order. `add` one step at a time (a live room), or feed them all and read `report()`. */
export class ZergTally {
  private alive = new Set<PlayerId>();
  private neutral = new Set<PlayerId>();
  private names = new Map<PlayerId, string>();
  private lastTerritories = new Map<PlayerId, number>();
  private seats = new Map<PlayerId, SeatLine>();
  private winner: PlayerId | null = null;
  private step = 0;
  private r: Omit<ZergReport, 'tradeRatio' | 'alarms' | 'seats' | 'zergs'> = {
    attacks: { onPrey: 0, onZergs: 0, onNeutral: 0 },
    zergOnZergWhilePreyAlive: [],
    destroyed: { prey: 0, zergs: 0, neutral: 0 },
    lost: 0,
    conquests: { fromPrey: 0, fromZergs: 0, fromNeutral: 0 },
    knockouts: { bySwarm: 0, ofSwarm: 0 },
    surrenders: { midGame: 0, endgame: 0, list: [] },
  };

  constructor(players: readonly ReportPlayer[]) {
    for (const p of players) {
      this.names.set(p.id, p.name);
      if (p.isNeutral) {
        this.neutral.add(p.id);
        continue;
      }
      this.alive.add(p.id);
      this.seats.set(p.id, { id: p.id, name: p.name, zerg: isZergSeat(p.id), turns: 0, attacks: 0, rolls: 0, destroyed: 0, lost: 0, conquests: 0, knockouts: 0, peakTerritories: 0, ended: 'alive' });
    }
  }

  /** Any non-neutral, non-Zerg player still alive: the swarm's alliance holds while there is prey. */
  private preyAlive(except?: PlayerId): boolean {
    for (const p of this.alive) if (p !== except && !isZergSeat(p)) return true;
    return false;
  }

  private kind(p: PlayerId): 'prey' | 'zergs' | 'neutral' {
    return this.neutral.has(p) ? 'neutral' : isZergSeat(p) ? 'zergs' : 'prey';
  }

  add(s: ReportStep) {
    const i = this.step++;
    const me = s.player;
    const seat = me ? this.seats.get(me) : undefined;
    if (s.action.type === 'attack' && me) {
      if (seat) seat.attacks++;
      const first = s.events.find((e) => e.type === 'battle');
      if (first && first.type === 'battle' && isZergSeat(me)) {
        const k = this.kind(first.defender);
        if (k === 'neutral') this.r.attacks.onNeutral++;
        else if (k === 'zergs') {
          this.r.attacks.onZergs++;
          if (this.preyAlive()) this.r.zergOnZergWhilePreyAlive.push({ step: i, attacker: this.names.get(me) ?? me, defender: this.names.get(first.defender) ?? first.defender });
        } else this.r.attacks.onPrey++;
      }
    }
    if (s.action.type === 'surrender' && me && isZergSeat(me) && this.alive.has(me)) {
      const midGame = this.preyAlive(me);
      this.r.surrenders.list.push({ step: i, player: this.names.get(me) ?? me, midGame, landLeft: this.lastTerritories.get(me) ?? 0 });
      if (midGame) this.r.surrenders.midGame++;
      else this.r.surrenders.endgame++;
    }
    for (const e of s.events) {
      if (e.type === 'turn_started') {
        const st = this.seats.get(e.player);
        const held = e.reinforcements?.territories ?? 0;
        this.lastTerritories.set(e.player, held);
        if (st) (st.turns++, (st.peakTerritories = Math.max(st.peakTerritories, held)));
      } else if (e.type === 'battle') {
        const a = this.seats.get(e.attacker);
        const d = this.seats.get(e.defender);
        if (a) (a.rolls++, (a.destroyed += e.defenderLosses), (a.lost += e.attackerLosses));
        if (d) (d.destroyed += e.attackerLosses), (d.lost += e.defenderLosses);
        if (isZergSeat(e.attacker)) {
          this.r.destroyed[this.kind(e.defender)] += e.defenderLosses;
          this.r.lost += e.attackerLosses;
        }
        if (isZergSeat(e.defender)) {
          this.r.lost += e.defenderLosses;
          if (!isZergSeat(e.attacker)) this.r.destroyed[this.kind(e.attacker)] += e.attackerLosses;
        }
      } else if (e.type === 'conquered') {
        const st = this.seats.get(e.player);
        if (st) st.conquests++;
        if (isZergSeat(e.player)) {
          const k = this.kind(e.previousOwner);
          if (k === 'prey') this.r.conquests.fromPrey++;
          else if (k === 'zergs') this.r.conquests.fromZergs++;
          else this.r.conquests.fromNeutral++;
        }
      } else if (e.type === 'eliminated') {
        this.alive.delete(e.player);
        const st = this.seats.get(e.player);
        if (e.by && isZergSeat(e.by) && !this.neutral.has(e.player)) this.r.knockouts.bySwarm++;
        if (isZergSeat(e.player)) this.r.knockouts.ofSwarm++;
        if (e.by) {
          const k = this.seats.get(e.by);
          if (k) k.knockouts++;
        }
        if (st) st.ended = e.by ? `knocked out by ${this.names.get(e.by) ?? e.by}` : 'surrendered';
      } else if (e.type === 'game_over') {
        this.winner = e.winner;
      }
    }
  }

  report(): ZergReport {
    const seats = [...this.seats.values()].map((s) => (s.id === this.winner ? { ...s, ended: 'won' } : { ...s }));
    const destroyed = this.r.destroyed.prey + this.r.destroyed.zergs + this.r.destroyed.neutral;
    return {
      zergs: seats.filter((s) => s.zerg).length,
      ...structuredClone(this.r),
      tradeRatio: this.r.lost > 0 ? Math.round((destroyed / this.r.lost) * 100) / 100 : null,
      alarms: { zergOnZerg: this.r.zergOnZergWhilePreyAlive.length, midGameSurrenders: this.r.surrenders.midGame },
      seats,
    };
  }
}

/** The report for a whole game at once. */
export function zergReport(steps: readonly ReportStep[], players: readonly ReportPlayer[]): ZergReport {
  const t = new ZergTally(players);
  for (const s of steps) t.add(s);
  return t.report();
}

/** Sum several games' reports into one (lists and seats are left out; the alarms keep their counts). */
export function sumReports(reports: readonly ZergReport[]): Omit<ZergReport, 'seats' | 'zergOnZergWhilePreyAlive' | 'surrenders'> & {
  games: number;
  surrenders: { midGame: number; endgame: number; landLeft: number };
} {
  const out = {
    games: reports.length,
    zergs: 0,
    attacks: { onPrey: 0, onZergs: 0, onNeutral: 0 },
    destroyed: { prey: 0, zergs: 0, neutral: 0 },
    lost: 0,
    tradeRatio: null as number | null,
    conquests: { fromPrey: 0, fromZergs: 0, fromNeutral: 0 },
    knockouts: { bySwarm: 0, ofSwarm: 0 },
    surrenders: { midGame: 0, endgame: 0, landLeft: 0 },
    alarms: { zergOnZerg: 0, midGameSurrenders: 0 },
  };
  for (const r of reports) {
    out.zergs += r.zergs;
    for (const k of ['onPrey', 'onZergs', 'onNeutral'] as const) out.attacks[k] += r.attacks[k];
    for (const k of ['prey', 'zergs', 'neutral'] as const) out.destroyed[k] += r.destroyed[k];
    out.lost += r.lost;
    for (const k of ['fromPrey', 'fromZergs', 'fromNeutral'] as const) out.conquests[k] += r.conquests[k];
    out.knockouts.bySwarm += r.knockouts.bySwarm;
    out.knockouts.ofSwarm += r.knockouts.ofSwarm;
    out.surrenders.midGame += r.surrenders.midGame;
    out.surrenders.endgame += r.surrenders.endgame;
    out.surrenders.landLeft += r.surrenders.list.reduce((n, s) => n + s.landLeft, 0);
    out.alarms.zergOnZerg += r.alarms.zergOnZerg;
    out.alarms.midGameSurrenders += r.alarms.midGameSurrenders;
  }
  const destroyed = out.destroyed.prey + out.destroyed.zergs + out.destroyed.neutral;
  out.tradeRatio = out.lost > 0 ? Math.round((destroyed / out.lost) * 100) / 100 : null;
  return out;
}
