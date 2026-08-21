/**
 * Dry-run: parse the user's `自作聪明的傻狐狸.md` and print every shot's
 * Hailuo prompt + camera move. No API calls; no quota consumed.
 *
 * Usage: node scripts/dry-run-fox-script.mjs
 */

import { readFileSync } from 'node:fs';
import { parseScript } from '../dist/workflow/script_parser.js';
import { decomposeIntoShots } from '../dist/workflow/shot_decomposer.js';
import { buildHailuoPrompt } from '../dist/workflow/prompt_builder.js';

const md = readFileSync('D:/down/自作聪明的傻狐狸.md', 'utf-8');
const parsed = parseScript(md);

console.log(`# ${parsed.title}`);
console.log(`genre=${parsed.genre}`);
console.log(`setting=${parsed.setting}`);
console.log(`duration=${parsed.duration}`);
console.log(`characters=${parsed.characters.map((c) => c.name).join(', ')}`);
console.log(`acts=${parsed.acts.length}`);
console.log('');

const shots = decomposeIntoShots(parsed, { maxShots: 12 });
console.log(`# ${shots.length} shots (capped at 12)`);
console.log('');
for (const shot of shots) {
  const p = buildHailuoPrompt(shot, parsed);
  console.log(`-- shot ${shot.index} (act ${shot.act + 1}, ${shot.duration}s, chars=${shot.characters.join(',')})`);
  console.log(`   desc: ${shot.description.slice(0, 120)}${shot.description.length > 120 ? '…' : ''}`);
  console.log(`   cam:  ${shot.camera_move}`);
  console.log(`   prompt:`);
  console.log(`     ${p.prompt}`);
  console.log('');
}
