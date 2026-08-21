/**
 * Tests for the TS sidecar client + config wiring.
 *
 * Uses vi.stubGlobal to stub `fetch`, then exercises the real
 * SidecarClient class so failures surface.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { SidecarClient, sidecarFromConfig } from '../src/quality/sidecar_client.js';
import { DEFAULT_QUALITY_CONFIG } from '../src/providers/config.js';

const ENABLED_CFG = {
  sidecarUrl: 'http://127.0.0.1:9000',
  sidecarTimeoutMs: 1000,
  retryBudget: 1,
  enableSubjectConsistency: true,
  enablePromptAlignment: false,
};

const DISABLED_CFG = {
  sidecarUrl: '',
  sidecarTimeoutMs: 30000,
  retryBudget: 2,
  enableSubjectConsistency: true,
  enablePromptAlignment: false,
};

beforeEach(() => {
  mockFetch.mockReset();
});

describe('SidecarClient (TS-side wrapper)', () => {
  it('enabled=false when sidecarUrl is empty', async () => {
    const c = new SidecarClient(DISABLED_CFG);
    expect(c.enabled).toBe(false);
    expect(await c.health()).toBeNull();
    expect(await c.subjectConsistency('/a.mp4')).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('enabled=true when sidecarUrl is set', () => {
    const c = new SidecarClient(ENABLED_CFG);
    expect(c.enabled).toBe(true);
  });

  it('health() returns parsed body on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ status: 'ok', ml: { dinov2: true, arcface: false } }),
    });
    const c = new SidecarClient(ENABLED_CFG);
    const h = await c.health();
    expect(h).toEqual({ status: 'ok', ml: { dinov2: true, arcface: false } });
  });

  it('subjectConsistency() returns parsed body on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ score: 0.85, details: { frame_count: 8, mean_cosine: 0.85, method: 'dinov2' } }),
    });
    const c = new SidecarClient(ENABLED_CFG);
    const r = await c.subjectConsistency('/clip.mp4', '/ref.jpg');
    expect(r?.score).toBe(0.85);
    expect(r?.details?.method).toBe('dinov2');
  });

  it('returns null on fetch failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('network down'));
    const c = new SidecarClient(ENABLED_CFG);
    expect(await c.subjectConsistency('/clip.mp4')).toBeNull();
  });

  it('returns null on non-OK HTTP', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
    const c = new SidecarClient(ENABLED_CFG);
    expect(await c.subjectConsistency('/clip.mp4')).toBeNull();
  });

  it('promptAlignment() is no-op when enablePromptAlignment=false', async () => {
    const c = new SidecarClient(ENABLED_CFG); // enablePromptAlignment=false
    expect(await c.promptAlignment('a', 'b')).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('promptAlignment() calls sidecar when enabled', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ score: 0.7, details: { method: 'blip_bleu' } }),
    });
    const c = new SidecarClient({ ...ENABLED_CFG, enablePromptAlignment: true });
    const r = await c.promptAlignment('a cat', 'a cat sits');
    expect(r?.score).toBe(0.7);
  });
});

describe('sidecarFromConfig', () => {
  it('returns disabled client when config.quality is missing', () => {
    const c = sidecarFromConfig({});
    expect(c.enabled).toBe(false);
  });

  it('returns enabled client when config.quality has sidecarUrl', () => {
    const c = sidecarFromConfig({ quality: ENABLED_CFG });
    expect(c.enabled).toBe(true);
  });
});

describe('config.ts quality section (integration)', () => {
  it('DEFAULT_QUALITY_CONFIG has empty sidecarUrl', () => {
    expect(DEFAULT_QUALITY_CONFIG.sidecarUrl).toBe('');
    expect(DEFAULT_QUALITY_CONFIG.retryBudget).toBe(2);
    expect(DEFAULT_QUALITY_CONFIG.enableSubjectConsistency).toBe(true);
  });
});