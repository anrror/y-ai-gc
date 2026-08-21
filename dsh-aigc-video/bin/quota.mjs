#!/usr/bin/env node
/**
 * CLI: report aggregate Hailuo usage from past sessions.
 *
 * Reads `code/data/sessions/*.json` (one file per pipeline run), aggregates
 * shots + estimated USD + estimated credits, and prints a human-readable
 * summary grouped by date.
 *
 * Why we don't query the provider directly: Hailuo's API doesn't expose a
 * clean quota-introspection endpoint (or it's behind a different path).
 * Local aggregation is honest: "this is what YOU ran through this CLI".
 *
 * Usage:
 *   node bin/quota.mjs                      # human-readable, all sessions
 *   node bin/quota.mjs --json              # JSON output (for scripts)
 *   node bin/quota.mjs --today             # only today's runs
 *   node bin/quota.mjs --since 2026-08-15 # since a date (YYYY-MM-DD)
 *   node bin/quota.mjs --data-dir <path>   # override data dir (default code/data/sessions)
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const __dirname = new URL('.', import.meta.url).pathname;
const pkgRoot = resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { json: false, today: false, since: undefined, dataDir: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--today') out.today = true;
    else if (a === '--since') out.since = argv[++i];
    else if (a === '--data-dir') out.dataDir = argv[++i];
    else if (a === '-h' || a === '--help') out.help = true;
  }
  return out;
}

function printHelp() {
  console.log(`Usage: node bin/quota.mjs [options]

Options:
  --json              machine-readable JSON output
  --today             only today's runs (local date)
  --since YYYY-MM-DD  only runs on/after this date
  --data-dir DIR      override session dir (default code/data/sessions)
  -h, --help          show this help

What this CLI does:
  Reads code/data/sessions/*.json (one per pipeline run) and aggregates
  total shots + estimated USD + estimated credits. Use --json to pipe
  into other tools.
`);
}

function loadSessions(dataDir) {
  if (!existsSync(dataDir)) return [];
  const files = readdirSync(dataDir).filter((f) => f.endsWith('.json') && !f.includes('.tmp-'));
  const sessions = [];
  for (const f of files) {
    try {
      const raw = readFileSync(join(dataDir, f), 'utf-8');
      const s = JSON.parse(raw);
      sessions.push({ file: f, ...s });
    } catch {
      // skip malformed files silently — they're recoverable
    }
  }
  return sessions;
}

function withinFilter(session, opts, now) {
  const ts = session.updated_at ?? session.created_at;
  if (!ts) return false;
  const sessionDate = new Date(ts);
  if (opts.today) {
    const today = new Date(now);
    return sessionDate.toDateString() === today.toDateString();
  }
  if (opts.since) {
    const since = new Date(opts.since);
    return sessionDate >= since;
  }
  return true;
}

function aggregate(sessions) {
  let shots_total = 0, shots_succeeded = 0, shots_failed = 0;
  let estimated_usd = 0, estimated_credits = 0;
  const byProvider = new Map();
  for (const s of sessions) {
    shots_total += s.shots_total ?? 0;
    shots_succeeded += s.shots_succeeded ?? 0;
    shots_failed += s.shots_failed ?? 0;
    if (s.estimate?.breakdown) {
      estimated_usd += s.estimate.breakdown.total_usd ?? 0;
      estimated_credits += s.estimate.breakdown_tokens?.total ?? 0;
    }
    if (s.provider) {
      const p = byProvider.get(s.provider) ?? { runs: 0, shots: 0 };
      p.runs++;
      p.shots += s.shots_total ?? 0;
      byProvider.set(s.provider, p);
    }
  }
  return {
    runs: sessions.length,
    shots_total,
    shots_succeeded,
    shots_failed,
    estimated_usd: Math.round(estimated_usd * 100) / 100,
    estimated_credits,
    by_provider: Object.fromEntries(byProvider),
  };
}

function groupByDate(sessions) {
  const groups = new Map();
  for (const s of sessions) {
    const ts = s.updated_at ?? s.created_at;
    if (!ts) continue;
    const date = ts.slice(0, 10); // YYYY-MM-DD
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(s);
  }
  return [...groups.entries()].sort(([a], [b]) => b.localeCompare(a));
}

function printHuman(sessionsByDate, opts) {
  if (sessionsByDate.length === 0) {
    console.log('[quota] no sessions found.');
    console.log('  Run a pipeline first:');
    console.log('    node bin/creative-to-video.mjs script.md --max-shots 4');
    console.log('  Then re-run this CLI to see usage.');
    return;
  }
  console.log(`[quota] sessions: ${sessionsByDate.reduce((s, [, g]) => s + g.length, 0)} (${opts.today ? 'today only' : opts.since ? `since ${opts.since}` : 'all-time'})\n`);
  for (const [date, sessions] of sessionsByDate) {
    const a = aggregate(sessions);
    console.log(`📅 ${date}`);
    console.log(`   runs:    ${a.runs}`);
    console.log(`   shots:   ${a.shots_succeeded}/${a.shots_total} succeeded${a.shots_failed > 0 ? ` (${a.shots_failed} failed)` : ''}`);
    console.log(`   est USD: $${a.estimated_usd.toFixed(2)}`);
    console.log(`   est credits: ${a.estimated_credits.toLocaleString()}`);
    if (Object.keys(a.by_provider).length > 0) {
      console.log(`   providers: ${Object.entries(a.by_provider).map(([n, p]) => `${n}(${p.runs}×${p.shots}shots)`).join(', ')}`);
    }
    console.log('');
  }
  // Grand total
  const all = sessionsByDate.flatMap(([, g]) => g);
  const total = aggregate(all);
  console.log(`─── total ───`);
  console.log(`   runs:    ${total.runs}`);
  console.log(`   shots:   ${total.shots_succeeded}/${total.shots_total} succeeded`);
  console.log(`   est USD: $${total.estimated_usd.toFixed(2)}`);
}

function printJson(sessionsByDate, opts) {
  const all = sessionsByDate.flatMap(([, g]) => g);
  const total = aggregate(all);
  const daily = sessionsByDate.map(([date, sessions]) => ({
    date,
    ...aggregate(sessions),
  }));
  console.log(JSON.stringify({
    generated_at: new Date().toISOString(),
    filter: opts.today ? 'today' : opts.since ? `since ${opts.since}` : 'all',
    daily,
    total,
  }, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { printHelp(); process.exit(0); }
  const dataDir = args.dataDir
    ? resolve(args.dataDir)
    : join(pkgRoot, 'code', 'data', 'sessions');
  const now = new Date();
  const all = loadSessions(dataDir);
  const filtered = all.filter((s) => withinFilter(s, args, now));
  const grouped = groupByDate(filtered);
  if (args.json) printJson(grouped, args);
  else printHuman(grouped, args);
}

main().catch((e) => {
  console.error('FATAL:', e instanceof Error ? e.message : String(e));
  process.exit(1);
});