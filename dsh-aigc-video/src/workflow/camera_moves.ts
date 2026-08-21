/**
 * Camera-move library for MiniMax-Hailuo-2.3 (and Hailuo-02, *-Director).
 *
 * MiniMax accepts 15 bracketed instructions in the prompt:
 *   左右移: [左移], [右移]
 *   左右摇: [左摇], [右摇]
 *   推拉  : [推进], [拉远]
 *   升降  : [上升], [下降]
 *   上下摇: [上摇], [下摇]
 *   变焦  : [变焦推近], [变焦拉远]
 *   其他  : [晃动], [跟随], [固定]
 *
 * Multiple instructions inside ONE `[]` apply simultaneously (max 3).
 * Separate `[]` groups apply in order they appear in the prompt.
 *
 * Rules:
 *   - Action verbs in the description (中 or 英) trigger candidate moves.
 *   - Only one primary move per shot; secondary move via combined `[]`.
 *   - At most 3 moves per group, at most 2 groups per prompt.
 */

export const CAMERA_MOVES = [
  '左移',
  '右移',
  '左摇',
  '右摇',
  '推进',
  '拉远',
  '上升',
  '下降',
  '上摇',
  '下摇',
  '变焦推近',
  '变焦拉远',
  '晃动',
  '跟随',
  '固定',
] as const;

export type CameraMove = (typeof CAMERA_MOVES)[number];

/** A single `[]` group, e.g. `[推进]` or `[左摇,上升]`. */
export type CameraMoveGroup = readonly CameraMove[];

/** up to 2 groups in a prompt — first group dominant, second optional. */
export type CameraMoves = readonly [CameraMoveGroup, CameraMoveGroup?];

/**
 * Verb → primary camera move. Order matters (first match wins).
 * Each entry: array of pattern substrings (Chinese or English, lowercase)
 * followed by the camera move to apply.
 */
const VERB_RULES: ReadonlyArray<{ patterns: readonly string[]; move: CameraMove; weight: number }> = [
  // 跟随 (follow / track) — checked FIRST so "慢慢悠悠走过来" doesn't get hijacked by 推进.
  { patterns: ['跟随', '跟踪', '慢悠悠', '晃晃悠悠', 'follow', 'track', 'chase'], move: '跟随', weight: 4 },
  // 推近 (push in / zoom in)
  { patterns: ['推进', '推近', '逼近', '靠近', '走上场', '走向', '袭来', '朝镜头', '迈着', 'push in', 'zoom in', 'approach'], move: '推进', weight: 3 },
  // 拉远 (pull out / zoom out)
  { patterns: ['拉远', '后退', '退场', '离开', '飞走', '远去', '消失', '拉远镜头', '拉远景', 'pull out', 'pull back', 'zoom out'], move: '拉远', weight: 3 },
  // 变焦推近 (extreme close-up, emotion)
  { patterns: ['震惊', '惊吓', '惊讶', '惊恐', '愣住', '表情变化', '内心', '特写', 'close-up', 'shock', 'surprise'], move: '变焦推近', weight: 2 },
  // 变焦拉远 (reveal wide)
  { patterns: ['全景', '远景', '展现', '揭露', 'reveal', 'wide shot'], move: '变焦拉远', weight: 2 },
  // 晃动 (shake / impact)
  { patterns: ['摔', '撞', '滑', '打', '击', '撞击', '翻车', '倒地', '倒下', 'shake', 'impact', 'slam', 'fall'], move: '晃动', weight: 2 },
  // 上升 (rise / lift)
  { patterns: ['抬头', '仰视', '上升', '升起', '飞向天空', '抬头看', 'rise', 'lift up', 'look up'], move: '上升', weight: 1 },
  // 下降 (drop)
  { patterns: ['低头', '俯视', '下降', '跌落', '掉落', '下沉', 'drop', 'descend', 'look down'], move: '下降', weight: 1 },
  // 上摇 (tilt up)
  { patterns: ['上摇', '仰角', '往上移', 'tilt up'], move: '上摇', weight: 1 },
  // 下摇 (tilt down)
  { patterns: ['下摇', '俯角', 'tilt down'], move: '下摇', weight: 1 },
  // 左移 (truck left)
  { patterns: ['左移', '左侧', '向左', 'truck left', 'move left'], move: '左移', weight: 1 },
  // 右移 (truck right)
  { patterns: ['右移', '右侧', '向右', 'truck right', 'move right'], move: '右移', weight: 1 },
  // 左摇 (pan left)
  { patterns: ['左摇', '往左看', '环视左', 'pan left'], move: '左摇', weight: 1 },
  // 右摇 (pan right)
  { patterns: ['右摇', '往右看', '环视右', 'pan right'], move: '右摇', weight: 1 },
  // 固定 (static)
  { patterns: ['站立', '静止', '不动', '等待', '闭眼', '静止不动', 'static', 'still', 'stand still'], move: '固定', weight: 1 },
];

/**
 * Pick the best camera-move group for a given action description.
 * Returns up to 2 groups: [primary] or [primary, secondary].
 */
export function pickCameraMoves(actionText: string): CameraMoves {
  if (!actionText?.trim()) return [['固定']];
  const t = actionText.toLowerCase();
  const scores = new Map<CameraMove, number>();
  for (const rule of VERB_RULES) {
    for (const p of rule.patterns) {
      if (t.includes(p.toLowerCase())) {
        scores.set(rule.move, (scores.get(rule.move) ?? 0) + rule.weight);
      }
    }
  }
  if (scores.size === 0) return [['固定']];
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const primary = ranked[0]?.[0] ?? '固定';
  // Second move only if it scored >= 2 and isn't identical
  const secondary = ranked[1]?.[0];
  if (secondary && secondary !== primary && (ranked[1]?.[1] ?? 0) >= 2) {
    return [[primary, secondary].slice(0, 3) as CameraMoveGroup, undefined];
  }
  return [[primary]];
}

/** Format a `CameraMoves` value as the bracketed MiniMax syntax. */
export function formatCameraMoves(moves: CameraMoves): string {
  const parts: string[] = [];
  for (const g of moves) {
    if (g && g.length > 0) parts.push(`[${g.join(',')}]`);
  }
  return parts.join(' ');
}
