import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerAgent } from '@risk/selfplay';
import { discoverNetAgents, modelsDir } from './net-agent.js';
import { makeTeacher, teacher } from './teacher.js';

/**
 * Loaded with `node --import` in front of the self-play CLI (`npm run delove -- ...`), so Delove's players can be
 * named in `play` and `ladder` without the self-play package knowing about them: the teacher, every tuned teacher
 * (models/delove/delove-teacher@N.json) and every trained version in models/delove (or DELOVE_MODELS). Models load
 * lazily, on a version's first decision.
 */
registerAgent(teacher);
// Tuned teachers: models/delove/delove-teacher@N.json holds that version's judgement numbers (src/tune.ts).
const dir = modelsDir();
if (existsSync(dir)) {
  for (const f of readdirSync(dir).filter((f) => /^delove-teacher@\d+\.json$/.test(f)).sort()) {
    registerAgent(makeTeacher(f.replace(/\.json$/, ''), JSON.parse(readFileSync(join(dir, f), 'utf8'))));
  }
}
for (const agent of discoverNetAgents()) registerAgent(agent);
