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

test('client success profile gates launch and stores daily control history', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'agency-ops-success-'));
  const port = 22000 + Math.floor(Math.random() * 1000);
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
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'ivan', password }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const headers = { 'content-type': 'application/json', cookie };
  const created = await fetch(`${base}/api/projects`, {
    method: 'POST', headers,
    body: JSON.stringify({ client: 'Контрольный проект', service: 'Яндекс Директ', stage: 'handoff' }),
  });
  const { id } = await created.json();

  const initial = await (await fetch(`${base}/api/projects/${id}/all`, { headers })).json();
  assert.equal(initial.success_profile, null);
  assert.deepEqual(initial.daily_audits, []);
  assert.deepEqual(initial.optimization_actions, []);

  const incomplete = await fetch(`${base}/api/projects/${id}/success-profile`, {
    method: 'PUT', headers, body: JSON.stringify({ business_goal: 'Получать заявки' }),
  });
  assert.equal(incomplete.status, 400);

  const saved = await fetch(`${base}/api/projects/${id}/success-profile`, {
    method: 'PUT', headers,
    body: JSON.stringify({
      business_goal: 'Получать целевые заявки', primary_kpi: 'cpl', target_value: '2500',
      monthly_budget: '150000', direct_login: 'client-login', metrika_counter_id: '12345678',
      crm_source: 'amoCRM', landing_url: 'https://example.ru/', geo: 'Санкт-Петербург',
      offer: 'Юридическая консультация', audience: 'Собственники бизнеса',
      restrictions: 'Не использовать гарантии результата', campaign_blueprint: 'Поиск + РСЯ + ретаргетинг',
      auto_actions_enabled: '0',
    }),
  });
  assert.equal(saved.status, 200);
  const profile = await saved.json();
  assert.equal(profile.readiness, 'ready');
  assert.equal(profile.direct_login, 'client-login');

  const audit = await fetch(`${base}/api/projects/${id}/daily-audits`, {
    method: 'POST', headers,
    body: JSON.stringify({
      audit_date: '2026-11-09', source_status: 'confirmed', status: 'attention',
      impressions: 1200, clicks: 83, spend: 8700.45, conversions: 2, cpa: 4350.23,
      findings: 'CPL выше цели; одна группа расходует бюджет без конверсий',
      actions: 'Подготовлены минус-слова и ограничение ставки',
    }),
  });
  assert.equal(audit.status, 201);

  const action = await fetch(`${base}/api/projects/${id}/optimization-actions`, {
    method: 'POST', headers,
    body: JSON.stringify({
      action_date: '2026-11-09', category: 'search_terms', entity: 'Группа 1',
      action: 'Добавить минус-слова', rationale: 'Нецелевые запросы потратили 1900 ₽',
      risk_level: 'low', status: 'planned', before_value: '7 нецелевых запросов', after_value: 'Минус-слова подготовлены',
    }),
  });
  assert.equal(action.status, 201);

  const workspace = await (await fetch(`${base}/api/projects/${id}/all`, { headers })).json();
  assert.equal(workspace.success_profile.readiness, 'ready');
  assert.equal(workspace.daily_audits.length, 1);
  assert.equal(workspace.daily_audits[0].source_status, 'confirmed');
  assert.equal(workspace.optimization_actions.length, 1);
  assert.equal(workspace.optimization_actions[0].status, 'planned');
});
