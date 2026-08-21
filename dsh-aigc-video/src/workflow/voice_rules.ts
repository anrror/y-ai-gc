/**
 * Rule-based voice assignment for the end-to-end creative pipeline.
 *
 * The creative workflow's selling point is "no LLM required" — so we
 * can't call the LLM to assign voices the way `VoiceDirectorAgent` does.
 * Instead, we use a tiny Chinese-name → system-voice heuristic: detect
 * gender + age cues in the character name / description and map them to
 * the curated `SYSTEM_VOICES` table in `providers/audio/tts.ts`.
 *
 * Mapping rules (highest match first, fall through on miss):
 *   - 少女 / 小 / 可爱 / 萌           → female-shaonv (少女音)
 *   - 御姐 / 女王 / 大姐             → female-yujie (御姐音)
 *   - 抒情 / 温柔 / 柔和             → Chinese (Mandarin)_Lyrical_Voice
 *   - 粤语 + 女                       → Cantonese_GentleLady
 *   - 粤语 + 男 / 港                  → Cantonese_podacast_host_1
 *   - English + Lady / Girl           → English_Graceful_Lady / radiant_girl
 *   - English + Speaker / Man         → English_Insightful_Speaker / Persuasive_Man
 *   - 熊 / 憨 / 老 / 实 / 稳重        → male-qn-qingse (清澈男声)
 *   - 精英 / 商务 / 领导 / 男         → male-qn-jingying (精英男声)
 *   - (fallback)                      → female-shaonv
 *
 * Users who want a custom voice can pass `voice_id` directly in
 * `characters[].voice_id` — that overrides the rule.
 */

import { SYSTEM_VOICES } from '../providers/audio/tts.js';
import type { TtsVoice } from '../providers/types.js';

export interface CharacterVoice {
  /** Original character name. */
  name: string;
  /** Description / trait line (used for matching). */
  description?: string;
  /** Explicit voice id (overrides the rule). */
  voice_id?: string;
  /** Resolved voice — output of `assignVoiceByRule`. */
  resolved_voice_id?: string;
}

/**
 * Resolve a voice id from a name + description. If `voice_id` is
 * already set, validates it's in `SYSTEM_VOICES` (falls back to the
 * rule if not).
 */
export function assignVoiceByRule(char: CharacterVoice): string {
  if (char.voice_id) {
    const known = SYSTEM_VOICES.find((v) => v.id === char.voice_id);
    if (known) return known.id;
    // User-supplied custom id (clone / external) — pass through.
    return char.voice_id;
  }
  const text = `${char.name} ${char.description ?? ''}`.toLowerCase();
  return matchRule(text);
}

function matchRule(text: string): string {
  // English cues first (avoid CJK false-positives).
  if (/english|英文|en\b/i.test(text)) {
    if (/lady|girl|woman|female/.test(text)) return 'English_Graceful_Lady';
    if (/man|male|speaker|guy/.test(text)) return 'English_Insightful_Speaker';
    if (/robot|lucky/.test(text)) return 'English_Lucky_Robot';
    return 'English_Graceful_Lady';
  }
  // Cantonese cues.
  if (/粤语|广东|港|cantonese/.test(text)) {
    if (/男|哥|仔/.test(text)) return 'Cantonese_podacast_host_1';
    return 'Cantonese_GentleLady';
  }
  // Japanese (best-effort): we only ship one Japanese voice.
  if (/japanese|日语|jp\b/.test(text)) return 'Japanese_Whisper_Belle';
  // Chinese cues.
  if (/少女|小机灵|可爱|萌|机灵|机智|幼|小姑娘|小姑娘/i.test(text)) return 'female-shaonv';
  if (/御姐|女王|霸气|姐姐|母老虎|大女人/i.test(text)) return 'female-yujie';
  if (/抒情|温柔|柔和|优雅|舒缓/i.test(text)) return 'Chinese (Mandarin)_Lyrical_Voice';
  if (/熊|憨|老实|稳重|笨|憨厚|蠢|大块头/i.test(text)) return 'male-qn-qingse';
  if (/精英|商务|领导|总裁|严肃|老板|成年男人/i.test(text)) return 'male-qn-jingying';
  // Default (gender-blind).
  return 'female-shaonv';
}

/**
 * Resolve voice_id for every character in a list. Mutates + returns the
 * same list for ergonomic chaining.
 */
export function assignVoicesByRule(
  chars: Array<CharacterVoice>,
): Array<CharacterVoice & { resolved_voice_id: string }> {
  return chars.map((c) => ({
    ...c,
    resolved_voice_id: assignVoiceByRule(c),
  }));
}

/** Helper for tests / debug — pretty-print resolved voices. */
export function describeVoices(chars: Array<{ name: string; resolved_voice_id?: string }>): string {
  return chars.map((c) => `${c.name} → ${c.resolved_voice_id ?? '?'}`).join(', ');
}

/** Re-export `SYSTEM_VOICES` so callers can map id → display name. */
export function getVoiceById(id: string): TtsVoice | undefined {
  return SYSTEM_VOICES.find((v) => v.id === id);
}