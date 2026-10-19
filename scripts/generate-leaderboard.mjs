import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { rankLeaderboard } from '../packages/engine/dist/ranking.js';

const RISK_DIR = 'C:\\Users\\makey\\Documents\\Claude gaming\\Risk';
const LOCAL_DIR = 'C:\\Users\\makey\\Documents\\Claude gaming\\Risky-business';

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

function computeStandings(results) {
  // Use official engine rankLeaderboard which strictly floors Elo points at zero (Math.max(0, ...))
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
    // Map tracking
    const m = maps.get(r.map) ?? { map: r.map, games: 0, wins: {} };
    m.games++;
    if (r.winner) {
      const winnerSeat = r.seats.find((s) => s.name === r.winner);
      const winnerKey = winnerSeat?.character ?? r.winner;
      m.wins[winnerKey] = (m.wins[winnerKey] ?? 0) + 1;
    }
    maps.set(r.map, m);

    // Placement breakdown tracking (1st through 6th)
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
      eloPoints: Math.max(0, r.points), // strictly floored at 0
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

function generateMarkdown(data) {
  const ts = new Date().toISOString();
  const lines = [
    '# Risk Tournament Official Leaderboard',
    '',
    `*Empirical rankings across **${data.totalGames}** AI self-play match${data.totalGames === 1 ? '' : 'es'}.*`,
    `*Scoring System: Placement points + eliminations (+1 pt each). Rating is strictly floored at 0 after each game (no negative Elo).*`,
    '',
    '## Overall Standings',
    '',
    '| Rank | Player / Character | Elo Points | Pts/Game | Games | Wins (1st) | Win Rate | Losses | Avg Place | Eliminations |',
    '| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |',
  ];

  for (const r of data.rows) {
    lines.push(
      `| #${r.rank} | **${r.key}** | **${r.eloPoints}** | ${r.pointsPerGame} | ${r.games} | ${r.wins} | ${r.winRate.toFixed(1)}% | ${r.losses} | ${r.avgPlace.toFixed(2)} | ${r.kills} |`
    );
  }

  lines.push('');
  lines.push('## Placement Breakdown (Finishes 1st through 6th)');
  lines.push('');
  lines.push(
    '| Rank | Player / Character | 1st 🥇 | 2nd 🥈 | 3rd 🥉 | 4th | 5th | 6th | Podium Rate |',
    '| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |'
  );

  for (const r of data.rows) {
    const podiumCount = r.placements[1] + r.placements[2] + r.placements[3];
    const podiumRate = r.games > 0 ? ((podiumCount / r.games) * 100).toFixed(1) + '%' : '0%';
    lines.push(
      `| #${r.rank} | **${r.key}** | ${r.placements[1]} | ${r.placements[2]} | ${r.placements[3]} | ${r.placements[4]} | ${r.placements[5]} | ${r.placements[6]} | ${podiumRate} |`
    );
  }

  lines.push('');
  lines.push('## Map Breakdown');
  lines.push('');
  lines.push('| Map | Matches | Dominant Winner(s) |');
  lines.push('| :--- | :---: | :--- |');

  for (const m of data.maps) {
    const topWinners = Object.entries(m.wins)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, n]) => `${k} (${n} win${n === 1 ? '' : 's'})`)
      .join(', ') || 'None';
    lines.push(`| ${m.map} | ${m.games} | ${topWinners} |`);
  }

  lines.push('');
  lines.push(`*Generated at: ${ts}*`);
  lines.push('');
  return lines.join('\n');
}

function main() {
  const results = loadResults();
  const standings = computeStandings(results);
  const md = generateMarkdown(standings);

  // Write to both Risk and Risky-business
  const riskPath = path.join(RISK_DIR, 'LEADERBOARD.md');
  const localPath = path.join(LOCAL_DIR, 'LEADERBOARD.md');

  writeFileSync(riskPath, md, 'utf8');
  writeFileSync(localPath, md, 'utf8');

  console.log(`\nSuccessfully updated LEADERBOARD.md (${standings.totalGames} games, ${standings.rows.length} characters)`);
  console.log(`Saved to:\n  - ${riskPath}\n  - ${localPath}\n`);

  console.table(
    standings.rows.map((r) => ({
      Rank: `#${r.rank}`,
      Character: r.key,
      Elo: r.eloPoints,
      Games: r.games,
      Wins: r.wins,
      'Win%': `${r.winRate.toFixed(1)}%`,
      'Avg Place': r.avgPlace.toFixed(2),
      Kills: r.kills,
    }))
  );
}

main();
