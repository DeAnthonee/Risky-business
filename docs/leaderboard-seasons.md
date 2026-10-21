# Leaderboard seasons: archiving and viewing past boards

How to wipe the live leaderboard without losing it, and how to read old seasons. Anyone can follow this; nothing here
touches Delove's training setup. The scoring itself and the league are in [character-league.md](character-league.md).

## What a season is

The server keeps the live board in `$RISK_DATA_DIR/rankings.json` and the season number in `rankings.json.season`.
Starting a new season **archives** the board: it is moved to `rankings.season-<N>.json` beside it, and the new season
starts with no games. Archives are never deleted or overwritten; a second archive of the same season number becomes
`rankings.season-<N>-2.json`. A game counts in exactly one season, never again in a later one.

| season | ran | archive |
| --- | --- | --- |
| 1 | everything before the first wipe, including the Gen 5 seed (#92) | `rankings.season-1.json` |
| 2 | #107 to #119 | `rankings.season-2.json` |
| 3 | #119 to #135 | `rankings.season-3.json` |
| 4 | since #135 | live |

## Archive the board now (recommended): one admin call

No code change, no PR, no deploy. You need the server's admin token (`RISK_ADMIN_TOKEN`):

```bash
curl -X POST -H "Authorization: Bearer $RISK_ADMIN_TOKEN" https://risky.deanthoneeking.com/api/admin/rankings/new-season
```

- Reply `{"archived": N, "season": N+1}`: done, the board is empty and season N is readable.
- `401`: wrong token. `404`: the server has no admin token configured.
- `500`: the archive could not be written (see the server log). Nothing changed; it is safe to retry.

It is safe while games are running: a game finishing at the same moment lands wholly in the old season or the new one.

## Archive on a deploy: bump `RANKINGS_SEASON`

When you have no admin token, or want the wipe tied to a release: in a PR, raise `RANKINGS_SEASON` in
`packages/server/src/rankings.ts` by one, add a row to the table above, and say plainly in the PR that merging wipes
production's board. The first start after the deploy archives the board the same way (if the move fails, it is
retried on the next start). Both ways run the same code (`Rankings.archiveTo`).

**How the two interact:** the season in force is the **higher** of `RANKINGS_SEASON` and the saved season. After admin
calls have moved the saved season past the constant, a deploy changes nothing until the constant is bumped above the
saved number. Check the current season first (`GET /api/rankings/seasons`, field `current`) and set the constant to
`current + 1`.

## View past seasons

- Web: the season picker above the leaderboard (shown once an archive exists; current season by default). Profiles
  opened from an old season show that season's numbers.
- HTTP: `GET /api/rankings/seasons` lists `{id, season, current, games}`, current first, then archives newest first;
  `GET /api/rankings?season=<id>` and `GET /api/rankings/profile?key=<key>&season=<id>` read one. Details in
  [http-api.md](http-api.md).
- MCP: the `leaderboard` tool takes an optional `season` and lists the seasons in its reply.

## What NOT to touch

Wiping or archiving the board never needs a change outside `packages/server`. In particular, **do not edit
`packages/engine/src/ranking.ts`** (the points formula) **or any file listed in `RULE_FILES`** in
`packages/delove-gpu/delove_gpu/fingerprint.py`. Delove's GPU training mirror copies those files; changing any of them
voids the mirror's verified fingerprint and forces an hour-long GPU re-verification on the training PC (README hard
rule 8). Season storage lives only in `packages/server/src/rankings.ts`, which is not mirrored. Before opening a PR,
`python packages/delove-gpu/delove_gpu/fingerprint.py check` should still say the mirror is verified.

Also: never delete or edit the `rankings.season-*.json` archives or the `.season` file by hand on the host, and never
reset the board by deleting `rankings.json`. Use the route or the bump above.
