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
- [ ] Hard rules kept (README.md "Hard rules", including the hosting invariants)
- [ ] The area's doc (README table of contents) and rules text updated if behaviour changed
- [ ] A line appended to the area's running log in `docs/logs/`

## New map (only for a PR that adds or reworks a board)

- [ ] Design approved by the owner before registration (link the issue or message)
- [ ] `npm run build:map -- <id>` prints no warnings; every region has 2-3 (small) or 3-5 (big) entry territories
- [ ] Every item of the registration checklist in `docs/map-making.md` section 5, with a chokepoint test
- [ ] `npm run maps:status` lists the map as offered, in RULE_FILES and the matrix (GPU-verified comes later, in its own PR)
