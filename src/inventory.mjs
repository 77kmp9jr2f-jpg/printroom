import { createHash } from 'node:crypto';
import { CommandError } from './commands.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function valueText(value, name, max = 64, empty = false) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new CommandError(`Invalid ${name}`);
  return value.trim();
}
function number(value, name, max, zero = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || (zero ? value < 0 : value <= 0) || value > max) throw new CommandError(`Invalid reviewed ${name}`);
  return value;
}
export function normalizeSpoolmark(input) {
  if (input?.schemaVersion !== 1 || input.source !== 'spoolmark' || input.reviewed !== true) throw new CommandError('A reviewed Spoolmark v1 handoff is required');
  if (typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(input.id)) throw new CommandError('Invalid handoff id');
  const spoolReference = valueText(input.spoolReference, 'physical spool reference', 128);
  const label = {};
  for (const name of ['maker', 'material', 'color', 'nozzle', 'bed', 'diameter', 'weight', 'drying', 'notes']) {
    label[name] = valueText(input.label?.[name] ?? '', name, name === 'notes' ? 512 : name === 'drying' ? 160 : 64, !['maker', 'material', 'color'].includes(name));
  }
  const m = input.measurements ?? {};
  const measurements = { diameterMm: number(m.diameterMm, 'diameter in mm', 10), densityGcm3: number(m.densityGcm3, 'density in g/cm3', 30),
    densitySource: valueText(m.densitySource, 'density source', 200), initialWeightG: number(m.initialWeightG, 'initial mass in g', 100000),
    remainingWeightG: number(m.remainingWeightG, 'remaining mass in g', 100000, true) };
  if (measurements.remainingWeightG > measurements.initialWeightG) throw new CommandError('Remaining mass cannot exceed reviewed initial mass');
  const name = valueText(`${label.material} ${label.color}`, 'filament name', 64);
  const colorHex = input.colorHex == null || input.colorHex === '' ? null : valueText(input.colorHex, 'hex color', 9).replace(/^#/, '').toUpperCase();
  if (colorHex && !/^[0-9A-F]{6}([0-9A-F]{2})?$/.test(colorHex)) throw new CommandError('Color must be an explicitly reviewed hex swatch');
  const comment = ['Reviewed Spoolmark label', ...['nozzle', 'bed', 'diameter', 'weight', 'drying', 'notes'].filter(k => label[k]).map(k => `${k}: ${label[k]}`),
    `Density source: ${measurements.densitySource}`].join('\n');
  if (comment.length > 800) throw new CommandError('Label notes exceed the inventory comment limit; shorten the reviewed notes');
  return { schemaVersion: 1, source: 'spoolmark', id: input.id, spoolReference, reviewed: true, label, measurements, colorHex,
    vendor: { name: label.maker }, filament: { name, material: label.material, density: measurements.densityGcm3,
      diameter: measurements.diameterMm, weight: measurements.initialWeightG, color_hex: colorHex, comment },
    spool: { initial_weight: measurements.initialWeightG, remaining_weight: measurements.remainingWeightG },
    warnings: ['Physical spool identity and remaining mass are operator-reviewed values.', 'Temperature ranges are notes, not printer settings.', 'CFS percentages are not used to deduct inventory mass.'] };
}
export class InventoryService {
  constructor(options) { Object.assign(this, options); this.kind = this.kind ?? 'import'; this.pending = new Map(); this.tail = Promise.resolve(); this.store.recoverImports(); }
  preview(input) {
    const preview = normalizeSpoolmark(input); const fingerprint = digest(preview);
    const current = this.get(preview.id);
    if (current) {
      if (current.fingerprint !== fingerprint) throw new CommandError('Handoff id is already bound to a different reviewed import', 409);
      return current;
    }
    if (this.store.importForReference(preview.spoolReference, this.kind)) throw new CommandError('This physical spool reference already has an import; reuse its existing handoff id', 409);
    return this.store.saveRecord(this.kind, { id: preview.id, fingerprint, preview, status: 'preview', steps: {}, spoolId: null }, 0);
  }
  get(id) { return this.store.getRecord(this.kind, id); }
  list() { return this.store.listRecords(this.kind); }
  async commit({ id, confirmed }) {
    if (confirmed !== true) throw new CommandError('Confirm the stored preview before creating inventory');
    if (!this.get(id)) throw new CommandError('Create a reviewed import preview first', 404);
    if (!this.spoolman) throw new CommandError('Spoolman is not configured', 503);
    if (this.pending.has(id)) return this.pending.get(id);
    if (this.pending.size >= 16) throw new CommandError('Inventory import queue is full', 503);
    const work = this.tail.then(() => this.run(id));
    this.pending.set(id, work); this.tail = work.catch(() => {});
    try { return await work; } finally { this.pending.delete(id); }
  }
  async run(id) {
    let record = this.get(id);
    if (record.status === 'complete') return record;
    const save = change => { record = this.store.saveRecord(this.kind, { ...record, ...change }, record.version); return record; };
    const p = record.preview;
    for (const kind of ['vendor', 'filament', 'spool']) {
      if (record.steps[kind]?.status === 'complete') continue;
      const marker = `[print-companion:${digest([id, kind])}]`;
      if (record.steps[kind]) {
        const matches = await this.spoolman.findCreated(kind, marker);
        if (matches.length !== 1) return save({ status: 'outcome_unknown', detail: matches.length ? 'Multiple matching inventory records require manual reconciliation.' : 'No unique inventory record observed after an uncertain create. The write was not replayed.' });
        if (!Number.isSafeInteger(matches[0].id) || matches[0].id <= 0) throw new CommandError('Spoolman returned an invalid record', 502);
        save({ steps: { ...record.steps, [kind]: { status: 'complete', id: matches[0].id } } });
        continue;
      }
      if (kind === 'vendor') {
        const matches = await this.spoolman.findVendor(p.vendor.name);
        if (matches.length > 1) throw new CommandError('Multiple matching vendor records require selection in Spoolman before importing', 409);
        if (matches.length === 1) {
          if (!Number.isSafeInteger(matches[0].id) || matches[0].id <= 0) throw new CommandError('Spoolman returned an invalid vendor', 502);
          save({ steps: { ...record.steps, vendor: { status: 'complete', id: matches[0].id, reused: true } } });
          continue;
        }
      }
      const body = kind === 'vendor' ? { ...p.vendor, comment: marker } : kind === 'filament' ?
        { ...p.filament, vendor_id: record.steps.vendor.id, comment: `${marker}\n${p.filament.comment}` } :
        { ...p.spool, filament_id: record.steps.filament.id, comment: `${marker}\nPhysical spool reference: ${p.spoolReference}` };
      save({ status: 'creating', detail: null, steps: { ...record.steps, [kind]: { status: 'submitted', submittedAt: Date.now() } } });
      try {
        const created = await this.spoolman.create(kind, body);
        if (!Number.isSafeInteger(created?.id) || created.id <= 0) throw new Error('Invalid inventory acknowledgment');
        save({ steps: { ...record.steps, [kind]: { status: 'complete', id: created.id } } });
      } catch {
        return save({ status: 'outcome_unknown', detail: `The ${kind} create has no conclusive acknowledgment. Reconciliation will read for its marker; it will not replay this write.` });
      }
    }
    return save({ status: 'complete', spoolId: record.steps.spool.id, detail: 'Spoolman returned or reconciled the inventory records. Physical slot assignment is separate.' });
  }
  async close() { await this.tail; }
}
