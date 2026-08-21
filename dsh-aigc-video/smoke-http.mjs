// Phase 8 smoke — start the AIGC HTTP server in-process, hit 10 endpoints with
// fetch, then shut down. Pure JavaScript (no TypeScript syntax).

import { setTimeout as wait } from 'node:timers/promises';

process.env.AIGC_HTTP_DISABLED = '1'; // prevent the plugin entry from auto-starting
const { AigcHttpServer } = await import('./dist/http/server.js');

const server = new AigcHttpServer({ port: 0 }); // ephemeral port
await new Promise((resolve) => server.server.once('listening', resolve));

const port = server.server.address().port;
const base = `http://127.0.0.1:${port}`;
console.log(`[smoke] HTTP server bound at ${base}`);

async function req(method, path, body) {
  const resp = await fetch(`${base}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: resp.status, body: parsed };
}

let pass = 0, fail = 0;
function expect(label, ok, detail) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label} — ${detail || ''}`); }
}
function fmt(v) {
  if (typeof v === 'string') return v.slice(0, 200);
  try { return JSON.stringify(v).slice(0, 200); } catch { return String(v); }
}

// 1. /api/health
{
  const r = await req('GET', '/api/health');
  expect('GET /api/health → 200',
    r.status === 200 && r.body && r.body.status === 'ok');
}

// 2. /api/stages
{
  const r = await req('GET', '/api/stages');
  const stages = r.body && r.body.stages;
  expect('GET /api/stages → 6 stages',
    r.status === 200 && Array.isArray(stages) && stages.length === 6);
}

// 3. POST /api/project/create
const create = await req('POST', '/api/project/create');
const sid = create.body && create.body.session_id;
expect('POST /api/project/create → 201 + session_id',
  create.status === 201 && typeof sid === 'string' && sid.length > 0,
  `status=${create.status} body=${fmt(create.body)}`);

// 4. GET /api/project/{id}
{
  const r = await req('GET', `/api/project/${sid}`);
  expect('GET /api/project/{id} → 200',
    r.status === 200 && r.body && r.body.session_id === sid,
    `status=${r.status} body=${fmt(r.body)}`);
}

// 5. GET /api/project/{id}/status
{
  const r = await req('GET', `/api/project/${sid}/status`);
  expect('GET /api/project/{id}/status → 200',
    r.status === 200 && r.body && r.body.status === 'idle',
    `status=${r.status} body=${fmt(r.body)}`);
}

// 6. GET /api/project/{id}/artifact/{stage} — not yet
{
  const r = await req('GET', `/api/project/${sid}/artifact/script_generation`);
  expect('GET artifact for empty stage → 404', r.status === 404);
}

// 7. POST /api/project/{id}/execute/{stage} — NDJSON stream
{
  const resp = await fetch(`${base}/api/project/${sid}/execute/script_generation`, { method: 'POST' });
  expect('POST execute/{stage} → 200', resp.status === 200);
  expect('execute → application/x-ndjson',
    (resp.headers.get('content-type') || '').includes('application/x-ndjson'));
  const text = await resp.text();
  const lines = text.trim().split('\n').filter(Boolean);
  expect('NDJSON has ≥ 2 lines (start + end)', lines.length >= 2,
    `got ${lines.length} lines; body=${text.slice(0, 200)}`);
  for (const line of lines) {
    try { JSON.parse(line); }
    catch {
      fail++;
      console.log(`  ✗ bad NDJSON line: ${line.slice(0, 80)}`);
    }
  }
  if (fail === 0) console.log('  ✓ all NDJSON lines parse as JSON');
}

// 8. POST /api/project/{id}/intervene
{
  const r = await req('POST', `/api/project/${sid}/intervene`, { stage: 'storyboard', modifications: { foo: 'bar' } });
  expect('POST intervene → 200',
    r.status === 200 && r.body && r.body.recorded === true,
    `status=${r.status} body=${fmt(r.body)}`);
}

// 9. POST /api/project/{id}/continue
{
  const r = await req('POST', `/api/project/${sid}/continue`);
  expect('POST continue → 200',
    r.status === 200 && r.body && r.body.next_stage,
    `status=${r.status} body=${fmt(r.body)}`);
}

// 10. GET /api/project/missing → 404
{
  const r = await req('GET', '/api/project/does-not-exist');
  expect('GET missing session → 404', r.status === 404);
}

server.close();
await wait(50);
console.log(`\n[smoke] ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);