// Tests for scripts/fold-logs.mjs: run with `node --test scripts/` (part of `npm test` as `npm run logs:test`).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { insertEntries, parseFragment } from "./fold-logs.mjs";

const SCRIPT = fileURLToPath(new URL("./fold-logs.mjs", import.meta.url));
const HEADER = "# Engine: running log\n\nNewest first, one line per change: `- YYYY-MM-DD #PR what changed`.\n\n";

function run(args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", stdio: "pipe" }) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  }
}

function sandbox(logs, fragments) {
  const dir = mkdtempSync(join(tmpdir(), "fold-logs-"));
  mkdirSync(join(dir, "pending"));
  for (const [name, text] of Object.entries(logs)) writeFileSync(join(dir, `${name}.md`), text);
  for (const [name, text] of Object.entries(fragments)) writeFileSync(join(dir, "pending", name), text);
  writeFileSync(join(dir, "pending", "README.md"), "# not a fragment\n");
  return dir;
}

test("parseFragment accepts good lines and names each bad one", () => {
  const areas = ["engine", "server"];
  const ok = parseFragment("engine: - 2026-10-21 #12 a rule\n\nserver: - 2026-10-21 #PR a route\n", areas);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.entries.map((e) => [e.area, e.pr, e.text]), [["engine", 12, "a rule"], ["server", null, "a route"]]);

  const bad = parseFragment("client: - 2026-10-21 #3 x\nengine - 2026-10-21 #3 x\nengine: - 21-10-2026 #3 x\n", areas, "f.md");
  assert.equal(bad.errors.length, 3);
  assert.match(bad.errors[0], /f\.md:1: unknown area "client"/);
  assert.match(bad.errors[1], /f\.md:2: malformed/);
  assert.match(bad.errors[2], /f\.md:3: malformed/);
  assert.match(parseFragment("\n", areas, "e.md").errors[0], /empty fragment/);
});

test("insertEntries keeps the log newest first under the header", () => {
  const log = `${HEADER}- 2026-10-21 #5 five\n- 2026-10-19 #2 two\n`;
  const out = insertEntries(log, [
    { date: "2026-10-20", pr: 3, text: "three" },
    { date: "2026-10-22", pr: 7, text: "seven" },
    { date: "2026-10-21", pr: 6, text: "six" },
    { date: "2026-10-18", pr: 1, text: "one" },
  ]);
  assert.equal(out, `${HEADER}- 2026-10-22 #7 seven\n- 2026-10-21 #6 six\n- 2026-10-21 #5 five\n- 2026-10-20 #3 three\n- 2026-10-19 #2 two\n- 2026-10-18 #1 one\n`);
  assert.equal(insertEntries("# Log\n\nheader text\n", [{ date: "2026-10-21", pr: 1, text: "first" }]), "# Log\n\nheader text\n\n- 2026-10-21 #1 first\n");
});

test("the fold moves every fragment line into its log and deletes the fragments", () => {
  const dir = sandbox(
    { engine: `${HEADER}- 2026-10-20 #1 old\n`, server: `${HEADER}- 2026-10-20 #1 old\n` },
    {
      "feat-a.md": "engine: - 2026-10-21 #10 rule a\nserver: - 2026-10-21 #10 route a\n",
      "feat-b.md": "engine: - 2026-10-21 #11 rule b\n",
    },
  );
  assert.equal(run(["--check", "--logs-dir", dir]).code, 0);
  const dry = run(["--dry-run", "--logs-dir", dir]);
  assert.equal(dry.code, 0);
  assert.equal(readdirSync(join(dir, "pending")).length, 3, "dry run writes nothing");

  const r = run(["--logs-dir", dir]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /folded 3 line\(s\) from 2 fragment\(s\)/);
  assert.equal(readFileSync(join(dir, "engine.md"), "utf8"), `${HEADER}- 2026-10-21 #11 rule b\n- 2026-10-21 #10 rule a\n- 2026-10-20 #1 old\n`);
  assert.equal(readFileSync(join(dir, "server.md"), "utf8"), `${HEADER}- 2026-10-21 #10 route a\n- 2026-10-20 #1 old\n`);
  assert.deepEqual(readdirSync(join(dir, "pending")), ["README.md"]);
});

test("#PR passes --check with a notice but stops the fold when git cannot fill it", () => {
  const dir = sandbox({ engine: HEADER }, { "feat-c.md": "engine: - 2026-10-21 #PR rule c\n" });
  const check = run(["--check", "--logs-dir", dir]);
  assert.equal(check.code, 0);
  assert.match(check.out, /still reads #PR/);
  const fold = run(["--no-git", "--logs-dir", dir]);
  assert.equal(fold.code, 1);
  assert.match(fold.out, /feat-c\.md:1: still reads #PR/);
  assert.equal(readFileSync(join(dir, "engine.md"), "utf8"), HEADER, "nothing written on error");
});

test("a bad fragment fails --check and the fold writes nothing", () => {
  const dir = sandbox({ engine: HEADER }, { "ok.md": "engine: - 2026-10-21 #1 fine\n", "bad.md": "engin: - 2026-10-21 #2 typo\n" });
  const r = run(["--check", "--logs-dir", dir]);
  assert.equal(r.code, 1);
  assert.match(r.out, /unknown area "engin"/);
  assert.equal(run(["--logs-dir", dir]).code, 1);
  assert.equal(readFileSync(join(dir, "engine.md"), "utf8"), HEADER);
});
