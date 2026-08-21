/**
 * dsh-aigc-video — DSH plugin entry point.
 *
 * Phase 8: also spawns a Node http server (port 8000) with the 10
 * endpoints that mirror the Python AIGC-Claw backend, so OpenClaw Agent
 * and dsh-shell tooling can keep calling `http://localhost:8000/api/project/...`.
 *
 * The HTTP server is opt-in via env var `AIGC_HTTP_DISABLED=1` to avoid
 * port collisions during testing.
 */

import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';

import { videoGenerateTool } from './tools/video_generate.js';
import { mixTool } from './tools/mix.js';
import { smartEditTool } from './tools/smart_edit.js';
import { pipelineTool } from './tools/pipeline.js';
import { AigcHttpServer } from './http/server.js';

/** Plugin identifier — must match `package.json#name` and `cordis.patch.yml#name`. */
export const name = 'dsh-aigc-video';

/**
** Declared Cordis dependencies. `tools` is required for `ctx.tools.register`;
** future phases may add `inject: ['llm', 'sessions', 'http']`.
*/
export const inject = ['tools'] as const;

let httpServer: AigcHttpServer | undefined;

/**
** Plugin entry — called by DSH when loading this plugin.
** `ctx.tools` is guaranteed to be ready before `apply` runs.
*/
export function apply(ctx: Context): void {
  // eslint-disable-next-line no-console
  console.log(
    '[dsh-aigc-video] plugin loaded; ' +
      'tools registered: aigc_video_generate, aigc_mix, aigc_smart_edit, aigc_pipeline_run',
  );

  ctx.tools.register(videoGenerateTool);
  ctx.tools.register(mixTool);
  ctx.tools.register(smartEditTool);
  ctx.tools.register(pipelineTool);

  // Phase 8: spawn the standalone HTTP server (10 endpoints, port 8000).
  // DSH public API has no `ctx.http.mount`, so we run our own Node http
  // server. Set AIGC_HTTP_DISABLED=1 to suppress (used in tests).
  if (process.env.AIGC_HTTP_DISABLED !== '1' && !httpServer) {
    try {
      httpServer = new AigcHttpServer();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('[dsh-aigc-video] failed to start HTTP server:', (e as Error).message);
    }
  }
}

/** Exposed for tests + teardown. */
export function stopHttpServer(): void {
  httpServer?.close();
  httpServer = undefined;
}

/** Re-exports for tooling + tests. */
export { defineTool };
export { AigcHttpServer } from './http/server.js';