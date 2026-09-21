import { createHash, randomUUID } from 'node:crypto';
import { normalizeSpoolmanConnection } from './config.mjs';
import { SpoolmanClient } from './spoolman.mjs';
import { CommandError } from './commands.mjs';

const identity = connection => connection ? `${connection.host}:${connection.port}` : 'unconfigured';
export const importKind = connection => 'import:' + createHash('sha256').update(identity(connection)).digest('hex').slice(0,24);
export class SpoolmanSettings {
  constructor({ store, initialConnection = null, inventory, assignments, cfsync, onChange = () => {}, makeClient = c => new SpoolmanClient(c) }) {
    Object.assign(this, { store, inventory, assignments, cfsync, onChange, makeClient });
    this.seed = normalizeSpoolmanConnection(initialConnection);
    store.db.exec('CREATE TABLE IF NOT EXISTS spoolman_configuration (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, body TEXT NOT NULL)');
    const row = store.db.prepare('SELECT version,body FROM spoolman_configuration WHERE id=1').get();
    if (row) { this.connection = normalizeSpoolmanConnection(JSON.parse(row.body)); this.version = row.version; }
    else { this.connection = this.seed; this.version = 1; store.db.prepare('INSERT INTO spoolman_configuration VALUES(1,?,?)').run(1, JSON.stringify(this.connection)); }
    // Move legacy imports and their entire history into the original inventory's namespace once.
    store.db.prepare("UPDATE records SET kind=? WHERE kind='import'").run(importKind(this.seed));
    this.apply();
  }
  snapshot() { return { version: this.version, connection: this.connection, cfsyncCompatible: !this.cfsync || identity(this.connection) === identity(this.seed) }; }
  apply() {
    this.client = this.connection ? this.makeClient(this.connection) : null;
    if (this.client) this.client.browserUrl = this.connection.browserUrl ?? (this.connection.host === 'spoolman' ? null : this.client.base.replace(/\/api\/v1$/, '/'));
    if (this.inventory) { this.inventory.spoolman = this.client; this.inventory.kind = importKind(this.connection); }
    if (this.assignments) this.assignments.spoolman = this.client;
    if (this.cfsync) { this.cfsync.inventoryCompatible = this.snapshot().cfsyncCompatible; this.cfsync.connectionRevision = this.version; }
    this.onChange(this.client);
  }
  save({ connection, baseVersion, confirmChange = false }) {
    if (baseVersion !== this.version) throw new CommandError('Spoolman configuration changed. Refresh settings before saving.', 409);
    let next; try { next = normalizeSpoolmanConnection(connection); } catch (e) { throw new CommandError(e.message); }
    if (this.inventory?.pending.size || this.cfsync?.activeWrites) throw new CommandError('Wait for inventory imports to finish before changing Spoolman.', 409);
    const changed = identity(next) !== identity(this.connection);
    if (changed && this.connection && !confirmChange) throw new CommandError('Confirm the connection change. Existing physical spool associations must be checked again.', 409);
    // Construct first so a bad client configuration cannot leave persisted and runtime state apart.
    if (next) this.makeClient(next);
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.store.db.prepare('UPDATE spoolman_configuration SET version=?,body=? WHERE id=1 AND version=?').run(this.version + 1, JSON.stringify(next), this.version);
      if (result.changes !== 1) throw new CommandError('Spoolman revision conflict. Reload settings.', 409);
      const current = this.store.getRecord('assignments', 'current');
      if (changed) this.store.saveRecord('assignments', { id: 'current', assignments: [], event: { id: 'spoolman-' + randomUUID(), reason: 'Spoolman connection changed; physical spool associations require reconfirmation.', previousConnection: this.connection, nextConnection: next } }, current?.version ?? 0, { transaction: false });
      this.store.db.exec('COMMIT');
    } catch (e) { this.store.db.exec('ROLLBACK'); throw e; }
    this.connection = next; this.version++; this.apply(); return this.snapshot();
  }
  async probe(connection) {
    let normalized; try { normalized = normalizeSpoolmanConnection(connection); } catch (e) { throw new CommandError(e.message); }
    if (!normalized) throw new CommandError('Enter a Spoolman connection to test');
    const rows = await this.makeClient(normalized).listPage('spool', 0);
    return { status: 'connected', detail: `Spoolman inventory responded. ${rows.length}${rows.length === 100 ? '+' : ''} spools in the first page. No records were changed.` };
  }
}
