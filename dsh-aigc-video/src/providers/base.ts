/**
 * HTTP base + provider base class.
 *
 * `BaseProvider` standardises:
 *   - Bearer auth header injection from `ProviderConfig.apiKey`
 *   - `${VAR}` env expansion at construction (so URLs can reference env)
 *   - common error decoding (try to surface provider's status_code + status_msg)
 */

import type { ProviderConfig } from './config.js';

export interface HttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  /** JSON body; the client stringifies + sets content-type. */
  body?: unknown;
  /** Timeout in ms (default 60_000 for POST / 30_000 for GET). */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class ProviderHttpError extends Error {
  readonly httpStatus: number;
  readonly providerCode?: number;
  readonly providerMessage?: string;
  constructor(httpStatus: number, message: string, providerCode?: number, providerMessage?: string) {
    super(message);
    this.name = 'ProviderHttpError';
    this.httpStatus = httpStatus;
    this.providerCode = providerCode;
    this.providerMessage = providerMessage;
  }
}

/**
 * P0-2: discriminated provider error so callers can branch on kind
 * instead of parsing error messages.
 *
 * `kind`:
 *   - `quota_exceeded` (Hailuo 2056): hard-stop — no retry, abort run.
 *   - `transient` (HTTP 5xx or 408): retry with exponential backoff.
 *   - `bad_request` (HTTP 4xx other than 408): retry at most once; usually content.
 *   - `cancelled`: caller signal aborted; don't retry.
 *   - `network` / `unknown`: usually transient; retry.
 */
export type ProviderErrorKind =
  | 'quota_exceeded'
  | 'transient'
  | 'bad_request'
  | 'cancelled'
  | 'network'
  | 'unknown';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly httpStatus?: number;
  readonly providerCode?: number;
  readonly providerMessage?: string;
  readonly retriable: boolean;
  constructor(
    kind: ProviderErrorKind,
    message: string,
    opts: {
      httpStatus?: number;
      providerCode?: number;
      providerMessage?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.httpStatus = opts.httpStatus;
    this.providerCode = opts.providerCode;
    this.providerMessage = opts.providerMessage;
    this.retriable =
      kind === 'transient' ||
      kind === 'network' ||
      kind === 'unknown' ||
      (kind === 'bad_request' && opts.httpStatus !== undefined && opts.httpStatus >= 500);
    if (opts.cause !== undefined) {
      // ES2022 Error cause chaining.
      (this as Error & { cause?: unknown }).cause = opts.cause;
    }
  }

  /** Static classifier — turn a provider http error into a ProviderError. */
  static fromHttp(err: ProviderHttpError): ProviderError {
    const code = err.providerCode;
    const status = err.httpStatus;
    // MiniMax quota / token-plan hard-stop. 2056 = Token Plan quota exhausted;
    // 1002 / 1004 / 1008 = auth / account issues (treat as non-retriable bad_request).
    if (code === 2056) {
      return new ProviderError(
        'quota_exceeded',
        `provider quota exhausted (code=${code}): ${err.providerMessage ?? err.message}`,
        { httpStatus: status, providerCode: code, providerMessage: err.providerMessage, cause: err },
      );
    }
    if (code === 1002 || code === 1004 || code === 1008) {
      return new ProviderError(
        'bad_request',
        `provider auth/account error (code=${code}): ${err.providerMessage ?? err.message}`,
        { httpStatus: status, providerCode: code, providerMessage: err.providerMessage, cause: err },
      );
    }
    if (status >= 500 || status === 408 || status === 429) {
      return new ProviderError(
        'transient',
        `provider transient (HTTP ${status}): ${err.message}`,
        { httpStatus: status, providerCode: code, providerMessage: err.providerMessage, cause: err },
      );
    }
    if (status >= 400) {
      return new ProviderError(
        'bad_request',
        `provider bad_request (HTTP ${status}): ${err.message}`,
        { httpStatus: status, providerCode: code, providerMessage: err.providerMessage, cause: err },
      );
    }
    return new ProviderError(
      'unknown',
      err.message,
      { httpStatus: status, providerCode: code, providerMessage: err.providerMessage, cause: err },
    );
  }
}

/**
 * Retry helper. Only retries when `e instanceof ProviderError && e.retriable`
 * AND caller signal not aborted. Backoff: 500ms, 1500ms, 4500ms (×3).
 * Quota and bad_request errors propagate immediately (no retry).
 */
