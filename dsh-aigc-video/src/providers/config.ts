/**
 * Provider configuration loader — mirrors the Python backend's
 * `config.yaml` + `.env` pattern.
 *
 * Resolution order:
 *   1. Built-in defaults
 *   2. `config.yaml` at workspace root (relative to the DSH runtime CWD)
 *   3. Environment variables (e.g. `MINIMAX_API_KEY`)
 *
 * YAML strings may carry `${VAR}` placeholders that are expanded from
 * the process environment at lookup time.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import * as YAML from 'yaml';

export interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
  modelName?: string;
  concurrency: number;
  mode?: string;
}

export interface PipelineConfig {
  videoProvider: string;
  plannerEnabled: boolean;
  plannerModel: string;
  previewFirstEnabled: boolean;
  /** Alias of the provider in `providers:` to use for the voice_generation stage. */
  ttsProvider?: string;
}

export interface QualityConfig {
  /** URL of the Python quality sidecar (FastAPI). Empty = pHash fallback. */
  sidecarUrl: string;
  /** Per-request timeout (ms). Default 30 000. */
  sidecarTimeoutMs: number;
  /** Max retries per shot before escalating to a human. Default 2. */
  retryBudget: number;
  /** Whether to call /subject_consistency. Default true. */
  enableSubjectConsistency: boolean;
  /** Whether to call /prompt_alignment. Default false (BLIP-BLEU not wired). */
  enablePromptAlignment: boolean;
}

export interface AppConfig {
  server: { host: string; port: number };
  session: { dataDir: string };
  pipeline: PipelineConfig;
  providers: Record<string, ProviderConfig>;
  /** Optional quality-engineering config (v3.2). */
  quality?: QualityConfig;
}

const DEFAULTS: AppConfig = {
  server: { host: '127.0.0.1', port: 8000 },
  session: { dataDir: 'code/data' },
  pipeline: {
    videoProvider: 'hailuo-2.3',
    plannerEnabled: false,
    plannerModel: 'isigning-llm',
    previewFirstEnabled: false,
  },
  providers: {},
};

/** Default quality config when the YAML doesn't declare one. */
export const DEFAULT_QUALITY_CONFIG: QualityConfig = {
  sidecarUrl: '',
  sidecarTimeoutMs: 30000,
  retryBudget: 2,
  enableSubjectConsistency: true,
  enablePromptAlignment: false,
};

/** Walk-`$` pattern that expands shell-style env placeholders. */
function expandEnv(value: string | undefined): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? '');
}

/** Recursively convert snake_case keys to camelCase (YAML uses snake_case, TS uses camelCase). */
function camelizeKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const camelKey = k.replace(/_([a-z])/g, (_, c) => (c as string).toUpperCase());
      out[camelKey] = camelizeKeys(v);
    }
    return out;
  }
  return value;
}

/** Expand env recursively through an object/array/scalar tree. */
function expandEnvDeep<T>(value: T): T {
  if (typeof value === 'string') return expandEnv(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => expandEnvDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandEnvDeep(v);
    return out as unknown as T;
  }
  return value;
}

/** Read and parse the YAML config; fall back to defaults on any failure. */
function readYaml(path: string): Partial<AppConfig> {
  if (!existsSync(path)) return {};
  try {
    const text = readFileSync(path, 'utf-8');
    const parsed = YAML.parse(text);
    if (parsed && typeof parsed === 'object') return parsed as Partial<AppConfig>;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(`[dsh-aigc-video] failed to parse ${path}:`, e);
  }
  return {};
}

/** Merge defaults + YAML (expanded) into a full AppConfig. */
export function loadConfig(yamlPath = 'config.yaml'): AppConfig {
  // Read raw YAML, camelize snake_case keys to camelCase (so `api_key` in
  // YAML maps to `apiKey` in the TS interface), then expand `${VAR}`.
  const fromYaml = expandEnvDeep(camelizeKeys(readYaml(yamlPath))) as Record<string, unknown>;
  // The canonical YAML key is `models:` (matches the Python backend schema),
  // but the AppConfig field is `providers:`. Accept both for forward-compat.
  const providersYaml = (fromYaml.providers ?? fromYaml.models) as Record<string, ProviderConfig> | undefined;
  const merged: AppConfig = {
    server: { ...DEFAULTS.server, ...((fromYaml.server as object | undefined) ?? {}) },
    session: { ...DEFAULTS.session, ...((fromYaml.session as object | undefined) ?? {}) },
    pipeline: { ...DEFAULTS.pipeline, ...((fromYaml.pipeline as object | undefined) ?? {}) },
    providers: providersYaml ?? {},
  };
  return merged;
}

/** Resolve a provider config by alias (e.g. `'hailuo-2.3'`). */
export function getProviderConfig(cfg: AppConfig, alias: string): ProviderConfig | null {
  const key = alias.toLowerCase();
  const raw = cfg.providers[key];
  if (!raw) return null;
  return { ...raw, apiKey: expandEnv(raw.apiKey) };
}

/** Absolute path for session/result directories under `cfg.session.dataDir`. */
export function dataPath(cfg: AppConfig, sub: 'sessions' | 'result' = 'sessions'): string {
  return resolve(cfg.session.dataDir, sub);
}