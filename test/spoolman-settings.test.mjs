import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.mjs';
import { InventoryService } from '../src/inventory.mjs';
import { AssignmentService } from '../src/assignments.mjs';
import { SpoolmanSettings, importKind } from '../src/spoolman-settings.mjs';
import { normalizeSpoolmanConnection } from '../src/config.mjs';

const first = { host: '192.168.20.2', port: 7912 }, second = { host: 'spoolman', port: 8000 };
function setup(t, initialConnection = first) {
  const store = new Store(':memory:'); t.after(() => store.close());
  const inventory = new InventoryService({ store }), assignments = new AssignmentService({ store, telemetry: new Map() });
  const cfsync = {}, requests = [];
  const makeClient = c => ({ base: `http://${c.host}:${c.port}/api/v1`, listPage: async (kind, offset) => { requests.push({ c, kind, offset }); return []; } });
  const settings = new SpoolmanSettings({ store, initialConnection, inventory, assignments, cfsync, makeClient });
  return { store, inventory, assignments, cfsync, settings, requests, makeClient };
}
test('Spoolman settings validate endpoints and persist without reseeding disabled connections', t => {
  for (const host of ['spoolman','host.docker.internal','localhost','192.168.20.2']) assert.equal(normalizeSpoolmanConnection({ host }).host, host);
  for (const host of ['8.8.8.8','https://example.com','192.168.20.2@evil.test','169.254.169.254']) assert.throws(() => normalizeSpoolmanConnection({ host }));
  const x = setup(t); x.settings.save({ connection: null, baseVersion: 1, confirmChange: true });
  const restarted = new SpoolmanSettings({ ...x, initialConnection: first });
  assert.equal(restarted.connection, null); assert.equal(restarted.version, 2); assert.equal(x.assignments.spoolman, null);
  assert.throws(() => restarted.save({ connection: first, baseVersion: 1 }), /changed/);
});
test('switching inventory separates import history and invalidates associations while retaining the audit', t => {
  const x = setup(t);
  x.store.saveRecord(x.inventory.kind, { id: 'old-import', status: 'complete', spoolId: 17 }, 0);
  x.store.saveRecord('assignments', { id: 'current', assignments: [{ printerId: 'p', slot: 'T1A', spoolId: 17 }] }, 0);
  assert.throws(() => x.settings.save({ connection: second, baseVersion: 1 }), /Confirm/);
  x.settings.save({ connection: second, baseVersion: 1, confirmChange: true });
  assert.equal(x.inventory.list().length, 0); assert.equal(x.cfsync.inventoryCompatible, false);
  assert.deepEqual(x.assignments.current().assignments, []); assert.equal(x.assignments.history().length, 2);
  assert.equal(x.inventory.spoolman, x.settings.client); assert.equal(x.assignments.spoolman, x.settings.client);
  x.store.saveRecord(x.inventory.kind, { id: 'new-import', status: 'preview' }, 0);
  x.settings.save({ connection: first, baseVersion: 2, confirmChange: true });
  assert.equal(x.inventory.list()[0].id, 'old-import'); assert.equal(x.cfsync.inventoryCompatible, true);
  assert.deepEqual(x.assignments.current().assignments, []);
});
test('legacy imports migrate with full history; interrupted imports in every connection recover', t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.saveRecord('import', { id: 'old-import', status: 'preview' }, 0);
  store.saveRecord('import', { id: 'old-import', status: 'complete', spoolId: 3 }, 1);
  const settings = new SpoolmanSettings({ store, initialConnection: first });
  assert.equal(store.recordHistory(importKind(first), 'old-import').length, 2);
  store.saveRecord(importKind(second), { id: 'interrupted', status: 'creating' }, 0);
  new InventoryService({ store });
  assert.equal(store.getRecord(importKind(second), 'interrupted').status, 'outcome_unknown');
  assert.equal(settings.snapshot().connection.host, first.host);
});
test('in-flight imports block connection changes and checks perform only bounded inventory reads', async t => {
  const x = setup(t);
  x.inventory.pending.set('working', Promise.resolve());
  assert.throws(() => x.settings.save({ connection: second, baseVersion: 1, confirmChange: true }), /finish/);
  assert.deepEqual(x.settings.connection, first);
  assert.equal((await x.settings.probe(second)).status, 'connected');
  assert.deepEqual(x.requests, [{ c: second, kind: 'spool', offset: 0 }]);
});
test('a connection change during a spool lookup cannot save an association from the old database', async t => {
  const x = setup(t); let finish;
  x.assignments.telemetry.set('p', { snapshot: () => ({ sources: { cfs: { state: 'fresh' } }, cfs: [{ slots: [{ designation: 'T1A' }] }] }) });
  x.assignments.spoolman = { getSpool: () => new Promise(resolve => { finish = resolve; }) };
  const work = x.assignments.assign({ id: 'assignment-race', actor: 'operator', confirmed: true, printerId: 'p', slot: 'T1A', spoolId: 17, baseVersion: 0 });
  x.settings.save({ connection: second, baseVersion: 1, confirmChange: true }); finish({ id: 17 });
  await assert.rejects(work, /Spoolman connection changed/); assert.equal(x.assignments.current().version, 1);
});
test('even empty associations advance revision when inventory changes, invalidating already-open dialogs', t => {
 const x=setup(t); assert.equal(x.assignments.current().version,0);
 x.settings.save({connection:second,baseVersion:1,confirmChange:true});
 assert.equal(x.assignments.current().version,1); assert.deepEqual(x.assignments.current().assignments,[]);
});
test('browser URL supports a separate public route without affecting inventory namespace or server requests', t => {
 const x=setup(t);const kind=x.inventory.kind;
 x.settings.save({connection:{...first,browserUrl:'https://inventory.example.test/library'},baseVersion:1});
 assert.equal(x.inventory.kind,kind);assert.equal(x.settings.client.browserUrl,'https://inventory.example.test/library/');
 for(const browserUrl of ['javascript:alert(1)','https://user:password@example.test/','https://example.test/?token=secret'])assert.throws(()=>normalizeSpoolmanConnection({...first,browserUrl}));
});
