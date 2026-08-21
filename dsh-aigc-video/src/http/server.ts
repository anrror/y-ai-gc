/**
 * Minimal Node HTTP server — exposes the 10 endpoints that the Python
 * AIGC-Claw backend's `main.py` exposed, so OpenClaw Agent + dsh-shell
 * tooling can keep calling `http://localhost:8000/api/project/...` without
 * any change.
 *
 * Phase 8: we discovered that `@deepseek-ai/cordis` public API has no
 * `ctx.http.mount` (the v2 design assumed one). Rather than wait for a
 * future `@deepseek-ai/dsh-webserver` package, the plugin runs its own
 * Node http server on a configurable port (default 8000). The DSH agent
 * loop is unaffected; HTTP clients (OpenClaw Agent, dashboards, curl)
 * keep working.
 *
 * Endpoints (mirror `backend/main.py`):
 *   GET  /api/health
 *   GET  /api/stages
 *   POST /api/project/create
 *   POST /api/project/start
 *   GET  /api/project/{id}
 *   GET  /api/project/{id}/status
 *   GET  /api/project/{id}/artifact/{stage}
 *   POST /api/project/{id}/execute/{stage}   (NDJSON stream)
 *   POST /api/project/{id}/intervene
 *   POST /api/project/{id}/continue
 */

import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { URL } from 'node:url';

import { loadConfig } from '../providers/config.js';
import { SessionManager } from '../pipeline/session.js';
import { PipelineOrchestrator } from '../pipeline/orchestrator.js';
import { createImageProvider } from '../providers/image/index.js';
import { createLLMProvider } from '../providers/llm/index.js';
import { createVideoProvider } from '../providers/video/index.js';
import { getProviderConfig } from '../providers/config.js';
import { STAGES } from '../pipeline/types.js';
import type { StageName } from '../pipeline/types.js';
import { SSEEvent } from '../framework/streaming.js';

export interface HttpServerOptions {
  /** Port to bind (default 8000). */
  port?: number;
  /** Host to bind (default '127.0.0.1'). */
  host?: string;
  /** Disable the HTTP server (e.g. when running tests). */
  disabled?: boolean;
}

/** Parsed JSON body. Returns undefined for non-JSON / empty. */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return await new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8');
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text) as Record<string, unknown>);
      } catch {
        resolve(undefined);
      }
    });
  });
}

/** JSON response helper. */
function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Build the OpenClaw-Agent / Python-backend-compatible response shape. */
function sessionView(s: ReturnType<SessionManager['get']> | undefined) {
  if (!s) return null;
  return {
    session_id: s.session_id,
    status: s.status,
    current_stage: s.current_stage,
  };
}

export class AigcHttpServer {
  private server: Server | undefined;
  private mgr!: SessionManager;
  private orch!: PipelineOrchestrator;
  private cfg = loadConfig('config.yaml');

  constructor(opts: HttpServerOptions = {}) {
    if (opts.disabled) return;
    const dataDir = this.cfg.session.dataDir;
    this.mgr = SessionManager.fromDataDir(dataDir);

    // Resolve providers from config.yaml. Missing providers just mean the
    // matching stages are skipped at runtime — pipeline still runs what
    // it can.
    const llmAlias = this.cfg.pipeline.plannerModel || 'isigning-llm';
    const llmCfg = getProviderConfig(this.cfg, llmAlias);
    const llm = llmCfg ? createLLMProvider(llmAlias, llmCfg) : undefined;

    const imageAlias = 'wan';
    const imageCfg = getProviderConfig(this.cfg, imageAlias);
    const image = imageCfg && imageCfg.baseUrl ? createImageProvider(imageAlias, imageCfg) : undefined;

    const videoAlias = this.cfg.pipeline.videoProvider;
    const videoCfg = getProviderConfig(this.cfg, videoAlias);
    const video = videoCfg && videoCfg.baseUrl ? createVideoProvider(videoAlias, videoCfg) : undefined;

    this.orch = new PipelineOrchestrator(this.cfg, this.mgr);
    this.orch.registerAllAgents({ llm, image, video });

    const port = opts.port ?? 8000;
    const host = opts.host ?? '127.0.0.1';
    this.server = createServer((req, res) => this.handle(req, res));
    this.server.listen(port, host, () => {
      // eslint-disable-next-line no-console
      console.log(
        `[dsh-aigc-video] HTTP server listening on http://${host}:${port} ` +
          `(10 endpoints, agents: ${this.orch.listRegistered().join(', ')})`,
      );
    });
  }

