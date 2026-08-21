/**
 * Provider interfaces — shared types for LLM / Image / Video / VLM.
 *
 * Concrete providers (DeepSeek, Hailuo, Kling, Wan, …) live in
 * sibling files and export a factory that takes a `ProviderConfig` and
 * returns an instance matching one of these interfaces.
 */

import type { ProviderConfig } from './config.js';

/** Canonical video-generation request — passed to a VideoProvider.execute. */
export interface VideoGenerationRequest {
  prompt: string;
  /** Provider-specific model id (e.g. 'MiniMax-Hailuo-2.3', 'kling-v3'). */
  model: string;
  /** Duration in seconds (4-15 typical). */
  duration: number;
  /** Output resolution (e.g. '768P', '1080P', '2K'). */
  resolution: string;
  /** Aspect ratio (e.g. '16:9', '9:16'); providers may ignore for i2v. */
  ratio: string;
  /** Optional first-frame image URL for i2v (otherwise t2v). */
  firstFrameImageUrl?: string;
  /** Optional last-frame image URL for fl2v. */
  lastFrameImageUrl?: string;
  /** Optional reference image URLs (subject consistency). */
  referenceImages?: string[];
  /** Optional reference video URLs (motion transfer). */
  referenceVideos?: string[];
  /** Cancellation signal for cooperative cancellation. */
  signal?: AbortSignal;
}

/** Progress emitted while polling a long-running video task. */
export interface VideoProgress {
  /** Status string from the provider (e.g. 'Processing', 'succeeded'). */
  status: string;
  /** Elapsed seconds since submit (provider-reported or local). */
  elapsedSec: number;
  /** Optional human-readable message. */
  message?: string;
}

/** Final result of a video-generation task. */
export interface VideoResult {
  /** Provider-assigned task id. */
  taskId: string;
  /** Provider status string ('succeeded' / 'failed' / etc.). */
  status: string;
  /** Downloadable URL for the generated MP4 (only when status='succeeded'). */
  videoUrl?: string;
  /** Provider-side error message (only when status='failed'). */
  error?: string;
  /** Which API generation was used. Set when known. */
  apiVersion?: 'v1' | 'v2';
}

/** Generic LLM chat request. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Tool / function calling JSON schema (optional). */
  tools?: unknown;
  signal?: AbortSignal;
}

export interface ChatResponse {
  content: string;
  model: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  finishReason?: string;
}

/** Image-generation request. */
export interface ImageGenerationRequest {
  prompt: string;
  model: string;
  width?: number;
  height?: number;
  /** Optional reference image URL for i2i. */
  referenceImageUrl?: string;
  n?: number;
  signal?: AbortSignal;
}

export interface ImageResult {
  images: Array<{ url: string; b64?: string; width?: number; height?: number }>;
  model: string;
}

/** VLM (vision-language) request — chat with images. */
export interface VlmRequest {
  model: string;
  messages: Array<ChatMessage & { imageUrls?: string[] }>;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

/** Provider base — every concrete provider implements one of these. */
export abstract class LLMProvider {
  abstract readonly providerName: string;
  abstract chat(req: ChatRequest): Promise<ChatResponse>;
}

export abstract class ImageProvider {
  abstract readonly providerName: string;
  abstract generate(req: ImageGenerationRequest): Promise<ImageResult>;
}

export abstract class VideoProvider {
  abstract readonly providerName: string;

  /** Submit a generation task; returns provider task id. */
  abstract submit(req: VideoGenerationRequest): Promise<string>;

