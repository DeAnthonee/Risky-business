## What

<!-- One or two sentences: what changes for players / agents / hosts. -->

## Why

<!-- The problem or request this solves. Link the issue if there is one. -->

## How it was verified

- [ ] `npm test` is green (typecheck + engine + server tests)
- [ ] `npm run build` succeeds
- [ ] Engine test added for any rules change
- [ ] Server test added for any API/MCP change
- [ ] Tried it in the browser against bots (if it touches the client)

## Checklist

- [ ] No direct push to the deploy branch; this PR targets `ccr-63b8112a-e2uk2g`
- [ ] Hosting invariants kept (see CONTRIBUTING.md §4)
- [ ] Docs updated (README / CLAUDE.md / rules text) if behaviour changed