  /** Close the server (call from plugin teardown if needed). */
  close(): void {
    this.server?.close();
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = (req.method ?? 'GET').toUpperCase();
    // Guard against double-write. Once any route starts streaming
    // (e.g. /execute's NDJSON), the outer catch must NOT try to write
    // a JSON error response.
    let headersSent = false;
    const sendSafe = (_res: ServerResponse, code: number, body: unknown): void => {
      if (headersSent) return;
      headersSent = true;
      sendJson(_res, code, body);
    };

    try {
      // GET /api/health
      if (path === '/api/health' && method === 'GET') {
        return sendSafe(res, 200, { status: 'ok', version: '2.0.0-rs' });
      }

      // GET /api/stages
      if (path === '/api/stages' && method === 'GET') {
        return sendSafe(res, 200, {
          stages: STAGES.map((s, idx) => ({
            id: s,
            name: s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
            order: idx,
            description: '',
          })),
        });
      }

      // POST /api/project/create
      if (path === '/api/project/create' && method === 'POST') {
        const s = this.mgr.create();
        return sendSafe(res, 201, sessionView(s));
      }

      // POST /api/project/start
      if (path === '/api/project/start' && method === 'POST') {
        const body = (await readJson(req)) ?? {};
        const s = this.mgr.create();
        this.mgr.update(s.session_id, (sess) => {
          // Map HTTP-friendly field names (`idea`) to the orchestrator's
          // expected `story`. Without this mapping, agents see an empty
          // story and bail with "缺少创意描述".
          const normalised: Record<string, unknown> = { ...(body as Record<string, unknown>) };
          if (typeof normalised.idea === 'string' && typeof normalised.story !== 'string') {
            normalised.story = normalised.idea;
          }
          sess.meta = { ...(sess.meta ?? {}), ...normalised };
          return sess;
        });
        const updated = this.mgr.get(s.session_id);
        return sendSafe(res, 201, { session_id: updated.session_id, status: updated.status, params: updated.meta });
      }

      // POST /api/creative/render — md script → N Hailuo clips
      if (path === '/api/creative/render' && method === 'POST') {
        const body = (await readJson(req)) ?? {};
        const md = typeof body.script_markdown === 'string' ? body.script_markdown : '';
        if (!md.trim()) {
          return sendSafe(res, 400, { error: 'script_markdown required' });
        }
        const maxShots = typeof body.max_shots === 'number' ? body.max_shots : 12;
        const projectName =
          typeof body.project_name === 'string' && body.project_name
            ? body.project_name
            : `creative_${Date.now()}`;
        const dryRun = body.dry_run === true;
        // Lazy imports keep the cold path of the HTTP server fast.
        const { parseScript } = await import('../workflow/script_parser.js');
        const { decomposeIntoShots } = await import('../workflow/shot_decomposer.js');
        const { buildHailuoPrompt } = await import('../workflow/prompt_builder.js');
        const parsed = parseScript(md);
        const shots = decomposeIntoShots(parsed, { maxShots });
        const prompts = shots.map((s) => buildHailuoPrompt(s, parsed));
        if (dryRun) {
          return sendSafe(res, 200, {
            script: {
              title: parsed.title,
              characters: parsed.characters.map((c) => c.name),
              acts: parsed.acts.length,
            },
            shots_total: shots.length,
            shots: shots.map((s, i) => ({
              shot_index: s.index,
              act: s.act,
              duration: s.duration,
              characters: s.characters,
              camera_move: s.camera_move,
              prompt: prompts[i]?.prompt ?? '',
            })),
            dry_run: true,
          });
        }
        // Real run: delegate to CreativePipeline (Hailuo calls).
        const { CreativePipeline } = await import('../workflow/creative_pipeline.js');
        const { createVideoProvider } = await import('../providers/video/index.js');
        const videoAlias = this.cfg.pipeline.videoProvider;
        const llmCfg = getProviderConfig(this.cfg, videoAlias);
        if (!llmCfg || !llmCfg.baseUrl) {
          return sendSafe(res, 500, { error: `video provider '${videoAlias}' not configured` });
        }
        const video = createVideoProvider(videoAlias, llmCfg);
        const pipeline = new CreativePipeline(video);
        const result = await pipeline.run({
          script_markdown: md,
          max_shots: maxShots,
          project_name: projectName,
        });
        return sendSafe(res, 200, result);
      }

      // /api/project/{id}    (GET)
      const getMatch = /^\/api\/project\/([A-Za-z0-9_-]+)$/.exec(path);
      if (getMatch && method === 'GET') {
        const id = getMatch[1] as string;
        try {
          const s = this.mgr.get(id);
          return sendSafe(res, 200, s);
        } catch {
          return sendSafe(res, 404, { error: 'session not found' });
        }
      }

      // /api/project/{id}/status
      const statusMatch = /^\/api\/project\/([A-Za-z0-9_-]+)\/status$/.exec(path);
      if (statusMatch && method === 'GET') {
        const id = statusMatch[1] as string;
        try {
          const s = this.mgr.get(id);
          return sendSafe(res, 200, {
            session_id: s.session_id,
            current_stage: s.current_stage,
            status: s.status,
            error: null,
            stages_completed: s.completed_stages,
          });
        } catch {
          return sendSafe(res, 404, { error: 'session not found' });
        }
      }

      // /api/project/{id}/artifact/{stage}
      const artifactMatch = /^\/api\/project\/([A-Za-z0-9_-]+)\/artifact\/([a-z_]+)$/.exec(path);
      if (artifactMatch && method === 'GET') {
        const id = artifactMatch[1] as string;
        const stage = artifactMatch[2] as string;
        try {
          const s = this.mgr.get(id);
          const arts = s.artifacts as Record<string, unknown>;
          const art = arts[stage];
          if (art === undefined) return sendSafe(res, 404, { error: `artifact not found for stage ${stage}` });
          return sendSafe(res, 200, art);
        } catch {
          return sendSafe(res, 404, { error: 'session not found' });
        }
      }

      // /api/project/{id}/intervene
      const interveneMatch = /^\/api\/project\/([A-Za-z0-9_-]+)\/intervene$/.exec(path);
      if (interveneMatch && method === 'POST') {
        const id = interveneMatch[1] as string;
        const body = (await readJson(req)) ?? {};
        const stage = typeof body.stage === 'string' ? (body.stage as StageName) : undefined;
        if (!stage) return sendSafe(res, 400, { error: 'missing stage' });
        const modifications = (body.modifications as Record<string, unknown> | undefined) ?? {};
        this.orch.intervene(id, { stage, modifications, approved: true });
        return sendSafe(res, 200, { session_id: id, stage, recorded: true });
      }

      // /api/project/{id}/continue
      const continueMatch = /^\/api\/project\/([A-Za-z0-9_-]+)\/continue$/.exec(path);
      if (continueMatch && method === 'POST') {
        const id = continueMatch[1] as string;
        const next = this.orch.continueSession(id);
        return sendSafe(res, 200, { session_id: id, next_stage: next, status: 'advanced' });
      }

      // /api/project/{id}/execute/{stage}   (POST, NDJSON stream)
      const execMatch = /^\/api\/project\/([A-Za-z0-9_-]+)\/execute\/([a-z_]+)$/.exec(path);
      if (execMatch && method === 'POST') {
        const id = execMatch[1] as string;
        const stage = execMatch[2] as string;
        // Validate stage
        if (!STAGES.includes(stage as StageName)) {
          return sendSafe(res, 400, { error: `unknown stage: ${stage}` });
        }
        const stageName = stage as StageName;
        // Stream NDJSON — once writeHead runs, the outer catch must not
        // try to send another response. Mark the guard immediately and
        // handle all errors inside this block via the NDJSON `error` event.
        res.writeHead(200, {
          'content-type': 'application/x-ndjson',
          'cache-control': 'no-cache',
          'transfer-encoding': 'chunked',
        });
        headersSent = true;
        const started = Date.now();
        const send = (ev: SSEEvent) => {
          try {
            res.write(ev.toLine() + '\n');
          } catch {
            /* socket closed */
          }
        };
        try {
          this.orch.loadSession(id);
          send(new SSEEvent('progress', { phase: 'starting', percent: 0, stage: stageName }));
          const out = await this.orch.runStage(id, stageName);
          send(
            new SSEEvent('stage_complete', {
              stage: stageName,
              status: out.completed ? 'completed' : 'waiting',
              requires_intervention: out.requires_intervention,
              openclaw: out.hint,
              elapsed_secs: (Date.now() - started) / 1000,
              payload_summary: out.payload,
            }),
          );
          if (out.completed && this.orch.getStateMachine().isTerminal()) {
            send(new SSEEvent('done', { stage: stageName }));
          }
        } catch (e) {
          send(new SSEEvent('error', { stage: stageName, content: (e as Error).message }));
        }
        res.end();
        return;
      }

      // Fallthrough
      sendSafe(res, 404, { error: `no route: ${method} ${path}` });
    } catch (e) {
      sendSafe(res, 500, { error: (e as Error).message });
    }
  }
}

/** Convenience: start the server in one call (plugin entry point). */
export function startHttpServer(opts: HttpServerOptions = {}): AigcHttpServer {
  return new AigcHttpServer(opts);
}