import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Imported first by seat-cli.ts, before branch.ts reads DELOVE_BRANCH_TRACE at load: when decision notes are on (no
 * --no-notes) and nobody set a trace file, each process gets its own (branch and score appends one line per compared
 * decision; notes.ts reads it back after each move and keeps it small). A trace file someone set is only read.
 */
if (!process.argv.includes('--no-notes') && (!process.env.DELOVE_BRANCH_TRACE || process.env.DELOVE_NOTES_TRACE_OWNED)) {
  process.env.DELOVE_BRANCH_TRACE = join(tmpdir(), `delove-notes-trace-${process.pid}.jsonl`);
  process.env.DELOVE_NOTES_TRACE_OWNED = '1';
}
