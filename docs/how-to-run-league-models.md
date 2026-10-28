# How to Run the League of Legends AI Characters and DeLOVE Models

This guide explains how anyone can run the **League of Legends AI character models** and **DeLOVE neural network models** on their own system, either locally or against the live multiplayer server at [risky.deanthoneeking.com](https://risky.deanthoneeking.com).

---

## 1. What This Is

In Risky Business, AI players come in two distinct flavors:

1. **League of Legends LLM Characters**:
   - LLM-powered autonomous commanders running locally via **Ollama**.
   - Each character possesses a distinct personality, strategic playbook, memory, and diplomatic style (e.g., Ahri, Darius, Jinx, Leona, Lux, Shaco, Shen, Teemo, Thresh, Tryndamere).
   - In-game turn loop: evaluates board facts, drafts strategic plans (win path, focus, target, avoidance), executes tactical movement, communicates via diplomatic pings (`⚔️ [attack]`, `🏡 [good neighbor]`, `🛡️ [alliance]`, `😈 [taunt]`), and reflects post-game into `RISK_LEARNINGS.md`.

2. **DeLOVE Neural Network Models (`delove@13`, the current best, and earlier `delove@N`)**:
   - Pure neural network players (ONNX graph networks) trained on hundreds of thousands of branch-and-score games.
   - High-speed board reading and candidate move evaluation without personality or chat.

3. **Mixed tables**: the runner seats League characters and leaves open seats that `delove-seat` fills with DeLOVE
   models, so both kinds play at one table (section 6).

---

## 2. Prerequisites

1. **Node.js 22+**:
   - Verify: `node -v` (v22.0.0 or later recommended).
2. **Git**:
   - To clone the repository and fetch model releases.
3. **Ollama**:
   - Install from [ollama.com](https://ollama.com).
   - Ensure the Ollama daemon is running at `http://localhost:11434`.
   - Pull the recommended strategic reasoning model:
     ```bash
     ollama pull qwen3:14b
     ```
     *(Alternative models like `qwen2.5:14b` or `llama3.1:8b` are also supported).*
4. **GitHub CLI (`gh`)** *(Optional but recommended for DeLOVE models)*:
   - For downloading released model weights directly.

---

## 3. Installation & Build

Clone and compile the monorepo:

```bash
# 1. Clone the repository
git clone https://github.com/DeAnthonee/Risky-business.git
cd Risky-business

# 2. Install all workspace dependencies
npm ci

# 3. Build the engine, server, client, runner, and delove packages
npm run build
```

---

## 4. Downloading DeLOVE Neural Network Models

DeLOVE weights are GitHub Releases of `DeAnthonee/delove-models`, one release per model (`delove@13` is the current
best; `gh release list --repo DeAnthonee/delove-models` lists them). Download into `models/delove/` (git-ignored):

```bash
mkdir -p models/delove
gh release download delove@13 --repo DeAnthonee/delove-models --dir models/delove --pattern "*.onnx" --pattern "*.json"
```

Each model needs `<model>.onnx` (the network), `<model>.value.onnx` (for the `+look` lookahead seats) and
`<model>.json` (metadata; `"fogInputs"` in it marks a model trained for fog of war). The `.pt` file is for training
only. Check the seats you can use:

```bash
npm run delove -- agents
# delove@13, delove@13+look, ...
```

---

## 5. Running the League of Legends Characters

### Mode A: Run a Local Match (Headless / Self-Contained)

You can spin up a local game between League characters on your machine:

```bash
# Terminal 1: Start local Risky Business server (http://localhost:8080)
RISK_DATA_DIR=none npm start

# Terminal 2: Run a match with specific League seats on Classic map
npm run runner -- \
  --server http://localhost:8080 \
  --map classic \
  --seats "Ahri=league/ahri,Darius=league/darius,Shen=league/shen,Jinx=league/jinx,Thresh=league/thresh" \
  --model qwen3:14b \
  --games 1
```

### Mode B: Endless League Loop on the Live Server (Spectator Mode)

You can run continuous League matches directly on the live shared server (`https://risky.deanthoneeking.com`) and watch them in your browser:

```bash
npm run runner -- \
  --server https://risky.deanthoneeking.com \
  --model qwen3:14b \
  --games 0 \
  --pace 0
```

Each match prints a spectator link:
```
Watch: https://risky.deanthoneeking.com/?game=<GAME_ID>&spectate=1
```
Open this link in any browser to watch the characters plan, attack, and converse in real time.

---

## 6. A Mixed Table: League Characters vs DeLOVE

Five random League characters against five `delove@13` seats on a local server, with the league's standard settings
(each game rolls fog of war, 0 or 8 blizzards, capitals on or off, and progressive, fixed or exponential cards; the
map is a random one that seats everyone):

```bash
# Terminal 1: the server
RISK_DATA_DIR=none npm start

# Terminal 2: five League seats and five open seats; prints "Lobby <CODE> on <map>"
npm run runner -- --server http://localhost:8080 --players 10 --open-seats 5 --games 1   --learnings-dir <your learnings folder>

# Terminal 3: fill the open seats with DeLOVE; the runner starts the game once all ten are in
npm run delove-seat -- --server http://localhost:8080 --join <CODE>   --agents delove@13,delove@13,delove@13,delove@13,delove@13   --names "Ronny@13,Joey@13,Hans@13,Demonte@13,Dejean@13" --pace 0
```

Only models trained for fog (`"fogInputs"` in their `.json`, `delove@12` and later) play fog-of-war tables;
`delove-seat` refuses fog games for older models. Add `--llm-stats <file>` to the runner to log how long each
model call takes (see [packages/runner/README.md](../packages/runner/README.md)). The runner's leaderboard
(`LEADERBOARD.md`) and results are written in its `--learnings-dir`, never in the repo.

---

## 7. Key Files & Directory Overview

| Path | Purpose |
| :--- | :--- |
| `AI/characters/league/` | Starting character markdown files (`ahri.md`, `darius.md`, etc.) defining persona, strategy, and banter style. |
| `AI/general-player/` | Foundational strategy documents (`playbook.md`, `ways-to-win.md`, `risk-learnings.md`). |
| `packages/runner/` | Standalone runner package (`planned-bot.ts`, `commander.ts`, `pings.ts`, `postgame.ts`). |
| `packages/delove/` | Neural network player wrapper and `seat-cli.js`. |
| `models/delove/` | Download directory for ONNX neural model checkpoints. |
