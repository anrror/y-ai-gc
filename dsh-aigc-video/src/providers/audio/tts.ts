/**
 * MiniMax TTS provider — wraps `/v1/t2a_v2` (TTS) and `/v1/voice_clone`.
 *
 * Capabilities per MiniMax T2A v2 docs:
 *   - Models: speech-2.8-hd, speech-2.8-turbo, speech-2.6-hd, speech-2.6-turbo,
 *             speech-02-hd/turbo, speech-01-hd/turbo
 *   - 8 emotions (happy/sad/angry/fearful/disgusted/surprised/calm/fluent/whisper)
 *   - 21+ inline emotion tags: (laughs), (chuckle), (coughs), (clear-throat),
 *     (groans), (breath), (pant), (inhale), (exhale), (gasps), (sniffs),
 *     (sighs), (snorts), (burps), (lip-smacking), (humming), (hissing),
 *     (emm), (whistles), (sneezes), (crying), (applause)
 *   - 300+ system voices (Chinese/English/Japanese/Cantonese/...)
 *   - Timbre mixing (up to 4 voices with weights)
 *   - Pronunciation dict (拼音/IPA/粤语)
 *   - Voice clone (10s-5min, ≤20MB, mp3/m4a/wav)
 *   - 36 languages via language_boost
 *   - Streaming and non-streaming
 *   - Audio formats: mp3, pcm, flac, wav, pcmu_raw, pcmu_wav, opus
 *   - Voice modify: pitch/intensity/timbre
 *   - Sound effects: spacious_echo, auditorium_echo, lofi_telephone, robotic
 *   - Subtitle generation (sentence/word/word_streaming)
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { BaseProvider, ProviderError, ProviderHttpError } from '../base.js';
import type { ProviderConfig } from '../config.js';
import type { TtsProvider, TtsRequest, TtsVoice } from '../types.js';

/** T2A v2 model enum. */
export const T2A_MODELS = [
  'speech-2.8-hd',
  'speech-2.8-turbo',
  'speech-2.6-hd',
  'speech-2.6-turbo',
  'speech-02-hd',
  'speech-02-turbo',
  'speech-01-hd',
  'speech-01-turbo',
] as const;
export type T2AModel = (typeof T2A_MODELS)[number];

/** Curated system voices (subset — full list via /v1/voice_list API). */
export const SYSTEM_VOICES: ReadonlyArray<TtsVoice> = [
  { id: 'male-qn-qingse', name: '清澈男声', lang: 'zh', gender: 'male' },
  { id: 'male-qn-jingying', name: '精英男声', lang: 'zh', gender: 'male' },
  { id: 'Chinese (Mandarin)_HK_Flight_Attendant', name: '粤语空乘', lang: 'zh', gender: 'female' },
  { id: 'female-shaonv', name: '少女音', lang: 'zh', gender: 'female' },
  { id: 'female-yujie', name: '御姐音', lang: 'zh', gender: 'female' },
  { id: 'Chinese (Mandarin)_Lyrical_Voice', name: '抒情女声', lang: 'zh', gender: 'female' },
  { id: 'English_Graceful_Lady', name: 'English Graceful Lady', lang: 'en', gender: 'female' },
  { id: 'English_Insightful_Speaker', name: 'English Insightful Speaker', lang: 'en', gender: 'male' },
  { id: 'English_radiant_girl', name: 'English Radiant Girl', lang: 'en', gender: 'female' },
  { id: 'English_Persuasive_Man', name: 'English Persuasive Man', lang: 'en', gender: 'male' },
  { id: 'English_Lucky_Robot', name: 'English Lucky Robot', lang: 'en', gender: 'neutral' },
  { id: 'Japanese_Whisper_Belle', name: 'Japanese Whisper Belle', lang: 'ja', gender: 'female' },
  { id: 'Cantonese_GentleLady', name: '粤语温柔女声', lang: 'zh-yue', gender: 'female' },
  { id: 'Cantonese_podacast_host_1', name: '粤语主播', lang: 'zh-yue', gender: 'male' },
];

export interface TtsProviderOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

function asTtsProviderConfig(opts: TtsProviderOptions): ProviderConfig {
  return {
    apiKey: opts.apiKey,
    baseUrl: opts.baseUrl ?? 'https://api.minimaxi.com',
    modelName: opts.model,
    concurrency: 1,
  };
}

export class MiniMaxTtsProvider extends BaseProvider implements TtsProvider {
  readonly providerName = 'minimax-tts';
  private clonedVoices = new Map<string, string>();

  constructor(opts: TtsProviderOptions) {
    super(asTtsProviderConfig(opts));
  }

