/**
 * Tests for reference-image wiring through CreativePipeline (v3.3 hardening).
 *
 * Subject-consistency hardening (commit fb7debb + this commit):
 *   - ONLY the first reference image is used as `first_frame` (hard anchor).
 *   - Additional references are DROPPED because Hailuo v2's `reference_image`
 *     is a SOFT signal that causes identity drift when multiple images are
 *     passed (model "averages" them).
 *   - When >1 reference is supplied, a `console.warn` is emitted so the
 *     caller knows their extras were ignored.
 *
 * Uses a mock VideoProvider that records all submit() invocations. No real
 * Hailuo calls; no quota consumed.
 */

import { describe, expect, it, vi } from 'vitest';

import { CreativePipeline } from '../src/workflow/creative_pipeline.js';
import type { VideoGenerationRequest, VideoProvider, VideoResult } from '../src/providers/types.js';

const SAMPLE_SCRIPT = `# 测试剧本片段
**剧本类型**: 测试
**人物角色**:
1. **小女娃**: 七岁练枪女童
**场景**: 校场·白日
**时长**: 30秒
---
**【全景】**
（空旷校场，一杆长枪插在地中央。）
（女童立于枪旁。）
**【近景】**
（小女娃神情专注，握住枪杆。）`;

class MockVideoProvider implements VideoProvider {
  readonly providerName = 'mock';
  public readonly submits: VideoGenerationRequest[] = [];

  async submit(req: VideoGenerationRequest): Promise<string> {
    this.submits.push(req);
    return `task-${this.submits.length}`;
  }

  async poll(_taskId: string): Promise<VideoResult> {
    return { taskId: _taskId, status: 'succeeded', videoUrl: 'https://example.com/fake.mp4' };
  }
}

class FailingDownloader {
  async download(_url: string, _dest: string): Promise<void> {
    throw new Error('mock download disabled');
  }
}

describe('CreativePipeline reference-image wiring (v3.3 hardening)', () => {
  it('passes firstFrameImageUrl from single reference, no referenceImages', async () => {
    const video = new MockVideoProvider();
    const pipeline = new CreativePipeline(video as VideoProvider, {
      ffmpeg: new FailingDownloader() as unknown as { download(url: string, outPath: string, signal?: AbortSignal): Promise<void> },
    });

    await pipeline.run({
      script_markdown: SAMPLE_SCRIPT,
      max_shots: 1,
      project_name: 'single-ref-test',
      references: ['data:image/jpeg;base64,AAA'],
    });

    expect(video.submits.length).toBeGreaterThan(0);
    const firstSubmit = video.submits[0]!;
    expect(firstSubmit.firstFrameImageUrl).toBe('data:image/jpeg;base64,AAA');
    // v3.3: referenceImages is intentionally NOT set even when references is set,
    // because Hailuo v2's reference_image role is a soft signal that hurts
    // consistency. Use first_frame as the hard anchor instead.
    expect(firstSubmit.referenceImages).toBeUndefined();
  });

  it('DROPS all but the first reference (no soft reference_images)', async () => {
    const video = new MockVideoProvider();
    const pipeline = new CreativePipeline(video as VideoProvider, {
      ffmpeg: new FailingDownloader() as unknown as { download(url: string, outPath: string, signal?: AbortSignal): Promise<void> },
    });

    const references = [
      'data:image/jpeg;base64,FIRST',
      'data:image/jpeg;base64,SECOND',
      'data:image/jpeg;base64,THIRD',
    ];

    await pipeline.run({
      script_markdown: SAMPLE_SCRIPT,
      max_shots: 1,
      project_name: 'multi-ref-test',
      references,
    });

    expect(video.submits.length).toBeGreaterThan(0);
    const firstSubmit = video.submits[0]!;
    // Only the first reference is used.
    expect(firstSubmit.firstFrameImageUrl).toBe(references[0]);
    // Others are completely dropped — no soft signal sent to Hailuo.
    expect(firstSubmit.referenceImages).toBeUndefined();
  });

  it('omits firstFrameImageUrl + referenceImages when no references', async () => {
    const video = new MockVideoProvider();
    const pipeline = new CreativePipeline(video as VideoProvider, {
      ffmpeg: new FailingDownloader() as unknown as { download(url: string, outPath: string, signal?: AbortSignal): Promise<void> },
    });

    await pipeline.run({
      script_markdown: SAMPLE_SCRIPT,
      max_shots: 1,
      project_name: 'no-ref-test',
    });

    expect(video.submits.length).toBeGreaterThan(0);
    const firstSubmit = video.submits[0]!;
    expect(firstSubmit.firstFrameImageUrl).toBeUndefined();
    expect(firstSubmit.referenceImages).toBeUndefined();
  });

  it('reuses the same firstFrameImageUrl across every shot (subject anchor)', async () => {
    const video = new MockVideoProvider();
    const pipeline = new CreativePipeline(video as VideoProvider, {
      pollIntervalMs: 0, // skip 4s sleep so test fits in 5s timeout
      ffmpeg: new FailingDownloader() as unknown as { download(url: string, outPath: string, signal?: AbortSignal): Promise<void> },
    });

    const firstFrame = 'data:image/jpeg;base64,ANCHOR';
    await pipeline.run({
      script_markdown: SAMPLE_SCRIPT,
      max_shots: 3,
      project_name: 'multi-shot-ref',
      references: [firstFrame, 'data:image/jpeg;base64,REF2'],
    });

    expect(video.submits.length).toBeGreaterThan(1);
    for (const submit of video.submits) {
      // Every shot uses the SAME first-frame anchor for cross-shot consistency.
      expect(submit.firstFrameImageUrl).toBe(firstFrame);
      // referenceImages is always undefined — only the hard first_frame anchor is sent.
      expect(submit.referenceImages).toBeUndefined();
    }
  });

  it('logs a warning when more than 1 reference is supplied (so caller knows extras were dropped)', async () => {
    const video = new MockVideoProvider();
    const pipeline = new CreativePipeline(video as VideoProvider, {
      ffmpeg: new FailingDownloader() as unknown as { download(url: string, outPath: string, signal?: AbortSignal): Promise<void> },
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await pipeline.run({
      script_markdown: SAMPLE_SCRIPT,
      max_shots: 1,
      project_name: 'warn-test',
      references: ['data:image/jpeg;base64,A', 'data:image/jpeg;base64,B'],
    });

    expect(warnSpy).toHaveBeenCalled();
    const msg = warnSpy.mock.calls.flat().join(' ');
    expect(msg).toMatch(/reference/i);
    expect(msg).toMatch(/Hailuo v2 reference_image/i);

    warnSpy.mockRestore();
  });

  it('does NOT warn when exactly 1 reference is supplied', async () => {
    const video = new MockVideoProvider();
    const pipeline = new CreativePipeline(video as VideoProvider, {
      ffmpeg: new FailingDownloader() as unknown as { download(url: string, outPath: string, signal?: AbortSignal): Promise<void> },
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await pipeline.run({
      script_markdown: SAMPLE_SCRIPT,
      max_shots: 1,
      project_name: 'no-warn-test',
      references: ['data:image/jpeg;base64,ONLY'],
    });

    // The "drop multi-reference" warning should NOT fire for exactly 1 reference.
    const dropWarnings = warnSpy.mock.calls.flat().filter((m) =>
      String(m).includes('Hailuo v2 reference_image'),
    );
    expect(dropWarnings).toHaveLength(0);

    warnSpy.mockRestore();
  });
});