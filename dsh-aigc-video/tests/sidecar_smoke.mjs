// Smoke test for the Python quality sidecar.
// Runs uvicorn in-process, hits the endpoints, prints results.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 9001;
const py = spawn('py', [
  '-m', 'uvicorn',
  'sidecar:app',
  '--port', String(PORT),
  '--log-level', 'warning',
], {
  cwd: 'E:\\code\\ai\\y-ai-gc\\dsh-aigc-video\\scripts',
  stdio: ['ignore', 'pipe', 'pipe'],
});

py.stdout.on('data', (d) => process.stdout.write('[sidecar] ' + d));
py.stderr.on('data', (d) => process.stderr.write('[sidecar-err] ' + d));

await sleep(2500);

async function hit(method, path, body) {
  const resp = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: resp.status, body: await resp.json() };
}

const results = [];
results.push(['GET /health', await hit('GET', '/health')]);
results.push(['POST /prompt_alignment', await hit('POST', '/prompt_alignment', { prompt: 'a cat', caption: 'a cat sits' })]);
results.push(['POST /prompt_alignment empty', await hit('POST', '/prompt_alignment', { prompt: '', caption: '' })]);
results.push(['POST /subject_consistency (missing file)', await hit('POST', '/subject_consistency', { clip_path: '/nope.mp4' })]);
results.push(['POST /subject_consistency missing field', await hit('POST', '/subject_consistency', {})]);

for (const [name, r] of results) {
  console.log(`-- ${name} --`);
  console.log(JSON.stringify(r));
}

py.kill('SIGTERM');
await sleep(500);
process.exit(0);