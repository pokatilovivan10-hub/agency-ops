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

const login = async (base, loginName, password) => {
  const response = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: loginName, password }),
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';')[0];
};

test('owner manages sales while project manager only sees production', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agency-ops-rbac-'));
  const port = 20000 + Math.floor(Math.random() * 1000);
  const ownerPassword = 'owner-password-123';
  const managerPassword = 'manager-password-123';
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      INIT_IVAN_PASSWORD: ownerPassword,
      INIT_LIZA_PASSWORD: managerPassword,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  t.after(async () => { child.kill('SIGTERM'); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(`${base}/health`);

  const ownerCookie = await login(base, 'ivan', ownerPassword);
  const managerCookie = await login(base, 'liza', managerPassword);
  const users = await (await fetch(`${base}/api/users`, { headers: { cookie: ownerCookie } })).json();
  const manager = users.find(user => user.role === 'manager');

  const createdLead = await fetch(`${base}/api/leads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: ownerCookie },
    body: JSON.stringify({
      company: 'Тестовый клиент',
      phone: '+79990000000',
      stage: 'qualified',
      qualification: 'qualified',
      next_action: 'Отправить КП',
      next_action_due: '2026-11-02',
    }),
  });
  assert.equal(createdLead.status, 201);
  const { id: leadId } = await createdLead.json();

  const ownerSales = await fetch(`${base}/api/sales/dashboard`, { headers: { cookie: ownerCookie } });
  assert.equal(ownerSales.status, 200);
  assert.equal((await ownerSales.json()).leads[0].company, 'Тестовый клиент');

  const movedLead = await fetch(`${base}/api/leads/${leadId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: ownerCookie },
    body: JSON.stringify({ stage: 'meeting', qualification: 'qualified' }),
  });
  assert.equal(movedLead.status, 200);
  const movedCard = await (await fetch(`${base}/api/leads/${leadId}`, { headers: { cookie: ownerCookie } })).json();
  assert.equal(movedCard.lead.stage, 'meeting');
  assert.equal(movedCard.activities.some(activity => activity.type === 'stage'), true);

  const invalidWon = await fetch(`${base}/api/leads/${leadId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: ownerCookie },
    body: JSON.stringify({ stage: 'won' }),
  });
  assert.equal(invalidWon.status, 409);

  const managerSales = await fetch(`${base}/api/sales/dashboard`, { headers: { cookie: managerCookie } });
  assert.equal(managerSales.status, 403);

  const converted = await fetch(`${base}/api/leads/${leadId}/convert`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: ownerCookie },
    body: JSON.stringify({ manager_id: manager.id, launch_deadline: '2026-11-10' }),
  });
  assert.equal(converted.status, 201);
  const { project_id: projectId } = await converted.json();

  const managerProject = await fetch(`${base}/api/projects/${projectId}/all`, { headers: { cookie: managerCookie } });
  assert.equal(managerProject.status, 200);
  assert.equal((await managerProject.json()).project.client, 'Тестовый клиент');

  const managerDashboard = await fetch(`${base}/api/dashboard`, { headers: { cookie: managerCookie } });
  assert.equal(managerDashboard.status, 200);
  assert.equal((await managerDashboard.json()).projects.some(project => project.id === projectId), true);
});
