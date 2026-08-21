/**
 * 8 transition kinds, mapped to ffmpeg's xfade filter (or equivalent).
 *
 * Most transitions use ffmpeg's native `xfade` filter. Two need custom
 * filter graphs:
 *   - `push`     → `overlay` with directional offset
 *   - `barn`     → `crop` + `overlay` (left/right doors closing)
 *
 * `cut` has no ffmpeg cost — clips are concatenated directly.
 */

export type TransitionKind =
  | 'cut'
  | 'crossfade'
  | 'dip-to-black'
  | 'dip-to-white'
  | 'iris'
  | 'wipe'
  | 'push'
  | 'barn'
  | 'clock';

export interface TransitionSpec {
  kind: TransitionKind;
  /** Duration in seconds. Ignored for 'cut'. */
  duration: number;
}

/** Map a TransitionKind to the ffmpeg `xfade` transition name (where supported). */
export function xfadeName(kind: TransitionKind): string | null {
  switch (kind) {
    case 'crossfade':
      return 'fade';
    case 'dip-to-black':
      return 'fadeblack';
    case 'dip-to-white':
      return 'fadewhite';
    case 'iris':
      return 'iris';
    case 'wipe':
      return 'wipeleft';
    case 'clock':
      return 'clock';
    case 'cut':
    case 'push':
    case 'barn':
      return null; // handled by custom filter graphs
  }
}