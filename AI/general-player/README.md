# General player

The **standard / base player** every character is built on (unless its profile's *Base model* line names
another). Characters add personality and their own memories on top; this folder holds what is true for
any player: how to play a turn, how to win under each setting, and what past games have shown.

| File | What goes in it |
| ---- | --------------- |
| `playbook.md` | The turn-by-turn routine: threat check, objective, attacks, cards, diplomacy, after-game routine |
| `ways-to-win.md` | How to win under each victory condition and game setting (Capital Conquest, fog, cards, blizzards, ...) |
| `findings.md` | Dated findings from real games that hold for every player, each with its evidence |
| `risk-learnings.md` | Lessons from every past game so far: troop movement, capitals, fixed vs progressive cards, diplomacy, tool tips, game log. Read before every game. |

## Saving here

- **A finding** (something a game showed that would help any player) → append to `findings.md` in the
  format at the top of that file. Name the game and the character diary it came from.
- **A better way to win under a setting** → edit that setting's section in `ways-to-win.md`, and add the
  finding that supports it.
- **A change to the routine** → edit `playbook.md`.
- Anything about one character (their grudges, their voice, their personal lessons) goes in that character's
  files under `../characters/`, not here.
- New files here are lowercase kebab-case `.md`; list them in the table above and in the tree in `../README.md`.

Agents read every file in this folder through the `general_model_info` MCP tool.
