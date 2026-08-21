#!/usr/bin/env node
/**
 * `bin/quality-report.mjs` — aggregate quality audit log.
 *
 * Reads the append-only `code/quality/<session>.jsonl` files produced
 * by `quality/end_to_end_gate.ts` and prints:
 *   - total sessions
 *   - shot pass/fail counts
 *   - top failure reasons
 *   - composite score distribution (min / max / mean)
 *
 * Usage:
 *   node bin/quality-report.mjs                         # scan code/quality
 *   node bin/quality-report.mjs --dir code/quality/s1.jsonl  # single file
 *   node bin/quality-report.mjs --json                  # machine-readable output
 *   node bin/quality-report.mjs --since 2026-08-01     # date filter
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = (fileURLToPath(import.meta.url)).replace(/[/\\][^/\\]+$/, '');
const pkgRoot = resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') out.dir = resolve(argv[++i]);
    else if (a === '--json') out.json = true;
    else if (a === '--since') out.since = argv[++i];
    else if (a === '-h' || a === '--help') out.help = true;
    else if (!a.startsWith('-')) out._.push(a);
  }
  return out;
}

function printHelp() {
  console.log(`Usage: node bin/quality-report.mjs [options]

Options:
  --dir PATH    read a single JSONL file (default: scan all of code/quality)
  --since DATE  ISO date filter (e.g. 2026-08-01)
  --json        emit machine-readable JSON
  -h, --help    show this help

Examples:
  node bin/quality-report.mjs
  node bin/quality-report.mjs --dir code/quality/s1.jsonl --json
`);
}

function collectLogFiles(target) {
  const files = [];
  if (!target) {
    const dir = join(pkgRoot, 'code', 'quality');
    if (!existsSync(dir)) return files;
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isFile() && name.endsWith('.jsonl')) files.push(full);
    }
    return files;
  }
  if (!existsSync(target)) return files;
  const st = statSync(target);
  if (st.isDirectory()) {
    for (const name of readdirSync(target)) {
      const full = join(target, name);
      if (statSync(full).isFile() && name.endsWith('.jsonl')) files.push(full);
    }
  } else {
    files.push(target);
  }
  return files;
}

function loadEntries(files, since) {
  const entries = [];
  for (const f of files) {
    let lines;
    try {
      lines = readFileSync(f, 'utf-8').split('\n').filter(Boolean);
    } catch (e) {
      console.warn(`warn: cannot read ${f}: ${e.message}`);
      continue;
    }
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        obj._file = f;
        if (since && obj.ts && obj.ts < since) continue;
        entries.push(obj);
      } catch {
        // skip malformed line
      }
    }
  }
  return entries;
}

function summarise(entries) {
  const stats = {
    sessions: new Set(),
    attempts: entries.length,
    passed: 0,
    failed: 0,
    composite_min: Infinity,
    composite_max: -Infinity,
    composite_sum: 0,
    failureReasons: new Map(),
    decisionCounts: new Map(),
  };
  for (const e of entries) {
    if (e.session_id) stats.sessions.add(e.session_id);
    if (e.passed) stats.passed += 1; else stats.failed += 1;
    if (typeof e.composite === 'number') {
      stats.composite_min = Math.min(stats.composite_min, e.composite);
      stats.composite_max = Math.max(stats.composite_max, e.composite);
      stats.composite_sum += e.composite;
    }
    for (const r of e.reasons ?? []) {
      stats.failureReasons.set(r, (stats.failureReasons.get(r) ?? 0) + 1);
    }
    const d = e.decision ?? '(none)';
    stats.decisionCounts.set(d, (stats.decisionCounts.get(d) ?? 0) + 1);
  }
  const topReasons = [...stats.failureReasons.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const decisions = [...stats.decisionCounts.entries()]
    .sort((a, b) => b[1] - a[1]);
  return {
    sessions: stats.sessions.size,
    attempts: stats.attempts,
    passed: stats.passed,
    failed: stats.failed,
    pass_rate: stats.attempts > 0 ? stats.passed / stats.attempts : 0,
    composite: {
      min: stats.composite_min === Infinity ? 0 : stats.composite_min,
      max: stats.composite_max === -Infinity ? 0 : stats.composite_max,
      mean: stats.attempts > 0 ? stats.composite_sum / stats.attempts : 0,
    },
    top_failure_reasons: topReasons.map(([reason, count]) => ({ reason, count })),
    decisions,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); process.exit(0); }
  const files = collectLogFiles(args.dir);
  if (files.length === 0) {
    console.log('(no audit logs found — run the pipeline first)');
    return;
  }
  const entries = loadEntries(files, args.since);
  const summary = summarise(entries);
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  // Pretty print.
  console.log('───── quality report ─────');
  console.log(`sessions:       ${summary.sessions}`);
  console.log(`attempts:       ${summary.attempts}`);
  console.log(`passed:         ${summary.passed}`);
  console.log(`failed:         ${summary.failed}`);
  console.log(`pass rate:      ${(summary.pass_rate * 100).toFixed(1)}%`);
  console.log(`composite min:  ${summary.composite.min.toFixed(3)}`);
  console.log(`composite max:  ${summary.composite.max.toFixed(3)}`);
  console.log(`composite mean: ${summary.composite.mean.toFixed(3)}`);
  console.log('');
  console.log('top failure reasons:');
  for (const r of summary.top_failure_reasons) {
    console.log(`  ${r.count.toString().padStart(4)}  ${r.reason}`);
  }
  console.log('');
  console.log('decisions:');
  for (const d of summary.decisions) {
    console.log(`  ${d[1].toString().padStart(4)}  ${d[0]}`);
  }
}

main().catch((e) => {
  console.error('FATAL:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});