  /** Synchronous TTS — returns the local output path of the synthesised file. */
  async submit(req: TtsRequest): Promise<string> {
    const body = this.buildT2aBody(req);
    const url = `${this.baseUrl}/v1/t2a_v2`;
    const resp = await this.http.request<{ data?: { audio?: string; status?: number }; base_resp?: { status_code: number; status_msg: string } }>({
      method: 'POST',
      url,
      body,
      headers: { 'Content-Type': 'application/json' },
      timeoutMs: req.timeoutMs ?? 120_000,
    });
    const code = resp.base_resp?.status_code ?? 0;
    if (code !== 0) {
      // P0-2: convert raw base_resp into a typed ProviderError so callers
      // can branch on kind (e.g. quota_exceeded → abort run).
      const msg = resp.base_resp?.status_msg ?? `status ${code}`;
      const fakeHttp = new ProviderHttpError(200, `tts: MiniMax t2a_v2 failed: ${msg}`, code, msg);
      throw ProviderError.fromHttp(fakeHttp);
    }
    const hexAudio = resp.data?.audio;
    if (!hexAudio) {
      throw new ProviderError('bad_request', 'tts: empty audio in response');
    }
    const buf = Buffer.from(hexAudio, 'hex');
    const outPath = req.outputPath ?? this.defaultOutputPath(req);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, buf);
    return outPath;
  }

  async poll(_taskId: string): Promise<{ status: 'succeeded' | 'failed' | 'pending'; audioUrl?: string; error?: string }> {
    return { status: 'succeeded' };
  }

  /** Clone a voice from a reference audio (10s-5min, ≤20MB mp3/m4a/wav). */
  async cloneVoice(opts: {
    sourceFileId: string;
    voiceId: string;
    clonePrompt?: { promptFileId: string; promptText: string };
    testText?: string;
    model?: T2AModel;
    accuracy?: number;
    textValidation?: string;
    needNoiseReduction?: boolean;
    needVolumeNormalization?: boolean;
  }): Promise<{ voiceId: string; demoAudioUrl?: string }> {
    if (this.clonedVoices.has(opts.voiceId)) {
      return { voiceId: opts.voiceId, demoAudioUrl: this.clonedVoices.get(opts.voiceId) };
    }
    const body: Record<string, unknown> = {
      file_id: Number(opts.sourceFileId),
      voice_id: opts.voiceId,
      need_noise_reduction: opts.needNoiseReduction ?? false,
      need_volume_normalization: opts.needVolumeNormalization ?? false,
    };
    if (opts.clonePrompt) {
      body.clone_prompt = {
        prompt_audio: Number(opts.clonePrompt.promptFileId),
        prompt_text: opts.clonePrompt.promptText,
      };
    }
    if (opts.testText && opts.model) {
      body.text = opts.testText;
      body.model = opts.model;
    }
    if (opts.accuracy !== undefined) body.accuracy = opts.accuracy;
    if (opts.textValidation) body.text_validation = opts.textValidation;

    const url = `${this.baseUrl}/v1/voice_clone`;
    const resp = await this.http.request<{
      demo_audio?: string;
      base_resp?: { status_code: number; status_msg: string };
    }>({
      method: 'POST',
      url,
      body,
      headers: { 'Content-Type': 'application/json' },
      timeoutMs: 180_000,
    });
    if (resp.base_resp?.status_code !== 0) {
      const code = resp.base_resp?.status_code ?? -1;
      const msg = resp.base_resp?.status_msg ?? 'unknown';
      const fakeHttp = new ProviderHttpError(200, `tts: voice_clone failed: ${msg}`, code, msg);
      throw ProviderError.fromHttp(fakeHttp);
    }
    if (resp.demo_audio) {
      this.clonedVoices.set(opts.voiceId, resp.demo_audio);
    }
    return { voiceId: opts.voiceId, demoAudioUrl: resp.demo_audio };
  }

  listSystemVoices(): ReadonlyArray<TtsVoice> {
    return SYSTEM_VOICES;
  }

  private buildT2aBody(req: TtsRequest): Record<string, unknown> {
    const model = req.model ?? 'speech-2.8-hd';
    const body: Record<string, unknown> = {
      model,
      text: req.text,
      stream: req.stream ?? false,
      voice_setting: {
        voice_id: req.voiceId,
        speed: req.speed ?? 1.0,
        vol: req.volume ?? 1.0,
        pitch: req.pitch ?? 0,
        ...(req.emotion ? { emotion: req.emotion } : {}),
      },
      audio_setting: {
        sample_rate: req.sampleRate ?? 32000,
        bitrate: req.bitrate ?? 128000,
        format: req.format ?? 'mp3',
        channel: req.channel ?? 1,
      },
    };
    if (req.pronunciationDict?.length) {
      body.pronunciation_dict = { tone: req.pronunciationDict };
    }
    if (req.timbreWeights?.length) {
      body.timbre_weights = req.timbreWeights;
    }
    if (req.languageBoost) body.language_boost = req.languageBoost;
    if (req.subtitleEnable) {
      body.subtitle_enable = true;
      body.subtitle_type = req.subtitleType ?? 'sentence';
    }
    if (req.outputFormat) body.output_format = req.outputFormat;
    return body;
  }

  private defaultOutputPath(req: TtsRequest): string {
    const ext = req.format ?? 'mp3';
    const safeText = req.text.slice(0, 32).replace(/[^a-z0-9\u4e00-\u9fff]/gi, '_');
    return `code/result/voice/${req.voiceId}_${safeText}_${Date.now()}.${ext}`;
  }
}