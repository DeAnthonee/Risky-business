# How to Run the League of Legends AI Characters and DeLOVE Models

This guide explains how anyone can run the **League of Legends AI character models** and **DeLOVE neural network models** on their own system, either locally or against the live multiplayer server at [risky.deanthoneeking.com](https://risky.deanthoneeking.com).

---

## 1. What This Is

In Risky Business, AI players come in two distinct flavors:

1. **League of Legends LLM Characters**:
   - LLM-powered autonomous commanders running locally via **Ollama**.
   - Each character possesses a distinct personality, strategic playbook, memory, and diplomatic style (e.g., Ahri, Darius, Jinx, Leona, Lux, Shaco, Shen, Teemo, Thresh, Tryndamere).
   - In-game turn loop: evaluates board facts, drafts strategic plans (win path, focus, target, avoidance), executes tactical movement, communicates via diplomatic pings (`⚔️ [attack]`, `🏡 [good neighbor]`, `🛡️ [alliance]`, `😈 [taunt]`), and reflects post-game into `RISK_LEARNINGS.md`.

2. **DeLOVE Neural Network Models (`delove@6`, `delove@5`, etc.)**:
   - Pure neural network players (ONNX graph networks) trained on hundreds of thousands of branch-and-score games.
   - High-speed board reading and candidate move evaluation without personality or chat.

3. **Continuous Tournament Orchestrator**:
   - An autonomous orchestrator (`scripts/continuous-model-orchestrator.mjs`) that pits a 20-player pool (10 League characters + 10 DeLOVE models) against each other in endless ranked matches across diverse maps.

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

If you want to run matches including DeLOVE neural net models (`delove@6`, `delove@5`, `delove@4`), download the weights from GitHub Releases into `models/delove/`:

```bash
# Create the models folder if it doesn't exist
mkdir -p models/delove

# Download the latest released models (delove@6 and delove@5)
gh release download delove@6 --repo DeAnthonee/delove-models --dir models/delove
gh release download delove@5 --repo DeAnthonee/delove-models --dir models/delove
```

Each model requires:
- `<model>.onnx` (the inference model)
- `<model>.value.onnx` (for lookahead evaluation)
- `<model>.json` (metadata and configuration)

Verify available agents:
```bash
npm run delove -- agents
# Should output:
# delove@5, delove@5+look, delove@6, delove@6+look, ...
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

## 6. What We Are Running Now (Continuous Tournament Orchestrator)

Our production setup runs an autonomous 20-seat tournament orchestrator pitting the **10 League of Legends LLM characters** against **10 DeLOVE neural models**:

### The Active Lineup (Pool of 20)

| Type | Count | Lineup |
| :--- | :---: | :--- |
| **League LLM Characters** | 10 | `Ahri`, `Darius`, `Jinx`, `Leona`, `Lux`, `Shaco`, `Shen`, `Teemo`, `Thresh`, `Tryndamere` |
| **DeLOVE Model 6 (Current Best)** | 5 | `Ronny@6`, `Joey@6`, `Hans@6`, `Demonte@6`, `Dejean@6` (`delove@6`) |
| **DeLOVE Model 5** | 5 | `Demario@5`, `Kai@5`, `Lauren@5`, `Diane@5`, `Jason@5` (`delove@5`) |

### Starting the Orchestrator

Run the background script:

```bash
node scripts/continuous-model-orchestrator.mjs
```

What the orchestrator does automatically:
1. Picks a random map (Europe, USA, Asia, World, Fantasy, etc.) without back-to-back duplicates.
2. Draws a random composition from the pool of 20 (guaranteeing at least 1 LLM host to capture telemetry).
3. Spawns `@risk/runner` for the LLM seats and `@risk/delove` for the neural net seats.
4. Manages the tactical diplomacy system (2v1 joint attacks, border non-aggression, taunts).
5. Appends finished game results to `results.jsonl`.
6. Recomputes tournament standings and renders `LEADERBOARD.md`.

---

## 7. Key Files & Directory Overview

| Path | Purpose |
| :--- | :--- |
| `AI/characters/league/` | Starting character markdown files (`ahri.md`, `darius.md`, etc.) defining persona, strategy, and banter style. |
| `AI/general-player/` | Foundational strategy documents (`playbook.md`, `ways-to-win.md`, `risk-learnings.md`). |
| `packages/runner/` | Standalone runner package (`planned-bot.ts`, `commander.ts`, `pings.ts`, `postgame.ts`). |
| `packages/delove/` | Neural network player wrapper and `seat-cli.js`. |
| `models/delove/` | Download directory for ONNX neural model checkpoints. |
| `scripts/continuous-model-orchestrator.mjs` | Automated script managing match lifecycles, player draws, and leaderboard syncing. |
| `LEADERBOARD.md` | Auto-generated tournament leaderboard with rankings, win rates, and elimination stats. |
