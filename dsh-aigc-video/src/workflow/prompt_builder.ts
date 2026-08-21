/**
 * Hailuo-2.3 prompt builder.
 *
 * Given a DecomposedShot + the parsed script (for character/setting
 * context), produce a single-line prompt ≤ 2000 chars that:
 *   1. Sets the scene in English (better model alignment than Chinese).
 *   2. Names characters with traits pulled from the script.
 *   3. Describes the action (translated/paraphrased from the original
 *      Chinese direction).
 *   4. Appends camera-move bracketed instructions.
 *
 * Hailuo-2.3 prompt grammar (from official docs):
 *   "{scene description}, [camera_move], ...up to 2000 chars."
 */

import type { DecomposedShot } from './shot_decomposer.js';
import type { ParsedScript } from './script_parser.js';

export const MAX_PROMPT_CHARS = 2000;

export interface HailuoPrompt {
  shot_index: number;
  prompt: string;
  duration: number;
  characters: string[];
  /** Camera move tokens (already inside `prompt`, kept separately for audit). */
  camera_move: string;
}

const ACTION_TRANSLATIONS: Array<{ from: RegExp; to: string }> = [
  // Chinese idiom → English action (lightweight dictionary; not exhaustive).
  { from: /迈着.*?步伐/gi, to: 'struts forward' },
  { from: /走上场|走上来/gi, to: 'walks onto the scene' },
  { from: /跑出场|跑上来/gi, to: 'runs onto the scene' },
  { from: /抬头挺胸/gi, to: 'chin up, chest out' },
  { from: /甩着大尾巴/gi, to: 'swishing tail' },
  { from: /叉腰/gi, to: 'hands on hips' },
  { from: /一脸傲娇/gi, to: 'arrogant expression' },
  { from: /对着观众.*?挑眉/gi, to: 'glances at the audience with a raised eyebrow' },
  { from: /慢悠悠|晃晃悠悠/gi, to: 'slowly and unsteadily' },
  { from: /抱着满满一罐/gi, to: 'clutching a jar of' },
  { from: /瞬间切换.*?模式/gi, to: 'instantly switching to a sweet, innocent mode' },
  { from: /凑上去/gi, to: 'sidles up' },
  { from: /挠挠头/gi, to: 'scratches head' },
  { from: /眼睛瞬间发亮/gi, to: 'eyes light up' },
  { from: /抱紧/gi, to: 'hugs tightly' },
  { from: /故作高深/gi, to: 'puts on a mysterious air' },
  { from: /背手踱步/gi, to: 'paces with hands clasped behind back' },
  { from: /用力点头/gi, to: 'nods vigorously' },
  { from: /紧紧闭眼/gi, to: 'squeezes eyes shut' },
  { from: /闭眼/gi, to: 'closes eyes tightly' },
  { from: /一动不动/gi, to: 'freezes in place' },
  { from: /转身/gi, to: 'turns around' },
  { from: /露出奸笑/gi, to: 'a sneaky grin spreads across face' },
  { from: /小声嘚瑟/gi, to: 'mutters smugly' },
  { from: /跑得太急/gi, to: 'runs too fast' },
  { from: /脚底打滑/gi, to: 'feet slip out' },
  { from: /四脚朝天摔/gi, to: 'falls flat on back' },
  { from: /尾巴炸成/gi, to: 'tail puffs out' },
  { from: /脱手飞起/gi, to: 'flies out of grasp' },
  { from: /惨叫/gi, to: 'screams in pain' },
  { from: /蜂蜜罐稳稳落地/gi, to: 'honey jar lands perfectly' },
  { from: /缓缓睁开眼睛/gi, to: 'slowly opens eyes' },
  { from: /一脸纯真/gi, to: 'innocent expression' },
  { from: /疑惑发问/gi, to: 'asks in confusion' },
  { from: /蹦蹦跳跳.*?上场/gi, to: 'bounces onto the scene' },
  { from: /躲在大树后/gi, to: 'hiding behind a tree' },
  { from: /笑得直捂肚子/gi, to: 'laughs holding belly' },
  { from: /原地蹦跳/gi, to: 'jumps in place' },
  { from: /狼狈爬起/gi, to: 'crawls up in a mess' },
  { from: /浑身沾满/gi, to: 'covered in' },
  { from: /尾巴耷拉下来/gi, to: 'tail droops' },
  { from: /强行挽尊/gi, to: 'tries to salvage dignity' },
  { from: /挺直身子/gi, to: 'straightens up' },
  { from: /故作淡定/gi, to: 'puts on a calm face' },
  { from: /似懂非懂/gi, to: 'half-understanding nod' },
  { from: /眉头一皱/gi, to: 'frowns' },
  { from: /补刀吐槽/gi, to: 'follows up with a jab' },
  { from: /面子挂不住/gi, to: 'loses face completely' },
  { from: /胡搅蛮缠/gi, to: 'starts blabbering excuses' },
  { from: /叉腰嚷嚷/gi, to: 'shouts with hands on hips' },
  { from: /用力过猛/gi, to: 'swings too hard' },
  { from: /扫飞/gi, to: 'knocks away' },
  { from: /精准砸在.*?脑门上/gi, to: 'smashes right onto the forehead' },
  { from: /僵住/gi, to: 'freezes up' },
  { from: /两眼冒星星/gi, to: 'sees stars' },
  { from: /晕乎乎/gi, to: 'dizzy and dazed' },
  { from: /喃喃自语/gi, to: 'mumbles to self' },
  { from: /扶着脑袋/gi, to: 'holds head in hand' },
  { from: /慢慢站直/gi, to: 'slowly straightens up' },
  { from: /一脸生无可恋/gi, to: 'worn-out, dead-inside expression' },
  { from: /对着观众叹气/gi, to: 'sighs at the audience' },
  { from: /面向观众鞠躬/gi, to: 'all three bow to the audience' },
  { from: /灯光暗/gi, to: 'lights dim' },
  // Fillers that frequently appear in 中文剧本
  { from: /摆放一堆/gi, to: 'some' },
  { from: /几颗/gi, to: 'some' },
  { from: /一棵大树下/gi, to: 'under a large tree' },
  { from: /开场/gi, to: 'opening' },
  { from: /主角/gi, to: 'a protagonist' },
  { from: /的小狐狸/gi, to: 'a comedic fox' },
  { from: /的小熊/gi, to: 'a bear' },
  { from: /的小兔子/gi, to: 'a rabbit' },
  { from: /双手/gi, to: 'both hands' },
  { from: /立刻/gi, to: 'suddenly' },
  { from: /见状/gi, to: 'seeing this' },
  { from: /瞬间/gi, to: 'instantly' },
  { from: /精确砸/gi, to: 'smashes precisely' },
  { from: /闭眼等待/gi, to: 'waiting with eyes shut' },
  { from: /落幕/gi, to: 'curtain falls' },
  { from: /三人一起/gi, to: 'all three' },
  { from: /尾巴用力过猛/gi, to: 'tail swings too hard' },
  { from: /抖尾巴/gi, to: 'swishes tail' },
  { from: /闪过/gi, to: 'flashes by' },
  { from: /扭头/gi, to: 'turns head' },
  { from: /一步三晃/gi, to: 'walking with sway' },
  { from: /撒娇/gi, to: 'acting cute' },
  { from: /嘴巴一撇/gi, to: 'pouts' },
  { from: /抓起/gi, to: 'grabs' },
  { from: /猛地/gi, to: 'suddenly' },
  { from: /噗嗤/gi, to: 'snorts' },
];

