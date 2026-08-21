/**
 * PipelineOrchestrator — runs registered BaseAgent per stage, persists
 * artefacts + session state, surfaces the 9 stop-points.
 *
 * Phase 4.5: registers all 6 concrete agents (script_writer,
 * character_designer, storyboard, reference_generator, video_director,
 * editor) via `registerAllAgents(deps)`. LLM / image / video providers
 * are optional — stages that need a missing provider are skipped (not
 * an error: a session with only an LLM configured will gracefully stop
 * at video_generation and return what it produced).
 */

import type { AppConfig } from '../providers/config.js';
import { SessionManager, getArtifact, setArtifact } from './session.js';
import type { StageName, Intervention, SessionState } from './types.js';
import { StateMachine, STAGES } from './types.js';
import { BaseAgent } from './base_agent.js';
import type { AgentInput, AgentOutput, AgentDeps } from './base_agent.js';

import { ScriptWriterAgent } from '../agents/script_writer.js';
import { CharacterDesignerAgent } from '../agents/character_designer.js';
import { StoryboardAgent } from '../agents/storyboard.js';
import { ReferenceGeneratorAgent } from '../agents/reference_generator.js';
import { VideoDirectorAgent } from '../agents/video_director.js';
import { VoiceDirectorAgent } from '../agents/voice_director.js';
import { EditorAgent } from '../agents/editor.js';

export interface PipelineEvent {
  type: 'stage_started' | 'stage_completed' | 'stage_failed' | 'intervention_required' | 'done';
  stage: StageName;
  state: SessionState;
  output?: AgentOutput;
}

export type PipelineEventSink = (e: PipelineEvent) => void;

export class PipelineOrchestrator {
  private readonly sm: StateMachine = new StateMachine();
  private readonly agents = new Map<StageName, BaseAgent>();

  constructor(
    private readonly cfg: AppConfig,
    private readonly sessionMgr: SessionManager,
    private readonly sink: PipelineEventSink = () => {},
  ) {}

  /** Register a concrete agent for one stage. */
  registerAgent(agent: BaseAgent): void {
    this.agents.set(agent.stage as StageName, agent);
  }

  /**
   * Register all 6 pipeline agents. Stages whose required provider is
   * missing (e.g. no `video` provider) are skipped — `runStage` will
   * then throw "no agent registered for stage X" if invoked, but the
   * pipeline will still complete all earlier stages.
   */
  registerAllAgents(deps: AgentDeps): void {
    if (deps.llm) {
      this.agents.set('script_generation', new ScriptWriterAgent(deps));
      this.agents.set('character_design', new CharacterDesignerAgent(deps));
      this.agents.set('storyboard', new StoryboardAgent(deps));
      this.agents.set('post_production', new EditorAgent(deps));
    }
    if (deps.image) {
      this.agents.set('reference_generation', new ReferenceGeneratorAgent(deps));
    }
    if (deps.video) {
      this.agents.set('video_generation', new VideoDirectorAgent(deps));
    }
    if (deps.tts) {
      this.agents.set('voice_generation', new VoiceDirectorAgent(deps));
    }
  }

  listRegistered(): StageName[] {
    return [...this.agents.keys()];
  }

  /** Re-hydrate the state machine from a persisted session. */
  loadSession(sessionId: string): SessionState {
    const state = this.sessionMgr.get(sessionId);
    if (state.state_machine) this.sm.restore(state.state_machine as never);
    return state;
  }

