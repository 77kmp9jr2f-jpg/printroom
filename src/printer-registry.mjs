import { randomUUID } from 'node:crypto';
import { normalizePrinters, runtimePrinters, MAX_PRINTERS } from './config.mjs';
import { CommandError } from './commands.mjs';

const endpoint = p => `${p.host}:${p.moonrakerPort}`;
export class PrinterRegistry {
  constructor({ store, initialPrinters = [], beforeChange = () => {}, onChange = () => {} }) {
    this.store = store; this.beforeChange = beforeChange; this.onChange = onChange;
    store.db.exec('CREATE TABLE IF NOT EXISTS printer_configuration (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, body TEXT NOT NULL)');
    const saved = store.db.prepare('SELECT version,body FROM printer_configuration WHERE id=1').get();
    if (saved) {
      const data = JSON.parse(saved.body);
      this.printers = normalizePrinters(data.printers); this.retiredIds = data.retiredIds ?? []; this.version = saved.version;
    } else {
      this.printers = normalizePrinters(initialPrinters); this.retiredIds = []; this.version = 1;
      store.db.prepare('INSERT INTO printer_configuration VALUES(1,?,?)').run(this.version, JSON.stringify({ printers: this.printers, retiredIds: [] }));
    }
  }
  snapshot() {
    return { version: this.version, maxPrinters: MAX_PRINTERS, printers: this.printers.map(({ apiKey, ...p }) => ({ ...p, hasApiKey: !!apiKey })) };
  }
  runtime() { return runtimePrinters(this.printers); }
  profile(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new CommandError('Expected printer profile');
    const previous = this.printers.find(p => p.id === input.id);
    const sameEndpoint = previous && input.host === previous.host && (input.moonrakerPort ?? 7125) === previous.moonrakerPort;
    const apiKey = input.clearApiKey === true ? '' : input.apiKey || (sameEndpoint ? previous.apiKey : '');
    try { return normalizePrinters([{ ...input, apiKey }])[0]; }
    catch (e) { throw new CommandError(e.message); }
  }
  save({ printer, baseVersion }) {
    this.checkVersion(baseVersion);
    const profile = this.profile(printer), previous = this.printers.find(p => p.id === profile.id);
    if (!previous && this.retiredIds.includes(profile.id)) throw new CommandError('This printer ID was retired. Use a new ID to preserve history.', 409);
    const next = previous ? this.printers.map(p => p.id === profile.id ? profile : p) : [...this.printers, profile];
    return this.commit(next, this.retiredIds);
  }
  remove({ id, baseVersion }) {
    this.checkVersion(baseVersion);
    if (!this.printers.some(p => p.id === id)) throw new CommandError('Unknown printer', 404);
    return this.commit(this.printers.filter(p => p.id !== id), [...this.retiredIds, id]);
  }
  checkVersion(version) {
    if (version !== this.version) throw new CommandError('Configuration changed in another tab. Refresh settings before saving.', 409);
  }
  commit(profiles, retiredIds) {
    let next;
    try { next = normalizePrinters(profiles); } catch (e) { throw new CommandError(e.message); }
    for (const old of this.printers) {
      const replacement = next.find(p => p.id === old.id);
      if (!replacement || !replacement.enabled || endpoint(replacement) !== endpoint(old) || replacement.adapter !== old.adapter) {
        if (this.store.unresolvedTargets(old.id).length) throw new CommandError(`Resolve pending or uncertain actions for ${old.name} before changing its connection.`, 409);
      }
    }
    this.beforeChange(next);
    const invalidated = new Set(this.printers.filter(old => {
      const replacement = next.find(p => p.id === old.id);
      return !replacement || !replacement.enabled || endpoint(replacement) !== endpoint(old) || replacement.adapter !== old.adapter;
    }).map(p => p.id));
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.store.db.prepare('UPDATE printer_configuration SET version=?,body=? WHERE id=1 AND version=?')
        .run(this.version + 1, JSON.stringify({ printers: next, retiredIds }), this.version);
      if (result.changes !== 1) throw new CommandError('Configuration revision conflict. Reload settings.', 409);
      const locations = this.store.getRecord('assignments', 'current');
      if (locations?.assignments.some(a => invalidated.has(a.printerId))) {
        this.store.saveRecord('assignments', { id: 'current', assignments: locations.assignments.filter(a => !invalidated.has(a.printerId)),
          event: { id: 'settings-' + randomUUID(), reason: 'Printer disabled, removed or connection changed; physical associations require reconfirmation.', invalidatedPrinterIds: [...invalidated] } }, locations.version, { transaction: false });
      }
      this.store.db.exec('COMMIT');
    } catch (error) { this.store.db.exec('ROLLBACK'); throw error; }
    this.printers = next; this.retiredIds = retiredIds; this.version++;
    this.onChange(this.runtime());
    return this.snapshot();
  }
}
