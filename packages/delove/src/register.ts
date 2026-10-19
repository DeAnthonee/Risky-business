import { registerAgent } from '@risk/selfplay';
import { discoverNetAgents } from './net-agent.js';
import { teacher } from './teacher.js';

/**
 * Loaded with `node --import` in front of the self-play CLI (`npm run delove -- ...`), so Delove's players can be
 * named in `play` and `ladder` without the self-play package knowing about them: the teacher, and every trained
 * version in models/delove (or DELOVE_MODELS). Models load lazily, on a version's first decision.
 */
registerAgent(teacher);
for (const agent of discoverNetAgents()) registerAgent(agent);
