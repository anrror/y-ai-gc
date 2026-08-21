/**
 * Unit tests for voice generation:
 *   - MiniMaxTtsProvider body building (model/voice/setting/audio)
 *   - voice_director agent without TTS provider returns proper error
 *   - system voices list
 *   - hasXfade() behaviour already covered in ffmpeg.test logic (n/a here)
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MiniMaxTtsProvider, SYSTEM_VOICES } from '../src/providers/audio/tts.js';
import { VoiceDirectorAgent } from '../src/agents/voice_director.js';
import type { TtsRequest, TtsProvider } from '../src/providers/types.js';

describe('MiniMaxTtsProvider (mocked HTTP)', () => {
  let tmp: string;
  let provider: MiniMaxTtsProvider;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'tts-test-'));
    provider = new MiniMaxTtsProvider({
      apiKey: 'mock-key',
      baseUrl: 'https://mock.minimaxi.com',
      model: 'speech-2.8-hd',
    });
  });
  afterAll(() => {
    try { rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* */ }
  });

  it('system voices list is non-empty and well-formed', () => {
    expect(SYSTEM_VOICES.length).toBeGreaterThan(5);
    for (const v of SYSTEM_VOICES) {
      expect(v.id).toBeTruthy();
      expect(v.name).toBeTruthy();
      expect(v.lang).toBeTruthy();
    }
  });

  it('submit() POSTs to /v1/t2a_v2 with model + voice_setting + audio_setting', async () => {
    // Mock the http client.
    const http = provider['http'] as unknown as { request: ReturnType<typeof vi.fn> };
    const requestSpy = vi.fn().mockResolvedValue({
      data: { audio: 'deadbeef', status: 2 },
      extra_info: { audio_length: 1000, audio_sample_rate: 32000, audio_size: 16, bitrate: 128000, word_count: 1, usage_characters: 1, audio_format: 'mp3', audio_channel: 1 },
      base_resp: { status_code: 0, status_msg: 'success' },
    });
    (provider as unknown as { http: { request: typeof requestSpy } }).http = { request: requestSpy };

    const out = join(tmp, 'test.mp3');
    const req: TtsRequest = {
      text: 'hello world',
      voiceId: 'female-shaonv',
      emotion: 'happy',
      outputPath: out,
    };
    const path = await provider.submit(req);
    expect(path).toBe(out);
    expect(requestSpy).toHaveBeenCalledTimes(1);
    const [call] = requestSpy.mock.calls[0] as [Record<string, unknown>];
    expect(call).toMatchObject({
      method: 'POST',
      url: 'https://mock.minimaxi.com/v1/t2a_v2',
    });
    const body = call.body as Record<string, unknown>;
    expect(body.model).toBe('speech-2.8-hd');
    expect(body.text).toBe('hello world');
    const vs = body.voice_setting as Record<string, unknown>;
    expect(vs.voice_id).toBe('female-shaonv');
    expect(vs.emotion).toBe('happy');
    const as_ = body.audio_setting as Record<string, unknown>;
    expect(as_.sample_rate).toBe(32000);
    expect(as_.format).toBe('mp3');
  });

  it('submit() throws on non-zero status_code', async () => {
    const http = provider['http'] as unknown as { request: ReturnType<typeof vi.fn> };
    const requestSpy = vi.fn().mockResolvedValue({
      data: { audio: '', status: 2 },
      base_resp: { status_code: 2013, status_msg: 'invalid params' },
    });
    (provider as unknown as { http: { request: typeof requestSpy } }).http = { request: requestSpy };
    await expect(provider.submit({ text: 'x', voiceId: 'female-shaonv', outputPath: join(tmp, 'a.mp3') })).rejects.toThrow(/invalid params/);
  });

  it('submit() throws when audio is empty', async () => {
    const http = provider['http'] as unknown as { request: ReturnType<typeof vi.fn> };
    const requestSpy = vi.fn().mockResolvedValue({
      data: { audio: '', status: 2 },
      base_resp: { status_code: 0, status_msg: 'success' },
    });
    (provider as unknown as { http: { request: typeof requestSpy } }).http = { request: requestSpy };
    await expect(provider.submit({ text: 'x', voiceId: 'female-shaonv', outputPath: join(tmp, 'b.mp3') })).rejects.toThrow(/empty audio/);
  });
});

describe('VoiceDirectorAgent', () => {
  it('returns helpful error when no TTS provider is configured', async () => {
    const agent = new VoiceDirectorAgent({}); // no deps
    const out = await agent.run({
      session_id: 's',
      project_name: 'p',
      user_prompt: 'hello',
      meta: {
        storyboard: { shots: [{ index: 1, description: 'a', characters: ['fox'] }] },
        script_generation: { characters: [{ name: 'fox' }] },
      },
      is_final_attempt: true,
    });
    expect(out.completed).toBe(false);
    expect(out.error).toMatch(/TTS provider/);
  });

  it('returns "missing storyboard" when storyboard artifact absent', async () => {
    const fakeTts: TtsProvider = {
      providerName: 'fake',
      submit: async () => '',
      poll: async () => ({ status: 'succeeded' }),
      cloneVoice: async () => ({ voiceId: 'x' }),
      listSystemVoices: () => [],
    };
    const agent = new VoiceDirectorAgent({ tts: fakeTts });
    const out = await agent.run({
      session_id: 's', project_name: 'p', user_prompt: 'hello',
      meta: {}, is_final_attempt: true,
    });
    expect(out.completed).toBe(false);
    expect(out.requires_intervention).toBe(true);
    expect(out.error).toMatch(/storyboard/);
  });
});