const SETTING_TRANSLATIONS: Array<{ from: RegExp; to: string }> = [
  { from: /夏日森林草坪/gi, to: 'summer forest meadow' },
  { from: /一棵大树下/gi, to: 'under a large tree' },
  { from: /野生蜂蜜罐/gi, to: 'wild honey jars' },
  { from: /大西瓜/gi, to: 'big watermelons' },
];

const TRAIT_TRANSLATIONS: Array<{ from: RegExp; to: string }> = [
  { from: /极度自恋/gi, to: 'extremely narcissistic' },
  { from: /自作聪明/gi, to: 'thinks he is clever' },
  { from: /嘴硬心软/gi, to: 'tough outside, soft inside' },
  { from: /干啥啥翻车/gi, to: 'fails at everything' },
  { from: /搞笑狐狸/gi, to: 'a comedic fox' },
  { from: /憨厚老实/gi, to: 'simple and honest' },
  { from: /反应慢半拍/gi, to: 'slow to react' },
  { from: /纯天然呆/gi, to: 'naturally clueless' },
  { from: /机灵通透/gi, to: 'sharp and witty' },
  { from: /看热闹不嫌事大/gi, to: 'loves to watch drama unfold' },
];

export function buildHailuoPrompt(
  shot: DecomposedShot,
  script: ParsedScript
): HailuoPrompt {
  // 1. Resolve characters with traits
  const charDescs = shot.characters
    .map((name) => {
      const c = script.characters.find((cc) => cc.name === name);
      const translated = c ? translateText(c.description, TRAIT_TRANSLATIONS) : '';
      return `${name}${translated ? `, ${translated}` : ''}`;
    })
    .filter(Boolean);

  // 2. Translate action / setting
  const actionEn = translateText(shot.description, [
    ...SETTING_TRANSLATIONS,
    ...ACTION_TRANSLATIONS,
  ]);
  const settingEn = translateText(script.setting, SETTING_TRANSLATIONS);

  // 3. Compose prompt
  const parts: string[] = [];
  if (settingEn) parts.push(`Scene: ${settingEn}.`);
  if (charDescs.length) parts.push(`Characters: ${charDescs.join('; ')}.`);
  parts.push(actionEn);
  if (shot.camera_move) parts.push(shot.camera_move);

  // v3.3 (subject-consistency hardening): Hailuo v2 `reference_image` is a
  // soft signal — it doesn't hard-lock identity. We compensate by adding an
  // explicit identity-preservation sentence at the end of the prompt. This
  // makes the model RE-STATE the constraint in text form, which empirically
  // helps it hold identity across distant shots in the same series.
  const IDENTITY_HINT =
    'Maintain identical character identity throughout: same face structure, ' +
    'same outfit details, same body proportions, same hairstyle and accessories.';

  const basePrompt = parts.join(' ');
  // Truncation policy: keep camera_move; drop the identity hint first if the
  // combined length exceeds MAX_PROMPT_CHARS (identity hint is enhancement,
  // camera_move is structurally required).
  let prompt: string;
  if (basePrompt.length <= MAX_PROMPT_CHARS) {
    prompt = basePrompt + (basePrompt.length + IDENTITY_HINT.length + 1 <= MAX_PROMPT_CHARS
      ? ' ' + IDENTITY_HINT
      : '');
  } else {
    // Base too long: trim and append identity hint only if room remains.
    const keepCamera = shot.camera_move ? ' ' + shot.camera_move : '';
    const trimmed = basePrompt.slice(0, MAX_PROMPT_CHARS - keepCamera.length - IDENTITY_HINT.length - 2);
    prompt = trimmed + keepCamera + ' ' + IDENTITY_HINT;
  }

  return {
    shot_index: shot.index,
    prompt,
    duration: shot.duration,
    characters: shot.characters,
    camera_move: shot.camera_move,
  };
}

