/**
 * Session persistence — atomic JSON write under
 * `<dataDir>/sessions/<session_id>.json`.
 *
 * Layout compatible with the Python backend's `framework/session/manager.py`.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { SessionState, StageName } from './types.js';
import { STAGES } from './types.js';

function uuid(): string {
  // Lightweight, dependency-free 16-hex char uuid v4-ish.
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < 32; i++) s += hex[Math.floor(Math.random() * 16)];
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function emptyState(): SessionState {
  const ts = nowIso();
  const firstStage = STAGES[0] ?? 'script_generation';
  return {
    session_id: '',
    status: 'idle',
    current_stage: firstStage,
    completed_stages: [],
    stage_statuses: {},
    artifacts: {},
    meta: {},
    created_at: ts,
    updated_at: ts,
  };
}

export class SessionManager {
  constructor(private readonly baseDir: string) {
    mkdirSync(baseDir, { recursive: true });
  }

  private path(id: string): string {
    return resolve(this.baseDir, `${id}.json`);
  }

  create(initialMeta: Record<string, unknown> = {}): SessionState {
    const state: SessionState = {
      ...emptyState(),
      session_id: uuid(),
      meta: { ...initialMeta },
    };
    this.write(state);
    return state;
  }

  get(id: string): SessionState {
    const p = this.path(id);
    if (!existsSync(p)) throw new Error(`session not found: ${id}`);
    const text = readFileSync(p, 'utf-8');
    return JSON.parse(text) as SessionState;
  }

  exists(id: string): boolean {
    return existsSync(this.path(id));
  }

  /** Update + persist atomically (write-then-rename). */
  update(id: string, mutator: (state: SessionState) => SessionState): SessionState {
    const next = mutator({ ...this.get(id), updated_at: nowIso() });
    this.write(next);
    return next;
  }

  list(): Array<Pick<SessionState, 'session_id' | 'status' | 'updated_at' | 'current_stage'>> {
    if (!existsSync(this.baseDir)) return [];
    return readdirSync(this.baseDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          const raw = JSON.parse(readFileSync(join(this.baseDir, f), 'utf-8')) as SessionState;
          return {
            session_id: raw.session_id,
            status: raw.status,
            updated_at: raw.updated_at,
            current_stage: raw.current_stage,
          };
        } catch {
          return null;
        }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  }

  delete(id: string): boolean {
    try {
      unlinkSync(this.path(id));
      return true;
    } catch {
      return false;
    }
  }

  /** Atomic write: temp file + rename. */
  private write(state: SessionState): void {
    const finalPath = this.path(state.session_id);
    mkdirSync(dirname(finalPath), { recursive: true });
    const tmp = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    // Atomic rename. On Windows, rename replaces the destination if it exists.
    renameSync(tmp, finalPath);
  }

  static defaultDir(dataDir: string): string {
    return resolve(dataDir, 'sessions');
  }

  static fromDataDir(dataDir: string): SessionManager {
    return new SessionManager(SessionManager.defaultDir(dataDir));
  }
}

/** Helper used by PipelineOrchestrator to fetch / mutate a stage's artefact. */
export function getArtifact<T = unknown>(state: SessionState, stage: StageName): T | undefined {
  return state.artifacts[stage] as T | undefined;
}

export function setArtifact(state: SessionState, stage: StageName, value: unknown): void {
  state.artifacts[stage] = value;
}