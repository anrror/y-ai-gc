/**
 * Pipeline types — canonical stage list + status + intervention shapes.
 * Mirrors the Python backend's `framework/state_machine.py` and
 * `framework/pipeline.py` semantics.
 */

export type StageName =
  | 'script_generation'
  | 'character_design'
  | 'storyboard'
  | 'reference_generation'
  | 'video_generation'
  | 'voice_generation'
  | 'post_production';

const STAGES_LIST: readonly StageName[] = [
  'script_generation',
  'character_design',
  'storyboard',
  'reference_generation',
  'video_generation',
  'voice_generation',
  'post_production',
] as const;

export const STAGES: readonly StageName[] = STAGES_LIST;

export type StageStatus = 'pending' | 'running' | 'waiting' | 'completed' | 'failed';

export interface SessionState {
  session_id: string;
  status: 'idle' | 'running' | 'waiting_in_stage' | 'stage_completed' | 'session_completed' | 'error';
  current_stage: StageName;
  completed_stages: StageName[];
  /** Per-stage status map. Missing entries default to 'pending'. */
  stage_statuses: Partial<Record<StageName, StageStatus>>;
  /** Persisted artefacts — keys are StageName, values are agent-defined JSON. */
  artifacts: Partial<Record<StageName, unknown>>;
  /** Free-form metadata (story, style, video_model, etc.). */
  meta: Record<string, unknown>;
  /** Persisted snapshot of the state machine, if any. */
  state_machine?: unknown;
  /** ISO timestamps. */
  created_at: string;
  updated_at: string;
}

/** Operator-supplied stop / modify payload between stages. */
export interface Intervention {
  stage: StageName;
  /** Stage-specific payload — schema decided by the agent. */
  modifications: Record<string, unknown>;
  /** When false, the agent treats this as a peek rather than approval. */
  approved: boolean;
}

function firstStage(): StageName {
  // STAGES is non-empty by construction; the fallback makes strict
  // noUncheckedIndexedAccess happy.
  return STAGES_LIST[0] ?? 'script_generation';
}

function buildDefaultStatuses(): Record<StageName, StageStatus> {
  const out: Record<StageName, StageStatus> = {} as Record<StageName, StageStatus>;
  for (const s of STAGES_LIST) out[s] = 'pending';
  return out;
}

function nextStageOf(stage: StageName): StageName | undefined {
  const i = STAGES_LIST.indexOf(stage);
  if (i < 0) return undefined;
  return STAGES_LIST[i + 1];
}

function lastStage(): StageName {
  return STAGES_LIST[STAGES_LIST.length - 1] ?? firstStage();
}

/** Forward-only transitions (matches the Python backend's StateMachine). */
export class StateMachine {
  private current: StageName = firstStage();
  private statuses: Record<StageName, StageStatus> = buildDefaultStatuses();
  private completed: StageName[] = [];
  private terminal = false;

  currentStage(): StageName {
    return this.current;
  }

  isTerminal(): boolean {
    return this.terminal;
  }

  statusOf(stage: StageName): StageStatus {
    return this.statuses[stage] ?? 'pending';
  }

  completedStages(): readonly StageName[] {
    return this.completed;
  }

  markRunning(stage: StageName): void {
    this.statuses[stage] = 'running';
  }

  markWaiting(stage: StageName): void {
    this.statuses[stage] = 'waiting';
  }

  markFailed(stage: StageName): void {
    this.statuses[stage] = 'failed';
  }

  /** Mark `stage` completed and advance the pointer if it is the current stage. */
  markCompleted(stage: StageName): void {
    this.statuses[stage] = 'completed';
    if (stage !== this.current) return;
    if (!this.completed.includes(stage)) this.completed.push(stage);
    const next = nextStageOf(stage);
    if (next) {
      this.current = next;
    } else {
      this.terminal = true;
    }
  }

  /** Advance past the current stage (called by `continue` after user confirmation). */
  advance(): StageName {
    if (this.terminal) return this.current;
    const next = nextStageOf(this.current) ?? lastStage();
    this.current = next;
    if (!nextStageOf(next)) this.terminal = true;
    return next;
  }

  /** Serialisable snapshot for persistence. */
  snapshot(): Record<string, unknown> {
    return {
      current: this.current,
      statuses: { ...this.statuses },
      completed: [...this.completed],
      terminal: this.terminal,
    };
  }

  /** Restore from a persisted snapshot. */
  restore(snap: {
    current: StageName;
    statuses: Partial<Record<StageName, StageStatus>>;
    completed: StageName[];
    terminal: boolean;
  }): void {
    this.current = snap.current;
    // Build a full Record by overlaying snap on the default (snap may omit
    // entries; defaults fill them in).
    const merged: Record<StageName, StageStatus> = buildDefaultStatuses();
    for (const [k, v] of Object.entries(snap.statuses)) {
      if (v) merged[k as StageName] = v;
    }
    this.statuses = merged;
    this.completed = [...snap.completed];
    this.terminal = snap.terminal;
  }
}