/**
 * `aigc_mix` — combine multiple clips into one final MP4.
 *
 * Phase 5: real ffmpeg implementation. Uses VideoMixer (subprocess ffmpeg
 * with xfade chain, BGM mix, subtitle burn-in). Supports 8 transition
 * kinds; push / barn are approximated with a `wiperight` xfade (a true
 * directional overlay will land in a future sub-task).
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import { FfmpegRunner } from '../video/ffmpeg.js';
import { VideoMixer } from '../video/mixer.js';
import type { MixRequest } from '../video/mixer.js';
import type { TransitionKind } from '../video/transitions.js';

export const mixTool = defineTool({
  name: 'aigc_mix',
  description:
    'Combine multiple video clips into one final MP4 with transitions, background music, ' +
    'and optional burned-in SRT captions. Supports 8 transition kinds. Returns the output path.',
  parameters: {
    clips: {
      type: 'array',
      required: true,
      description: 'Input clips with optional in/out points',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          in_point: { type: 'number' },
          out_point: { type: 'number' },
        },
      },
    },
    transitions: {
      type: 'array',
      description: 'One entry per adjacent clip pair. Defaults to 0.5s crossfade when omitted.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: {
            type: 'string',
            description:
              "'crossfade' / 'dip-to-black' / 'dip-to-white' / 'iris' / 'wipe' / 'push' / 'barn-doors' / 'clock-wipe' / 'cut'",
          },
          duration: { type: 'number', description: 'Transition duration in seconds (default 0.5)' },
        },
      },
    },
    bgm_path: {
      type: 'string',
      description: 'Optional background-music track. Layered under voice track.',
    },
    captions_srt: {
      type: 'string',
      description: 'Optional SRT subtitle file path to burn into the output.',
    },
    output_path: {
      type: 'string',
      required: true,
      description: 'Where to write the final MP4 (absolute path).',
    },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        output_path: { type: 'string' },
        duration_seconds: { type: 'number' },
        transitions_applied: { type: 'integer' },
      },
    },
    render: (_args, value) => [
      { type: 'text', text: `[aigc_mix]\n${JSON.stringify(value, null, 2)}` },
    ],
  },
  async execute(args, _exec) {
    const transitions = (args.transitions ?? []).map((t) => ({
      kind: (t.kind ?? 'crossfade') as TransitionKind,
      duration: t.duration ?? 0.5,
    }));

    const req: MixRequest = {
      clips: (args.clips ?? []).map((c) => ({
        path: c.path,
        ...(c.in_point !== undefined && { in_point: c.in_point }),
        ...(c.out_point !== undefined && { out_point: c.out_point }),
      })),
      transitions,
      ...(args.bgm_path && { bgm_path: args.bgm_path }),
      ...(args.captions_srt && { captions_srt: args.captions_srt }),
      output_path: args.output_path,
    };

    const mixer = new VideoMixer(new FfmpegRunner());
    return await mixer.mix(req);
  },
});