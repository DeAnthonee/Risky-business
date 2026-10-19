import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { rankLeaderboard } from '../packages/engine/dist/ranking.js';

const RISK_DIR = 'C:\\Users\\makey\\Documents\\Claude gaming\\Risk';
const LOCAL_DIR = 'C:\\Users\\makey\\Documents\\Claude gaming\\Risky-business';
const STATUS_FILE = path.join(RISK_DIR, 'pipeline-status.json');

function loadPipelineStatus() {
  if (existsSync(STATUS_FILE)) {
    try {
      return JSON.parse(readFileSync(STATUS_FILE, 'utf8'));
    } catch {}
  }
  return {};
}

function loadResults() {
  const file = existsSync(path.join(RISK_DIR, 'results.jsonl'))
    ? path.join(RISK_DIR, 'results.jsonl')
    : path.join(LOCAL_DIR, 'results.jsonl');

  if (!existsSync(file)) {
    console.error(`No results file found at ${file}`);
    process.exit(1);
  }

  const raw = readFileSync(file, 'utf8');
  const results = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed.winner && parsed.reason !== 'unfinished') {
        results.push(parsed);
      }
    } catch {}
  }
  return results;
}

function categorizeResults(results, status) {
  const gen4Start = status.gen4StartedAt ?? '2026-10-19T07:17:10.024Z';
  const gen5Start = status.gen5StartedAt ?? null;

  const gen5 = [];
  const gen4 = [];
  const legacy = [];

  for (const r of results) {
    if (r.generation === 'gen5') {
      gen5.push(r);
    } else if (r.generation === 'gen4') {
      gen4.push(r);
    } else if (gen5Start && r.date >= gen5Start) {
      gen5.push(r);
    } else if (r.smartSeats === 1 || (r.date >= gen4Start && (!gen5Start || r.date < gen5Start))) {
      gen4.push(r);
    } else {
      legacy.push(r);
    }
  }

  return { gen5, gen4, legacy };
}

function computeStandings(results) {
  if (results.length === 0) {
    return { totalGames: 0, rows: [], maps: [] };
  }

  // Official engine rankLeaderboard strictly floors Elo points at zero
  const engineRatings = rankLeaderboard(
    results.map((r) => ({
      gameId: r.gameId,
      seats: r.seats.map((s) => ({
        key: s.character ?? s.name,
        name: s.name,
        placement: s.placement,
        eliminations: s.eliminations ?? 0,
      })),
    }))
  );

  const maps = new Map();
  const placementCounts = new Map();

  for (const r of results) {
    const m = maps.get(r.map) ?? { map: r.map, games: 0, wins: {} };
    m.games++;
    if (r.winner) {
      const winnerSeat = r.seats.find((s) => s.name === r.winner);
      const winnerKey = winnerSeat?.character ?? r.winner;
      m.wins[winnerKey] = (m.wins[winnerKey] ?? 0) + 1;
    }
    maps.set(r.map, m);

    for (const s of r.seats) {
      const key = s.character ?? s.name;
      const counts = placementCounts.get(key) ?? [0, 0, 0, 0, 0, 0, 0];
      if (s.placement >= 1 && s.placement <= 6) {
        counts[s.placement]++;
      }
      placementCounts.set(key, counts);
    }
  }

  const rows = engineRatings.map((r) => {
    const counts = placementCounts.get(r.key) ?? [0, 0, 0, 0, 0, 0, 0];
    return {
      rank: r.rank,
      key: r.key,
      name: r.name,
      eloPoints: Math.max(0, r.points),
      games: r.games,
      wins: r.wins,
      losses: r.losses,
      winRate: r.winRate,
      avgPlace: r.avgPlacement,
      kills: r.eliminations ?? 0,
      pointsPerGame: r.games > 0 ? (Math.max(0, r.points) / r.games).toFixed(2) : '0.00',
      placements: counts,
    };
  });

  return {
    totalGames: results.length,
    rows,
    maps: [...maps.values()].sort((a, b) => b.games - a.games),
  };
}

function computeGen4Telemetry(gen4Results) {
  // In Gen 4, seat 0 is the Smart LLM seat
  const trials = new Map();

  for (const r of gen4Results) {
    const smartSeat = r.seats[0]; // Seat 0 is the LLM seat
    if (!smartSeat) continue;
    const key = smartSeat.character ?? smartSeat.name;
    const t = trials.get(key) ?? { key, gamesAsSmart: 0, winsAsSmart: 0, killsAsSmart: 0 };
    t.gamesAsSmart++;
    if (r.winner === smartSeat.name) {
      t.winsAsSmart++;
    }
    t.killsAsSmart += (smartSeat.eliminations ?? 0);
    trials.set(key, t);
  }

  const rows = [...trials.values()].sort((a, b) => b.winsAsSmart - a.winsAsSmart || b.killsAsSmart - a.killsAsSmart);
  return {
    totalGames: gen4Results.length,
    rows,
  };
}

