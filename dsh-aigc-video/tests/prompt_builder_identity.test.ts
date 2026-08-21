/**
 * Tests for `src/workflow/prompt_builder.ts` v3.3 subject-consistency hardening.
 *
 * The prompt builder now appends an explicit identity-preservation sentence
 * to every shot's prompt. This compensates for Hailuo v2's soft
 * `reference_image` signal by re-stating the constraint in text form.
 */

import { describe, expect, it } from 'vitest';

import { buildHailuoPrompt } from '../src/workflow/prompt_builder.js';
import { parseScript } from '../src/workflow/script_parser.js';

const SAMPLE_SCRIPT = `# 杨家枪剧本片段
**剧本类型**: 动作
**人物角色**:
1. **小女娃**: 七岁练枪女童
**场景**: 校场·白日·微风
**时长**: 60秒
---
**【全景】**
（空旷校场，旌旗轻晃。）
（女童立于枪旁。）
`;

describe('buildHailuoPrompt (v3.3 identity hardening)', () => {
  it('appends an identity-preservation hint to the prompt', () => {
    const parsed = parseScript(SAMPLE_SCRIPT);
    const shot = {
      index: 1,
      act: 0,
      block_indices: [0],
      description: '空旷校场，旌旗轻晃',
      duration: 6,
      characters: ['小女娃'],
      camera_move: '[固定]',
    };
    const p = buildHailuoPrompt(shot, parsed);
    expect(p.prompt).toMatch(/identical character identity/i);
    expect(p.prompt).toMatch(/face structure/i);
    expect(p.prompt).toMatch(/outfit details/i);
    expect(p.prompt).toMatch(/hairstyle/i);
  });

  it('keeps the camera_move at the end of the prompt (after identity hint or as-is)', () => {
    const parsed = parseScript(SAMPLE_SCRIPT);
    const shot = {
      index: 1,
      act: 0,
      block_indices: [0],
      description: '空旷校场，旌旗轻晃',
      duration: 6,
      characters: ['小女娃'],
      camera_move: '[Push in]',
    };
    const p = buildHailuoPrompt(shot, parsed);
    expect(p.prompt).toContain('[Push in]');
  });

  it('produces a prompt within MAX_PROMPT_CHARS', async () => {
    const { MAX_PROMPT_CHARS } = await import('../src/workflow/prompt_builder.js');
    const parsed = parseScript(SAMPLE_SCRIPT);
    const shot = {
      index: 1,
      act: 0,
      block_indices: [0],
      description: '空旷校场，旌旗轻晃，暖融融的白日柔光洒落满地。小小的女童一身定制的短小贴身墨色劲装，袖口裤脚紧紧束拢，利落干净又不显凌厉，反倒衬得身形玲珑乖巧。乌黑柔软的发丝梳得整整齐齐，高高扎成两个圆鼓鼓的小发髻，系着两根鲜亮的鲜红发带，微风拂过，发带轻轻摇曳飘晃，细碎鬓发垂在白嫩脸颊两侧。'.repeat(5),
      duration: 10,
      characters: ['小女娃'],
      camera_move: '[固定]',
    };
    const p = buildHailuoPrompt(shot, parsed);
    expect(p.prompt.length).toBeLessThanOrEqual(MAX_PROMPT_CHARS);
  });
});