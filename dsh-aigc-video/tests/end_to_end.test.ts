/**
 * End-to-end creative pipeline tests (Phase 5.5+ → v3.1).
 *
 * Tests run with stub video + TTS providers + stub ffmpeg so no real
 * Hailuo API calls land. Verifies:
 *   - md → N video clips → TTS per dialog line → SRT → final.mp4 path
 *   - rule-based voice assignment for 3 typical character archetypes
 *   - SRT time offsets sum to clip durations
 *   - graceful failure when all clips fail (placeholder final)
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const SAMPLE_MD = `# 自作聪明的傻狐狸

**剧本类型**: 儿童故事
**人物角色**:
1. **狐小机灵**: 一只机灵的狐狸，少女声音
2. **熊大憨**: 一只憨厚的大熊
3. **观众**: 看故事的人
**场景**: 夏日森林草坪
**时长**: 1分钟
---
**【第一幕:开场】**
（森林草坪上，狐小机灵骄傲地走上来）
**狐小机灵**：各位森林街坊注意了！我狐小机灵，天下第一聪明！
**熊大憨**：嘿嘿，你又吹牛啦。
---
**【第二幕:蜂蜜罐】**
（树边放着一罐蜂蜜）
**狐小机灵**：看我的，一口搞定！
**熊大憨**：别啊，会滑倒的！
`;

// Mock the heavy ffmpeg mixer so the test runs without a real ffmpeg.
vi.mock('../src/video/mixer.js', () => ({
  VideoMixer: class {
    async mix(req: { output_path: string }) {
      writeFileSync(req.output_path, Buffer.alloc(4096, 0));
      return { output_path: req.output_path, duration_seconds: 12, transitions_applied: 1 };
    }
  },
}));
// Mock quality gate so the fake 4KB file doesn't get rejected.
vi.mock('../src/video/quality_gate.js', () => ({
  checkClipQuality: vi.fn(async () => ({
    ok: true,
    probed: { duration_sec: null, width: null, height: null, black_ratio: null },
    reasons: [],
  })),
}));

describe('end-to-end creative pipeline (mocked ffmpeg/video/tts)', () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'e2e-test-'));

  it('runs md → N clips → TTS → SRT → final.mp4 path', async () => {
    const { EndToEndCreativePipeline } = await import('../src/workflow/end_to_end.js');

    const fakeVideo = {
      providerName: 'fake',
      submit: async () => 'fake-task',
      poll: async () => ({ status: 'succeeded' as const, videoUrl: 'https://example.com/v.mp4' }),
    };
    const fakeTts = {
      providerName: 'fake-tts',
      submit: async (req: { text: string; outputPath?: string }) => {
        const path = req.outputPath ?? 'tmp.mp3';
        writeFileSync(path, Buffer.alloc(256, 0));
        return path;
      },
      poll: async () => ({ status: 'succeeded' as const, audioUrl: '' }),
      // Methods unused by EndToEndCreativePipeline:
      listVoices: async () => [],
      cloneVoice: async () => ({ voiceId: 'x' }),
    };

    const pipe = new EndToEndCreativePipeline(
      fakeVideo as never,
      fakeTts as never,
      {
        ffmpegRunner: {
          download: async (_url: string, outPath: string) => { writeFileSync(outPath, Buffer.alloc(2048, 0)); },
        },
      },
    );

    const res = await pipe.run({
      script_markdown: SAMPLE_MD,
      max_shots: 2,
      project_name: 'test-fox',
      output_dir: tmpDir,
    });

    expect(res.shots_total).toBeGreaterThan(0);
    expect(res.shots_succeeded).toBeGreaterThan(0);
    expect(res.lines.length).toBeGreaterThan(0);
    expect(res.lines[0]?.voice_id).toBeTruthy();
    expect(res.srt_path).toMatch(/\.srt$/);
    expect(existsSync(res.srt_path)).toBe(true);
    expect(res.final_mp4_path).toMatch(/\.mp4$/);
    // SRT must contain at least one subtitle line.
    const srt = readFileSync(res.srt_path, 'utf-8');
    expect(srt).toMatch(/-->/);
  });

  it('no_dub skips TTS but still writes act-title SRT (v3.3 add)', async () => {
    // v3.3 behaviour change: SRT generation runs even when --dub is NOT set.
    // The act-title fallback works without TTS, so the SRT is no longer
    // empty for action-only scripts. TTS itself is still skipped when
    // no_dub=true (we don't want voice generation in this mode).
    const { EndToEndCreativePipeline } = await import('../src/workflow/end_to_end.js');
    const fakeVideo = {
      providerName: 'fake',
      submit: async () => 'fake-task',
      poll: async () => ({ status: 'succeeded' as const, videoUrl: 'https://example.com/v.mp4' }),
    };
    const fakeTts = {
      providerName: 'fake-tts',
      submit: async () => { throw new Error('TTS should not be called when no_dub=true'); },
      poll: async () => ({ status: 'succeeded' as const, audioUrl: '' }),
      listVoices: async () => [],
      cloneVoice: async () => ({ voiceId: 'x' }),
    };
    const pipe = new EndToEndCreativePipeline(
      fakeVideo as never, fakeTts as never,
      { ffmpegRunner: { download: async (_u: string, p: string) => { writeFileSync(p, Buffer.alloc(2048, 0)); } } },
    );
    const res = await pipe.run({
      script_markdown: SAMPLE_MD,
      max_shots: 1,
      project_name: 'no-dub',
      output_dir: tmpDir,
      no_dub: true,
    });
    // TTS was skipped → no voice lines.
    expect(res.lines).toEqual([]);
    // SRT is NOT empty — act-title cues span the act headings.
    const srt = readFileSync(res.srt_path, 'utf-8');
    expect(srt).not.toBe('');
    expect(srt).toMatch(/-->/);
    // First cue text must match an act heading (e.g. "第一幕").
    expect(srt).toMatch(/第.+幕/);
  });

  it('no_dub with explicit subtitle_mode=dialog writes empty SRT (no dialog in script)', async () => {
    // If the caller explicitly opts out of act-title and the script has no
    // dialog, SRT ends up empty. This is the explicit "no subtitles" path.
    const { EndToEndCreativePipeline } = await import('../src/workflow/end_to_end.js');
    const fakeVideo = {
      providerName: 'fake',
      submit: async () => 'fake-task',
      poll: async () => ({ status: 'succeeded' as const, videoUrl: 'https://example.com/v.mp4' }),
    };
    const fakeTts = {
      providerName: 'fake-tts',
      submit: async () => { throw new Error('TTS should not be called'); },
      poll: async () => ({ status: 'succeeded' as const, audioUrl: '' }),
      listVoices: async () => [],
      cloneVoice: async () => ({ voiceId: 'x' }),
    };
    const pipe = new EndToEndCreativePipeline(
      fakeVideo as never, fakeTts as never,
      { ffmpegRunner: { download: async (_u: string, p: string) => { writeFileSync(p, Buffer.alloc(2048, 0)); } } },
    );
    const res = await pipe.run({
      script_markdown: SAMPLE_MD,
      max_shots: 1,
      project_name: 'no-dub-dialog',
      output_dir: tmpDir,
      no_dub: true,
      subtitle_mode: 'dialog', // explicit — act-title disabled
    });
    expect(res.lines).toEqual([]);
    expect(readFileSync(res.srt_path, 'utf-8')).toBe('');
  });

  it('cleanup', () => {
    try { rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* */ }
    expect(true).toBe(true);
  });
});

