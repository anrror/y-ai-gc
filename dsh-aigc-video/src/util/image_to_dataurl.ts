/**
 * Local image → base64 data URL conversion for Hailuo v2 `image_url` field.
 *
 * Hailuo v2's `content[].image_url` accepts either HTTP(S) URLs or base64 data
 * URLs of the form `data:<mime>;base64,<payload>`. For local reference images
 * (the typical case in our workflow), we read the file and encode it inline.
 *
 * No network egress is required: the data URL is embedded in the submit body
 * and travels to Hailuo as a string. Large images will inflate the JSON
 * payload — callers should resize or compress first if the file is >2 MB.
 *
 * Supported mime types (auto-detected by extension):
 *   .jpg / .jpeg → image/jpeg
 *   .png         → image/png
 *   .webp        → image/webp
 */

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

/** Detect mime type from a file path's extension. Throws on unsupported types. */
export function mimeFromPath(absPath: string): string {
  const ext = extname(absPath).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    throw new Error(
      `unsupported image extension '${ext}' for ${absPath} (supported: ${Object.keys(MIME_BY_EXT).join(', ')})`,
    );
  }
  return mime;
}

/**
 * Read a local image file and return a base64 data URL string ready for
 * Hailuo v2 `image_url.url`.
 *
 * If the input already looks like a data URL or an http(s) URL it is returned
 * unchanged — handy for callers that may mix local paths with remote ones.
 */
export function imagePathToDataUrl(absPath: string): string {
  if (
    absPath.startsWith('data:') ||
    absPath.startsWith('http://') ||
    absPath.startsWith('https://')
  ) {
    return absPath;
  }
  const mime = mimeFromPath(absPath);
  const bytes = readFileSync(absPath);
  const b64 = bytes.toString('base64');
  return `data:${mime};base64,${b64}`;
}

/**
 * Convert a list of paths/URLs to data URLs. Empty input → empty output.
 * Each input is processed independently — failures on individual items
 * are reported as `null` in the output array so the caller can decide
 * whether to skip or abort.
 */
export function imagePathsToDataUrls(paths: ReadonlyArray<string>): Array<string | null> {
  return paths.map((p) => {
    try {
      return imagePathToDataUrl(p);
    } catch {
      return null;
    }
  });
}

/** Convenience: filter out the nulls. */
export function nonNull<T>(xs: ReadonlyArray<T | null>): T[] {
  return xs.filter((x): x is T => x !== null);
}