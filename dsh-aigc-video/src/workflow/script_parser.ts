/**
 * Markdown script parser.
 *
 * The expected format (mirrors the user's `自作聪明的傻狐狸.md`):
 *
 *   # Title
 *   **剧本类型**: xxx
 *   **人物角色**:
 *   1. **NameA**: short description
 *   2. **NameB**: short description
 *   **场景**: setting prose
 *   **时长**: 3-5分钟
 *   ---
 *   **【第一幕:xxx】**
 *   (stage direction in parentheses)
 *   **NameA**：(dialog)
 *   ...
 *
 * The parser is forgiving: missing sections are tolerated.
 */

export interface ParsedCharacter {
  name: string;
  description: string;
}

export interface ParsedScript {
  title: string;
  genre: string;
  setting: string;
  duration: string;
  characters: ParsedCharacter[];
  /** Each act is a chronological slice of stage directions + dialog. */
  acts: ParsedAct[];
}

export interface ParsedAct {
  /** Act heading e.g. "第一幕:装逼开场". */
  heading: string;
  /** Stage directions (parenthetical prose) and dialog lines, in order. */
  blocks: ScriptBlock[];
}

export type ScriptBlock =
  | { kind: 'direction'; text: string }
  | { kind: 'dialog'; character: string; text: string };

const ACT_HEADING_RE = /^\*\*【(.+?)】\*\*\s*$/;
const CHARACTER_LINE_RE = /^\d+\.\s*\*\*(.+?)\*\*[:：]\s*(.+)$/;
const DIALOG_RE = /^\*\*(.+?)\*\*\s*[:：]\s*(.*)$/;
const DIRECTION_RE = /^（(.+?)）\s*$|^[(](.+?)[)]\s*$/;

/** Markdown escape sequences we tolerate (e.g. `3\-5分钟` → `3-5分钟`,
 *  `1\.` → `1.`). */
function unescape(s: string): string {
  return s.replace(/\\([\\\-\*\[\]\(\)\.])/g, '$1');
}

/** Parse a markdown script into a structured representation. */
export function parseScript(md: string): ParsedScript {
  // Normalise backslash escapes first (some editors emit `\-`).
  const normalised = unescape(md);
  const lines = normalised.split(/\r?\n/);
  const result: ParsedScript = {
    title: '',
    genre: '',
    setting: '',
    duration: '',
    characters: [],
    acts: [],
  };

  let i = 0;
  // Header section: collect title + metadata until first `---` separator or first act.
  while (i < lines.length) {
    const raw = lines[i] ?? '';
    const line = raw.trim();
    if (line.startsWith('# ')) {
      result.title = line.slice(2).trim();
      i++;
      continue;
    }
    if (/^---+$/.test(line)) {
      i++;
      break;
    }
    if (line.startsWith('**')) {
      const m = /^\*\*(.+?)\*\*\s*[:：]\s*(.*)$/.exec(line);
      if (m) {
        const key = (m[1] ?? '').trim();
        const val = (m[2] ?? '').trim();
        switch (key) {
          case '剧本类型':
            result.genre = val;
            break;
          case '场景':
            result.setting = val;
            break;
          case '时长':
            result.duration = val;
            break;
          case '人物角色':
            i++;
            // Read indented numbered list
            while (i < lines.length) {
              const sub = (lines[i] ?? '').trim();
              const cm = CHARACTER_LINE_RE.exec(sub);
              if (cm) {
                result.characters.push({
                  name: (cm[1] ?? '').trim(),
                  description: (cm[2] ?? '').trim(),
                });
                i++;
              } else if (sub === '') {
                i++;
              } else {
                break;
              }
            }
            continue;
        }
      }
    }
    i++;
  }

  // Body: alternating act headings + blocks
  let currentAct: ParsedAct | undefined;
  while (i < lines.length) {
    const line = (lines[i] ?? '').trim();
    if (line === '' || line.startsWith('>')) {
      i++;
      continue;
    }
    const actMatch = ACT_HEADING_RE.exec(line);
    if (actMatch) {
      currentAct = { heading: actMatch[1] ?? '', blocks: [] };
      result.acts.push(currentAct);
      i++;
      continue;
    }
    if (!currentAct) {
      // Pre-act prose (continuation of header); skip.
      i++;
      continue;
    }
    // Try direction
    const dirMatch = DIRECTION_RE.exec(line);
    if (dirMatch) {
      const text = (dirMatch[1] ?? dirMatch[2] ?? '').trim();
      if (text) currentAct.blocks.push({ kind: 'direction', text });
      i++;
      continue;
    }
    // Try dialog
    const dlgMatch = DIALOG_RE.exec(line);
    if (dlgMatch) {
      const character = (dlgMatch[1] ?? '').trim();
      const text = (dlgMatch[2] ?? '').trim();
      currentAct.blocks.push({ kind: 'dialog', character, text });
      i++;
      continue;
    }
    i++;
  }
  return result;
}

/** Helper: enumerate all (block, index) pairs across acts. */
export function* iterBlocks(s: ParsedScript): Generator<{ actIdx: number; blockIdx: number; block: ScriptBlock }> {
  for (let a = 0; a < s.acts.length; a++) {
    const act = s.acts[a];
    if (!act) continue;
    for (let b = 0; b < act.blocks.length; b++) {
      const block = act.blocks[b];
      if (!block) continue;
      yield { actIdx: a, blockIdx: b, block };
    }
  }
}
