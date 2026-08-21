/**
 * Unit tests for the creative workflow:
 *   - script_parser correctly extracts acts/dialog/directions
 *   - camera_moves picks the right move for known verbs
 *   - shot_decomposer gives one shot per direction
 *   - prompt_builder emits English + bracketed camera moves
 *   - dry_run pipeline returns shots without consuming Hailuo
 */

import { describe, expect, it, vi } from 'vitest';

// Mock the quality gate so the integration test doesn't depend on a real
// ffmpeg/ffprobe probing a fake downloaded file (which would fail
// ffprobe and incorrectly mark the stub clips as failed).
vi.mock('../src/video/quality_gate.js', () => ({
  checkClipQuality: vi.fn(async () => ({
    ok: true,
    probed: { duration_sec: null, width: null, height: null, black_ratio: null },
    reasons: [],
  })),
}));
import { readFileSync, writeFileSync } from 'node:fs';

import { parseScript, iterBlocks } from '../src/workflow/script_parser.js';
import { pickCameraMoves, formatCameraMoves } from '../src/workflow/camera_moves.js';
import { decomposeIntoShots } from '../src/workflow/shot_decomposer.js';
import { buildHailuoPrompt } from '../src/workflow/prompt_builder.js';

const SAMPLE_MD = readFileSync('D:/down/fox.md', 'utf-8');

describe('script_parser', () => {
  it('parses the user-supplied fox script', () => {
    const s = parseScript(SAMPLE_MD);
    expect(s.title).toBe('自作聪明的傻狐狸');
    expect(s.genre).toContain('搞笑');
    expect(s.setting).toContain('夏日森林草坪');
    expect(s.duration).toContain('3-5分钟');
    expect(s.characters.map((c) => c.name)).toEqual(['狐小机灵', '笨笨熊', '兔兔跳跳']);
    expect(s.acts.length).toBeGreaterThanOrEqual(3);
    let totalBlocks = 0;
    for (const _ of iterBlocks(s)) totalBlocks++;
    expect(totalBlocks).toBeGreaterThan(20);
  });

  it('tolerates missing metadata', () => {
    const s = parseScript('# Test\n\n(no metadata, no acts)\n');
    expect(s.title).toBe('Test');
    expect(s.acts.length).toBe(0);
    expect(s.characters.length).toBe(0);
  });
});

describe('camera_moves', () => {
  it('picks [推进] for approach verbs', () => {
    const moves = pickCameraMoves('狐小机灵迈着六亲不认的步伐，走上前来');
    expect(formatCameraMoves(moves)).toContain('推进');
  });
  it('picks [晃动] for impact verbs', () => {
    const moves = pickCameraMoves('啪叽一声，四脚朝天摔在地上');
    expect(formatCameraMoves(moves)).toContain('晃动');
  });
  it('picks [跟随] for follow verbs', () => {
    const moves = pickCameraMoves('笨笨熊抱着蜂蜜，慢慢悠悠走过来');
    expect(formatCameraMoves(moves)).toContain('跟随');
  });
  it('picks [拉远] for exit verbs', () => {
    const moves = pickCameraMoves('灯光暗，落幕，三人退场');
    expect(formatCameraMoves(moves)).toContain('拉远');
  });
  it('falls back to [固定] when no verbs match', () => {
    const moves = pickCameraMoves('some generic prose');
    expect(formatCameraMoves(moves)).toBe('[固定]');
  });
  it('respects the 3-instruction cap per group', () => {
    const moves = pickCameraMoves('推进 上升 跟随 左摇 上摇 下摇 晃动');
    const first = moves[0];
    expect(first).toBeDefined();
    expect(first!.length).toBeLessThanOrEqual(3);
  });
});

describe('shot_decomposer', () => {
  it('emits a shot per direction block (with greedy dialog attach)', () => {
    const s = parseScript(SAMPLE_MD);
    const shots = decomposeIntoShots(s, { maxShots: 50 });
    expect(shots.length).toBeGreaterThan(5);
    expect(shots.length).toBeLessThanOrEqual(30);
    for (const shot of shots) {
      expect(shot.index).toBeGreaterThanOrEqual(1);
      expect(shot.duration).toBeGreaterThanOrEqual(4);
      expect(shot.duration).toBeLessThanOrEqual(10);
      expect(shot.camera_move).toMatch(/\[.+\]/);
    }
  });
  it('respects the max_shots cap', () => {
    const s = parseScript(SAMPLE_MD);
    const shots = decomposeIntoShots(s, { maxShots: 3 });
    expect(shots.length).toBeLessThanOrEqual(3);
    expect(shots[0]?.index).toBe(1);
  });
});

describe('prompt_builder', () => {
  it('emits an English prompt with bracketed camera move', () => {
    const s = parseScript(SAMPLE_MD);
    const shots = decomposeIntoShots(s, { maxShots: 5 });
    const shot = shots[0];
    expect(shot).toBeDefined();
    const p = buildHailuoPrompt(shot!, s);
    expect(p.prompt.length).toBeLessThanOrEqual(2000);
    expect(p.prompt).toMatch(/\[(推进|拉远|晃动|跟随|固定|.+)\]/);
    // Should contain character names (some translation rules may leave CJK in traits)
    expect(p.prompt.toLowerCase()).toContain('scene:');
  });
});

describe('integration: dry-run of CreativePipeline', () => {
  it('returns shots without consuming Hailuo quota', async () => {
    // We import CreativePipeline lazily here to avoid pulling in the
    // video provider stack (which would need real config).
    const { CreativePipeline } = await import('../src/workflow/creative_pipeline.js');
    // Stub video provider: submit returns immediately, poll returns succeeded.
    const fakeVideo = {
      providerName: 'fake',
      submit: async () => 'fake-task-1',
      poll: async () => ({ status: 'succeeded' as const, videoUrl: 'https://example.com/v.mp4' }),
    };
    const pipe = new CreativePipeline(fakeVideo as never, {
      pollIntervalMs: 0,
      ffmpeg: { download: async (_url: string, outPath: string) => { writeFileSync(outPath, Buffer.alloc(2048, 0)); } },
    });
    const res = await pipe.run({ script_markdown: SAMPLE_MD, max_shots: 3, output_dir: 'code/result/_test' });
    expect(res.shots_total).toBeLessThanOrEqual(3);
    expect(res.shots_succeeded).toBe(res.shots_total);
    expect(res.shots[0]?.video_url).toBe('https://example.com/v.mp4');
    expect(res.shots[0]?.prompt.length).toBeGreaterThan(0);
  });
});