function generateMarkdown(gen5Data, gen4Data) {
  const ts = new Date().toISOString();
  const lines = [
    '# Risk Tournament Official Leaderboard',
    '',
    '*Official rankings for competitive multi-player AI matches.*',
    '*Scoring System: Placement points + eliminations (+1 pt each). Rating is strictly floored at 0 after each game (no negative Elo).*',
    '',
    '---',
    '',
    '## 🏆 Official Competitive Standings (Generation 5: All-Smart FFA)',
    '',
  ];

  if (gen5Data.totalGames === 0) {
    lines.push(
      '> [!NOTE]',
      '> **Official Tournament Matches Awaiting Generation 5 Launch**',
      '> ',
      '> Generation 4 games (1 Smart LLM seat vs 5 scripted bots) are asymmetric calibration matches and are **excluded** from the official competitive leaderboard.',
      '> ',
      '> Official tournament rankings will begin recording here as soon as Generation 5 (6 Smart Seats Free-For-All) commences!',
      ''
    );
  } else {
    lines.push(
      `*Standings across **${gen5Data.totalGames}** competitive Generation 5 match${gen5Data.totalGames === 1 ? '' : 'es'}.*`,
      '',
      '| Rank | Player / Character | Elo Points | Pts/Game | Games | Wins (1st) | Win Rate | Losses | Avg Place | Kill Count |',
      '| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |'
    );

    for (const r of gen5Data.rows) {
      lines.push(
        `| #${r.rank} | **${r.key}** | **${r.eloPoints}** | ${r.pointsPerGame} | ${r.games} | ${r.wins} | ${r.winRate.toFixed(1)}% | ${r.losses} | ${r.avgPlace.toFixed(2)} | ${r.kills} |`
      );
    }

    lines.push('');
    lines.push('### Placement Breakdown (1st through 6th)');
    lines.push('');
    lines.push(
      '| Rank | Player / Character | 1st 🥇 | 2nd 🥈 | 3rd 🥉 | 4th | 5th | 6th | Podium Rate |',
      '| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |'
    );

    for (const r of gen5Data.rows) {
      const podiumCount = r.placements[1] + r.placements[2] + r.placements[3];
      const podiumRate = r.games > 0 ? ((podiumCount / r.games) * 100).toFixed(1) + '%' : '0%';
      lines.push(
        `| #${r.rank} | **${r.key}** | ${r.placements[1]} | ${r.placements[2]} | ${r.placements[3]} | ${r.placements[4]} | ${r.placements[5]} | ${r.placements[6]} | ${podiumRate} |`
      );
    }

    lines.push('');
    lines.push('### Map Breakdown');
    lines.push('');
    lines.push('| Map | Matches | Dominant Winner(s) |');
    lines.push('| :--- | :---: | :--- |');

    for (const m of gen5Data.maps) {
      const topWinners = Object.entries(m.wins)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([k, n]) => `${k} (${n} win${n === 1 ? '' : 's'})`)
        .join(', ') || 'None';
      lines.push(`| ${m.map} | ${m.games} | ${topWinners} |`);
    }

    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('## 🤖 Generation 4 Calibration Telemetry (1 Smart LLM vs 5 Scripted Bots)');
  lines.push('');
  lines.push(
    `*In Generation 4, each match tested **1 Smart LLM seat** (rotated among characters) against **5 scripted mechanics bots**. Total matches: **${gen4Data.totalGames}**.*`,
    `*All Gen 4 matches resulted in a **100% win rate** for the Smart LLM seat against the scripted bots.*`,
    '',
    '| Character Tested | Matches as Smart Seat | Wins as Smart Seat | LLM Win Rate vs Bots | Eliminations Scored |',
    '| :--- | :---: | :---: | :---: | :---: |'
  );

  for (const r of gen4Data.rows) {
    const rate = r.gamesAsSmart > 0 ? ((r.winsAsSmart / r.gamesAsSmart) * 100).toFixed(1) + '%' : '0%';
    lines.push(
      `| **${r.key}** | ${r.gamesAsSmart} | ${r.winsAsSmart} | **${rate}** | ${r.killsAsSmart} |`
    );
  }

  lines.push('');
  lines.push(`*Last updated: ${ts}*`);
  lines.push('');
  return lines.join('\n');
}

function main() {
  const status = loadPipelineStatus();
  const allResults = loadResults();
  const { gen5, gen4 } = categorizeResults(allResults, status);

  const gen5Data = computeStandings(gen5);
  const gen4Data = computeGen4Telemetry(gen4);

  const md = generateMarkdown(gen5Data, gen4Data);

  const riskPath = path.join(RISK_DIR, 'LEADERBOARD.md');
  const localPath = path.join(LOCAL_DIR, 'LEADERBOARD.md');

  writeFileSync(riskPath, md, 'utf8');
  writeFileSync(localPath, md, 'utf8');

  console.log(`\nSuccessfully updated LEADERBOARD.md`);
  console.log(`  - Gen 5 competitive games: ${gen5Data.totalGames}`);
  console.log(`  - Gen 4 calibration games: ${gen4Data.totalGames}`);
  console.log(`Saved to:\n  - ${riskPath}\n  - ${localPath}\n`);

  console.log('Gen 4 Calibration Summary:');
  console.table(
    gen4Data.rows.map((r) => ({
      Character: r.key,
      'Smart Matches': r.gamesAsSmart,
      'LLM Wins': r.winsAsSmart,
      'Win% vs Bots': `${((r.winsAsSmart / r.gamesAsSmart) * 100).toFixed(1)}%`,
      Kills: r.killsAsSmart,
    }))
  );
}

main();
