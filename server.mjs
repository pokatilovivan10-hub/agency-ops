import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { extractProjectName, normalizeProjectName } from './lib/call-intake.mjs';

const PORT = Number(process.env.PORT || 8790);
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
const PUBLIC_DIR = join(process.cwd(), 'public');
const COOKIE_NAME = 'agency_ops_session';
const SESSION_TTL = 30 * 86400;
const INTEGRATION_TOKEN = process.env.INTEGRATION_TOKEN || '';
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 5_000_000);
const PUBLIC_LEAD_ORIGINS = new Set(String(process.env.PUBLIC_LEAD_ORIGINS || 'https://digital-red.ru,https://www.digital-red.ru,https://v753842.hosted-by-vdsina.com').split(',').map(v=>v.trim()).filter(Boolean));
const LEAD_STAGES = new Set(['new','contacted','qualified','meeting','proposal','won','lost']);
const publicLeadRate = new Map();
mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(join(DATA_DIR, 'agency-ops.sqlite'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','manager','specialist')),
  login TEXT NOT NULL UNIQUE COLLATE NOCASE, password_hash TEXT NOT NULL, must_change INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY, client TEXT NOT NULL, service TEXT NOT NULL, sale_date TEXT, handoff_date TEXT,
  owner_id INTEGER REFERENCES users(id), manager_id INTEGER REFERENCES users(id), stage TEXT NOT NULL DEFAULT 'sold',
  acceptance_status TEXT NOT NULL DEFAULT 'not_transferred', launch_deadline TEXT, next_action TEXT,
  next_action_due TEXT, next_client_contact TEXT, next_report TEXT, risk TEXT NOT NULL DEFAULT 'none',
  materials_url TEXT, call_summary TEXT, public_token TEXT NOT NULL UNIQUE, archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS handoff_items (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  section TEXT NOT NULL, label TEXT NOT NULL, hint TEXT NOT NULL, required INTEGER NOT NULL DEFAULT 1,
  value TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'missing', comment TEXT NOT NULL DEFAULT '',
  proof TEXT NOT NULL DEFAULT '', updated_by INTEGER REFERENCES users(id), updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS launch_items (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage TEXT NOT NULL, label TEXT NOT NULL, criterion TEXT NOT NULL, assignee TEXT NOT NULL,
  required INTEGER NOT NULL DEFAULT 1, due_date TEXT, status TEXT NOT NULL DEFAULT 'todo', proof TEXT NOT NULL DEFAULT '',
  checked_by INTEGER REFERENCES users(id), checked_at TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', assignee_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'backlog', priority TEXT NOT NULL DEFAULT 'normal', due_date TEXT,
  proof TEXT NOT NULL DEFAULT '', created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  period TEXT NOT NULL, planned TEXT NOT NULL, completed TEXT NOT NULL, metrics TEXT NOT NULL,
  deviation TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '', next_steps TEXT NOT NULL,
  risk TEXT NOT NULL DEFAULT 'none', client_message TEXT NOT NULL DEFAULT '', report_url TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS escalations (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL, facts TEXT NOT NULL, impact TEXT NOT NULL, option_a TEXT NOT NULL, option_b TEXT NOT NULL,
  recommendation TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY, project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id), action TEXT NOT NULL, details TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS call_records (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'manual', external_id TEXT UNIQUE, title TEXT NOT NULL DEFAULT '',
  transcript TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '', trigger_phrase TEXT NOT NULL DEFAULT '',
  occurred_at TEXT, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY, company TEXT NOT NULL, contact_name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '', website TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '', service TEXT NOT NULL DEFAULT '',
  lead_date TEXT, external_key TEXT UNIQUE,
  stage TEXT NOT NULL DEFAULT 'new', qualification TEXT NOT NULL DEFAULT 'unqualified', owner_id INTEGER REFERENCES users(id),
  budget TEXT NOT NULL DEFAULT '', need TEXT NOT NULL DEFAULT '', deadline TEXT NOT NULL DEFAULT '',
  decision_maker TEXT NOT NULL DEFAULT '', next_action TEXT NOT NULL DEFAULT '', next_action_due TEXT,
  last_contact_at TEXT, loss_reason TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '',
  source_project_id INTEGER UNIQUE REFERENCES projects(id), converted_project_id INTEGER REFERENCES projects(id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS lead_activities (
  id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id), type TEXT NOT NULL DEFAULT 'note', summary TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS client_success_profiles (
  project_id INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  business_goal TEXT NOT NULL, primary_kpi TEXT NOT NULL, target_value TEXT NOT NULL,
  monthly_budget TEXT NOT NULL, direct_login TEXT NOT NULL, metrika_counter_id TEXT NOT NULL,
  crm_source TEXT NOT NULL, landing_url TEXT NOT NULL, geo TEXT NOT NULL, offer TEXT NOT NULL,
  audience TEXT NOT NULL, restrictions TEXT NOT NULL, campaign_blueprint TEXT NOT NULL,
  auto_actions_enabled INTEGER NOT NULL DEFAULT 0, readiness TEXT NOT NULL DEFAULT 'draft',
  updated_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS daily_audits (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  audit_date TEXT NOT NULL, source_status TEXT NOT NULL CHECK(source_status IN ('confirmed','confirmed_zero','unavailable')),
  status TEXT NOT NULL CHECK(status IN ('ok','attention','critical','unavailable')),
  impressions INTEGER, clicks INTEGER, spend REAL, conversions REAL, cpa REAL,
  findings TEXT NOT NULL DEFAULT '', actions TEXT NOT NULL DEFAULT '', raw_reference TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(project_id,audit_date)
);
CREATE TABLE IF NOT EXISTS optimization_actions (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  action_date TEXT NOT NULL, category TEXT NOT NULL, entity TEXT NOT NULL DEFAULT '', action TEXT NOT NULL,
  rationale TEXT NOT NULL, risk_level TEXT NOT NULL DEFAULT 'low', status TEXT NOT NULL DEFAULT 'planned',
  before_value TEXT NOT NULL DEFAULT '', after_value TEXT NOT NULL DEFAULT '', proof TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id), applied_by INTEGER REFERENCES users(id), applied_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_handoff_project ON handoff_items(project_id);
CREATE INDEX IF NOT EXISTS idx_launch_project ON launch_items(project_id);
CREATE INDEX IF NOT EXISTS idx_activity_project ON activity(project_id);
CREATE INDEX IF NOT EXISTS idx_calls_project ON call_records(project_id);
CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
CREATE INDEX IF NOT EXISTS idx_leads_owner ON leads(owner_id);
CREATE INDEX IF NOT EXISTS idx_lead_activities_lead ON lead_activities(lead_id);
CREATE INDEX IF NOT EXISTS idx_daily_audits_project_date ON daily_audits(project_id,audit_date DESC);
CREATE INDEX IF NOT EXISTS idx_optimization_actions_project_date ON optimization_actions(project_id,action_date DESC);
`);

db.exec(`
INSERT OR IGNORE INTO leads(company,service,stage,qualification,owner_id,next_action,next_action_due,notes,source_project_id,created_at,updated_at)
SELECT client,service,'new','unqualified',owner_id,next_action,next_action_due,call_summary,id,created_at,updated_at
FROM projects WHERE stage='lead';
`);

const handoffTemplate = [
  ['Коммерция','Что продано','Услуга, объём и формат ведения'],['Коммерция','Цена и оплата','Стоимость, график и что уже оплачено'],
  ['Коммерция','Сроки','Обещанная дата старта и важные даты'],['Результат','Цель клиента','Какой бизнес-результат ждёт клиент'],
  ['Результат','Главная метрика','Лиды, продажи, CPL, ДРР или другой KPI'],['Результат','Ограничения','Бюджет, география, товары и юридические запреты'],
  ['Контекст','Сводка созвона','Расшифровка или сводка Plaud'],['Контекст','Что обещано клиенту','Все обещания и нестандартные условия'],
  ['Контекст','Что клиент считает проблемой','Формулировка клиента без интерпретации'],['Доступы','Сайт и аналитика','Ссылки и подтверждение доступа'],
  ['Доступы','Рекламные кабинеты','ID и подтверждение доступа; секреты только защищённо'],['Доступы','CRM и формы','Где проверять реальные заявки'],
  ['Материалы','Оффер и посадочные','Ссылки на актуальные версии'],['Материалы','Креативы и бренд','Папка, ограничения и согласованные примеры'],
  ['Коммуникация','Рабочий чат','Ссылка на общий чат Иван + Лиза + клиент'],['Коммуникация','ЛПР и участники','Кто принимает решения и кто согласует'],
  ['Коммуникация','Ритм связи','Когда отчёт, созвон и время ответа'],['Передача','Первое действие Лизы','Что сделать сразу после приёмки'],
  ['Передача','Дедлайн запуска','Конкретная дата и время'],['Передача','Критерий готовности','Что должно быть проверено до запуска']
];
const launchTemplate = [
  ['Приёмка','Передача заполнена полностью','Нет обязательных незаполненных полей','Лиза'],['Приёмка','Сводка созвона изучена','Цели, обещания и ограничения зафиксированы','Лиза'],
  ['Приёмка','Неясности закрыты','По каждому вопросу есть письменный ответ','Лиза'],['Доступы','Рекламный кабинет','Доступ проверен входом или через API','Лиза'],
  ['Доступы','Метрика и аналитика','Счётчик, цели и права проверены','Лиза'],['Доступы','CRM и формы','Тестовая заявка видна, источник определяется','Лиза'],
  ['Подготовка','План работ','Есть задачи, владельцы, сроки и зависимости','Лиза'],['Подготовка','Структура кампаний','Соответствует офферу, географии и бюджету','Исполнитель'],
  ['Подготовка','Семантика и аудитории','Минус-слова, исключения и пересечения проверены','Исполнитель'],['Подготовка','Объявления и креативы','Нет неподтверждённых обещаний, ссылки рабочие','Исполнитель'],
  ['Подготовка','UTM и атрибуция','Метки едины и читаются в аналитике и CRM','Исполнитель'],['Контроль','Проверка Лизы','Все обязательные пункты имеют доказательства','Лиза'],
  ['Контроль','Тестовая заявка','Полный путь от формы до CRM подтверждён','Лиза'],['Контроль','Бюджет и лимиты','Лимиты совпадают с договорённостью','Лиза'],
  ['Контроль','Модерация и статус','Нет критических отклонений или есть план','Лиза'],['Запуск','Сообщение клиенту','Клиенту сообщены старт и контрольная дата','Лиза'],
  ['Запуск','Первые 24 часа','Показы, клики, расходы и заявки проверены','Лиза'],['Запуск','Первые 72 часа','Есть первичный вывод и корректировки','Лиза']
];

function passwordHash(password) { const salt=randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password,salt,64).toString('hex')}`; }
function verifyPassword(password, stored) { const [salt, hex]=stored.split(':'); const got=scryptSync(password,salt,64); const want=Buffer.from(hex,'hex'); return got.length===want.length && timingSafeEqual(got,want); }
function tokenHash(token) { return createHash('sha256').update(token).digest('hex'); }
function seedUser(name, role, login, password) {
  if (!password) return;
  db.prepare('INSERT OR IGNORE INTO users(name,role,login,password_hash) VALUES(?,?,?,?)').run(name,role,login,passwordHash(password));
}
seedUser('Иван','owner','ivan',process.env.INIT_IVAN_PASSWORD);
seedUser('Лиза','manager','liza',process.env.INIT_LIZA_PASSWORD);

const json = (res,status,body,headers={}) => { res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers}); res.end(JSON.stringify(body)); };
const text = (res,status,body,type='text/plain; charset=utf-8') => { res.writeHead(status,{'content-type':type,'cache-control':'no-store'}); res.end(body); };
async function body(req) { let size=0, chunks=[]; for await (const c of req) { size+=c.length; if(size>MAX_BODY_BYTES) throw new Error('Слишком большой запрос'); chunks.push(c); } return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'); }
function cookies(req) { return Object.fromEntries(String(req.headers.cookie||'').split(';').map(v=>v.trim().split('=').map(decodeURIComponent)).filter(v=>v.length===2)); }
function auth(req) {
  const token=cookies(req)[COOKIE_NAME]; if(!token) return null;
  return db.prepare(`SELECT u.id,u.name,u.role,u.login,u.must_change FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`).get(tokenHash(token),Math.floor(Date.now()/1000)) || null;
}
function activity(projectId,userId,action,details='') { db.prepare('INSERT INTO activity(project_id,user_id,action,details) VALUES(?,?,?,?)').run(projectId,userId,action,details); }
function canSeeSales(user) { return user?.role === 'owner'; }
function projectAccess(id,user) {
  const own = user?.role === 'specialist' ? ' AND (p.manager_id=? OR EXISTS (SELECT 1 FROM tasks at WHERE at.project_id=p.id AND at.assignee_id=?))' : '';
  const params = user?.role === 'specialist' ? [id,user.id,user.id] : [id];
  return db.prepare(`SELECT p.*, o.name owner_name, m.name manager_name FROM projects p LEFT JOIN users o ON o.id=p.owner_id LEFT JOIN users m ON m.id=p.manager_id WHERE p.id=? AND p.archived=0 AND p.stage!='lead'${own}`).get(...params);
}
function canManageProject(user) { return user?.role === 'owner' || user?.role === 'manager'; }
const SUCCESS_PROFILE_FIELDS = ['business_goal','primary_kpi','target_value','monthly_budget','direct_login','metrika_counter_id','crm_source','landing_url','geo','offer','audience','restrictions','campaign_blueprint'];
function successProfile(projectId) { return db.prepare('SELECT * FROM client_success_profiles WHERE project_id=?').get(projectId)||null; }
function cleanSuccessProfile(input) {
  const profile=Object.fromEntries(SUCCESS_PROFILE_FIELDS.map(k=>[k,String(input[k]||'').trim()]));
  const missing=SUCCESS_PROFILE_FIELDS.filter(k=>!profile[k]);
  return {...profile,auto_actions_enabled:String(input.auto_actions_enabled||'0')==='1'?1:0,readiness:missing.length?'draft':'ready',missing};
}
function numberOrNull(value) { return value==='' || value===null || value===undefined ? null : Number(value); }
function route(pattern,path) { const keys=[]; const re=new RegExp('^'+pattern.replace(/:([A-Za-z]+)/g,(_,k)=>(keys.push(k),'([^/]+)'))+'$'); const m=path.match(re); return m?Object.fromEntries(keys.map((k,i)=>[k,decodeURIComponent(m[i+1])])):null; }
function secureEqual(a,b) { const aa=Buffer.from(String(a||'')),bb=Buffer.from(String(b||'')); return aa.length===bb.length && timingSafeEqual(aa,bb); }
function publicLeadCors(req) {
  const origin=String(req.headers.origin||'');
  return PUBLIC_LEAD_ORIGINS.has(origin)?{'access-control-allow-origin':origin,'access-control-allow-methods':'POST, OPTIONS','access-control-allow-headers':'content-type','vary':'Origin'}:null;
}
function publicLeadIp(req) { return String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'unknown').split(',')[0].trim(); }
function publicLeadRateAllowed(req) {
  const now=Date.now(),ip=publicLeadIp(req),windowMs=10*60*1000;
  const recent=(publicLeadRate.get(ip)||[]).filter(ts=>now-ts<windowMs);
  if(recent.length>=8) { publicLeadRate.set(ip,recent); return false; }
  recent.push(now); publicLeadRate.set(ip,recent); return true;
}
function cleanPublic(value,max=500) { return String(value||'').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max); }
function createPublicLead(input) {
  const submissionId=cleanPublic(input.submission_id,80);
  if(!/^[a-zA-Z0-9_-]{16,80}$/.test(submissionId)) throw Object.assign(new Error('Некорректный идентификатор отправки'),{status:400});
  const existing=db.prepare('SELECT id FROM leads WHERE external_key=?').get(`website:${submissionId}`);
  if(existing) return {id:existing.id,duplicate:true};
  const phone=cleanPublic(input.phone,80),email=cleanPublic(input.email,160),contactName=cleanPublic(input.contact_name,160),website=cleanPublic(input.website,300);
  if(!phone&&!email) throw Object.assign(new Error('Укажите телефон или email'),{status:400});
  if(cleanPublic(input.website_trap,100)) throw Object.assign(new Error('Заявка отклонена'),{status:400});
  const owner=db.prepare("SELECT id,name,role,login,must_change FROM users WHERE role='owner' AND active=1 ORDER BY id LIMIT 1").get();
  if(!owner) throw Object.assign(new Error('Не найден активный собственник'),{status:409});
  const sourcePage=cleanPublic(input.page,500),formName=cleanPublic(input.form_name,200),message=cleanPublic(input.message,1500),utm=cleanPublic(input.utm,1000);
  const notes=[formName&&`Форма: ${formName}`,sourcePage&&`Страница: ${sourcePage}`,message&&`Сообщение: ${message}`,utm&&`UTM: ${utm}`].filter(Boolean).join('\n');
  const today=new Date().toISOString().slice(0,10);
  const company=contactName||website||email||phone||'Заявка с сайта';
  const id=createLead({company,contact_name:contactName,phone,email,website,source:'digital-red.ru',service:cleanPublic(input.service,240)||'Заявка с сайта',lead_date:today,external_key:`website:${submissionId}`,stage:'new',qualification:'unqualified',owner_id:owner.id,next_action:'Связаться с лидом',next_action_due:today,need:message,notes},owner);
  return {id,duplicate:false};
}
function findProjectByName(name) { const key=normalizeProjectName(name); return db.prepare('SELECT id,client,stage FROM projects WHERE archived=0 ORDER BY updated_at DESC').all().find(p=>normalizeProjectName(p.client)===key)||null; }
function findLeadByName(name) { const key=normalizeProjectName(name); return db.prepare("SELECT id,company FROM leads WHERE stage NOT IN ('won','lost') ORDER BY updated_at DESC").all().find(p=>normalizeProjectName(p.company)===key)||null; }

function createLead(input,user) {
  if(!String(input.company||'').trim()) throw new Error('Укажите компанию или имя лида');
  const r=db.prepare(`INSERT INTO leads(company,contact_name,phone,email,website,source,service,lead_date,external_key,stage,qualification,owner_id,budget,need,deadline,decision_maker,next_action,next_action_due,last_contact_at,loss_reason,notes)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    String(input.company).trim(),String(input.contact_name||'').trim(),String(input.phone||'').trim(),String(input.email||'').trim(),String(input.website||'').trim(),String(input.source||'').trim(),String(input.service||'').trim(),input.lead_date||null,input.external_key||null,
    input.stage||'new',input.qualification||'unqualified',input.owner_id||user.id,String(input.budget||'').trim(),String(input.need||'').trim(),String(input.deadline||'').trim(),String(input.decision_maker||'').trim(),String(input.next_action||'').trim(),input.next_action_due||null,input.last_contact_at||null,String(input.loss_reason||'').trim(),String(input.notes||'').trim());
  const id=Number(r.lastInsertRowid);
  db.prepare('INSERT INTO lead_activities(lead_id,user_id,type,summary) VALUES(?,?,?,?)').run(id,user.id,'created','Лид добавлен в CRM');
  return id;
}

function createProject(input,user) {
  if(!String(input.client||'').trim()) throw new Error('Укажите клиента');
  const service=String(input.service||'').trim()||'Уточнить после созвона';
  const publicToken=randomBytes(18).toString('base64url');
  const r=db.prepare(`INSERT INTO projects(client,service,sale_date,owner_id,manager_id,stage,launch_deadline,next_action,next_action_due,next_client_contact,next_report,risk,materials_url,call_summary,public_token) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    String(input.client).trim(),service,input.sale_date||null,user.id,input.manager_id||null,input.stage||'sold',input.launch_deadline||null,input.next_action||'',input.next_action_due||null,input.next_client_contact||null,input.next_report||null,input.risk||'none',input.materials_url||'',input.call_summary||'',publicToken);
  const pid=Number(r.lastInsertRowid);
  const h=db.prepare('INSERT INTO handoff_items(project_id,section,label,hint) VALUES(?,?,?,?)');
  const l=db.prepare('INSERT INTO launch_items(project_id,stage,label,criterion,assignee) VALUES(?,?,?,?,?)');
  db.exec('BEGIN'); try { for(const x of handoffTemplate) h.run(pid,...x); for(const x of launchTemplate) l.run(pid,...x); db.exec('COMMIT'); } catch(e){db.exec('ROLLBACK');throw e;}
  activity(pid,user.id,input.stage==='lead'?'Создан лид':'Создан проект',`${input.client} — ${service}`); return pid;
}

function addCallRecord(projectId,input,user) {
  const externalId=String(input.external_id||'').trim()||null;
  if(externalId) {
    const duplicate=db.prepare('SELECT id,project_id FROM call_records WHERE external_id=?').get(externalId);
    if(duplicate) return {id:duplicate.id,project_id:duplicate.project_id,duplicate:true};
  }
  const summary=String(input.summary||'').trim();
  const transcript=String(input.transcript||'').trim();
  if(!summary && !transcript) throw new Error('Добавьте сводку или расшифровку созвона');
  const result=db.prepare(`INSERT INTO call_records(project_id,source,external_id,title,transcript,summary,trigger_phrase,occurred_at,created_by) VALUES(?,?,?,?,?,?,?,?,?)`).run(
    projectId,String(input.source||'manual').trim()||'manual',externalId,String(input.title||'').trim(),transcript,summary,String(input.trigger_phrase||'').trim(),input.occurred_at||null,user?.id||null);
  if(summary) db.prepare(`UPDATE projects SET call_summary=CASE WHEN trim(call_summary)='' THEN ? ELSE call_summary END,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(summary,projectId);
  else db.prepare('UPDATE projects SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(projectId);
  activity(projectId,user?.id||null,'Добавлен созвон',summary||String(input.title||'Без названия'));
  return {id:Number(result.lastInsertRowid),project_id:projectId,duplicate:false};
}

function intakeCall(input,user) {
  const externalId=String(input.external_id||'').trim();
  if(externalId) {
    const duplicate=db.prepare(`SELECT c.id,c.project_id,p.client project_name FROM call_records c JOIN projects p ON p.id=c.project_id WHERE c.external_id=?`).get(externalId);
    if(duplicate) return {project_id:duplicate.project_id,project_name:duplicate.project_name,project_created:false,id:duplicate.id,duplicate:true};
  }
  const projectName=extractProjectName(input);
  if(!projectName) throw new Error('В конце расшифровки нужна отдельная фраза «Проект <название>»');
  const project=findProjectByName(projectName);
  if(project && project.stage!=='lead') {
    const call=addCallRecord(project.id,{...input,trigger_phrase:`Проект ${projectName}`},user);
    return {kind:'project',project_id:project.id,project_name:project.client,project_created:false,...call};
  }
  let lead=findLeadByName(projectName),created=false;
  if(!lead) {
    const id=createLead({company:projectName,service:input.service||'',source:input.source||'Созвон',next_action:'Квалифицировать лид и назначить следующий контакт',notes:input.summary||input.transcript||''},user);
    lead={id,company:projectName}; created=true;
  }
  const summary=String(input.summary||input.title||'Добавлен первичный созвон').trim();
  db.prepare('INSERT INTO lead_activities(lead_id,user_id,type,summary,occurred_at) VALUES(?,?,?,?,COALESCE(?,CURRENT_TIMESTAMP))').run(lead.id,user.id,'call',summary,input.occurred_at||null);
  db.prepare('UPDATE leads SET last_contact_at=COALESCE(?,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=?').run(input.occurred_at||null,lead.id);
  return {kind:'lead',lead_id:lead.id,lead_name:lead.company,lead_created:created,duplicate:false};
}

function dashboard(user) {
  const scope=user.role==='specialist'?' AND (p.manager_id=? OR EXISTS (SELECT 1 FROM tasks at WHERE at.project_id=p.id AND at.assignee_id=?))':'';
  const params=user.role==='specialist'?[user.id,user.id]:[];
  const counts=db.prepare(`SELECT COUNT(*) total, SUM(stage IN ('launched','management')) active, SUM(risk IN ('high','stop')) risks, SUM(acceptance_status!='accepted') handoffs,
    SUM(next_report IS NULL OR next_report<date('now')) reports_due, SUM(next_client_contact IS NOT NULL AND next_client_contact<=date('now')) contacts_due,
    SUM(trim(COALESCE(next_action,''))='') without_action,
    SUM(NOT EXISTS(SELECT 1 FROM client_success_profiles sp WHERE sp.project_id=p.id AND sp.readiness='ready')) without_success_profile,
    SUM(stage IN ('launched','management') AND NOT EXISTS(SELECT 1 FROM daily_audits da WHERE da.project_id=p.id AND da.audit_date>=date('now','-1 day'))) audits_due
    FROM projects p WHERE archived=0 AND stage!='lead'${scope}`).get(...params);
  const overdue=db.prepare(`SELECT COUNT(*) n FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.status!='done' AND t.due_date IS NOT NULL AND t.due_date<date('now') AND p.archived=0 AND p.stage!='lead'${scope}`).get(...params).n;
  const projects=db.prepare(`SELECT p.id,p.client,p.service,p.stage,p.acceptance_status,p.launch_deadline,p.next_action,p.next_action_due,p.next_report,p.risk,m.name manager_name,
    (SELECT COUNT(*) FROM handoff_items h WHERE h.project_id=p.id AND h.required=1 AND h.status!='accepted') handoff_open,
    (SELECT COUNT(*) FROM launch_items l WHERE l.project_id=p.id AND l.required=1 AND l.status NOT IN ('done','na')) launch_open,
    (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id AND t.status!='done') open_tasks,
    (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id AND t.status!='done' AND (t.status='blocked' OR t.priority IN ('high','urgent') OR (t.due_date IS NOT NULL AND t.due_date<=date('now','+2 day')))) urgent_tasks,
    (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id AND t.status!='done' AND t.due_date<date('now')) overdue,
    (SELECT MIN(t.due_date) FROM tasks t WHERE t.project_id=p.id AND t.status!='done' AND t.due_date IS NOT NULL) next_task_due,
    (SELECT MAX(r.created_at) FROM reports r WHERE r.project_id=p.id) last_report_at,
    (SELECT sp.readiness FROM client_success_profiles sp WHERE sp.project_id=p.id) success_readiness,
    (SELECT MAX(da.audit_date) FROM daily_audits da WHERE da.project_id=p.id) last_audit_date,
    (SELECT da.status FROM daily_audits da WHERE da.project_id=p.id ORDER BY da.audit_date DESC,da.id DESC LIMIT 1) last_audit_status,
    (SELECT COUNT(*) FROM escalations e WHERE e.project_id=p.id AND e.status='open') open_escalations
    FROM projects p LEFT JOIN users m ON m.id=p.manager_id WHERE p.archived=0 AND p.stage!='lead'${scope}
    ORDER BY CASE WHEN p.risk='stop' THEN 0 WHEN p.risk='high' THEN 1 WHEN EXISTS(SELECT 1 FROM tasks ot WHERE ot.project_id=p.id AND ot.status!='done' AND ot.due_date<date('now')) THEN 2 WHEN p.next_report IS NULL OR p.next_report<date('now') THEN 3 ELSE 4 END,p.updated_at DESC`).all(...params);
  return {counts:{...counts,overdue},projects};
}

function salesDashboard() {
  const leads=db.prepare(`SELECT l.*,u.name owner_name,
    (SELECT MAX(a.occurred_at) FROM lead_activities a WHERE a.lead_id=l.id) activity_at,
    (SELECT COUNT(*) FROM lead_activities a WHERE a.lead_id=l.id) activity_count
    FROM leads l LEFT JOIN users u ON u.id=l.owner_id ORDER BY
    CASE WHEN l.stage NOT IN ('won','lost') AND l.next_action_due IS NOT NULL AND l.next_action_due<date('now') THEN 0
         WHEN l.stage='new' THEN 1 WHEN l.stage='qualified' THEN 2 ELSE 3 END,l.updated_at DESC`).all();
  const counts=db.prepare(`SELECT COUNT(*) total,
    SUM(stage NOT IN ('won','lost')) active, SUM(stage='new') new_count, SUM(qualification='qualified' AND stage NOT IN ('won','lost')) qualified,
    SUM(stage='won') won, SUM(stage='lost') lost,
    SUM(stage NOT IN ('won','lost') AND next_action_due IS NOT NULL AND next_action_due<date('now')) overdue,
    SUM(stage NOT IN ('won','lost') AND trim(COALESCE(next_action,''))='') without_action
    FROM leads`).get();
  return {counts,leads};
}

function leadCard(id) {
  const lead=db.prepare('SELECT l.*,u.name owner_name FROM leads l LEFT JOIN users u ON u.id=l.owner_id WHERE l.id=?').get(id);
  if(!lead) return null;
  const activities=db.prepare('SELECT a.*,u.name user_name FROM lead_activities a LEFT JOIN users u ON u.id=a.user_id WHERE a.lead_id=? ORDER BY a.occurred_at DESC,a.id DESC').all(id);
  return {lead,activities};
}

async function api(req,res,path) {
  if(path==='/api/public/leads' && req.method==='OPTIONS') {
    const cors=publicLeadCors(req); return cors?json(res,200,{ok:true},cors):json(res,403,{error:'Домен не разрешён'});
  }
  if(path==='/api/public/leads' && req.method==='POST') {
    const cors=publicLeadCors(req); if(!cors) return json(res,403,{error:'Домен не разрешён'});
    if(!String(req.headers['content-type']||'').toLowerCase().includes('application/json')) return json(res,415,{error:'Ожидается JSON'},cors);
    if(!publicLeadRateAllowed(req)) return json(res,429,{error:'Слишком много отправок. Попробуйте позже.'},cors);
    try { const result=createPublicLead(await body(req)); return json(res,result.duplicate?200:201,{ok:true,...result},cors); }
    catch(e) { return json(res,e.status||400,{error:e.message||'Не удалось отправить заявку'},cors); }
  }
  if(req.method==='POST' && path==='/api/integrations/calls') {
    if(!INTEGRATION_TOKEN) return json(res,503,{error:'Интеграция созвонов пока не подключена'});
    const supplied=String(req.headers.authorization||'').replace(/^Bearer\s+/i,'');
    if(!secureEqual(supplied,INTEGRATION_TOKEN)) return json(res,401,{error:'Неверный токен интеграции'});
    const owner=db.prepare("SELECT id,name,role,login,must_change FROM users WHERE role='owner' AND active=1 ORDER BY id LIMIT 1").get();
    if(!owner) return json(res,409,{error:'Не найден активный собственник'});
    const result=intakeCall(await body(req),owner); return json(res,result.project_created||result.lead_created?201:200,result);
  }
  if(req.method==='POST' && path==='/api/login') {
    const input=await body(req); const u=db.prepare('SELECT * FROM users WHERE login=? AND active=1').get(String(input.login||''));
    if(!u || !verifyPassword(String(input.password||''),u.password_hash)) return json(res,401,{error:'Неверный логин или пароль'});
    const token=randomBytes(32).toString('base64url'); db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(tokenHash(token),u.id,Math.floor(Date.now()/1000)+SESSION_TTL);
    return json(res,200,{ok:true},{'set-cookie':`${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL}`});
  }
  const user=auth(req); if(!user) return json(res,401,{error:'Требуется вход'});
  if(req.method==='GET' && path==='/api/me') return json(res,200,user);
  if(req.method==='POST' && path==='/api/logout') { const t=cookies(req)[COOKIE_NAME]; if(t) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(t)); return json(res,200,{ok:true},{'set-cookie':`${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`}); }
  if(req.method==='POST' && path==='/api/change-password') { const x=await body(req); if(String(x.password||'').length<10) return json(res,400,{error:'Пароль должен быть не короче 10 символов'}); db.prepare('UPDATE users SET password_hash=?,must_change=0 WHERE id=?').run(passwordHash(x.password),user.id); db.prepare('DELETE FROM sessions WHERE user_id=? AND token_hash!=?').run(user.id,tokenHash(cookies(req)[COOKIE_NAME])); return json(res,200,{ok:true}); }
  if(req.method==='GET' && path==='/api/users') return json(res,200,db.prepare('SELECT id,name,role,login FROM users WHERE active=1 ORDER BY id').all());
  if(req.method==='GET' && path==='/api/dashboard') return json(res,200,dashboard(user));
  if(req.method==='GET' && path==='/api/projects') return json(res,200,dashboard(user).projects);
  if(req.method==='POST' && path==='/api/projects') { if(user.role==='specialist')return json(res,403,{error:'Недостаточно прав'}); const input=await body(req); if(['lead','sold'].includes(input.stage))input.stage='handoff'; const id=createProject(input,user); return json(res,201,{id}); }
  if(req.method==='POST' && path==='/api/calls/intake') { if(!canSeeSales(user))return json(res,403,{error:'Раздел продаж доступен только собственнику'}); const result=intakeCall(await body(req),user); return json(res,result.lead_created||result.project_created?201:200,result); }
  if(path.startsWith('/api/sales') || path.startsWith('/api/leads')) {
    if(!canSeeSales(user)) return json(res,403,{error:'Раздел продаж доступен только собственнику'});
    if(req.method==='GET' && path==='/api/sales/dashboard') return json(res,200,salesDashboard());
    if(req.method==='POST' && path==='/api/leads') { const id=createLead(await body(req),user); return json(res,201,{id}); }
    let lm=route('/api/leads/:id/activities',path);
    if(lm && req.method==='POST') { const x=await body(req),id=Number(lm.id); if(!db.prepare('SELECT id FROM leads WHERE id=?').get(id))return json(res,404,{error:'Лид не найден'}); if(!String(x.summary||'').trim())return json(res,400,{error:'Опишите контакт или результат'}); db.prepare('INSERT INTO lead_activities(lead_id,user_id,type,summary,occurred_at) VALUES(?,?,?,?,COALESCE(?,CURRENT_TIMESTAMP))').run(id,user.id,x.type||'note',String(x.summary).trim(),x.occurred_at||null); db.prepare('UPDATE leads SET last_contact_at=CASE WHEN ? IN (\'call\',\'meeting\',\'message\') THEN COALESCE(?,CURRENT_TIMESTAMP) ELSE last_contact_at END,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(x.type||'note',x.occurred_at||null,id); return json(res,201,{ok:true}); }
    lm=route('/api/leads/:id/convert',path);
    if(lm && req.method==='POST') { const id=Number(lm.id),x=await body(req),l=db.prepare('SELECT * FROM leads WHERE id=?').get(id); if(!l)return json(res,404,{error:'Лид не найден'}); if(l.converted_project_id)return json(res,409,{error:'Лид уже передан в производство'}); const pid=createProject({client:l.company,service:l.service||'Уточнить',sale_date:new Date().toISOString().slice(0,10),manager_id:x.manager_id||null,stage:'handoff',launch_deadline:x.launch_deadline||null,next_action:'Принять передачу и проверить вводные',call_summary:[l.need,l.notes].filter(Boolean).join('\n')},user); db.prepare("UPDATE leads SET stage='won',qualification='qualified',converted_project_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(pid,id); db.prepare('INSERT INTO lead_activities(lead_id,user_id,type,summary) VALUES(?,?,?,?)').run(id,user.id,'conversion',`Продажа состоялась, создан проект #${pid}`); return json(res,201,{project_id:pid}); }
    lm=route('/api/leads/:id',path);
    if(lm && req.method==='GET') { const card=leadCard(Number(lm.id)); return card?json(res,200,card):json(res,404,{error:'Лид не найден'}); }
    if(lm && req.method==='PATCH') { const id=Number(lm.id),current=db.prepare('SELECT * FROM leads WHERE id=?').get(id); if(!current)return json(res,404,{error:'Лид не найден'}); const x=await body(req),allowed=['company','contact_name','phone','email','website','source','service','lead_date','stage','qualification','owner_id','budget','need','deadline','decision_maker','next_action','next_action_due','last_contact_at','loss_reason','notes']; if(x.stage&&!LEAD_STAGES.has(x.stage))return json(res,400,{error:'Неизвестный этап продаж'}); if(x.stage==='won'&&!current.converted_project_id)return json(res,409,{error:'Продажу нужно передать в производство через действие «Продажа состоялась»'}); if(x.stage==='lost'&&!String(x.loss_reason||current.loss_reason||'').trim())return json(res,400,{error:'Укажите причину проигрыша'}); const e=Object.entries(x).filter(([k])=>allowed.includes(k)); if(!e.length)return json(res,400,{error:'Нет допустимых полей'}); db.prepare(`UPDATE leads SET ${e.map(([k])=>`${k}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...e.map(([,v])=>v||null),id); if(x.stage&&x.stage!==current.stage)db.prepare('INSERT INTO lead_activities(lead_id,user_id,type,summary) VALUES(?,?,?,?)').run(id,user.id,'stage',`Этап: ${current.stage} → ${x.stage}`); return json(res,200,{ok:true}); }
    return json(res,404,{error:'Метод продаж не найден'});
  }
  let m=route('/api/projects/:id',path);
  if(m && req.method==='GET') { const p=projectAccess(Number(m.id),user); if(!p)return json(res,404,{error:'Проект не найден'}); return json(res,200,p); }
  if(m && req.method==='PATCH') {
    const id=Number(m.id), input=await body(req), p=projectAccess(id,user); if(!p)return json(res,404,{error:'Проект не найден'});
    const allowed=['client','service','sale_date','handoff_date','manager_id','stage','acceptance_status','launch_deadline','next_action','next_action_due','next_client_contact','next_report','risk','materials_url','call_summary'];
    if(input.acceptance_status==='accepted') { const open=db.prepare("SELECT COUNT(*) n FROM handoff_items WHERE project_id=? AND required=1 AND status!='accepted'").get(id).n; if(open) return json(res,409,{error:`Передача не может быть принята: незакрытых пунктов — ${open}`}); }
    if(input.stage==='launched' || input.stage==='management') {
      const open=db.prepare("SELECT COUNT(*) n FROM launch_items WHERE project_id=? AND required=1 AND status NOT IN ('done','na')").get(id).n;
      if(open) return json(res,409,{error:`Запуск запрещён: незакрытых проверок — ${open}`});
      const profile=successProfile(id);
      if(!profile || profile.readiness!=='ready') return json(res,409,{error:'Запуск запрещён: заполните паспорт результата и утверждённую структуру кампаний'});
    }
    const entries=Object.entries(input).filter(([k])=>allowed.includes(k)); if(!entries.length)return json(res,400,{error:'Нет допустимых полей'});
    db.prepare(`UPDATE projects SET ${entries.map(([k])=>`${k}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...entries.map(([,v])=>v||null),id);
    activity(id,user.id,'Обновлён проект',entries.map(([k])=>k).join(', ')); return json(res,200,{ok:true});
  }
  m=route('/api/projects/:id/all',path);
  if(m && req.method==='GET') {
    const id=Number(m.id),p=projectAccess(id,user); if(!p)return json(res,404,{error:'Проект не найден'});
    return json(res,200,{
      project:p,
      handoff:db.prepare('SELECT * FROM handoff_items WHERE project_id=? ORDER BY id').all(id),
      launch:db.prepare('SELECT * FROM launch_items WHERE project_id=? ORDER BY id').all(id),
      tasks:db.prepare(`SELECT t.*,u.name assignee_name FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE t.project_id=? ORDER BY CASE t.status WHEN 'blocked' THEN 0 WHEN 'doing' THEN 1 ELSE 2 END,t.due_date`).all(id),
      reports:db.prepare('SELECT r.*,u.name author_name FROM reports r LEFT JOIN users u ON u.id=r.created_by WHERE r.project_id=? ORDER BY r.created_at DESC').all(id),
      escalations:db.prepare('SELECT e.*,u.name author_name FROM escalations e LEFT JOIN users u ON u.id=e.created_by WHERE e.project_id=? ORDER BY e.created_at DESC').all(id),
      calls:db.prepare('SELECT c.*,u.name author_name FROM call_records c LEFT JOIN users u ON u.id=c.created_by WHERE c.project_id=? ORDER BY COALESCE(c.occurred_at,c.created_at) DESC,c.id DESC').all(id),
      success_profile:successProfile(id),
      daily_audits:db.prepare('SELECT d.*,u.name author_name FROM daily_audits d LEFT JOIN users u ON u.id=d.created_by WHERE d.project_id=? ORDER BY d.audit_date DESC,d.id DESC LIMIT 90').all(id),
      optimization_actions:db.prepare('SELECT o.*,u.name author_name FROM optimization_actions o LEFT JOIN users u ON u.id=o.created_by WHERE o.project_id=? ORDER BY o.action_date DESC,o.id DESC LIMIT 200').all(id),
      activity:db.prepare('SELECT a.*,u.name user_name FROM activity a LEFT JOIN users u ON u.id=a.user_id WHERE a.project_id=? ORDER BY a.created_at DESC LIMIT 60').all(id)
    });
  }
  m=route('/api/projects/:pid/success-profile',path);
  if(m && req.method==='PUT') {
    const pid=Number(m.pid); if(!projectAccess(pid,user))return json(res,404,{error:'Проект не найден'});
    if(!canManageProject(user))return json(res,403,{error:'Паспорт результата меняет собственник или проджект'});
    const profile=cleanSuccessProfile(await body(req));
    if(profile.missing.length) return json(res,400,{error:`Заполните обязательные поля паспорта результата: ${profile.missing.join(', ')}`});
    db.prepare(`INSERT INTO client_success_profiles(project_id,business_goal,primary_kpi,target_value,monthly_budget,direct_login,metrika_counter_id,crm_source,landing_url,geo,offer,audience,restrictions,campaign_blueprint,auto_actions_enabled,readiness,updated_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(project_id) DO UPDATE SET business_goal=excluded.business_goal,primary_kpi=excluded.primary_kpi,target_value=excluded.target_value,monthly_budget=excluded.monthly_budget,direct_login=excluded.direct_login,metrika_counter_id=excluded.metrika_counter_id,crm_source=excluded.crm_source,landing_url=excluded.landing_url,geo=excluded.geo,offer=excluded.offer,audience=excluded.audience,restrictions=excluded.restrictions,campaign_blueprint=excluded.campaign_blueprint,auto_actions_enabled=excluded.auto_actions_enabled,readiness=excluded.readiness,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`).run(
      pid,...SUCCESS_PROFILE_FIELDS.map(k=>profile[k]),profile.auto_actions_enabled,profile.readiness,user.id);
    activity(pid,user.id,'Обновлён паспорт результата',`${profile.primary_kpi}: ${profile.target_value}`);
    return json(res,200,successProfile(pid));
  }
  m=route('/api/projects/:pid/daily-audits',path);
  if(m && req.method==='POST') {
    const pid=Number(m.pid),x=await body(req); if(!projectAccess(pid,user))return json(res,404,{error:'Проект не найден'});
    if(!canManageProject(user))return json(res,403,{error:'Ежедневный аудит фиксирует собственник или проджект'});
    const sourceStatuses=new Set(['confirmed','confirmed_zero','unavailable']),statuses=new Set(['ok','attention','critical','unavailable']);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(x.audit_date||'')))return json(res,400,{error:'Укажите дату аудита'});
    if(!sourceStatuses.has(x.source_status))return json(res,400,{error:'Укажите подтверждённость данных'});
    if(!statuses.has(x.status))return json(res,400,{error:'Укажите итог аудита'});
    const existed=db.prepare('SELECT id FROM daily_audits WHERE project_id=? AND audit_date=?').get(pid,x.audit_date);
    db.prepare(`INSERT INTO daily_audits(project_id,audit_date,source_status,status,impressions,clicks,spend,conversions,cpa,findings,actions,raw_reference,created_by)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(project_id,audit_date) DO UPDATE SET source_status=excluded.source_status,status=excluded.status,impressions=excluded.impressions,clicks=excluded.clicks,spend=excluded.spend,conversions=excluded.conversions,cpa=excluded.cpa,findings=excluded.findings,actions=excluded.actions,raw_reference=excluded.raw_reference,created_by=excluded.created_by,updated_at=CURRENT_TIMESTAMP`).run(
      pid,x.audit_date,x.source_status,x.status,numberOrNull(x.impressions),numberOrNull(x.clicks),numberOrNull(x.spend),numberOrNull(x.conversions),numberOrNull(x.cpa),String(x.findings||'').trim(),String(x.actions||'').trim(),String(x.raw_reference||'').trim(),user.id);
    activity(pid,user.id,existed?'Обновлён ежедневный аудит':'Добавлен ежедневный аудит',`${x.audit_date}: ${x.status}`);
    return json(res,existed?200:201,{id:(existed||db.prepare('SELECT id FROM daily_audits WHERE project_id=? AND audit_date=?').get(pid,x.audit_date)).id});
  }
  m=route('/api/projects/:pid/optimization-actions',path);
  if(m && req.method==='POST') {
    const pid=Number(m.pid),x=await body(req); if(!projectAccess(pid,user))return json(res,404,{error:'Проект не найден'});
    if(!canManageProject(user))return json(res,403,{error:'Корректировки фиксирует собственник или проджект'});
    if(!/^\d{4}-\d{2}-\d{2}$/.test(String(x.action_date||'')))return json(res,400,{error:'Укажите дату корректировки'});
    if(!String(x.action||'').trim()||!String(x.rationale||'').trim())return json(res,400,{error:'Укажите действие и основание'});
    const allowedStatus=new Set(['planned','approval_required','applied','rejected','rolled_back']),status=allowedStatus.has(x.status)?x.status:'planned';
    const applied=status==='applied';
    const r=db.prepare(`INSERT INTO optimization_actions(project_id,action_date,category,entity,action,rationale,risk_level,status,before_value,after_value,proof,created_by,applied_by,applied_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END)`).run(pid,x.action_date,String(x.category||'other'),String(x.entity||''),String(x.action).trim(),String(x.rationale).trim(),String(x.risk_level||'low'),status,String(x.before_value||''),String(x.after_value||''),String(x.proof||''),user.id,applied?user.id:null,applied?1:0);
    activity(pid,user.id,'Зафиксирована корректировка',`${x.action_date}: ${String(x.action).trim()}`);
    return json(res,201,{id:Number(r.lastInsertRowid)});
  }
  m=route('/api/projects/:pid/calls',path);
  if(m && req.method==='POST') { const pid=Number(m.pid),p=projectAccess(pid,user); if(!p)return json(res,404,{error:'Проект не найден'}); const result=addCallRecord(pid,await body(req),user); return json(res,result.duplicate?200:201,result); }
  m=route('/api/projects/:pid/handoff/:id',path);
  if(m && req.method==='PATCH') { const x=await body(req), pid=Number(m.pid), id=Number(m.id); if(!projectAccess(pid,user))return json(res,404,{error:'Проект не найден'}); if(x.status==='accepted' && (!String(x.value||'').trim() || !String(x.proof||'').trim())) return json(res,409,{error:'Для принятия заполните значение и доказательство/ссылку'}); db.prepare('UPDATE handoff_items SET value=?,status=?,comment=?,proof=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND project_id=?').run(x.value||'',x.status||'missing',x.comment||'',x.proof||'',user.id,id,pid); activity(pid,user.id,'Обновлена передача',`Пункт #${id}: ${x.status}`); return json(res,200,{ok:true}); }
  m=route('/api/projects/:pid/launch/:id',path);
  if(m && req.method==='PATCH') { const x=await body(req),pid=Number(m.pid),id=Number(m.id); if(!projectAccess(pid,user))return json(res,404,{error:'Проект не найден'}); if(x.status==='done' && !String(x.proof||'').trim()) return json(res,409,{error:'Готово требует доказательство: ссылку, ID, дату или цифру'}); db.prepare("UPDATE launch_items SET status=?,proof=?,due_date=?,checked_by=CASE WHEN ?='done' THEN ? ELSE checked_by END,checked_at=CASE WHEN ?='done' THEN CURRENT_TIMESTAMP ELSE checked_at END,updated_at=CURRENT_TIMESTAMP WHERE id=? AND project_id=?").run(x.status||'todo',x.proof||'',x.due_date||null,x.status,user.id,x.status,id,pid); activity(pid,user.id,'Обновлена проверка запуска',`Пункт #${id}: ${x.status}`); return json(res,200,{ok:true}); }
  m=route('/api/projects/:pid/tasks',path);
  if(m && req.method==='POST') { const x=await body(req),pid=Number(m.pid); if(!projectAccess(pid,user))return json(res,404,{error:'Проект не найден'}); if(!String(x.title||'').trim())return json(res,400,{error:'Укажите задачу'}); const r=db.prepare('INSERT INTO tasks(project_id,title,description,assignee_id,status,priority,due_date,created_by) VALUES(?,?,?,?,?,?,?,?)').run(pid,x.title.trim(),x.description||'',x.assignee_id||null,x.status||'backlog',x.priority||'normal',x.due_date||null,user.id); activity(pid,user.id,'Создана задача',x.title); return json(res,201,{id:Number(r.lastInsertRowid)}); }
  m=route('/api/tasks/:id',path);
  if(m && req.method==='PATCH') { const x=await body(req),id=Number(m.id),t=db.prepare('SELECT * FROM tasks WHERE id=?').get(id); if(!t||!projectAccess(t.project_id,user))return json(res,404,{error:'Задача не найдена'}); const allowed=['title','description','assignee_id','status','priority','due_date','proof']; const e=Object.entries(x).filter(([k])=>allowed.includes(k)); db.prepare(`UPDATE tasks SET ${e.map(([k])=>`${k}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...e.map(([,v])=>v||null),id); activity(t.project_id,user.id,'Обновлена задача',`${t.title}: ${x.status||'изменена'}`); return json(res,200,{ok:true}); }
  m=route('/api/projects/:pid/reports',path);
  if(m && req.method==='POST') { const x=await body(req),pid=Number(m.pid); if(!projectAccess(pid,user))return json(res,404,{error:'Проект не найден'}); for(const k of ['period','planned','completed','metrics','next_steps']) if(!String(x[k]||'').trim())return json(res,400,{error:`Заполните обязательное поле: ${k}`}); const r=db.prepare('INSERT INTO reports(project_id,period,planned,completed,metrics,deviation,reason,next_steps,risk,client_message,report_url,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(pid,x.period,x.planned,x.completed,x.metrics,x.deviation||'',x.reason||'',x.next_steps,x.risk||'none',x.client_message||'',x.report_url||'',user.id); db.prepare('UPDATE projects SET next_report=?,risk=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(x.next_report||null,x.risk||'none',pid); activity(pid,user.id,'Добавлен недельный отчёт',x.period); return json(res,201,{id:Number(r.lastInsertRowid)}); }
  m=route('/api/projects/:pid/escalations',path);
  if(m && req.method==='POST') { const x=await body(req),pid=Number(m.pid); if(!projectAccess(pid,user))return json(res,404,{error:'Проект не найден'}); for(const k of ['type','facts','impact','option_a','option_b','recommendation']) if(!String(x[k]||'').trim())return json(res,400,{error:'Эскалация должна содержать факты, влияние, 2 варианта и рекомендацию'}); const r=db.prepare('INSERT INTO escalations(project_id,type,facts,impact,option_a,option_b,recommendation,created_by) VALUES(?,?,?,?,?,?,?,?)').run(pid,x.type,x.facts,x.impact,x.option_a,x.option_b,x.recommendation,user.id); db.prepare("UPDATE projects SET risk='high',updated_at=CURRENT_TIMESTAMP WHERE id=? AND risk!='stop'").run(pid); activity(pid,user.id,'Создана эскалация',x.type); return json(res,201,{id:Number(r.lastInsertRowid)}); }
  m=route('/api/escalations/:id',path);
  if(m && req.method==='PATCH') { const id=Number(m.id),e=db.prepare('SELECT * FROM escalations WHERE id=?').get(id); if(!e||!projectAccess(e.project_id,user))return json(res,404,{error:'Эскалация не найдена'}); const x=await body(req); const status=x.status==='resolved'?'resolved':'open'; db.prepare("UPDATE escalations SET status=?,resolved_at=CASE WHEN ?='resolved' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=?").run(status,status,id); activity(e.project_id,user.id,status==='resolved'?'Закрыта эскалация':'Открыта эскалация',e.type); return json(res,200,{ok:true}); }
  return json(res,404,{error:'Метод не найден'});
}

function publicReport(res,token) {
  const p=db.prepare('SELECT id,client,service,stage,risk,updated_at FROM projects WHERE public_token=? AND archived=0').get(token); if(!p)return text(res,404,'Отчёт не найден');
  const reports=db.prepare('SELECT period,completed,metrics,deviation,next_steps,risk,client_message,created_at FROM reports WHERE project_id=? ORDER BY created_at DESC LIMIT 12').all(p.id);
  const esc=s=>String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const cards=reports.map(r=>`<article><small>${esc(r.period)}</small><h2>Результаты</h2><p>${esc(r.completed)}</p><h3>Цифры</h3><p>${esc(r.metrics)}</p><h3>Следующие шаги</h3><p>${esc(r.next_steps)}</p>${r.client_message?`<div class=note>${esc(r.client_message)}</div>`:''}</article>`).join('');
  return text(res,200,`<!doctype html><html lang=ru><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(p.client)} — отчёты DigitalRed</title><style>body{margin:0;background:#f4f6f8;color:#17212b;font:16px Inter,Arial,sans-serif}.wrap{max-width:850px;margin:auto;padding:32px 18px}header,article{background:#fff;border:1px solid #e5e9ee;border-radius:18px;padding:24px;margin-bottom:16px}h1{margin:4px 0}.brand{color:#d92727;font-weight:800;letter-spacing:.05em}.note{background:#fff0f0;border-radius:12px;padding:14px;white-space:pre-wrap}p{white-space:pre-wrap;line-height:1.55}small{color:#6b7580}</style><div class=wrap><header><div class=brand>DIGITALRED</div><h1>${esc(p.client)}</h1><p>${esc(p.service)}</p></header>${cards||'<article>Первый отчёт ещё готовится.</article>'}</div></html>`,'text/html; charset=utf-8');
}

const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml'};
http.createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost'), path=url.pathname;
    if(path==='/health') return json(res,200,{ok:true,service:'agency-ops'});
    if(path.startsWith('/api/')) return await api(req,res,path);
    if(path.startsWith('/report/')) return publicReport(res,path.slice(8));
    let file=path==='/'?'index.html':path.slice(1); if(!/^[\w.-]+$/.test(file)) file='index.html'; const full=join(PUBLIC_DIR,file);
    if(existsSync(full)) return text(res,200,readFileSync(full),mime[extname(full)]||'application/octet-stream');
    return text(res,200,readFileSync(join(PUBLIC_DIR,'index.html')),'text/html; charset=utf-8');
  } catch(e) { console.error(e); return json(res,500,{error:e.message||'Внутренняя ошибка'}); }
}).listen(PORT,'127.0.0.1',()=>console.log(`Agency Ops listening on ${PORT}`));