function translateText(input: string, rules: ReadonlyArray<{ from: RegExp; to: string }>): string {
  if (!input) return '';
  let out = input;
  // Apply dictionary rules first (longest matches first).
  for (const rule of rules) {
    out = out.replace(rule.from, rule.to);
  }
  // Bracket any remaining CJK runs so the model doesn't see mixed scripts.
  out = out.replace(/[\u4e00-\u9fff]+/g, (m) => `[${m}]`);
  // Strip dangling grammatical particles that survive translation.
  out = out
    .replace(/\[\s*的\s*\]\s*/g, ' ')
    .replace(/\[\s*了\s*\]\s*/g, ' ')
    .replace(/\[\s*一\s*\]\s*/g, ' ')
    .replace(/\[\s*里\s*\]\s*/g, ' ')
    .replace(/\[\s*上\s*\]\s*/g, ' ')
    .replace(/\[\s*下\s*\]\s*/g, ' ')
    .replace(/\[\s*中\s*\]\s*/g, ' ')
    .replace(/\[\s*在\s*\]\s*/g, ' ')
    .replace(/\[\s*是\s*\]\s*/g, ' ')
    .replace(/\[\s*有\s*\]\s*/g, ' ')
    .replace(/\[\s*\u2026\s*\]\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1');
  return out.trim();
}
