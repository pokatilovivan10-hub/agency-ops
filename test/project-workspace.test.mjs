import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const waitFor = async (url, attempts = 50) => {
  for (let i = 0; i < attempts; i += 1) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`Server did not start: ${url}`);
};

test('project workspace endpoint returns all joined sections', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agency-ops-test-'));
  const port = 19000 + Math.floor(Math.random() * 1000);
  const password = 'test-password-123';
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, INIT_IVAN_PASSWORD: password },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  t.after(async () => { child.kill('SIGTERM'); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/health`);

  const login = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'ivan', password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const created = await fetch(`${base}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ client: 'КоФЕ', service: 'Контекстная реклама', stage: 'paused' }),
  });
  assert.equal(created.status, 201);
  const { id } = await created.json();
  const response = await fetch(`${base}/api/projects/${id}/all`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const workspace = await response.json();
  assert.equal(workspace.project.client, 'КоФЕ');
  for (const key of ['handoff', 'launch', 'tasks', 'reports', 'escalations', 'calls', 'activity']) {
    assert.ok(Array.isArray(workspace[key]), `${key} should be an array`);
  }
});
