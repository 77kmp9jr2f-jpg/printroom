import { DatabaseSync } from 'node:sqlite';

export class Store {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, body TEXT NOT NULL, PRIMARY KEY(kind,id,version));`);
  }
  createAction(action) {
    this.db.prepare('INSERT INTO actions(id,created_at,body) VALUES(?,?,?)').run(action.id, action.createdAt, JSON.stringify(action));
    return action;
  }
  getAction(id) {
    const row = this.db.prepare('SELECT body FROM actions WHERE id=?').get(id);
    return row ? JSON.parse(row.body) : null;
  }
  updateTarget(id, printerId, changes) {
    const action = this.getAction(id);
    if (!action) throw new Error('Unknown action');
    const target = action.targets.find(t => t.printerId === printerId);
    if (!target) throw new Error('Unknown action target');
    Object.assign(target, changes);
    this.db.prepare('UPDATE actions SET body=? WHERE id=?').run(JSON.stringify(action), id);
    return action;
  }
  recentActions(limit = 50) {
    return this.db.prepare('SELECT body FROM actions ORDER BY created_at DESC LIMIT ?').all(Math.min(100, limit)).map(r => JSON.parse(r.body));
  }
  unresolvedTargets(printerId) {
    const rows = this.db.prepare(`SELECT j.value FROM actions a, json_each(a.body, '$.targets') j
      WHERE json_extract(j.value, '$.printerId')=? AND json_extract(j.value, '$.status') IN ('requested','acknowledged','outcome_unknown')`).all(printerId);
    return rows.map(r => JSON.parse(r.value));
  }
  recoverInterrupted() {
    for (const row of this.db.prepare('SELECT id,body FROM actions').iterate()) {
      const action = JSON.parse(row.body);
      let changed = false;
      for (const target of action.targets) {
        if (['requested', 'acknowledged'].includes(target.status)) {
          Object.assign(target, { status: 'outcome_unknown', finishedAt: Date.now(), detail: 'Companion restarted before the outcome was observed. Request was not replayed.' });
          changed = true;
        }
      }
      if (changed) this.db.prepare('UPDATE actions SET body=? WHERE id=?').run(JSON.stringify(action), row.id);
    }
  }
  getRecord(kind, id) {
    const row = this.db.prepare('SELECT body FROM records WHERE kind=? AND id=? ORDER BY version DESC LIMIT 1').get(kind, id);
    return row ? JSON.parse(row.body) : null;
  }
  listRecords(kind, limit = 100) {
    return this.db.prepare(`SELECT r.body FROM records r WHERE kind=? AND version=(
      SELECT MAX(s.version) FROM records s WHERE s.kind=r.kind AND s.id=r.id)
      ORDER BY updated_at DESC LIMIT ?`).all(kind, Math.max(1, Math.min(100, limit))).map(r => JSON.parse(r.body));
  }
  recordHistory(kind, id, limit = 100) {
    return this.db.prepare('SELECT body FROM records WHERE kind=? AND id=? ORDER BY version DESC LIMIT ?')
      .all(kind, id, Math.max(1, Math.min(100, limit))).map(r => JSON.parse(r.body));
  }
  assignmentEvent(id) {
    const row = this.db.prepare("SELECT body FROM records WHERE kind='assignments' AND json_extract(body,'$.event.id')=? LIMIT 1").get(id);
    return row ? JSON.parse(row.body) : null;
  }
  importForReference(reference, kind = 'import') {
    const row = this.db.prepare("SELECT body FROM records WHERE kind=? AND json_extract(body,'$.preview.spoolReference')=? ORDER BY version DESC LIMIT 1").get(kind, reference);
    return row ? JSON.parse(row.body) : null;
  }
  recoverImports() {
    const rows = this.db.prepare(`SELECT r.kind,r.body FROM records r WHERE (kind='import' OR kind LIKE 'import:%') AND json_extract(body,'$.status')='creating'
      AND version=(SELECT MAX(s.version) FROM records s WHERE s.kind=r.kind AND s.id=r.id)`).all();
    for (const row of rows) {
      const record = JSON.parse(row.body);
      this.saveRecord(row.kind, { ...record, status: 'outcome_unknown', detail: 'Companion restarted during inventory creation. No operation is running; reconcile the stored marker before any further steps.' }, record.version);
    }
  }
  saveRecord(kind, record, baseVersion, { transaction = true } = {}) {
    if (transaction) this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.getRecord(kind, record.id);
      if (!Number.isInteger(baseVersion) || baseVersion !== (current?.version ?? 0)) throw new Error('Record version conflict');
      const result = { ...record, version: baseVersion + 1, updatedAt: Date.now() };
      this.db.prepare('INSERT INTO records(kind,id,version,updated_at,body) VALUES(?,?,?,?,?)')
        .run(kind, record.id, result.version, result.updatedAt, JSON.stringify(result));
      if (transaction) this.db.exec('COMMIT');
      return result;
    } catch (error) { if (transaction) this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}
