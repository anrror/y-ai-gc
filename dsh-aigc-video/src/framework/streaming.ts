/**
 * NDJSON streaming helpers shared between tool runtimes and the HTTP
 * server. Mirrors the Python backend's `framework/streaming.py` wire
 * format: one JSON object per line, `{"event": "...", "data": {...}}`.
 *
 * Phase 8: imported by both the tool implementation (NDJSON progress
 * events) and the standalone HTTP server.
 */

export type SSEEventType = 'progress' | 'heartbeat' | 'stage_complete' | 'error' | 'done';

export class SSEEvent {
  readonly event: string;
  readonly data: Record<string, unknown>;

  constructor(event: SSEEventType, data: Record<string, unknown>) {
    this.event = event;
    this.data = data;
  }

  toLine(): string {
    return JSON.stringify({ event: this.event, data: this.data });
  }
}

export function progressEvent(phase: string, percent: number, extra: Record<string, unknown> = {}): SSEEvent {
  return new SSEEvent('progress', { phase, percent, ...extra });
}

export function stageCompleteEvent(stage: string, status: string, extra: Record<string, unknown> = {}): SSEEvent {
  return new SSEEvent('stage_complete', { stage, status, ...extra });
}

export function errorEvent(content: string, extra: Record<string, unknown> = {}): SSEEvent {
  return new SSEEvent('error', { content, ...extra });
}

export function doneEvent(extra: Record<string, unknown> = {}): SSEEvent {
  return new SSEEvent('done', extra);
}