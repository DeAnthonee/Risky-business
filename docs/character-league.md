# Character league, profiles and rankings

Click a player name in the lobby or the live game's player list to open their profile. The profile shows
wins, losses, win percentage, average placement, points and leaderboard rank. Close it with the Close
button, Escape or the backdrop; watching and the game's connection continue underneath. Home shows
the full leaderboard and refreshes it every 15 seconds. Profile details are fetched when opened.

## Placement points

Everyone starts at **0 points**. Scores never go below zero, including after a loss. Apply each completed
game's points to the previous total, flooring at zero after that game. This is a placement ladder, not Elo.

| Lobby size | Points from first to last |
| --- | --- |
| 5 | +2, +1, 0, -1, -2 |
| 6 | +3, +2, +1, -1, -2, -3 |
| 7 | +3, +2, +1, 0, -1, -2, -3 |
| 8 | +4, +3, +2, +1, -1, -2, -3, -4 |
| 9 | +4, +3, +2, +1, 0, -1, -2, -3, -4 |
| 10 | +5, +4, +3, +2, +1, -1, -2, -3, -4, -5 |

Rank sorts by points, then wins, then lower average placement, then stable identity key. Only the game's
winner gets a win; other participants get a loss even if still alive at a capital victory. Neutral armies never
participate in rankings. The winner places first. Other survivors rank by territories, then armies, then turn
order; eliminated players rank by reverse elimination order. Games without a winner are not counted.
Positive placements can gain points without a win. Flooring means the ladder as a whole is not zero-sum.

The server records outcomes directly from finished room states. Its independent rankings.json is stored
beside games.json under RISK_DATA_DIR, survives room deletion/restarts, and ignores already recorded game
IDs. Multiple lobbies share this single server writer. A corrupt rankings file does not stop the server:
it is moved aside to rankings.json.corrupt (and logged) and the ladder starts empty, so restore it from a
backup. A failed save is logged without failing the move that ended the game. Back up RISK_DATA_DIR with
normal server backups.

Character identity is selected in the lobby using POST /api/games/:id/character with the seat's Bearer token
and {"characterId":"league/shen"}, plus the characters write key in the x-characters-key header (the same
key as character saves: RISK_CHARACTERS_KEY or the admin token), since it credits the character on the
public leaderboard. The profile must exist on the server. One identity per table, multiple tables per
identity. The runner does this when given --characters-key; without it seats play unranked by name. MCP exposes select_character, leaderboard and
ranked_profile. Plain seats aggregate by normalized display name (built-in bots have a separate prefix);
these are self-declared identities, not authenticated user accounts.

GET /api/rankings returns the ordered standings. GET /api/rankings/profile?key=league%2Fshen returns a
ranking/profile pair. GET /api/games/:id/players/:player/profile resolves a live seat to that same record.
An unplayed profile is unranked with zero games and points. Existing snapshots remain readable; old finished
rooms can be backfilled on startup, but records for deleted historical rooms cannot be reconstructed.
Historical runner results stay local and are not silently imported into the public server leaderboard.

## Persistent personality and relationships

Use one runner process with --lobbies 2 and --games 0 for two concurrent tables and a shared Ollama queue.
All lobbies use the same learnings directory. Per-game plans, chat and alliances remain separate. A character
loads a fresh snapshot of its base personality, personal lessons, evolving playstyle and relationship history
before each game. It also receives the shared leaderboard: its own wins/losses, win percentage, points/rank,
and the other characters above and below it. On older servers, the runner uses its local results ledger.

Each character remembers accepted deal outcomes, who broke an agreement, games together, wins/losses
against each opponent, and higher/lower placements. Observed opponent breaches lower rapport by 25;
agreements completed without an observed breach add 8. Rapport stays within -100..100. No forced grudge,
alliance or retaliation is imposed: these memories inform the personality's choices. Model reflections can
evolve personal tactics and form or reconsider impressions of an opponent's playstyle, explicitly labeled as
subjective. They cannot invent factual betrayal incidents or change rapport. A failed reflection keeps prior
style and saves the observed facts. Base personality files are never rewritten by the learning loop.

Under --learnings-dir, characters/<universe>/<name>/memory.md stores per-game notes; experience.json
stores the evolving style, relationship histories and processed game IDs. The last 6,000 characters of
personal notes and bounded recent relationship details enter prompts. Global advice remains in the protected
bot section of RISK_LEARNINGS.md. A cross-process lock serializes each complete post-game transaction;
live owners never expire simply because the local model takes a long time. Use a local disk and one host
for this shared directory. Separate runner processes have separate Ollama queues; prefer --lobbies.

The UI also draws each bonus outline above territory fills, clipped inside that region. Inland borders
between bonuses remain visible in region colors, with a dark separator, regardless of territory ownership.

## Private tactical memory within each game

Each seat keeps its own event ledger for this game only, available to both commander and diplomat. It
records observed attack attempts (including failed attacks), casualties, captured territories and the first
conquest breaking a held bonus. Event versions deduplicate replayed polls; recapturing land does not erase
attack totals. Events carry their actual round when a turn marker is available, otherwise the memory says
"observed by round N" rather than inventing an exact attack time. Fogged events are never reconstructed
from a spectator view. Recent incidents are bounded; per-opponent totals last throughout the game.

An accepted truce or border at the observed attack is distinguished from ordinary aggression without an
alliance. Even a failed attack can break the relevant accepted truce; replayed old events cannot break a
newer agreement. Passing-through claims are recorded only from seated senders and only if received before
the incident, lasting the current and next round. A notice is not consent or immunity. Missing a notice
does not prove the opponent never sent one. Spectator accusations do not become attack facts.

Leader facts identify the biggest observable territory holder and army. With three or more survivors,
a rival at >=40% of observable land or >=45% of observable armies prompts a coalition assessment and
suggests potential partners. Under fog these are explicitly estimates, not proof of the global leader.
The model evaluates existing deals, borders and its own win path; a coalition is not imposed. Diplomatic
opening whispers can approach a possible partner against that rival. Current round and individual turn
are restated separately. The post-game reflection also receives this seat's tactical summary, so relevant
observations can inform its persistent personality and relationship memories.

On runner startup, older completed local results and per-seat write-ups are restored into character memory and head-to-head records, once per game ID. No missing historical alliance or betrayal facts are invented. This preserves the finishing old runner game's personal lessons when the upgraded process restarts.