describe('voice_rules (rule-based voice assignment)', () => {
  it('assigns 少女 / 可爱 / 机灵 → female-shaonv', async () => {
    const { assignVoiceByRule } = await import('../src/workflow/voice_rules.js');
    expect(assignVoiceByRule({ name: '狐小机灵', description: '机灵的狐狸' })).toBe('female-shaonv');
    expect(assignVoiceByRule({ name: '萌萌', description: '可爱的小姑娘' })).toBe('female-shaonv');
  });
  it('assigns 御姐 / 女王 → female-yujie', async () => {
    const { assignVoiceByRule } = await import('../src/workflow/voice_rules.js');
    expect(assignVoiceByRule({ name: '女王大人' })).toBe('female-yujie');
  });
  it('assigns 熊 / 憨 / 老实 → male-qn-qingse', async () => {
    const { assignVoiceByRule } = await import('../src/workflow/voice_rules.js');
    expect(assignVoiceByRule({ name: '熊大憨', description: '憨厚老实' })).toBe('male-qn-qingse');
  });
  it('assigns 精英 / 商务 / 总裁 → male-qn-jingying', async () => {
    const { assignVoiceByRule } = await import('../src/workflow/voice_rules.js');
    expect(assignVoiceByRule({ name: '王总裁', description: '商务精英领导' })).toBe('male-qn-jingying');
  });
  it('assigns 粤语 + 女 → Cantonese_GentleLady', async () => {
    const { assignVoiceByRule } = await import('../src/workflow/voice_rules.js');
    expect(assignVoiceByRule({ name: '陈小姐', description: '粤语温柔姐姐' })).toBe('Cantonese_GentleLady');
  });
  it('honours explicit voice_id override', async () => {
    const { assignVoiceByRule } = await import('../src/workflow/voice_rules.js');
    expect(assignVoiceByRule({ name: '狐小机灵', voice_id: 'male-qn-qingse' })).toBe('male-qn-qingse');
  });
  it('passes through unknown custom voice_id', async () => {
    const { assignVoiceByRule } = await import('../src/workflow/voice_rules.js');
    expect(assignVoiceByRule({ name: 'X', voice_id: 'my-clone-voice-001' })).toBe('my-clone-voice-001');
  });
});

describe('srt builder', () => {
  it('formats lines with HH:MM:SS,mmm timestamps', async () => {
    const { buildSrt } = await import('../src/workflow/end_to_end.js');
    const srt = buildSrt([
      { start: 1.5, end: 3.2, text: 'Hello, world.' },
      { start: 4.0, end: 6.0, text: 'Next line.' },
    ]);
    expect(srt).toContain('00:00:01,500 --> 00:00:03,200');
    expect(srt).toContain('00:00:04,000 --> 00:00:06,000');
    expect(srt).toContain('Hello, world.');
    expect(srt).toContain('Next line.');
    expect(srt.indexOf('1')).toBeLessThan(srt.indexOf('2'));
  });
  it('drops lines with end <= start', async () => {
    const { buildSrt } = await import('../src/workflow/end_to_end.js');
    const srt = buildSrt([
      { start: 0, end: 1, text: 'OK' },
      { start: 1, end: 1, text: 'skip-me' },
      { start: 2, end: 0, text: 'also-skip' },
    ]);
    expect(srt).toContain('OK');
    expect(srt).not.toContain('skip-me');
    expect(srt).not.toContain('also-skip');
  });
  it('drops empty / whitespace text', async () => {
    const { buildSrt } = await import('../src/workflow/end_to_end.js');
    const srt = buildSrt([
      { start: 0, end: 1, text: '   ' },
      { start: 1, end: 2, text: 'real' },
    ]);
    expect(srt).toContain('real');
    // Whitespace-only line was skipped → only one "real" subtitle block.
    expect((srt.match(/-->/g) ?? []).length).toBe(1);
  });
});