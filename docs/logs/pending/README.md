# Pending log lines

Each PR writes its running-log lines here, in its own new file named after its branch with `/` turned into `-`
(branch `feat/fog-totals` → `feat-fog-totals.md`), instead of editing the logs in `docs/logs/` directly. Two PRs never
touch the same file, so the logs stop conflicting (README hard rule 12).

One line per log entry, the area first (a log's base name: engine, maps, server, mcp, client, hosting, characters,
runner, selfplay, delove, delove-gpu, docs):

```
server: - 2026-10-21 #123 what changed
docs: - 2026-10-21 #123 what changed
```

Write `#PR` until the PR is open, then fill in the number on the branch. `npm test` checks every fragment
(`npm run logs:check`: format and area; `#PR` only gets a notice). A reviewer folds them into the logs in a periodic
docs PR with `npm run logs:fold`, which moves each line to the top of its log (newest first) and deletes the fragment;
a line still reading `#PR` then gets its number from the merge commit, or the fold stops and says so.
