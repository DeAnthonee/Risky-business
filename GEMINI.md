# Gemini instructions

This project's instructions for AI coding agents live in two files. Read both in full before you change anything:

1. `README.md`, section **"For AI coding agents: read this first"**: it lists every context file and doc
   in this repo (CONTRIBUTING.md, docs/hardening.md, AI/README.md, the package READMEs, the PR template, CI).
   Read all of them.
2. `CLAUDE.md`: the condensed project reference (commands, branch rule, hosting invariants, conventions).
   It is written for Claude Code but applies to every agent.

Also read every other agent file in the repo (AGENTS.md, GEMINI.md, .github/copilot-instructions.md,
.cursor/rules/, .windsurf/rules/, .clinerules, .claude/), whichever tool it was written for.

Never push to the deploy branch `ccr-63b8112a-e2uk2g`. Work on a feature branch, open a PR and keep `npm test` green.

Keep this file a pointer: put new instructions in CLAUDE.md or the docs, not here, so the agent files never drift apart.
