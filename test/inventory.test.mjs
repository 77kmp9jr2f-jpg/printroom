import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { InventoryService, normalizeSpoolmark } from '../src/inventory.mjs';

export const handoff = () => ({ schemaVersion: 1, source: 'spoolmark', id: 'label-import-0001', spoolReference: 'physical-spool-0001', reviewed: true,
  label: { maker: 'Example Filament', material: 'PLA', color: 'Black', nozzle: '190–220 °C', bed: '45–60 °C', diameter: '1.75 mm', weight: '1 kg', drying: 'Manufacturer instructions', notes: '' },
  measurements: { diameterMm: 1.75, densityGcm3: 1.24, densitySource: 'Manufacturer specification reviewed by operator', initialWeightG: 1000, remainingWeightG: 670 }, colorHex: '000000' });
function setup(path = ':memory:') {
  const store = new Store(path); const rows = { vendor: [], filament: [], spool: [] }; const posts = [];
  const spoolman = {
    findVendor: async name => rows.vendor.filter(v => v.name.toLowerCase() === name.toLowerCase()),
    findCreated: async (kind, marker) => rows[kind].filter(r => r.comment?.includes(marker)),
    create: async (kind, body) => { const row = { id: rows[kind].length + 1, ...body }; rows[kind].push(row); posts.push(kind); return row; },
  };
  return { store, rows, posts, spoolman, svc: new InventoryService({ store, spoolman }) };
}

test('reviewed Spoolmark preview uses explicit units and preserves temperature ranges as notes', () => {
  const p = normalizeSpoolmark(handoff());
  assert.equal(p.filament.density, 1.24); assert.equal(p.filament.weight, 1000);
  assert.equal(p.spool.remaining_weight, 670); assert.match(p.filament.comment, /190–220/);
  assert.equal(p.filament.settings_extruder_temp, undefined);
  for (const edit of [p => p.reviewed = false, p => delete p.measurements.densityGcm3,
    p => delete p.measurements.remainingWeightG, p => p.measurements.diameterMm = '1.75',
    p => p.colorHex = 'black', p => p.measurements.remainingWeightG = 1100]) {
    const p = handoff(); edit(p); assert.throws(() => normalizeSpoolmark(p));
  }
});

test('preview has no external writes and commit requires a separate confirmation', async () => {
  const { store, svc, posts } = setup();
  try {
    const p = svc.preview(handoff()); assert.equal(p.status, 'preview'); assert.deepEqual(posts, []);
    await assert.rejects(svc.commit({ id: p.id, confirmed: false }), /confirm/i);
    assert.deepEqual(posts, []);
  } finally { store.close(); }
});

test('confirmed imports reuse one exact vendor and return the same spool on repeat or service restart', async () => {
  const { store, svc, posts, rows, spoolman } = setup();
  try {
    rows.vendor.push({ id: 12, name: 'Example Filament' }); svc.preview(handoff());
    const result = await svc.commit({ id: 'label-import-0001', confirmed: true });
    assert.equal(result.status, 'complete'); assert.equal(result.spoolId, 1); assert.deepEqual(posts, ['filament', 'spool']);
    const again = await new InventoryService({ store, spoolman }).commit({ id: result.id, confirmed: true });
    assert.equal(again.spoolId, 1); assert.equal(rows.spool.length, 1);
  } finally { store.close(); }
});

test('lost create response is reconciled after a file-backed restart without replaying the write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'print-import-')); const path = join(dir, 'db.sqlite');
  const fixture = setup(path); const { svc, posts, spoolman } = fixture; let store = fixture.store;
  const create = spoolman.create;
  spoolman.create = async (kind, body) => { const row = await create(kind, body); if (kind === 'spool') throw new Error('response lost'); return row; };
  try {
    svc.preview(handoff()); const uncertain = await svc.commit({ id: 'label-import-0001', confirmed: true });
    assert.equal(uncertain.status, 'outcome_unknown');
    store.close(); store = new Store(path);
    const recovered = await new InventoryService({ store, spoolman }).commit({ id: uncertain.id, confirmed: true });
    assert.equal(recovered.status, 'complete'); assert.equal(recovered.spoolId, 1);
    assert.equal(posts.filter(k => k === 'spool').length, 1);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('an uncertain create with no matching record stays uncertain and is never resent', async () => {
  const { store, svc, spoolman } = setup(); let calls = 0;
  spoolman.create = async () => { calls++; throw new Error('network failure'); };
  try {
    svc.preview(handoff()); await svc.commit({ id: 'label-import-0001', confirmed: true });
    const result = await svc.commit({ id: 'label-import-0001', confirmed: true });
    assert.equal(result.status, 'outcome_unknown'); assert.equal(calls, 1);
  } finally { store.close(); }
});

test('handoff identity and physical spool reference prevent accidental duplicates', async () => {
  const { store, svc } = setup();
  try {
    svc.preview(handoff());
    const changed = handoff(); changed.measurements.remainingWeightG = 650;
    assert.throws(() => svc.preview(changed), /bound/i);
    const duplicate = handoff(); duplicate.id = 'another-import-id';
    assert.throws(() => svc.preview(duplicate), /physical spool/i);
  } finally { store.close(); }
});

test('concurrent commits share one operation and ambiguous vendor matches produce no writes', async () => {
  const { store, svc, posts, rows } = setup();
  try {
    svc.preview(handoff());
    const [a, b] = await Promise.all([svc.commit({ id: 'label-import-0001', confirmed: true }), svc.commit({ id: 'label-import-0001', confirmed: true })]);
    assert.equal(a.spoolId, b.spoolId); assert.equal(posts.length, 3);
    const p = handoff(); p.id = 'label-import-0002'; p.spoolReference = 'second-physical-spool';
    rows.vendor.push({ id: 2, name: 'Example Filament' }); svc.preview(p);
    await assert.rejects(svc.commit({ id: p.id, confirmed: true }), /multiple.*vendor/i);
    assert.equal(posts.length, 3);
  } finally { store.close(); }
});

test('an interrupted submitted import is visibly uncertain after restart without replay', () => {
  const { store, svc, posts, spoolman } = setup();
  try {
    const p = svc.preview(handoff());
    store.saveRecord('import', { ...p, status: 'creating', steps: { vendor: { status: 'submitted', submittedAt: Date.now() } } }, p.version);
    const restarted = new InventoryService({ store, spoolman });
    assert.equal(restarted.get(p.id).status, 'outcome_unknown');
    assert.deepEqual(posts, []);
  } finally { store.close(); }
});
