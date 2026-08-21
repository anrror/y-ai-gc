#!/usr/bin/env node
/**
 * CLI: turn a Chinese markdown script into N Hailuo-2.3 video clips.
 *
 * Usage:
 *   node bin/creative-to-video.mjs <script.md>                  # real run
 *   node bin/creative-to-video.mjs <script.md> --dry-run        # parse + preview only
 *   node bin/creative-to-video.mjs <script.md> --max-shots 6    # cap to 6 shots
 *   node bin/creative-to-video.mjs <script.md> --project my-fox
 *
 * Requires:
 *   - MINIMAX_API_KEY in env (the Hailuo subscription key)
 *   - config.yaml at the dsh-aigc-video root (or via AIGC_CONFIG_PATH)
 *   - Node ≥ 22.15
 *
 * Side effects per shot (real run only — consumes 1 Hailuo token each):
 *   - submits a video_generation task
 *   - polls until success
 *   - downloads the MP4 to code/result/creative/<project>/clips/
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printHelp();
    process.exit(0);
  }
  if (!args.path) {
    console.error('ERROR: <script.md> required');
    printHelp();
    process.exit(2);
  }

  const mdPath = resolve(args.path);
  const md = readFileSync(mdPath, 'utf-8');
  const projectName = args.project ?? basename(mdPath, '.md');

  // Lazy imports so the CLI responds fast on --help.
  const { CreativePipeline } = await import('../dist/workflow/creative_pipeline.js');
  const { loadConfig, getProviderConfig } = await import('../dist/providers/config.js');
  const { createVideoProvider } = await import('../dist/providers/video/index.js');
  // Reference-image support: convert local paths to base64 data URLs that
  // Hailuo v2 accepts in the `content[].image_url` field. The util handles
  // HTTP(S) URLs and already-encoded data URLs by passing them through.
  const { imagePathToDataUrl } = await import('../dist/util/image_to_dataurl.js');
  const referenceDataUrls = (args.references ?? []).map((p) => {
    try {
      return imagePathToDataUrl(p);
    } catch (e) {
      console.error(`ERROR: --reference ${p}: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    }
  });
  if (referenceDataUrls.length > 0) {
    console.log(`[run] references: ${referenceDataUrls.length} image(s) loaded as data URLs`);
  }

  // For dry-run we just parse + decompose + build prompts.
  if (args.dryRun) {
    const { parseScript } = await import('../dist/workflow/script_parser.js');
    const { decomposeIntoShots } = await import('../dist/workflow/shot_decomposer.js');
    const { buildHailuoPrompt } = await import('../dist/workflow/prompt_builder.js');
    const { estimateRunCost } = await import('../dist/cost/estimator.js');
    const parsed = parseScript(md);
    const shots = decomposeIntoShots(parsed, { maxShots: args.maxShots ?? 12 });
    const prompts = shots.map((s) => buildHailuoPrompt(s, parsed));
    // P0-3: surface cost estimate so user knows the budget before submitting.
    const estimate = estimateRunCost({
      shots: shots.length,
      duration_per_shot_sec: prompts[0]?.duration ?? 6,
    });
    const report = {
      script: { title: parsed.title, characters: parsed.characters.map((c) => c.name), acts: parsed.acts.length },
      references: referenceDataUrls.length,
      shots: shots.map((s, i) => ({
        shot_index: s.index, act: s.act, duration: s.duration, characters: s.characters,
        camera_move: s.camera_move, prompt: prompts[i]?.prompt,
      })),
      estimate,
    };
    const outFile = args.out ?? `code/result/creative/${projectName}/preview.json`;
    mkdirSync(dirname(resolve(outFile)), { recursive: true });
    writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf-8');
    console.log(`[dry-run] ${shots.length} shots → ${outFile}`);
    if (referenceDataUrls.length > 0) {
      console.log(`[dry-run] references: ${referenceDataUrls.length} image(s) (will be sent as first_frame + reference_image)`);
    }
    console.log(`[estimate] video ≈ $${estimate.breakdown.video_usd} (${estimate.breakdown_tokens.video} tokens) total ≈ $${estimate.breakdown.total_usd} (${estimate.breakdown_tokens.total} tokens)`);
    for (const n of estimate.notes) console.log(`[estimate] note: ${n}`);
    return;
  }

  // Real run: load config, create video provider, run pipeline.
  const cfg = loadConfig('config.yaml');
  const videoAlias = cfg.pipeline.videoProvider;
  const videoCfg = getProviderConfig(cfg, videoAlias);
  if (!videoCfg) {
    console.error(`ERROR: video provider '${videoAlias}' not configured in config.yaml`);
    process.exit(1);
  }
  const video = createVideoProvider(videoAlias, videoCfg);
  // Allow tests / advanced users to swap the ffmpeg runner.
  const pipeline = new CreativePipeline(video);

  console.log(`[run] script=${mdPath}  project=${projectName}  max_shots=${args.maxShots ?? 12}`);
  // P0-3: pre-submit cost preview (USD + Token Plan credits).
  const { estimateRunCost: preEstimate } = await import('../dist/cost/estimator.js');
  // Use the script's natural shot estimate from parseScript; we'll re-print
  // the post-run estimate from `result.estimate` after submit completes.
  const { parseScript: preParse } = await import('../dist/workflow/script_parser.js');
  const { decomposeIntoShots: preDecomp } = await import('../dist/workflow/shot_decomposer.js');
  const { buildHailuoPrompt: preBuild } = await import('../dist/workflow/prompt_builder.js');
  const _preParsed = preParse(md);
  const _preShots = preDecomp(_preParsed, { maxShots: args.maxShots ?? 12 });
  const _prePrompts = _preShots.map((s) => preBuild(s, _preParsed));
  const _est = preEstimate({
    shots: _preShots.length,
    duration_per_shot_sec: _prePrompts[0]?.duration ?? 6,
    tts_chars: args.dub ? _preParsed.acts.reduce((s, a) =>
      s + a.blocks.filter((b) => b.kind === 'dialog').reduce((t, b) => t + (b.kind === 'dialog' ? b.text.length : 0), 0), 0) : 0,
  });
  console.log(`[estimate] pre-submit: video ≈ $${_est.breakdown.video_usd} (${_est.breakdown_tokens.video} tokens)` + (args.dub ? `  tts ≈ $${_est.breakdown.tts_usd} (${_est.breakdown_tokens.tts} tokens)` : '') + `  total ≈ $${_est.breakdown.total_usd}`);
  const started = Date.now();

  // #1 (Phase 5.5+ → v3.1): end-to-end mode — when --dub is set, route
  // through `EndToEndCreativePipeline` which wraps CreativePipeline +
  // TTS + SRT + VideoMixer into one call, producing `final.mp4` with
  // voice-over + BGM + SRT burn-in.
  let result;
  let finalMuxPath;
  if (args.dub) {
    const { EndToEndCreativePipeline } = await import('../dist/workflow/end_to_end.js');
    const { createTtsProvider } = await import('../dist/providers/audio/index.js');
    const ttsAlias = cfg.pipeline.ttsProvider ?? 'hailuo-tts';
    const ttsCfg = getProviderConfig(cfg, ttsAlias);
    if (!ttsCfg) {
      console.error(`ERROR: TTS provider '${ttsAlias}' not configured in config.yaml`);
      process.exit(1);
    }
    const tts = createTtsProvider(ttsAlias, ttsCfg);
    const e2e = new EndToEndCreativePipeline(video, tts);
    const e2eResult = await e2e.run({
      script_markdown: md,
      max_shots: args.maxShots,
      project_name: projectName,
      output_dir: args.outDir,
      ...(args.bgm ? { bgm_path: args.bgm } : {}),
      no_bgm: !args.bgm,
      ...(referenceDataUrls.length > 0 ? { references: referenceDataUrls } : {}),
      ...(args.subtitleMode ? { subtitle_mode: args.subtitleMode } : {}),
    });
    finalMuxPath = e2eResult.final_mp4_path;
    // Re-shape e2eResult into the existing report shape so the rest of
    // the CLI (report.json + summary lines) stays uniform.
    result = {
      script: e2eResult.script,
      shots_total: e2eResult.shots_total,
      shots_succeeded: e2eResult.shots_succeeded,
      shots_failed: e2eResult.shots_failed,
      shots: e2eResult.shots,
      estimate: _est,
      lines: e2eResult.lines,
      srt_path: e2eResult.srt_path,
      final_mp4_path: e2eResult.final_mp4_path,
      ...(e2eResult.aborted_reason ? { aborted_reason: e2eResult.aborted_reason } : {}),
    };
  } else {
    result = await pipeline.run({
      script_markdown: md,
      max_shots: args.maxShots,
      project_name: projectName,
      output_dir: args.outDir,
      ...(referenceDataUrls.length > 0 ? { references: referenceDataUrls } : {}),
    });
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  // Always write the report.
  const reportPath = args.outDir
    ? resolve(args.outDir, 'report.json')
    : resolve('code/result/creative', projectName, 'report.json');
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify(result, null, 2), 'utf-8');

  console.log(`[done] ${elapsed}s  ${result.shots_succeeded}/${result.shots_total} succeeded`);
  console.log(`[done] ${result.shots_failed} failed`);
  if (result.estimate) {
    console.log(`[estimate] post-run total: ≈ $${result.estimate.breakdown.total_usd} (${result.estimate.breakdown_tokens.total} tokens)`);
  }
  if (args.dub) {
    console.log(`[done] voice lines: ${result.lines.length}`);
    if (result.lines[0]) {
      console.log(`[done] first voice: "${result.lines[0].character}" → voice_id=${result.lines[0].voice_id}`);
    }
    console.log(`[done] SRT: ${result.srt_path}`);
    console.log(`[done] final.mp4: ${result.final_mp4_path}`);
  }
  if (result.aborted_reason) {
    console.log(`[done] run aborted: ${result.aborted_reason}`);
    process.exit(1);
  }
  console.log(`[done] report: ${reportPath}`);
  if (result.shots_succeeded > 0) {
    console.log(`[done] videos:`);
    for (const s of result.shots) {
      if (!s.error) console.log(`  - shot ${s.shot_index}: ${s.video_path}`);
    }
  }
  if (result.shots_failed > 0) {
    console.log(`[done] failures:`);
    for (const s of result.shots) {
      if (s.error) console.log(`  - shot ${s.shot_index}: ${s.error}`);
    }
    process.exit(1);
  }
}

function parseArgs(argv) {
  const out = { _: [], references: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--max-shots') out.maxShots = Number(argv[++i]);
    else if (a === '--project') out.project = argv[++i];
    else if (a === '--out-dir') out.outDir = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--dub') out.dub = true;
    else if (a === '--bgm') out.bgm = argv[++i];
    else if (a === '--reference') {
      const p = argv[++i];
      if (typeof p !== 'string' || !p) {
        console.error('ERROR: --reference requires a path argument');
        process.exit(2);
      }
      out.references.push(p);
    } else if (a === '--subtitle-mode') {
      const v = argv[++i];
      if (v !== 'dialog' && v !== 'act-title' && v !== 'auto') {
        console.error(`ERROR: --subtitle-mode must be dialog | act-title | auto (got: ${v})`);
        process.exit(2);
      }
      out.subtitleMode = v;
    } else if (a === '-h' || a === '--help') out.help = true;
    else if (!a.startsWith('-')) out.path = a;
    else out._.push(a);
  }
  return out;
}

function printHelp() {
  console.log(`Usage: node bin/creative-to-video.mjs <script.md> [options]

Options:
  --dry-run          parse + preview only (no Hailuo calls)
  --max-shots N      cap the number of shots (default 12, hard cap 30)
  --project NAME     project name (used for output directory)
  --out-dir DIR      override output directory (default code/result/creative)
  --out FILE         override dry-run output file
  --dub              end-to-end mode: parse → videos → TTS → SRT → final.mp4 (consumes TTS quota)
  --bgm PATH         optional BGM track to layer under voice (implies --dub)
  --reference PATH   reference image for subject consistency (repeatable; first → first_frame, others dropped — Hailuo v2 reference_image is soft)
  --subtitle-mode M  subtitle strategy: dialog | act-title | auto (default: auto — dialog if present, else act-title)
  -h, --help         show this help

Env:
  MINIMAX_API_KEY    required for real runs (uses hailuo-2.3 from config.yaml)
  AIGC_CONFIG_PATH   optional path to config.yaml (default: config.yaml in cwd)
`);
}

main().catch((e) => {
  console.error('FATAL:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});
