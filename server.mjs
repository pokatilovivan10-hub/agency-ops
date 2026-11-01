import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

const PORT = Number(process.env.PORT || 8790);
const DATA_DIR = process.env.DATA_DIR || join(process.cwd(), 'data');
const PUBLIC_DIR = join(process.cwd(), 'public');
const COOKIE_NAME = 'agency_ops_session';
const SESSION_TTL = 30 * 86400;
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
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_handoff_project ON handoff_items(project_id);
CREATE INDEX IF NOT EXISTS idx_launch_project ON launch_items(project_id);
CREATE INDEX IF NOT EXISTS idx_activity_project ON activity(project_id);
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
async function body(req) { let size=0, chunks=[]; for await (const c of req) { size+=c.length; if(size>1_000_000) throw new Error('Слишком большой запрос'); chunks.push(c); } return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'); }
function cookies(req) { return Object.fromEntries(String(req.headers.cookie||'').split(';').map(v=>v.trim().split('=').map(decodeURIComponent)).filter(v=>v.length===2)); }
function auth(req) {
  const token=cookies(req)[COOKIE_NAME]; if(!token) return null;
  return db.prepare(`SELECT u.id,u.name,u.role,u.login,u.must_change FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1`).get(tokenHash(token),Math.floor(Date.now()/1000)) || null;
}
function activity(projectId,userId,action,details='') { db.prepare('INSERT INTO activity(project_id,user_id,action,details) VALUES(?,?,?,?)').run(projectId,userId,action,details); }
function projectAccess(id) { return db.prepare(`SELECT p.*, o.name owner_name, m.name manager_name FROM projects p LEFT JOIN users o ON o.id=p.owner_id LEFT JOIN users m ON m.id=p.manager_id WHERE p.id=? AND p.archived=0`).get(id); }
function route(pattern,path) { const keys=[]; const re=new RegExp('^'+pattern.replace(/:([A-Za-z]+)/g,(_,k)=>(keys.push(k),'([^/]+)'))+'$'); const m=path.match(re); return m?Object.fromEntries(keys.map((k,i)=>[k,decodeURIComponent(m[i+1])])):null; }

function createProject(input,user) {
  if(!String(input.client||'').trim() || !String(input.service||'').trim()) throw new Error('Укажите клиента и услугу');
  const publicToken=randomBytes(18).toString('base64url');
  const r=db.prepare(`INSERT INTO projects(client,service,sale_date,owner_id,manager_id,launch_deadline,next_action,next_action_due,next_client_contact,next_report,risk,materials_url,call_summary,public_token) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    String(input.client).trim(),String(input.service).trim(),input.sale_date||null,user.id,input.manager_id||null,input.launch_deadline||null,input.next_action||'',input.next_action_due||null,input.next_client_contact||null,input.next_report||null,input.risk||'none',input.materials_url||'',input.call_summary||'',publicToken);
  const pid=Number(r.lastInsertRowid);
  const h=db.prepare('INSERT INTO handoff_items(project_id,section,label,hint) VALUES(?,?,?,?)');
  const l=db.prepare('INSERT INTO launch_items(project_id,stage,label,criterion,assignee) VALUES(?,?,?,?,?)');
  db.exec('BEGIN'); try { for(const x of handoffTemplate) h.run(pid,...x); for(const x of launchTemplate) l.run(pid,...x); db.exec('COMMIT'); } catch(e){db.exec('ROLLBACK');throw e;}
  activity(pid,user.id,'Создан проект',`${input.client} — ${input.service}`); return pid;
}

function dashboard() {
  const counts=db.prepare(`SELECT COUNT(*) total, SUM(stage='launched' OR stage='management') active, SUM(risk IN ('high','stop')) risks, SUM(acceptance_status!='accepted') handoffs FROM projects WHERE archived=0`).get();
  const overdue=db.prepare(`SELECT COUNT(*) n FROM tasks WHERE status!='done' AND due_date IS NOT NULL AND due_date<date('now')`).get().n;
  const projects=db.prepare(`SELECT p.id,p.client,p.service,p.stage,p.acceptance_status,p.launch_deadline,p.next_action,p.next_action_due,p.next_report,p.risk,m.name manager_name,
    (SELECT COUNT(*) FROM handoff_items h WHERE h.project_id=p.id AND h.required=1 AND h.status!='accepted') handoff_open,
    (SELECT COUNT(*) FROM launch_items l WHERE l.project_id=p.id AND l.required=1 AND l.status NOT IN ('done','na')) launch_open,
    (SELECT COUNT(*) FROM tasks t WHERE t.project_id=p.id AND t.status!='done' AND t.due_date<date('now')) overdue
    FROM projects p LEFT JOIN users m ON m.id=p.manager_id WHERE p.archived=0 ORDER BY CASE p.risk WHEN 'stop' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,p.updated_at DESC`).all();
  return {counts:{...counts,overdue},projects};
}

async function api(req,res,path) {
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
  if(req.method==='GET' && path==='/api/dashboard') return json(res,200,dashboard());
  if(req.method==='GET' && path==='/api/projects') return json(res,200,dashboard().projects);
  if(req.method==='POST' && path==='/api/projects') { const input=await body(req); const id=createProject(input,user); return json(res,201,{id}); }
  let m=route('/api/projects/:id',path);
  if(m && req.method==='GET') { const p=projectAccess(Number(m.id)); if(!p)return json(res,404,{error:'Проект не найден'}); return json(res,200,p); }
  if(m && req.method==='PATCH') {
    const id=Number(m.id), input=await body(req), p=projectAccess(id); if(!p)return json(res,404,{error:'Проект не найден'});
    const allowed=['client','service','sale_date','handoff_date','manager_id','stage','acceptance_status','launch_deadline','next_action','next_action_due','next_client_contact','next_report','risk','materials_url','call_summary'];
    if(input.acceptance_status==='accepted') { const open=db.prepare("SELECT COUNT(*) n FROM handoff_items WHERE project_id=? AND required=1 AND status!='accepted'").get(id).n; if(open) return json(res,409,{error:`Передача не может быть принята: незакрытых пунктов — ${open}`}); }
    if(input.stage==='launched' || input.stage==='management') { const open=db.prepare("SELECT COUNT(*) n FROM launch_items WHERE project_id=? AND required=1 AND status NOT IN ('done','na')").get(id).n; if(open) return json(res,409,{error:`Запуск запрещён: незакрытых проверок — ${open}`}); }
    const entries=Object.entries(input).filter(([k])=>allowed.includes(k)); if(!entries.length)return json(res,400,{error:'Нет допустимых полей'});
    db.prepare(`UPDATE projects SET ${entries.map(([k])=>`${k}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...entries.map(([,v])=>v||null),id);
    activity(id,user.id,'Обновлён проект',entries.map(([k])=>k).join(', ')); return json(res,200,{ok:true});
  }
  m=route('/api/projects/:id/all',path);
  if(m && req.method==='GET') { const id=Number(m.id),p=projectAccess(id); if(!p)return json(res,404,{error:'Проект не найден'}); return json(res,200,{project:p,handoff:db.prepare('SELECT * FROM handoff_items WHERE project_id=? ORDER BY id').all(id),launch:db.prepare('SELECT * FROM launch_items WHERE project_id=? ORDER BY id').all(id),tasks:db.prepare(`SELECT t.*,u.name assignee_name FROM tasks t LEFT JOIN users u ON u.id=t.assignee_id WHERE project_id=? ORDER BY CASE status WHEN 'blocked' THEN 0 WHEN 'doing' THEN 1 ELSE 2 END,due_date`).all(id),reports:db.prepare('SELECT r.*,u.name author_name FROM reports r LEFT JOIN users u ON u.id=r.created_by WHERE project_id=? ORDER BY created_at DESC').all(id),escalations:db.prepare('SELECT e.*,u.name author_name FROM escalations e LEFT JOIN users u ON u.id=e.created_by WHERE project_id=? ORDER BY created_at DESC').all(id),activity:db.prepare('SELECT a.*,u.name user_name FROM activity a LEFT JOIN users u ON u.id=a.user_id WHERE project_id=? ORDER BY created_at DESC LIMIT 60').all(id)}); }
  m=route('/api/projects/:pid/handoff/:id',path);
  if(m && req.method==='PATCH') { const x=await body(req), pid=Number(m.pid), id=Number(m.id); if(x.status==='accepted' && (!String(x.value||'').trim() || !String(x.proof||'').trim())) return json(res,409,{error:'Для принятия заполните значение и доказательство/ссылку'}); db.prepare('UPDATE handoff_items SET value=?,status=?,comment=?,proof=?,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND project_id=?').run(x.value||'',x.status||'missing',x.comment||'',x.proof||'',user.id,id,pid); activity(pid,user.id,'Обновлена передача',`Пункт #${id}: ${x.status}`); return json(res,200,{ok:true}); }
  m=route('/api/projects/:pid/launch/:id',path);
  if(m && req.method==='PATCH') { const x=await body(req),pid=Number(m.pid),id=Number(m.id); if(x.status==='done' && !String(x.proof||'').trim()) return json(res,409,{error:'Готово требует доказательство: ссылку, ID, дату или цифру'}); db.prepare("UPDATE launch_items SET status=?,proof=?,due_date=?,checked_by=CASE WHEN ?='done' THEN ? ELSE checked_by END,checked_at=CASE WHEN ?='done' THEN CURRENT_TIMESTAMP ELSE checked_at END,updated_at=CURRENT_TIMESTAMP WHERE id=? AND project_id=?").run(x.status||'todo',x.proof||'',x.due_date||null,x.status,user.id,x.status,id,pid); activity(pid,user.id,'Обновлена проверка запуска',`Пункт #${id}: ${x.status}`); return json(res,200,{ok:true}); }
  m=route('/api/projects/:pid/tasks',path);
  if(m && req.method==='POST') { const x=await body(req),pid=Number(m.pid); if(!String(x.title||'').trim())return json(res,400,{error:'Укажите задачу'}); const r=db.prepare('INSERT INTO tasks(project_id,title,description,assignee_id,status,priority,due_date,created_by) VALUES(?,?,?,?,?,?,?,?)').run(pid,x.title.trim(),x.description||'',x.assignee_id||null,x.status||'backlog',x.priority||'normal',x.due_date||null,user.id); activity(pid,user.id,'Создана задача',x.title); return json(res,201,{id:Number(r.lastInsertRowid)}); }
  m=route('/api/tasks/:id',path);
  if(m && req.method==='PATCH') { const x=await body(req),id=Number(m.id),t=db.prepare('SELECT * FROM tasks WHERE id=?').get(id); if(!t)return json(res,404,{error:'Задача не найдена'}); const allowed=['title','description','assignee_id','status','priority','due_date','proof']; const e=Object.entries(x).filter(([k])=>allowed.includes(k)); db.prepare(`UPDATE tasks SET ${e.map(([k])=>`${k}=?`).join(',')},updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...e.map(([,v])=>v||null),id); activity(t.project_id,user.id,'Обновлена задача',`${t.title}: ${x.status||'изменена'}`); return json(res,200,{ok:true}); }
  m=route('/api/projects/:pid/reports',path);
  if(m && req.method==='POST') { const x=await body(req),pid=Number(m.pid); for(const k of ['period','planned','completed','metrics','next_steps']) if(!String(x[k]||'').trim())return json(res,400,{error:`Заполните обязательное поле: ${k}`}); const r=db.prepare('INSERT INTO reports(project_id,period,planned,completed,metrics,deviation,reason,next_steps,risk,client_message,report_url,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(pid,x.period,x.planned,x.completed,x.metrics,x.deviation||'',x.reason||'',x.next_steps,x.risk||'none',x.client_message||'',x.report_url||'',user.id); db.prepare('UPDATE projects SET next_report=?,risk=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(x.next_report||null,x.risk||'none',pid); activity(pid,user.id,'Добавлен недельный отчёт',x.period); return json(res,201,{id:Number(r.lastInsertRowid)}); }
  m=route('/api/projects/:pid/escalations',path);
  if(m && req.method==='POST') { const x=await body(req),pid=Number(m.pid); for(const k of ['type','facts','impact','option_a','option_b','recommendation']) if(!String(x[k]||'').trim())return json(res,400,{error:'Эскалация должна содержать факты, влияние, 2 варианта и рекомендацию'}); const r=db.prepare('INSERT INTO escalations(project_id,type,facts,impact,option_a,option_b,recommendation,created_by) VALUES(?,?,?,?,?,?,?,?)').run(pid,x.type,x.facts,x.impact,x.option_a,x.option_b,x.recommendation,user.id); db.prepare("UPDATE projects SET risk='high',updated_at=CURRENT_TIMESTAMP WHERE id=? AND risk!='stop'").run(pid); activity(pid,user.id,'Создана эскалация',x.type); return json(res,201,{id:Number(r.lastInsertRowid)}); }
  m=route('/api/escalations/:id',path);
  if(m && req.method==='PATCH') { const id=Number(m.id),e=db.prepare('SELECT * FROM escalations WHERE id=?').get(id); if(!e)return json(res,404,{error:'Эскалация не найдена'}); const x=await body(req); const status=x.status==='resolved'?'resolved':'open'; db.prepare("UPDATE escalations SET status=?,resolved_at=CASE WHEN ?='resolved' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id=?").run(status,status,id); activity(e.project_id,user.id,status==='resolved'?'Закрыта эскалация':'Открыта эскалация',e.type); return json(res,200,{ok:true}); }
  return json(res,404,{error:'Метод не найден'});
}

function publicReport(res,token) {
  const p=db.prepare('SELECT id,client,service,stage,risk,updated_at FROM projects WHERE public_token=? AND archived=0').get(token); if(!p)return text(res,404,'Отчёт не найден');
  const reports=db.prepare('SELECT period,completed,metrics,deviation,next_steps,risk,client_message,created_at FROM reports WHERE project_id=? ORDER BY created_at DESC LIMIT 12').all(p.id);
  const esc=s=>String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const cards=reports.map(r=>`<article><small>${esc(r.period)}</small><h2>Результаты</h2><p>${esc(r.completed)}</p><h3>Цифры</h3><p>${esc(r.metrics)}</p><h3>Следующие шаги</h3><p>${esc(r.next_steps)}</p>${r.client_message?`<div class=note>${esc(r.client_message)}</div>`:''}</article>`).join('');
  return text(res,200,`<!doctype html><html lang=ru><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(p.client)} — отчёты</title><style>body{margin:0;background:#f4f6f8;color:#17212b;font:16px Inter,Arial,sans-serif}.wrap{max-width:850px;margin:auto;padding:32px 18px}header,article{background:#fff;border:1px solid #e5e9ee;border-radius:18px;padding:24px;margin-bottom:16px}h1{margin:4px 0}.brand{color:#5965e8;font-weight:800}.note{background:#f0f2ff;border-radius:12px;padding:14px;white-space:pre-wrap}p{white-space:pre-wrap;line-height:1.55}small{color:#6b7580}</style><div class=wrap><header><div class=brand>AGENCY OPS</div><h1>${esc(p.client)}</h1><p>${esc(p.service)}</p></header>${cards||'<article>Первый отчёт ещё готовится.</article>'}</div></html>`,'text/html; charset=utf-8');
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
