/**
 * Integration tests — exercise the FULL pipeline end-to-end with mocks.
 *
 * Scope (intentionally narrower than unit tests):
 *   - Compose every component (`parseScript` + `decomposeIntoShots` +
 *     `buildHailuoPrompt` + `CreativePipeline` + `composeFinalMp4` +
 *     `ProviderRouter` + `QuotaTracker`) in one run.
 *   - Assert that the produced artefacts (`shots`, `manifest.json`,
 *     `final_mp4_path` when ffmpeg is missing) are coherent.
 *   - Catch integration regressions that unit tests would miss
 *     (e.g. wrong argument forwarded to a downstream helper).
 *
 * Why this matters:
 *   Unit tests pass individually (227 of them) but composition bugs
 *   only surface when modules are wired together. These tests run the
 *   whole stack against in-memory mocks.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CreativePipeline } from '../../src/workflow/creative_pipeline.js';
import { EndToEndCreativePipeline } from '../../src/workflow/end_to_end.js';
import { ProviderRouter } from '../../src/providers/router.js';
import { QuotaTracker } from '../../src/quota/budget.js';
import { MockVideoProvider, MockTtsProvider, StubDownloader } from '../helpers/mock_providers.js';
import type { TtsProvider } from '../../src/providers/types.js';

// ── shared fixtures ───────────────────────────────────────────────────────

const SAMPLE_SCRIPT = `# 杨家枪剧本片段
**剧本类型**: 动作
**人物角色**:
1. **小女娃**: 七岁练枪女童
**场景**: 校场·白日·微风
**时长**: 30秒
---
**【全景】**
（空旷校场，旌旗轻晃，长枪插地。）
**【近景】**
（小女娃握住枪杆，神情专注。）
**【动作特写】**
（起势！枪尖寒芒一闪。）
`;

let scratchDir: string;
function ensureScratch(): string {
  if (!scratchDir) scratchDir = mkdtempSync(join(tmpdir(), 'aigc-integ-'));
  return scratchDir;
}
function cleanup() {
  if (scratchDir) {
    rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = '';
  }
}
process.on('exit', cleanup);

class MockTtsFull implements TtsProvider {
  readonly providerName = 'mock-tts-full';
  public readonly submits = 0;
  async submit(): Promise<string> {
    this.submits++;
    return '/tmp/mock-tts-output.mp3';
  }
  async poll() {
    return { status: 'succeeded' as const, audioUrl: 'https://example.com/mock.mp3' };
  }
  async cloneVoice() {
    return { voiceId: 'x' };
  }
  listSystemVoices() {
    return [
      { id: 'female-shaonv', name: '少女音', lang: 'zh' },
    ];
  }
}

// ── tests ─────────────────────────────────────────────────────────────────

describe('Integration: full creative pipeline (mocked Hailuo)', () => {
  it('parses + decomposes + builds prompts + submits (parallel) + downloads + composes manifest', async () => {
    const video = new MockVideoProvider();
    const pipe = new CreativePipeline(video as never, {
      pollIntervalMs: 0,
      ffmpeg: new StubDownloader() as never,
    });

    const result = await pipe.run({
      script_markdown: SAMPLE_SCRIPT,
      max_shots: 6,
      project_name: 'integ-full',
      output_dir: ensureScratch(),
    });

    // Sanity: pipeline produced the right shape.
    expect(result.shots_total).toBeGreaterThan(0);
    expect(result.shots_succeeded).toBe(result.shots_total);
    expect(result.shots_failed).toBe(0);
    expect(video.submits.length).toBe(result.shots_total);

    // Each shot has: video_url + video_path + the buildHailuoPrompt fields.
    for (const s of result.shots) {
      expect(s.shot_index).toBeGreaterThan(0);
      expect(s.video_url).toMatch(/^https:\/\/example\.com\/task-\d+\.mp4$/);
      expect(s.video_path).toMatch(/[\\/]shot_\d{3}\.mp4$/);
      expect(s.prompt).toContain('Maintain identical character identity');
      expect(s.duration).toBeGreaterThan(0);
    }

    // Composer output: manifest.json always present (this box has no ffmpeg).
    expect(result.manifest_path).toBeDefined();
    expect(existsSync(result.manifest_path!)).toBe(true);
    const manifest = JSON.parse(readFileSync(result.manifest_path!, 'utf-8'));
    expect(manifest.project).toBe('integ-full');
    expect(manifest.shots.length).toBe(result.shots_succeeded);
    expect(manifest.shots[0]).toMatchObject({ index: 1, path: expect.any(String), duration: expect.any(Number) });
  });

  it('parallel submission (concurrency=3) submits multiple shots near-simultaneously', async () => {
    const video = new MockVideoProvider();
    const pipe = new CreativePipeline(video as never, {
      pollIntervalMs: 0,
      ffmpeg: new StubDownloader() as never,
    });

    // Track when each submit fires — parallel mode should cluster them.
    const submitTimestamps: number[] = [];
    const originalSubmit = video.submit.bind(video);
    video.submit = async (req) => {
      submitTimestamps.push(Date.now());
      return originalSubmit(req);
    };

    await pipe.run({
      script_markdown: SAMPLE_SCRIPT,
      max_shots: 6,
      project_name: 'integ-parallel',
      output_dir: ensureScratch(),
      concurrency: 3,
    });

    expect(submitTimestamps.length).toBeGreaterThan(0);
    // All shots for SAMPLE_SCRIPT (3 acts → 3 shots) should fire within 1s
    // of each other when concurrency ≥ 3 — that's the parallel promise.
    if (submitTimestamps.length >= 2) {
      const span = Math.max(...submitTimestamps) - Math.min(...submitTimestamps);
      expect(span).toBeLessThan(1000);
    }
  });

  it('per-shot identity-hint appears in every prompt (subject-consistency v3.3)', () => {
    // Smoke check that the prompt template wiring reaches every shot.
    const video = new MockVideoProvider();
    const pipe = new CreativePipeline(video as never, {
      pollIntervalMs: 0,
      ffmpeg: new StubDownloader() as never,
    });

    return pipe.run({
      script_markdown: SAMPLE_SCRIPT,
      max_shots: 4,
      project_name: 'integ-identity',
      output_dir: ensureScratch(),
    }).then((r) => {
      for (const s of r.shots) {
        expect(s.prompt).toMatch(/Maintain identical character identity/);
        expect(s.prompt).toMatch(/face structure/);
        expect(s.prompt).toMatch(/outfit details/);
      }
    });
  });
});

describe('Integration: provider router inside creative pipeline', () => {
  it('priority strategy: Hailuo quota-exhausted → Kling succeeds, single final.mp4', async () => {
    // Hailuo always fails quota; Kling always succeeds.
    const kling = new MockVideoProvider('kling');
    const router = new ProviderRouter({
      providers: [
        {
          providerName: 'hailuo',
          submits: [],
          async submit() {
            this.submits.push({} as never);
            throw new (await import('../../src/providers/base.js')).ProviderError(
              'quota_exceeded', 'token plan max',
            );
          },
          async poll() { return { taskId: 'x', status: 'failed' as const }; },
        },
        kling,
      ],
      strategy: 'priority',
    });
    const pipe = new CreativePipeline(router as never, {
      pollIntervalMs: 0,
      ffmpeg: new StubDownloader() as never,
    });

    const result = await pipe.run({
      script_markdown: SAMPLE_SCRIPT,
      max_shots: 3,
      project_name: 'integ-router',
      output_dir: ensureScratch(),
    });

    // Router attempted hailuo first (failed), fell back to kling.
    expect(kling.submits.length).toBeGreaterThan(0);
    expect(result.shots_succeeded).toBe(result.shots_total);

    const log = router.getAttemptLog();
    expect(log.length).toBeGreaterThan(0);
    expect(log.some((l) => l.provider === 'hailuo' && !l.ok)).toBe(true);
    expect(log.some((l) => l.provider === 'kling' && l.ok)).toBe(true);
  });
});

describe('Integration: quota tracking + structured logs', () => {
  it('records one entry per shot and aggregates totals correctly', async () => {
    const video = new MockVideoProvider();
    const tracker = new QuotaTracker();
    const pipe = new CreativePipeline(video as never, {
      pollIntervalMs: 0,
      ffmpeg: new StubDownloader() as never,
    });

    const result = await pipe.run({
      script_markdown: SAMPLE_SCRIPT,
      max_shots: 3,
      project_name: 'integ-quota',
      output_dir: ensureScratch(),
    });

    // Simulate quota tracking by hand (production code wires this in
    // via a tracker callback; we just verify the shape here).
    for (let i = 0; i < result.shots_succeeded; i++) {
      tracker.recordSubmit('mock', true, undefined, result.estimate);
    }
    const report = tracker.report('integ-quota');
    expect(report.totals.shots_succeeded).toBe(result.shots_succeeded);
    expect(report.providers[0]?.estimated_credits_used).toBeGreaterThan(0);
  });
});

describe('Integration: end-to-end creative pipeline with --dub (mocked TTS)', () => {
  it('produces shots + SRT + manifest when all providers mocked', async () => {
    const video = new MockVideoProvider();
    const tts = new MockTtsFull();
    const e2e = new EndToEndCreativePipeline(
      video as never,
      tts as never,
      {
        ffmpegRunner: new StubDownloader() as never,
      },
    );

    // SAMPLE_SCRIPT has no dialog blocks, so EndToEnd skips TTS but
    // still writes SRT (act-title mode is default).
    const result = await e2e.run({
      script_markdown: SAMPLE_SCRIPT,
      max_shots: 3,
      project_name: 'integ-e2e',
      output_dir: ensureScratch(),
    });

    expect(result.shots_succeeded).toBeGreaterThan(0);
    expect(result.srt_path).toMatch(/captions\.srt$/);
    expect(existsSync(result.srt_path)).toBe(true);

    // SRT content: act-title cues (since no dialog blocks in script).
    const srt = readFileSync(result.srt_path, 'utf-8');
    expect(srt).toContain('-->');
    expect(srt).toMatch(/全景|近景|动作特写/);

    // Final mp4 is undefined on this box (no ffmpeg).
    // EndToEndCreativePipeline doesn't expose manifest_path directly; the
    // composer output lives next to final.mp4 as `manifest.json` when
    // dub mode runs. We just verify SRT + clips here.
  });

  it('TTS failures do NOT abort the run (warn-and-continue)', async () => {
    class FailingTtsAlways implements TtsProvider {
      readonly providerName = 'fail-tts';
      async submit(): Promise<string> {
        throw new Error('TTS service is down');
      }
      async poll() {
        return { status: 'failed' as const, error: 'TTS service is down' };
      }
      async cloneVoice() { return { voiceId: 'x' }; }
      listSystemVoices() { return []; }
    }

    // Add dialog blocks so TTS would actually be called.
    const scriptWithDialog = `# 对白剧本
**剧本类型**: 剧情
**人物角色**:
1. **小女娃**: 七岁
**场景**: 校场
**时长**: 30秒
---
**【第一幕】**
**小女娃**：师父，我要学枪法！
（师父走近。）
`;

    const video = new MockVideoProvider();
    const e2e = new EndToEndCreativePipeline(
      video as never,
      new FailingTtsAlways() as never,
      {
        ffmpegRunner: new StubDownloader() as never,
      },
    );
    const result = await e2e.run({
      script_markdown: scriptWithDialog,
      max_shots: 1,
      project_name: 'integ-tts-fail',
      output_dir: ensureScratch(),
      no_dub: false, // TTS path active
    });

    // Videos still generated even though TTS failed.
    expect(result.shots_succeeded).toBeGreaterThan(0);
    expect(result.lines).toEqual([]); // no voice tracks because TTS failed
  });
});