  /** Poll task status. Should be idempotent. */
  abstract poll(taskId: string, signal?: AbortSignal): Promise<VideoResult>;
}

export abstract class VlmProvider {
  abstract readonly providerName: string;
  abstract chatWithImages(req: VlmRequest): Promise<ChatResponse>;
}

/** Helper to construct any provider from a `ProviderConfig`. */
export type ProviderFactory<T> = (cfg: ProviderConfig) => T;

/* ============================================================================
 * TTS (text-to-speech) — MiniMax Speech 2.8 / 2.6 / 02 / 01
 * ==========================================================================*/

export type TtsModel =
  | 'speech-2.8-hd'
  | 'speech-2.8-turbo'
  | 'speech-2.6-hd'
  | 'speech-2.6-turbo'
  | 'speech-02-hd'
  | 'speech-02-turbo'
  | 'speech-01-hd'
  | 'speech-01-turbo';

export type TtsEmotion =
  | 'happy' | 'sad' | 'angry' | 'fearful' | 'disgusted' | 'surprised' | 'calm' | 'fluent' | 'whisper';

export type TtsFormat = 'mp3' | 'pcm' | 'flac' | 'wav' | 'pcmu_raw' | 'pcmu_wav' | 'opus';

export interface TtsVoice {
  /** Provider voice_id (system voice id, cloned voice id, or designed id). */
  id: string;
  /** Human-readable display name. */
  name: string;
  /** ISO 639-1 / BCP-47 short code (e.g. 'zh', 'en', 'ja', 'zh-yue'). */
  lang: string;
  gender?: 'male' | 'female' | 'neutral';
  /** True if this voice was created via /v1/voice_clone. */
  cloned?: boolean;
}

export interface TtsTimbreWeight {
  voice_id: string;
  /** Integer weight 1-100. Multiple weights sum to a 4-voice mix. */
  weight: number;
}

export interface TtsProviderOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export interface TtsRequest {
  /** Script to synthesise. Up to 10000 chars; ≤3000 recommended for non-streaming. */
  text: string;
  /** voice_id of the speaker. */
  voiceId: string;
  /** Model id. Default: speech-2.8-hd. */
  model?: TtsModel;
  /** Speed multiplier [0.5, 2]. Default 1.0. */
  speed?: number;
  /** Volume (0, 10]. Default 1.0. */
  volume?: number;
  /** Pitch adjustment [-12, 12]. Default 0. */
  pitch?: number;
  /** Optional emotion control. */
  emotion?: TtsEmotion;
  /** Mix multiple voices (up to 4) by weighted blend. */
  timbreWeights?: TtsTimbreWeight[];
  /** Sample rate. Default 32000. */
  sampleRate?: number;
  /** Bitrate. Default 128000. */
  bitrate?: number;
  /** Output format. Default mp3. */
  format?: TtsFormat;
  /** Channel count [1, 2]. Default 1. */
  channel?: number;
  /** Pronunciation overrides: ['处理/(chu3)(li3)', ...]. */
  pronunciationDict?: string[];
  /** language_boost — null (auto) or specific language string. */
  languageBoost?: string;
  /** Enable subtitle generation (sentence/word/word_streaming). */
  subtitleEnable?: boolean;
  subtitleType?: 'sentence' | 'word' | 'word_streaming';
  /** 'url' returns a 24h-valid URL; 'hex' (default) returns audio bytes inline. */
  outputFormat?: 'url' | 'hex';
  /** Use streaming endpoint. */
  stream?: boolean;
  /** Optional explicit output path (otherwise provider default). */
  outputPath?: string;
  /** Cancellation signal. */
  signal?: AbortSignal;
  /** Per-request timeout. */
  timeoutMs?: number;
}

export interface TtsSubtitleCue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface TtsResult {
  /** Local file path to the synthesised audio. */
  outputPath: string;
  /** Provider-reported audio length (ms). */
  audioLengthMs?: number;
  /** Provider-reported sample rate. */
  sampleRate?: number;
  /** Provider-reported size (bytes). */
  audioSize?: number;
  /** Subtitle cues (only if subtitleEnable was true). */
  subtitles?: TtsSubtitleCue[];
  /** If outputFormat='url', the 24h-valid download URL. */
  audioUrl?: string;
}

export abstract class TtsProvider {
  abstract readonly providerName: string;
  /** Synchronous TTS — returns the local output path of the synthesised file. */
  abstract submit(req: TtsRequest): Promise<string>;
  /** Stream-mode TTS — returns the audio bytes (or a URL if outputFormat='url'). */
  abstract poll(taskId: string, signal?: AbortSignal): Promise<{ status: 'succeeded' | 'failed' | 'pending'; audioUrl?: string; error?: string }>;
  /** Clone a voice from a reference audio file (10s-5min, ≤20MB). */
  abstract cloneVoice(opts: {
    sourceFileId: string;
    voiceId: string;
    clonePrompt?: { promptFileId: string; promptText: string };
    testText?: string;
    model?: TtsModel;
    accuracy?: number;
    textValidation?: string;
    needNoiseReduction?: boolean;
    needVolumeNormalization?: boolean;
  }): Promise<{ voiceId: string; demoAudioUrl?: string }>;
  /** List curated system voices (full list requires /v1/voice_list). */
  abstract listSystemVoices(): ReadonlyArray<TtsVoice>;
}