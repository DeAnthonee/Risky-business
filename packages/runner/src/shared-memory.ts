import { appendFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Cross-process lock around the whole read/model/write transaction. Never expire a live curator's lock. */
export async function withLearningLock<T>(dir: string, run: () => Promise<T>): Promise<T> {
  await mkdir(dir, { recursive: true });
  const lock = path.join(dir, '.learning.lock');
  for (;;) {
    try {
      await mkdir(lock);
      await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let dead = false;
      try {
        const { pid } = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8'));
        try { process.kill(pid, 0); } catch (e) { dead = (e as NodeJS.ErrnoException).code === 'ESRCH'; }
      } catch {
        try { dead = Date.now() - (await stat(lock)).mtimeMs > 30_000; } catch { /* lock just released */ }
      }
      if (dead) {
        // A separate recovery mutex prevents two stale-lock reclaimers deleting a new live lock.
        const recovery = path.join(dir, '.learning.recovery');
        let recovering = false;
        try {
          await mkdir(recovery); recovering = true;
          let stillDead = false;
          try {
            const owner = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8'));
            try { process.kill(owner.pid, 0); } catch (e) { stillDead = (e as NodeJS.ErrnoException).code === 'ESRCH'; }
          } catch (e) {
            // A crash between mkdir and writing owner.json leaves an ownerless lock.
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') stillDead = Date.now() - (await stat(lock)).mtimeMs > 30_000;
            else throw e;
          }
          if (stillDead) await rm(lock, { recursive: true, force: true });
        } catch (e) { if (!['EEXIST','ENOENT'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; }
        finally { if (recovering) await rm(recovery, { recursive: true, force: true }); }
      }
      await new Promise(r => setTimeout(r, 100));
    }
  }
  try { return await run(); }
  finally { await rm(lock, { recursive: true, force: true }); }
}

function memoryPath(dir: string, id: string): string {
  if (!/^[a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*$/.test(id)) throw new Error('Invalid character id');
  return path.join(dir, 'characters', id, 'memory.md');
}
export async function readPersonalityMemory(dir: string, id: string): Promise<string> {
  try { return (await readFile(memoryPath(dir, id), 'utf8')).slice(-6000); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''; throw error; }
}
/** Called under withLearningLock; persona seeds remain untouched. */
export async function addPersonalityMemory(dir: string, id: string, gameId: string, note: string): Promise<void> {
  const file = memoryPath(dir, id);
  await mkdir(path.dirname(file), { recursive: true });
  let old = '';
  try { old = await readFile(file, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  if (old.includes(`<!-- game:${gameId} -->`)) return;
  await appendFile(file, `\n<!-- game:${gameId} -->\n## Game ${gameId}\n${note.slice(0, 6000)}\n`);
}
