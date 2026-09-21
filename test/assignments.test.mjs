import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.mjs';
import { AssignmentService } from '../src/assignments.mjs';

function setup(path = ':memory:') {
  const store = new Store(path);
  const telemetry = new Map(['left', 'right'].map(id => [id, { snapshot: () => ({ sources: { cfs: { state: 'fresh' } },
    cfs: [{ slots: [{ designation: 'T1A', material: 'PLA', color: '#000000' }, { designation: 'T1B' }] }] }) }]));
  const spoolman = { getSpool: async id => id === 3 ? { id, archived: true } : id === 404 ? null : { id, archived: false } };
  const svc = new AssignmentService({ store, telemetry, spoolman });
  return { store, telemetry, spoolman, svc };
}
const move = (overrides = {}) => ({ id: 'assignment-0001', printerId: 'left', slot: 'T1A', spoolId: 1,
  confirmed: true, baseVersion: 0, actor: 'operator', ...overrides });

test('moving a real spool clears its old slot and retains history across a file-backed restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'print-assignment-')); const path = join(dir, 'db.sqlite');
  const fixture = setup(path); const { svc } = fixture; let store = fixture.store;
  try {
    await svc.assign(move());
    const result = await svc.assign(move({ id: 'assignment-0002', printerId: 'right', slot: 'T1B', baseVersion: 1 }));
    assert.equal(result.assignments.length, 1);
    assert.equal(result.assignments[0].printerId, 'right');
    assert.equal(result.assignments[0].source, 'operator_confirmed');
    assert.equal(result.event.from[0].printerId, 'left');
    assert.equal(svc.history().length, 2);
    store.close(); store = new Store(path);
    const restarted = new AssignmentService({ store, telemetry: new Map(), spoolman: null });
    assert.deepEqual(restarted.current(), result);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('assignment checks physical confirmation, actual spool and fresh connected slot', async () => {
  const { store, svc, telemetry } = setup();
  try {
    for (const change of [{ confirmed: false }, { spoolId: 3 }, { spoolId: 404 }, { slot: 'T4A' }, { printerId: 'other' }]) {
      await assert.rejects(svc.assign(move(change)));
    }
    telemetry.get('left').snapshot = () => ({ sources: { cfs: { state: 'stale' } }, cfs: [{ slots: [{ designation: 'T1A' }] }] });
    await assert.rejects(svc.assign(move()), /fresh/i);
    assert.equal(svc.current().assignments.length, 0);
  } finally { store.close(); }
});

test('idempotent move retries do not undo a later move, and conflicting edits are rejected', async () => {
  const { store, svc } = setup();
  try {
    const first = await svc.assign(move());
    await svc.assign(move({ id: 'assignment-0002', slot: 'T1B', baseVersion: 1 }));
    assert.deepEqual(await svc.assign(move()), first);
    assert.equal(svc.current().assignments[0].slot, 'T1B');
    await assert.rejects(svc.assign(move({ spoolId: 2 })), /bound/i);
    await assert.rejects(svc.assign(move({ id: 'assignment-0003' })), /version/i);
  } finally { store.close(); }
});

test('replacing and unassigning a spool records displaced identity without inventory consumption writes', async () => {
  const { store, svc } = setup();
  try {
    await svc.assign(move());
    const replaced = await svc.assign(move({ id: 'assignment-0002', spoolId: 2, baseVersion: 1 }));
    assert.equal(replaced.assignments[0].spoolId, 2); assert.equal(replaced.event.displaced.spoolId, 1);
    const cleared = await svc.assign(move({ id: 'assignment-0003', spoolId: null, baseVersion: 2 }));
    assert.deepEqual(cleared.assignments, []); assert.equal(cleared.event.displaced.spoolId, 2);
  } finally { store.close(); }
});

test('two concurrent assignments cannot overwrite each other after asynchronous inventory reads', async () => {
  const { store, svc } = setup();
  try {
    const results = await Promise.allSettled([svc.assign(move()), svc.assign(move({ id: 'assignment-0002', slot: 'T1B', spoolId: 2 }))]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(svc.current().version, 1); assert.equal(svc.current().assignments.length, 1);
  } finally { store.close(); }
});
