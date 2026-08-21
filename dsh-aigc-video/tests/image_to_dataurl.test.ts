/**
 * Tests for `src/util/image_to_dataurl.ts`.
 *
 * Covers the conversion + passthrough behaviour that Hailuo v2 relies on
 * for local reference images.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  mimeFromPath,
  imagePathToDataUrl,
  imagePathsToDataUrls,
  nonNull,
} from '../src/util/image_to_dataurl.js';

let scratchDir: string;
function makeScratchDir() {
  if (!scratchDir) {
    scratchDir = mkdtempSync(join(tmpdir(), 'aigc-imgurl-'));
  }
  return scratchDir;
}
function cleanup() {
  if (scratchDir) {
    rmSync(scratchDir, { recursive: true, force: true });
    scratchDir = '';
  }
}

describe('mimeFromPath', () => {
  it('returns image/jpeg for .jpg', () => {
    expect(mimeFromPath('/tmp/foo.jpg')).toBe('image/jpeg');
  });
  it('returns image/jpeg for .jpeg (case-insensitive)', () => {
    expect(mimeFromPath('/tmp/foo.JPEG')).toBe('image/jpeg');
  });
  it('returns image/png for .png', () => {
    expect(mimeFromPath('/tmp/foo.png')).toBe('image/png');
  });
  it('returns image/webp for .webp', () => {
    expect(mimeFromPath('/tmp/foo.webp')).toBe('image/webp');
  });
  it('throws on unsupported extension', () => {
    expect(() => mimeFromPath('/tmp/foo.gif')).toThrow(/unsupported image extension/);
    expect(() => mimeFromPath('/tmp/foo.txt')).toThrow(/unsupported/);
  });
});

describe('imagePathToDataUrl', () => {
  it('returns existing data: URLs unchanged', () => {
    const url = 'data:image/png;base64,iVBORw0KGgo=';
    expect(imagePathToDataUrl(url)).toBe(url);
  });
  it('returns existing http(s) URLs unchanged', () => {
    expect(imagePathToDataUrl('http://example.com/x.jpg'))
      .toBe('http://example.com/x.jpg');
    expect(imagePathToDataUrl('https://example.com/x.jpg'))
      .toBe('https://example.com/x.jpg');
  });

  it('reads a local jpg file and produces a base64 data URL', () => {
    const dir = makeScratchDir();
    const p = join(dir, 'test.jpg');
    // 1x1 transparent JPEG bytes (deterministic; not magic, just real JPEG bytes).
    const jpegBytes = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
      0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
      0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
      0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
      0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
      0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
      0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
      0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xd9,
    ]);
    writeFileSync(p, jpegBytes);
    const url = imagePathToDataUrl(p);
    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true);
    // Decode the payload back to verify it round-trips.
    const payload = url.slice('data:image/jpeg;base64,'.length);
    expect(Buffer.from(payload, 'base64').equals(jpegBytes)).toBe(true);
  });

  it('throws when local file does not exist', () => {
    expect(() => imagePathToDataUrl('C:/no/such/file.jpg'))
      .toThrow(); // ENOENT or unsupported-extension depending on path
  });

  it('throws when extension is unsupported', () => {
    const dir = makeScratchDir();
    const p = join(dir, 'test.bmp');
    writeFileSync(p, 'BM');
    expect(() => imagePathToDataUrl(p)).toThrow(/unsupported/);
  });
});

describe('imagePathsToDataUrls', () => {
  it('returns [] for []', () => {
    expect(imagePathsToDataUrls([])).toEqual([]);
  });
  it('passes through URLs unchanged and converts local files', () => {
    const dir = makeScratchDir();
    const p = join(dir, 't.png');
    // PNG signature
    writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const out = imagePathsToDataUrls([
      'https://example.com/x.jpg',
      p,
    ]);
    expect(out[0]).toBe('https://example.com/x.jpg');
    expect(out[1]?.startsWith('data:image/png;base64,')).toBe(true);
  });
  it('returns null for individual failures', () => {
    const out = imagePathsToDataUrls(['C:/no/such/file.jpg']);
    expect(out).toEqual([null]);
  });
});

describe('nonNull', () => {
  it('filters nulls', () => {
    expect(nonNull([1, null, 2, null, 3])).toEqual([1, 2, 3]);
    expect(nonNull([])).toEqual([]);
    expect(nonNull([null, null])).toEqual([]);
  });
});

// Best-effort cleanup — Vitest doesn't run afterEach hooks unless declared, so
// schedule the rm at process exit. Test runs are short-lived so this is fine.
process.on('exit', cleanup);