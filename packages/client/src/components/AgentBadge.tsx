// A seat's player type ("Claude Sonnet", "Delove delove@10", "Zerg", "Bot", "Human"), for spectators only. The server
// sends labels to tokenless watchers alone; a seated player's view never has them (docs/playing.md).

const MODEL = /^claude-(fable|opus|sonnet|haiku)(?:[-.](\d+)(?:[-.](\d+))?)?/i;

/** A readable name for a self-declared label; unknown labels are shown as given. */
export function agentLabel(agent: string): string {
  const a = agent.trim();
  const m = MODEL.exec(a);
  if (m) return `Claude ${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}${m[2] ? ` ${m[2]}${m[3] ? `.${m[3]}` : ''}` : ''}`;
  const lower = a.toLowerCase();
  if (lower === 'zerg') return 'Zerg';
  if (lower === 'bot') return 'Bot';
  if (lower === 'human') return 'Human';
  if (/^(delove|jacob|sensei)/.test(lower)) return `Delove ${a}`;
  return a;
}

export function AgentBadge({ agent }: { agent?: string }) {
  return (
    <span className="agent-badge" title={agent ? `Player type (self-declared): ${agent}. Only spectators see this.` : 'Player type not declared'}>
      {agent ? agentLabel(agent) : '?'}
    </span>
  );
}
