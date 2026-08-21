/**
 * ReferenceGeneratorAgent (Phase 4.5).
 *
 * Reads characters → generates one reference image per character via the
 * configured ImageProvider. Consumes image-generation quota (NOT Hailuo).
 */

import { BaseAgent } from '../pipeline/base_agent.js';
import type { AgentInput, AgentOutput } from '../pipeline/base_agent.js';
import { FfmpegRunner } from '../video/ffmpeg.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { ImageGenerationRequest } from '../providers/types.js';

interface CharacterForRef {
  name: string;
  role?: string;
  description?: string;
  visual_traits?: string[];
}

const DEFAULT_OUTPUT_DIR = 'code/result/image';

export class ReferenceGeneratorAgent extends BaseAgent<'reference_generation'> {
  readonly stage = 'reference_generation' as const;

  async run(input: AgentInput): Promise<AgentOutput> {
    if (!this.image) {
      return {
        payload: {},
        hint: '需要 image provider',
        artifacts: {},
        completed: false,
        requires_intervention: false,
        error: 'ReferenceGeneratorAgent requires an image provider; configure models.<provider> in config.yaml',
      };
    }
    const arts = input.meta.artifacts as {
      character_design?: { characters?: CharacterForRef[] };
    } | undefined;
    const characters = arts?.character_design?.characters ?? [];
    if (!characters.length) {
      return {
        payload: {},
        hint: '缺少角色设计',
        artifacts: {},
        completed: false,
        requires_intervention: true,
        error: 'character_design artifact required',
      };
    }

    const projectName = (input.meta.project_name as string | undefined) ?? input.session_id;
    const outDir = resolve(DEFAULT_OUTPUT_DIR, projectName, 'reference');
    mkdirSync(outDir, { recursive: true });
    const ffmpeg = new FfmpegRunner();

    const refImages: Array<{ name: string; path: string; visual_traits?: string[] }> = [];
    const errors: string[] = [];
    for (const ch of characters) {
      const traits = (ch.visual_traits ?? []).slice(0, 8).join(', ');
      const prompt = `portrait photo of ${ch.name}, ${ch.role ?? 'character'}, ${ch.description ?? ''}, ${traits}, high quality, clear face, centered composition, cinematic lighting, 1080p`.trim();
      try {
        const req: ImageGenerationRequest = {
          model: this.image.providerName,
          prompt,
          width: 1024,
          height: 1024,
          signal: input.signal,
        };
        const result = await this.image.generate(req);
        const url = result.images[0]?.url;
        if (!url) throw new Error('image provider returned no url');
        const ext = pickExt(url);
        const filePath = join(outDir, `${slugify(ch.name)}${ext}`);
        await ffmpeg.download(url, filePath, input.signal);
        refImages.push({ name: ch.name, path: filePath, visual_traits: ch.visual_traits });
      } catch (e) {
        errors.push(`${ch.name}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return {
      payload: { refImages, errors },
      hint: `已生成 ${refImages.length}/${characters.length} 张角色参考图${errors.length ? `, 失败 ${errors.length}` : ''}`,
      artifacts: { reference_generation: { refImages, errors } },
      completed: true,
      requires_intervention: false,
      ...(errors.length > 0 ? { error: errors.join('; ') } : {}),
    };
  }
}

function pickExt(url: string): string {
  if (url.includes('.png')) return '.png';
  if (url.includes('.webp')) return '.webp';
  if (url.includes('.jpg') || url.includes('.jpeg')) return '.jpg';
  return '.png';
}

function slugify(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64);
}