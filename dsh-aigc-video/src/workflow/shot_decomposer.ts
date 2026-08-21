/**
 * Shot decomposer: turns a parsed script into a list of cinematic shots.
 *
 * Strategy:
 *   - Each `direction` block = at least one shot.
 *   - Adjacent dialog blocks with no direction between them can share a
 *     wide shot (one shot, multiple voices).
 *   - Each shot gets:
 *       - a description (English, video-friendly)
 *       - a primary camera move (rule-based on action verbs)
 *       - a duration (4–10 s, derived from block density)
 *       - the characters appearing
 *
 * Output is consumed by `prompt_builder.ts` to make Hailuo prompts.
 */

import type { ParsedScript, ScriptBlock } from './script_parser.js';
import { pickCameraMoves } from './camera_moves.js';

export interface DecomposedShot {
  index: number;
  /** Source act index (0-based). */
  act: number;
  /** Source block indices covered by this shot. */
  block_indices: number[];
  description: string;
  duration: number;
  characters: string[];
  /** Primary camera move (used for prompt emission). */
  camera_move: string;
}

const SHOT_DURATION_MIN = 4;
const SHOT_DURATION_MAX = 10;
const SHOT_DURATION_DEFAULT = 6;

/**
 * Decompose a parsed script into shots.
 *
 * @param maxShots Cap the number of shots (Hailuo quota is precious).
 */
export function decomposeIntoShots(script: ParsedScript, opts: { maxShots?: number } = {}): DecomposedShot[] {
  const maxShots = opts.maxShots ?? 12;
  const shots: DecomposedShot[] = [];

  for (let a = 0; a < script.acts.length; a++) {
    const act = script.acts[a];
    if (!act) continue;

    let i = 0;
    while (i < act.blocks.length) {
      const block = act.blocks[i];
      if (!block) { i++; continue; }

      if (block.kind === 'direction') {
        // Direction: open with this shot, possibly continue through following dialog.
        const covered: number[] = [i];
        const characters = new Set<string>();
        let combinedDialog = '';

        // Greedily include subsequent dialog blocks until the next direction.
        let j = i + 1;
        while (j < act.blocks.length) {
          const nxt = act.blocks[j];
          if (!nxt || nxt.kind === 'direction') break;
          covered.push(j);
          characters.add(nxt.character);
          combinedDialog += ' ' + nxt.text;
          j++;
          // Don't let dialog absorb forever; cap at 2 lines per shot.
          if (covered.length >= 3) break;
        }

        const description = composeDescription(block.text, combinedDialog);
        const actionText = block.text + ' ' + combinedDialog;
        const moves = pickCameraMoves(actionText);
        const cameraMove = formatMoves(moves);
        shots.push({
          index: shots.length + 1,
          act: a,
          block_indices: covered,
          description,
          duration: estimateDuration(block.text, combinedDialog),
          characters: [...characters],
          camera_move: cameraMove,
        });
        i = j;
        continue;
      }

      // Stray dialog with no preceding direction — wrap it as a wide shot.
      const covered: number[] = [i];
      const characters = new Set<string>([block.character]);
      let combinedDialog = block.text;
      let j = i + 1;
      while (j < act.blocks.length) {
        const nxt = act.blocks[j];
        if (!nxt || nxt.kind === 'direction') break;
        covered.push(j);
        characters.add(nxt.character);
        combinedDialog += ' ' + nxt.text;
        j++;
        if (covered.length >= 2) break;
      }
      shots.push({
        index: shots.length + 1,
        act: a,
        block_indices: covered,
        description: composeDescription('', combinedDialog),
        duration: estimateDuration('', combinedDialog),
        characters: [...characters],
        camera_move: '[固定]',
      });
      i = j;
    }
  }

  // Cap & renumber.
  return shots.slice(0, maxShots).map((s, idx) => ({ ...s, index: idx + 1 }));
}

function composeDescription(direction: string, dialog: string): string {
  const parts: string[] = [];
  if (direction.trim()) parts.push(direction.trim());
  if (dialog.trim()) parts.push(`Characters say: ${dialog.trim()}`);
  return parts.join(' ').slice(0, 800);
}

function estimateDuration(direction: string, dialog: string): number {
  const textLen = direction.length + dialog.length;
  // Rough heuristic: ~12 Chinese chars per second of dialog/direction.
  // Hailuo-2.3 only accepts 6s or 10s — snap to the nearest valid duration.
  const raw = Math.round(textLen / 12);
  const sec = raw <= 8 ? 6 : 10;
  return Math.max(SHOT_DURATION_MIN, Math.min(SHOT_DURATION_MAX, sec));
}

function formatMoves(groups: ReturnType<typeof pickCameraMoves>): string {
  const parts: string[] = [];
  for (const g of groups) {
    if (g && g.length) parts.push(`[${g.join(',')}]`);
  }
  return parts.join(' ');
}
