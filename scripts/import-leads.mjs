import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [inputArg, databaseArg] = process.argv.slice(2);
if (!inputArg || !databaseArg) {
  console.error('Usage: node scripts/import-leads.mjs <records.json> <agency-ops.sqlite>');
  process.exit(2);
}

const records = JSON.parse(readFileSync(resolve(inputArg), 'utf8'));
if (!Array.isArray(records)) throw new Error('Import source must be a JSON array');

const db = new DatabaseSync(resolve(databaseArg));
db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
const owner = db.prepare("SELECT id FROM users WHERE role='owner' AND active=1 ORDER BY id LIMIT 1").get();
if (!owner) throw new Error('Active owner user not found');

const insertLead = db.prepare(`
  INSERT OR IGNORE INTO leads(
    company,contact_name,phone,email,website,source,service,lead_date,external_key,
    stage,qualification,owner_id,budget,need,next_action,next_action_due,loss_reason,notes,created_at,updated_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,COALESCE(?,CURRENT_TIMESTAMP),COALESCE(?,CURRENT_TIMESTAMP))
`);
const insertActivity = db.prepare(`
  INSERT INTO lead_activities(lead_id,user_id,type,summary,occurred_at)
  VALUES(?,?,?,?,COALESCE(?,CURRENT_TIMESTAMP))
`);

let imported = 0;
let skipped = 0;
db.exec('BEGIN IMMEDIATE');
try {
  for (const record of records) {
    if (!record.external_key || !record.company) throw new Error('Each record requires external_key and company');
    const createdAt = record.lead_date ? `${record.lead_date} 12:00:00` : null;
    const result = insertLead.run(
      record.company, record.contact_name || '', record.phone || '', record.email || '', record.website || '',
      record.source || 'Импорт', record.service || '', record.lead_date || null, record.external_key,
      record.stage || 'new', record.qualification || 'unqualified', owner.id, record.budget || '',
      record.need || '', record.next_action || '', record.next_action_due || null, record.loss_reason || '',
      record.notes || '', createdAt, createdAt,
    );
    if (!result.changes) { skipped += 1; continue; }
    imported += 1;
    const leadId = Number(result.lastInsertRowid);
    insertActivity.run(leadId, owner.id, 'import', record.import_summary || 'Импортировано из таблицы лидов', createdAt);
  }
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}

console.log(JSON.stringify({ total: records.length, imported, skipped }));
