import { registerAgent } from '@risk/selfplay';
import { teacher } from './teacher.js';

/**
 * Loaded with `node --import` in front of the self-play CLI (`npm run delove -- ...`), so Delove's players can be
 * named in `play` and `ladder` without the self-play package knowing about them.
 */
registerAgent(teacher);