export async function withProviderRetry<T>(
  fn: () => Promise<T>,
  opts: { maxRetries?: number; signal?: AbortSignal; onRetry?: (err: ProviderError, attempt: number, delayMs: number) => void } = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  let attempt = 0;
  for (;;) {
    if (opts.signal?.aborted) throw new ProviderError('cancelled', 'cancelled by caller');
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ProviderError)) {
        // Network / unknown error: wrap and retry once.
        if (attempt >= 1) throw e;
        const wrapped = new ProviderError('network', e instanceof Error ? e.message : String(e), { cause: e });
        attempt += 1;
        opts.onRetry?.(wrapped, attempt, 500 * 3 ** (attempt - 1));
        await new Promise((r) => setTimeout(r, 500 * 3 ** (attempt - 1)));
        continue;
      }
      if (e.kind === 'cancelled' || e.kind === 'quota_exceeded') throw e;
      if (!e.retriable || attempt >= maxRetries) throw e;
      const delay = 500 * 3 ** attempt;
      attempt += 1;
      opts.onRetry?.(e, attempt, delay);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/** Minimal env expansion (`${VAR}`). */
function expandEnv(value: string): string {
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '');
}

export class HttpClient {
  constructor(private defaultHeaders: Record<string, string> = {}) {}

  async request<T>(req: HttpRequest): Promise<T> {
    const url = expandEnv(req.url);
    const headers = { ...this.defaultHeaders, ...(req.headers ?? {}) };
    const init: RequestInit = {
      method: req.method,
      headers,
      ...(req.body !== undefined && { body: JSON.stringify(req.body) }),
      ...(req.signal && { signal: req.signal }),
    };
    const timeoutMs = req.timeoutMs ?? (req.method === 'POST' ? 60_000 : 30_000);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
    if (req.signal) {
      // Bridge caller signal — abort our controller when caller aborts.
      req.signal.addEventListener('abort', () => controller.abort(req.signal!.reason), {
        once: true,
      });
    }

    try {
      const resp = await fetch(url, { ...init, signal: controller.signal });
      if (!resp.ok) {
        const text = await resp.text();
        let providerCode: number | undefined;
        let providerMessage: string | undefined;
        try {
          const parsed: unknown = JSON.parse(text);
          if (parsed && typeof parsed === 'object') {
            const obj = parsed as Record<string, unknown>;
            // Hailuo v1/v2 wraps errors in `base_resp.status_code` /`status_msg`.
            if (obj.base_resp && typeof obj.base_resp === 'object') {
              const br = obj.base_resp as Record<string, unknown>;
              if (typeof br.status_code === 'number') providerCode = br.status_code;
              if (typeof br.status_msg === 'string') providerMessage = br.status_msg;
            } else if ('error' in obj && obj.error && typeof obj.error === 'object') {
              // OpenAI-style `error: { type, message, code }`.
              const e = obj.error as Record<string, unknown>;
              if (typeof e.message === 'string') providerMessage = e.message as string;
              if (typeof e.code === 'string') providerCode = e.code as unknown as number;
            }
          }
        } catch {
          // body was not JSON — fall through.
        }
        throw new ProviderHttpError(
          resp.status,
          `HTTP ${resp.status}: ${text.slice(0, 500)}`,
          providerCode,
          providerMessage,
        );
      }
      if (resp.status === 204) return undefined as unknown as T;
      const ct = resp.headers.get('content-type') ?? '';
      if (ct.includes('application/json')) {
        return (await resp.json()) as T;
      }
      return (await resp.text()) as unknown as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Download `url` to a local file. Returns absolute path. */
  async download(url: string, destAbsPath: string, signal?: AbortSignal): Promise<string> {
    const expanded = expandEnv(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('timeout')), 5 * 60_000);
    if (signal) {
      signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
    try {
      const resp = await fetch(expanded, { signal: controller.signal });
      if (!resp.ok) throw new ProviderHttpError(resp.status, `download failed: ${resp.status}`);
      const buf = Buffer.from(await resp.arrayBuffer());
      const { writeFileSync, mkdirSync } = await import('node:fs');
      const { dirname } = await import('node:path');
      mkdirSync(dirname(destAbsPath), { recursive: true });
      writeFileSync(destAbsPath, buf);
      return destAbsPath;
    } finally {
      clearTimeout(timer);
    }
  }
}

export abstract class BaseProvider {
  protected readonly cfg: ProviderConfig;
  protected readonly http: HttpClient;

  constructor(cfg: ProviderConfig) {
    this.cfg = cfg;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (cfg.apiKey) headers['authorization'] = `Bearer ${cfg.apiKey}`;
    this.http = new HttpClient(headers);
  }

  protected get baseUrl(): string {
    return this.cfg.baseUrl.replace(/\/+$/, '');
  }

  protected get modelName(): string {
    return this.cfg.modelName || this.constructor.name;
  }
}