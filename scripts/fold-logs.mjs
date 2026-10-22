#!/usr/bin/env node
// Folds the per-PR log fragments in docs/logs/pending/ into the running logs in docs/logs/.
//
// Every PR writes its log lines to its own file, docs/logs/pending/<branch-name>.md, so two PRs never edit the same
// file and the logs stop conflicting. Each line of a fragment reads
//
//   <area>: - YYYY-MM-DD #123 what changed
//
// where <area> is a log's base name (engine, server, client, ...). Blank lines are ignored. The reviewer runs the fold
// in a periodic docs PR: each line moves to its area log (under the header, newest first) and the fragment is deleted.
//
//   node scripts/fold-logs.mjs            fold every fragment (npm run logs:fold)
//   node scripts/fold-logs.mjs --check    validate the fragments only, write nothing (npm run logs:check, in npm test)
//   node scripts/fold-logs.mjs --dry-run  show what the fold would do, write nothing
//   --logs-dir <dir>                      another logs folder (tests); its fragments are in <dir>/pending
//   --no-git                              never look up a missing PR number in git
//
// A line still reading `#PR` gets its number from git when it can: the first "Merge pull request #N from ..." merge
// (or a squash commit ending in "(#N)") that brought the commit adding the fragment into HEAD. --check accepts `#PR`
// with a notice (the number does not exist until the PR is opened); the fold errors if git cannot supply it.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LINE = /^([a-z][a-z0-9-]*):\s+- (\d{4}-\d{2}-\d{2}) #(PR|\d+) (\S.*)$/;
const ENTRY = /^- (\d{4}-\d{2}-\d{2}) /;

/** The areas: the base names of the logs in `logsDir`. */
export function areasIn(logsDir) {
  return readdirSync(logsDir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
}

/** The fragment files in `<logsDir>/pending` (README.md excluded). */
export function fragmentFiles(logsDir) {
  const dir = join(logsDir, "pending");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md").sort().map((f) => join(dir, f));
}

/**
 * Parses one fragment's text. Returns `{ entries, errors }`: each entry is `{ area, date, pr, text, lineNo }` with
 * `pr` a number or `null` for `#PR`; each error a message naming the line.
 */
export function parseFragment(text, areas, name = "fragment") {
  const entries = [];
  const errors = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const where = `${name}:${i + 1}`;
    const m = LINE.exec(line);
    if (!m) {
      errors.push(`${where}: malformed line (want "<area>: - YYYY-MM-DD #123 what changed"): ${line}`);
      return;
    }
    const [, area, date, pr, what] = m;
    if (!areas.includes(area)) {
      errors.push(`${where}: unknown area "${area}" (one of: ${areas.join(", ")})`);
      return;
    }
    if (Number.isNaN(Date.parse(date))) {
      errors.push(`${where}: bad date ${date}`);
      return;
    }
    entries.push({ area, date, pr: pr === "PR" ? null : Number(pr), text: what, lineNo: i + 1 });
  });
  if (!entries.length && !errors.length) errors.push(`${name}: empty fragment`);
  return { entries, errors };
}

/** The log line an entry becomes. */
export function logLine(e) {
  return `- ${e.date} #${e.pr} ${e.text}`;
}

/**
 * Inserts entries into a log's text: under the header, before the first entry of the same date or older, so the log
 * stays newest first. Entries are inserted oldest (then lowest PR) first, so the newest lands on top.
 */
export function insertEntries(logText, entries) {
  const eol = logText.includes("\r\n") ? "\r\n" : "\n";
  const lines = logText.split(/\r?\n/);
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date) || a.pr - b.pr);
  for (const e of sorted) {
    let at = lines.findIndex((l) => {
      const m = ENTRY.exec(l);
      return m && m[1] <= e.date;
    });
    if (at < 0) {
      // Older than every entry (or no entries yet): after the last entry, else after the header.
      let last = -1;
      lines.forEach((l, i) => { if (ENTRY.test(l)) last = i; });
      if (last >= 0) at = last + 1;
      else {
        while (lines.length && lines[lines.length - 1] === "") lines.pop();
        lines.push("");
        at = lines.length;
        lines.push("");
      }
    }
    lines.splice(at, 0, logLine(e));
  }
  return lines.join(eol);
}

function git(args) {
  return execFileSync("git", args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** The PR number that merged `file` into HEAD, from git history, or null. */
export function prFromGit(file) {
  try {
    const path = relative(REPO, file).split("\\").join("/");
    const added = git(["log", "--diff-filter=A", "--format=%H", "-1", "--", path]);
    if (!added) return null;
    const merges = git(["log", "--merges", "--ancestry-path", "--reverse", "--format=%s", `${added}..HEAD`]);
    for (const subject of merges.split("\n")) {
      const m = /^Merge pull request #(\d+) from /.exec(subject);
      if (m) return Number(m[1]);
    }
    const squash = /\(#(\d+)\)$/.exec(git(["log", "-1", "--format=%s", added]));
    return squash ? Number(squash[1]) : null;
  } catch {
    return null;
  }
}

function main(argv) {
  const opt = { check: false, dryRun: false, git: true, logsDir: join(REPO, "docs", "logs") };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") opt.check = true;
    else if (a === "--dry-run") opt.dryRun = true;
    else if (a === "--no-git") opt.git = false;
    else if (a === "--logs-dir") opt.logsDir = resolve(argv[++i]);
    else {
      console.error(`fold-logs: unknown argument ${a}`);
      return 2;
    }
  }
  const areas = areasIn(opt.logsDir);
  const files = fragmentFiles(opt.logsDir);
  const errors = [];
  const byArea = new Map();
  for (const file of files) {
    const name = relative(REPO, file).split("\\").join("/");
    const { entries, errors: errs } = parseFragment(readFileSync(file, "utf8"), areas, name);
    errors.push(...errs);
    for (const e of entries) {
      if (e.pr === null && !opt.check) {
        e.pr = opt.git ? prFromGit(file) : null;
        if (e.pr === null) {
          errors.push(`${name}:${e.lineNo}: still reads #PR and git has no merge commit for it; fill in the PR number`);
          continue;
        }
        console.log(`${name}:${e.lineNo}: #PR filled from git as #${e.pr}`);
      } else if (e.pr === null) {
        console.log(`${name}:${e.lineNo}: notice: still reads #PR (fill it in once the PR is open)`);
      }
      if (!byArea.has(e.area)) byArea.set(e.area, []);
      byArea.get(e.area).push(e);
    }
  }
  if (errors.length) {
    for (const e of errors) console.error(`fold-logs: ${e}`);
    console.error(`fold-logs: ${errors.length} error(s); nothing written`);
    return 1;
  }
  const count = [...byArea.values()].reduce((n, l) => n + l.length, 0);
  if (opt.check) {
    console.log(`fold-logs: ${files.length} fragment(s), ${count} line(s), all valid`);
    return 0;
  }
  for (const [area, entries] of byArea) {
    const log = join(opt.logsDir, `${area}.md`);
    const next = insertEntries(readFileSync(log, "utf8"), entries);
    if (opt.dryRun) entries.forEach((e) => console.log(`${area}.md <- ${logLine(e)}`));
    else writeFileSync(log, next);
  }
  if (!opt.dryRun) for (const f of files) unlinkSync(f);
  console.log(`fold-logs: ${opt.dryRun ? "would fold" : "folded"} ${count} line(s) from ${files.length} fragment(s)`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
