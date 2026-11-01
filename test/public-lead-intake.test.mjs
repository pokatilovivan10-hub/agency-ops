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

const login = async (base, password) => {
  const response = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'ivan', password }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
};

test('public website lead is origin-checked and idempotently added to sales', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agency-ops-public-lead-'));
  const port = 22000 + Math.floor(Math.random() * 1000);
  const password = 'owner-password-123';
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, INIT_IVAN_PASSWORD: password, PUBLIC_LEAD_ORIGINS: 'https://digital-red.ru' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  t.after(async () => { child.kill('SIGTERM'); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/health`);

  const forbidden = await fetch(`${base}/api/public/leads`, {
    method: 'POST', headers: { origin: 'https://example.com', 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(forbidden.status, 403);

  const payload = {
    submission_id: 'test-submission-0001', contact_name: 'Тестовый лид', phone: '+79990000000',
    form_name: 'Консультация', page: 'https://digital-red.ru/', message: 'Нужна реклама', utm: 'utm_source=test', website_trap: '',
  };
  const created = await fetch(`${base}/api/public/leads`, {
    method: 'POST', headers: { origin: 'https://digital-red.ru', 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('access-control-allow-origin'), 'https://digital-red.ru');
  const createdBody = await created.json();
  assert.equal(createdBody.duplicate, false);

  const duplicate = await fetch(`${base}/api/public/leads`, {
    method: 'POST', headers: { origin: 'https://digital-red.ru', 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).id, createdBody.id);

  const ownerCookie = await login(base, password);
  const sales = await (await fetch(`${base}/api/sales/dashboard`, { headers: { cookie: ownerCookie } })).json();
  assert.equal(sales.leads.length, 1);
  assert.equal(sales.leads[0].company, 'Тестовый лид');
  assert.equal(sales.leads[0].source, 'digital-red.ru');
  assert.equal(sales.leads[0].next_action, 'Связаться с лидом');
});
