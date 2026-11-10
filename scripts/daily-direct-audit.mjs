import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { classifyDailyResult } from '../lib/success-control.mjs';

const dataDir = process.env.DATA_DIR || '/var/lib/agency-ops';
const database = new DatabaseSync(`${dataDir}/agency-ops.sqlite`);
database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');

function token() {
  if (process.env.YANDEX_DIRECT_TOKEN) return process.env.YANDEX_DIRECT_TOKEN;
  const file = process.env.YANDEX_DIRECT_CREDENTIALS_FILE || '/home/openclaw/.secrets/yandex-direct.json';
  const secret = JSON.parse(readFileSync(file, 'utf8'));
  return secret.oauth_token || secret.token || secret.access_token || '';
}

function moscowDate(offsetDays = 0) {
  const date = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

const number = value => {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : 0;
};

function parseTsv(text) {
  const rows = String(text).trim().split(/\r?\n/).filter(Boolean).map(line => line.split('\t'));
  if (rows.length < 2) return { impressions: 0, clicks: 0, spend: 0, conversions: 0 };
  const headers = rows.shift();
  const index = name => headers.indexOf(name);
  return rows.reduce((sum, row) => ({
    impressions: sum.impressions + number(row[index('Impressions')]),
    clicks: sum.clicks + number(row[index('Clicks')]),
    spend: sum.spend + number(row[index('Cost')]),
    conversions: sum.conversions + number(row[index('Conversions')]),
  }), { impressions: 0, clicks: 0, spend: 0, conversions: 0 });
}

async function report(accessToken, clientLogin, date) {
  const response = await fetch('https://api.direct.yandex.com/json/v5/reports', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Client-Login': clientLogin,
      'Accept-Language': 'ru',
      'Content-Type': 'application/json; charset=utf-8',
      processingMode: 'auto',
      returnMoneyInMicros: 'false',
      skipReportHeader: 'true',
      skipColumnHeader: 'false',
      skipReportSummary: 'true',
    },
    body: JSON.stringify({ params: {
      SelectionCriteria: { DateFrom: date, DateTo: date },
      FieldNames: ['Impressions', 'Clicks', 'Cost', 'Conversions'],
      ReportName: `agency-ops-${clientLogin}-${date}-${Date.now()}`.slice(0, 190),
      ReportType: 'ACCOUNT_PERFORMANCE_REPORT', DateRangeType: 'CUSTOM_DATE', Format: 'TSV',
      IncludeVAT: 'NO', IncludeDiscount: 'NO',
    } }),
  });
  if (response.status === 201 || response.status === 202) throw new Error(`Reports API готовит отчёт (HTTP ${response.status})`);
  if (!response.ok) throw new Error(`Reports API HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return parseTsv(await response.text());
}

function saveAudit(projectId, date, sourceStatus, status, metrics, findings, actions) {
  const cpa = metrics.conversions > 0 ? metrics.spend / metrics.conversions : null;
  database.prepare(`INSERT INTO daily_audits(project_id,audit_date,source_status,status,impressions,clicks,spend,conversions,cpa,findings,actions,raw_reference)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(project_id,audit_date) DO UPDATE SET source_status=excluded.source_status,status=excluded.status,impressions=excluded.impressions,clicks=excluded.clicks,spend=excluded.spend,conversions=excluded.conversions,cpa=excluded.cpa,findings=excluded.findings,actions=excluded.actions,raw_reference=excluded.raw_reference,updated_at=CURRENT_TIMESTAMP`).run(
    projectId,date,sourceStatus,status,metrics.impressions,metrics.clicks,metrics.spend,metrics.conversions,cpa,findings,actions,'Yandex Direct Reports API');
  database.prepare('INSERT INTO activity(project_id,action,details) VALUES(?,?,?)').run(projectId,'Автоматический аудит Direct',`${date}: ${status}`);
}

const profiles = database.prepare(`SELECT p.id,p.client,sp.* FROM projects p JOIN client_success_profiles sp ON sp.project_id=p.id
  WHERE p.archived=0 AND p.stage IN ('launched','management') AND sp.readiness='ready' AND trim(sp.direct_login)!='' ORDER BY p.id`).all();
if (!profiles.length) {
  console.log('No ready active Direct profiles; nothing to audit.');
  process.exit(0);
}

const accessToken = token();
if (!accessToken) throw new Error('Yandex Direct token is unavailable');
const auditDate = process.env.AUDIT_DATE || moscowDate(-1);

for (const profile of profiles) {
  try {
    const metrics = await report(accessToken, profile.direct_login, auditDate);
    const sourceStatus = Object.values(metrics).every(value => value === 0) ? 'confirmed_zero' : 'confirmed';
    const result = classifyDailyResult(profile, metrics);
    saveAudit(profile.project_id, auditDate, sourceStatus, result.status, metrics, result.findings, result.actions);
    if (['attention', 'critical'].includes(result.status)) {
      const exists = database.prepare("SELECT id FROM optimization_actions WHERE project_id=? AND action_date=? AND category='daily_control'").get(profile.project_id,auditDate);
      if (!exists) database.prepare(`INSERT INTO optimization_actions(project_id,action_date,category,entity,action,rationale,risk_level,status,before_value,after_value)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(profile.project_id,auditDate,'daily_control','Проект',result.actions,result.findings,result.status==='critical'?'high':'medium','approval_required',`Расход ${metrics.spend.toFixed(2)} ₽; конверсии ${metrics.conversions}`, 'Ожидает проверки проджекта');
    }
    console.log(`${profile.client}: ${sourceStatus}/${result.status}`);
  } catch (error) {
    saveAudit(profile.project_id,auditDate,'unavailable','unavailable',{ impressions: 0, clicks: 0, spend: 0, conversions: 0 },error.message,'Повторить сбор; до подтверждения данных не выполнять изменения кампаний.');
    console.error(`${profile.client}: ${error.message}`);
  }
}
