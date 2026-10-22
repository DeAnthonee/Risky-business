/**
 * Canned lines for big-move reactions (reactions.ts): what the attacker says and what the victim answers. Generic
 * lines per kind of move, and a voice per AI character written by hand from its profile's "Personality & voice"
 * section (AI/characters/<universe>/<name>.md; those files are not read at run time). No LLM, no TTS. `{victim}`,
 * `{attacker}` and `{n}` are filled in.
 */

export type BigMoveKind = 'sweep' | 'knockout' | 'capital';

export const GENERIC_LINES: Record<BigMoveKind, { attacker: string[]; victim: string[] }> = {
  sweep: {
    attacker: ['{n} territories in one turn. Keep up, {victim}.', 'That was a sweep, not a skirmish.', 'Thank you for the land, {victim}.'],
    victim: ['That was not a fair fight.', 'Enjoy it while it lasts, {attacker}.', "I'll remember this."],
  },
  knockout: {
    attacker: ['And {victim} is out.', "That's one fewer at the table.", 'Goodbye, {victim}.'],
    victim: ['GG. Well played, {attacker}.', 'I was just getting started.', 'Avenge me, someone.'],
  },
  capital: {
    attacker: ['Your capital is mine, {victim}.', 'The crown changes hands.', 'Nice capital. Mine now.'],
    victim: ['Not my capital!', "You'll pay for that, {attacker}.", 'That was the heart of my empire.'],
  },
};

/** One line as the attacker and one as the victim, per character id (`universe/name`). */
export const CHARACTER_LINES: Record<string, { attacker: string; victim: string }> = {
  'dc/batman': { attacker: 'Done.', victim: 'Noted.' },
  'league/ahri': { attacker: "Sorry, {victim}, darling. You looked so lonely there.", victim: "Oh, {attacker}. And I thought we had something." },
  'league/darius': { attacker: 'Strength takes what weakness cannot hold.', victim: 'You earned that. Now earn what comes next.' },
  'league/jinx': { attacker: 'BOOM! Fireworks for {victim}!', victim: "Hey! That was MY toy box!" },
  'league/leona': { attacker: 'The line moves forward. Stand aside, {victim}.', victim: 'I will hold what is left. No one falls behind.' },
  'league/lux': { attacker: "Sorry, {victim}! It had to be done. Let's still be friends!", victim: "Ouch! Okay, I didn't see that coming." },
  'league/shaco': { attacker: 'Surprise! A little gift for {victim}.', victim: 'Ha. Ha. Very funny. My turn next.' },
  'league/shen': { attacker: 'Balance is restored.', victim: 'The border will be kept.' },
  'league/teemo': { attacker: "Scout's honour, that was totally harmless, {victim}!", victim: 'Hey! Not cool, {attacker}!' },
  'league/thresh': { attacker: 'Another soul for the lantern, {victim}.', victim: 'A debt is noted, {attacker}. I collect.' },
  'league/tryndamere': { attacker: 'CRUSHED. Who is NEXT?', victim: 'I will be BACK for that, {attacker}!' },
  'marvel/iron-man': { attacker: 'Genius, billionaire, landlord. Hi, {victim}.', victim: "Okay. Okay. That one stung." },
  'marvel/ultron': { attacker: 'Inevitable, {victim}. You only delayed it.', victim: 'A setback. Not a conclusion.' },
};

/** A stable index from a seed string (FNV-1a): the same move always gets the same line. */
export function pick<T>(list: readonly T[], seed: string): T {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193) >>> 0;
  return list[h % list.length];
}

export function fill(line: string, vars: { attacker: string; victim: string; n: number }): string {
  return line.replace(/\{attacker\}/g, vars.attacker).replace(/\{victim\}/g, vars.victim).replace(/\{n\}/g, String(vars.n));
}

/** The attacker's line and the victim's reply: their character's voice when bound to one, else a generic line. */
export function linesFor(
  kind: BigMoveKind,
  attacker: { name: string; characterId?: string },
  victim: { name: string; characterId?: string },
  n: number,
  seed: string,
): { line: string; reply: string } {
  const vars = { attacker: attacker.name, victim: victim.name, n };
  const a = (attacker.characterId && CHARACTER_LINES[attacker.characterId]?.attacker) || pick(GENERIC_LINES[kind].attacker, `${seed}:a`);
  const v = (victim.characterId && CHARACTER_LINES[victim.characterId]?.victim) || pick(GENERIC_LINES[kind].victim, `${seed}:v`);
  return { line: fill(a, vars), reply: fill(v, vars) };
}