  /**
   * Run one stage end-to-end (run agent → write artefact → mark state).
   * Throws if the stage has no registered agent.
   */
  async runStage(sessionId: string, stage: StageName, intervention?: Intervention): Promise<AgentOutput> {
    const agent = this.agents.get(stage);
    if (!agent) throw new Error(`no agent registered for stage ${stage}`);

    const state = this.sessionMgr.get(sessionId);
    this.sm.restore((state.state_machine as never) ?? this.sm.snapshot());

    this.sm.markRunning(stage);
    this.persist(sessionId, stage, 'running');

    this.sink({ type: 'stage_started', stage, state: this.sessionMgr.get(sessionId) });

    const input: AgentInput = {
      session_id: sessionId,
      project_name: (state.meta.project_name as string) ?? '',
      user_prompt: (state.meta.story as string) ?? '',
      meta: state.meta,
      is_final_attempt: !intervention,
    };
    if (intervention) input.meta = { ...input.meta, intervention: intervention.modifications };

    const output = await agent.run(input);

    if (output.requires_intervention) {
      this.sm.markWaiting(stage);
      this.persist(sessionId, stage, 'waiting', output);
      this.sink({ type: 'intervention_required', stage, state: this.sessionMgr.get(sessionId), output });
    } else if (!output.completed || output.error) {
      this.sm.markFailed(stage);
      this.persist(sessionId, stage, 'failed', output);
      this.sink({ type: 'stage_failed', stage, state: this.sessionMgr.get(sessionId), output });
    } else {
      this.sm.markCompleted(stage);
      this.persist(sessionId, stage, 'completed', output);
      this.sink({ type: 'stage_completed', stage, state: this.sessionMgr.get(sessionId), output });
    }

    if (this.sm.isTerminal()) {
      this.sink({ type: 'done', stage, state: this.sessionMgr.get(sessionId) });
    }

    return output;
  }

  /** `continue` — operator confirms and we advance the state machine. */
  continueSession(sessionId: string): StageName {
    const next = this.sm.advance();
    this.sessionMgr.update(sessionId, (s) => ({
      ...s,
      current_stage: next,
      status: 'idle',
      state_machine: this.sm.snapshot() as unknown,
    }));
    return next;
  }

  /** Apply a user intervention; persists `modifications` under the stage. */
  intervene(sessionId: string, intervention: Intervention): SessionState {
    return this.sessionMgr.update(sessionId, (s) => {
      setArtifact(s, intervention.stage, { intervention: intervention.modifications });
      s.status = 'waiting_in_stage';
      return s;
    });
  }

  /** Run all remaining stages in order (skips if no agent registered). */
  async runAll(sessionId: string, onEvent?: PipelineEventSink): Promise<SessionState> {
    const localSink = onEvent ?? this.sink;
    let current = this.sessionMgr.get(sessionId).current_stage;
    while (!this.sm.isTerminal()) {
      const agent = this.agents.get(current);
      if (!agent) break;
      const out = await this.runStage(sessionId, current);
      localSink({ type: out.completed ? 'stage_completed' : 'stage_failed', stage: current, state: this.sessionMgr.get(sessionId), output: out });
      if (!out.completed) break;
      if (!this.sm.isTerminal()) this.continueSession(sessionId);
      current = this.sm.currentStage();
    }
    return this.sessionMgr.get(sessionId);
  }

  private persist(sessionId: string, stage: StageName, status: 'running' | 'waiting' | 'failed' | 'completed', output?: AgentOutput): void {
    this.sessionMgr.update(sessionId, (s) => {
      s.stage_statuses[stage] = status;
      if (status === 'completed' && !s.completed_stages.includes(stage)) {
        s.completed_stages.push(stage);
      }
      if (output?.artifacts) {
        for (const [k, v] of Object.entries(output.artifacts)) {
          (s.artifacts as Record<string, unknown>)[k] = v;
        }
      }
      s.status = status === 'waiting' ? 'waiting_in_stage' : status === 'failed' ? 'error' : 'running';
      if (status === 'completed') s.status = this.sm.isTerminal() ? 'session_completed' : 'stage_completed';
      s.state_machine = this.sm.snapshot() as unknown;
      return s;
    });
  }

  getStateMachine(): StateMachine {
    return this.sm;
  }

  getArtifact<T = unknown>(sessionId: string, stage: StageName): T | undefined {
    return getArtifact<T>(this.sessionMgr.get(sessionId), stage);
  }

  /** Public accessor for the session manager (used by tools/http server). */
  getSessionManager(): SessionManager {
    return this.sessionMgr;
  }
}

export { SessionManager };
export type { AgentInput, AgentOutput, BaseAgent };