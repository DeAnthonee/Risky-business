// Live yardstick, step 1: create one lobby on the game server and seat five LLM players named "<Tier> <Character>".
// Prints {gameId, seats:[{name, character, token}]} and keeps the tokens in $YARDSTICK_DIR (default ~/risk-yardstick),
// never in the repo. Seat Delove with `npm run delove-seat -- --join <gameId>`, give each token to one agent, then
// start the game with the host token (seats[0]). See docs/delove-yardstick.md.
// usage: node packages/delove/scripts/yardstick/setup.mjs <server> <Tier> <label>
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [server, tier, label] = process.argv.slice(2);
if (!server || !tier) throw new Error('usage: setup.mjs <server> <Tier> <label>');
const dir = process.env.YARDSTICK_DIR || join(homedir(), 'risk-yardstick');
mkdirSync(dir, { recursive: true });
const CHARACTERS = ['Shen', 'Jinx', 'Thresh', 'Leona', 'Teemo'];
// The fixed yardstick settings: Classic, 6 seats, random deal and armies, capitals, 8 blizzards, progressive cards, no fog.
const options = {
  map: 'classic', maxPlayers: 6, autoSetup: true, randomDeal: true, balancedBlitz: true, firstRoundBonus: true,
  fortifyMode: 'connected', fogOfWar: false, cardValues: 'progressive', spectatorChat: true,
  capitals: true, chooseCapitals: true, blizzards: 8,
};
// The training board takes the characters write key; without it the room is public (it is closed, so never ranked,
// when Delove is knocked out). The key is read from the environment and never printed.
const key = process.env.RISK_CHARACTERS_KEY;
const post = async (path, body, headers = {}) => {
  const res = await fetch(`${server}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${json.error ?? res.status}`);
  return json;
};
const host = await post('/games', {
  playerName: `${tier} ${CHARACTERS[0]}`, gameName: `Yardstick: delove vs ${tier} (${label ?? ''})`, options,
  ...(key ? { board: 'training' } : {}),
}, key ? { 'x-characters-key': key } : {});
const seats = [{ name: `${tier} ${CHARACTERS[0]}`, character: `league/${CHARACTERS[0].toLowerCase()}`, token: host.token }];
for (const c of CHARACTERS.slice(1)) {
  const j = await post(`/games/${host.gameId}/join`, { playerName: `${tier} ${c}` });
  seats.push({ name: `${tier} ${c}`, character: `league/${c.toLowerCase()}`, token: j.token });
}
writeFileSync(join(dir, `host-${host.gameId}.json`), JSON.stringify({ token: host.token }));
writeFileSync(join(dir, `seats-${host.gameId}.json`), JSON.stringify(seats, null, 1));
console.error(key ? 'board: training' : 'board: public (no RISK_CHARACTERS_KEY)');
console.log(JSON.stringify({ gameId: host.gameId, seats }));
