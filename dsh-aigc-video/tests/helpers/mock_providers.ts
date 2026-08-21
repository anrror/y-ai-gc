/**
 * Reusable mock providers for vitest.
 *
 * Lives in `tests/helpers/` so individual test files don't reinvent the
 * same fake Hailuo / TTS / downloader. Each mock is the minimal shape
 * the corresponding real provider needs (`VideoProvider`, `TtsProvider`,
 * or the duck-typed downloader slot in CreativePipeline).
 *
 * Usage:
 *   import { MockVideoProvider, FailingDownloader } from './helpers/mock_providers.js';
 *   const pipe = new CreativePipeline(new MockVideoProvider(), {
 *     ffmpeg: new FailingDownloader(),
 *   });
 */

import { writeFileSync } from 'node:fs';
import type { VideoGenerationRequest, VideoProvider, VideoResult } from '../../src/providers/types.js';
import type { TtsProvider, TtsRequest, TtsResult } from '../../src/providers/types.js';

// ── Video provider mocks ──────────────────────────────────────────────────

/**
 * Records every submit() invocation; poll() always reports succeeded with
 * a fake URL. Use `submits[i]` to assert what was sent to Hailuo.
 */
export class MockVideoProvider implements VideoProvider {
  readonly providerName: string;
  public readonly submits: VideoGenerationRequest[] = [];
  /** If set, submit() throws this on the Nth call (1-indexed). */
  public failOnCall: { call: number; error: Error } | undefined;
  /** Per-task status override. When set, poll(taskId) returns this status. */
  public statusOverrides: Map<string, VideoResult['status']> | undefined;

  constructor(providerName = 'mock') {
    this.providerName = providerName;
  }

  async submit(req: VideoGenerationRequest): Promise<string> {
    this.submits.push(req);
    if (this.failOnCall && this.failOnCall.call === this.submits.length) {
      throw this.failOnCall.error;
    }
    return `task-${this.submits.length}`;
  }

  async poll(taskId: string): Promise<VideoResult> {
    const status = this.statusOverrides?.get(taskId) ?? 'succeeded';
    if (status === 'succeeded') {
      return { taskId, status: 'succeeded', videoUrl: `https://example.com/${taskId}.mp4` };
    }
    return { taskId, status };
  }
}

/** Always fails submit — useful for testing the failure / quota-abort paths. */
export class FailingVideoProvider implements VideoProvider {
  readonly providerName = 'fail';
  constructor(private readonly error: Error = new Error('provider down')) {}
  async submit(): Promise<string> { throw this.error; }
  async poll(): Promise<VideoResult> { return { taskId: 'x', status: 'failed' }; }
}

// ── TTS provider mocks ───────────────────────────────────────────────────

/** Records submit() calls; returns a fake MP3 path. */
export class MockTtsProvider implements TtsProvider {
  readonly providerName = 'mock-tts';
  public readonly submits: TtsRequest[] = [];
  async submit(req: TtsRequest): Promise<string> {
    this.submits.push(req);
    return req.outputPath ?? '/tmp/mock-tts.mp3';
  }
  async poll(): Promise<{ status: 'succeeded' | 'failed' | 'pending'; audioUrl?: string; error?: string }> {
    return { status: 'succeeded', audioUrl: 'https://example.com/mock-tts.mp3' };
  }
  async cloneVoice(): Promise<{ voiceId: string; demoAudioUrl?: string }> {
    return { voiceId: 'cloned' };
  }
  listSystemVoices(): ReadonlyArray<{ id: string; name: string; lang: string; gender?: 'male' | 'female' | 'neutral'; cloned?: boolean }> {
    return [
      { id: 'female-shaonv', name: '少女音', lang: 'zh' },
      { id: 'male-qn-qingse', name: '青涩男声', lang: 'zh' },
    ];
  }
}

/** TTS that throws on submit — for testing the dub-mode TTS-failure path. */
export class FailingTtsProvider implements TtsProvider {
  readonly providerName = 'fail-tts';
  constructor(private readonly error: Error = new Error('TTS service down')) {}
  async submit(): Promise<string> { throw this.error; }
  async poll(): Promise<{ status: 'succeeded' | 'failed' | 'pending' }> {
    return { status: 'failed', error: this.error.message };
  }
  async cloneVoice(): Promise<{ voiceId: string }> { return { voiceId: 'x' }; }
  listSystemVoices() { return []; }
}

// ── Downloader mocks (CreativePipeline duck-type) ─────────────────────────

/** Writes a 2 KB stub MP4 to the destination. */
export class StubDownloader {
  public readonly downloads: Array<{ url: string; dest: string }> = [];
  async download(url: string, dest: string): Promise<string> {
    this.downloads.push({ url, dest });
    writeFileSync(dest, Buffer.alloc(2048, 0x42));
    return dest;
  }
}

/** Always throws — keeps CreativePipeline's `download` step non-functional
 * so tests can assert on `shots_failed` without writing to disk. */
export class FailingDownloader {
  async download(_url: string, _dest: string): Promise<string> {
    throw new Error('mock download disabled');
  }
}