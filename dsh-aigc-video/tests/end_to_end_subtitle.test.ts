/**
 * Tests for `src/workflow/end_to_end.ts` subtitle system (v3.3 add).
 *
 * Two helpers:
 *   - `resolveSubtitleMode(requested, hasDialog)` — pick 'dialog' | 'act-title'
 *   - `buildSrtForMode(mode, shots, parsed, lines)` — emit SrtLine[]
 *
 * Plus the run() integration:
 *   - SRT is written even when --dub is NOT set, when subtitle_mode='act-title'
 *     or 'auto' picks it up.
 */

import { describe, expect, it } from 'vitest';

import {
  resolveSubtitleMode,
  buildSrtForMode,
} from '../src/workflow/end_to_end.js';
import { parseScript } from '../src/workflow/script_parser.js';

const ACT_TITLE_SCRIPT = `# 杨家枪剧本片段
**剧本类型**: 动作
**人物角色**:
1. **小女娃**: 七岁练枪女童
**场景**: 校场·白日
**时长**: 60秒
---
**【全景】**
（空旷校场，旌旗轻晃。）
**【近景】**
（小女娃神情专注。）
**【动作特写】**
（她握住枪杆。）
`;

const DIALOG_SCRIPT = `# 对白剧本片段
**剧本类型**: 剧情
**人物角色**:
1. **小女娃**: 七岁练枪女童
2. **师父**: 老拳师
**场景**: 校场
**时长**: 30秒
---
**【第一幕】**
**小女娃**：师父，我要学枪法。
（师父走近。）
**师父**：好，看仔细。
`;

describe('resolveSubtitleMode', () => {
  it("'auto' with dialog → 'dialog'", () => {
    expect(resolveSubtitleMode('auto', true)).toBe('dialog');
  });
  it("'auto' without dialog → 'act-title'", () => {
    expect(resolveSubtitleMode('auto', false)).toBe('act-title');
  });
  it("'dialog' requested → 'dialog' regardless of hasDialog", () => {
    expect(resolveSubtitleMode('dialog', true)).toBe('dialog');
    expect(resolveSubtitleMode('dialog', false)).toBe('dialog');
  });
  it("'act-title' requested → 'act-title' regardless of hasDialog", () => {
    expect(resolveSubtitleMode('act-title', true)).toBe('act-title');
    expect(resolveSubtitleMode('act-title', false)).toBe('act-title');
  });
});

describe('buildSrtForMode — dialog', () => {
  it('emits one cue per TTS line, distributed evenly across its shot', () => {
    const parsed = parseScript(DIALOG_SCRIPT);
    const shots = [
      { shot_index: 1, act: 0, duration: 6 },
      { shot_index: 2, act: 0, duration: 6 },
    ];
    const lines = [
      { shot_index: 1, character: '小女娃', text: '师父，我要学枪法。' },
      { shot_index: 2, character: '师父', text: '好，看仔细。' },
    ];
    const cues = buildSrtForMode('dialog', shots, parsed, lines);
    expect(cues.length).toBe(2);
    expect(cues[0]?.text).toBe('小女娃：师父，我要学枪法。');
    expect(cues[0]?.start).toBe(0);
    expect(cues[0]?.end).toBe(6);
    expect(cues[1]?.text).toBe('师父：好，看仔细。');
    expect(cues[1]?.start).toBe(6);
    expect(cues[1]?.end).toBe(12);
  });

  it('returns [] when no TTS lines (e.g. action-only script)', () => {
    const parsed = parseScript(ACT_TITLE_SCRIPT);
    const shots = [{ shot_index: 1, act: 0, duration: 6 }];
    const cues = buildSrtForMode('dialog', shots, parsed, []);
    expect(cues).toEqual([]);
  });
});

describe('buildSrtForMode — act-title', () => {
  it('emits one cue per act spanning cumulative duration', () => {
    const parsed = parseScript(ACT_TITLE_SCRIPT);
    const shots = [
      { shot_index: 1, act: 0, duration: 6 }, // 全景
      { shot_index: 2, act: 1, duration: 6 }, // 近景
      { shot_index: 3, act: 2, duration: 10 }, // 动作特写
    ];
    const cues = buildSrtForMode('act-title', shots, parsed, []);
    expect(cues.length).toBe(3);
    expect(cues[0]).toEqual({ start: 0, end: 6, text: '全景' });
    expect(cues[1]).toEqual({ start: 6, end: 12, text: '近景' });
    expect(cues[2]).toEqual({ start: 12, end: 22, text: '动作特写' });
  });

  it('groups consecutive shots in the same act into one cue', () => {
    const parsed = parseScript(ACT_TITLE_SCRIPT);
    const shots = [
      { shot_index: 1, act: 0, duration: 4 },
      { shot_index: 2, act: 0, duration: 6 }, // same act as previous
      { shot_index: 3, act: 1, duration: 10 },
    ];
    const cues = buildSrtForMode('act-title', shots, parsed, []);
    expect(cues.length).toBe(2);
    expect(cues[0]).toEqual({ start: 0, end: 10, text: '全景' });
    expect(cues[1]).toEqual({ start: 10, end: 20, text: '近景' });
  });

  it('falls back to "Act N" when heading is missing', () => {
    const parsed = parseScript(ACT_TITLE_SCRIPT);
    // Shots reference act 5 which doesn't exist in parsed.
    const shots = [{ shot_index: 1, act: 5, duration: 6 }];
    const cues = buildSrtForMode('act-title', shots, parsed, []);
    expect(cues[0]?.text).toBe('Act 6'); // 1-indexed for display
  });

  it('handles single act with single shot', () => {
    const parsed = parseScript(ACT_TITLE_SCRIPT);
    const shots = [{ shot_index: 1, act: 0, duration: 6 }];
    const cues = buildSrtForMode('act-title', shots, parsed, []);
    expect(cues).toEqual([{ start: 0, end: 6, text: '全景' }]);
  });

  it('returns [] for empty shots', () => {
    const parsed = parseScript(ACT_TITLE_SCRIPT);
    expect(buildSrtForMode('act-title', [], parsed, [])).toEqual([]);
  });
});

describe('buildSrtForMode — 9-act jb script (integration)', () => {
  it('produces 9 cues spanning the 9 acts', () => {
    // The jb.docx → jb.md conversion produces 9 acts. Simulate a 12-shot
    // decomposition across those acts and verify SRT shape.
    const SCRIPT_9ACTS = Array.from({ length: 9 }, (_, i) =>
      `**【第${i + 1}幕】**\n（场景 ${i + 1}。）\n`).join('');
    const md = `# jb\n**剧本类型**: 动作\n**人物角色**:\n1. **小女娃**: 七岁\n**场景**: 校场\n**时长**: 60秒\n---\n${SCRIPT_9ACTS}`;
    const parsed = parseScript(md);
    expect(parsed.acts.length).toBe(9);

    // Build shots — one per act with mixed durations (Hailuo-2.3 snaps to 6 or 10).
    const shots = parsed.acts.map((_act, i) => ({
      shot_index: i + 1,
      act: i,
      duration: i % 2 === 0 ? 10 : 6,
    }));

    const cues = buildSrtForMode('act-title', shots, parsed, []);
    expect(cues.length).toBe(9);

    // Verify monotonic timing.
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i]!.start).toBe(cues[i - 1]!.end);
      expect(cues[i]!.text).toMatch(/^第\d+幕$/);
    }
  });
});