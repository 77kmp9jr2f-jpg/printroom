import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlClient, sourceState, requestId } from '../web/ui-core.js';
test('HTTP LAN request ids use secure random bytes without secure-context-only APIs', () => {
  const crypto = { getRandomValues: a => { a.fill(255); return a; } };
  assert.equal(requestId(crypto), 'ffffffff-ffff-4fff-bfff-ffffffffffff');
  assert.notEqual(requestId(), requestId());
});
const storage = () => { let value = null; return { getItem: () => value, setItem: (key, v) => value = v }; };
const reply = (body, statuses = ['requested']) => ({ ...body, targets: statuses.map((status, i) => ({ printerId: i ? 'right' : 'left', status })) });
test('client freshness ages retained server values instead of trusting an old fresh label', () => {
  assert.equal(sourceState({ observedAt: 1000, state: 'fresh' }, 17000), 'stale');
  assert.equal(sourceState({ observedAt: 1000, state: 'fresh' }, 32000), 'disconnected');
  assert.equal(sourceState({ observedAt: null, state: 'fresh' }, 1000), 'unavailable');
});
test('control id is persisted before submission and concurrent clicks send only once', async () => {
  const disk = storage(); let calls = 0, release;
  const c = new ControlClient({ storage: disk, api: async (path, body) => { calls++; assert.ok(disk.getItem().includes(body.id)); await new Promise(r => release = r); return reply(body); } });
  const a = c.send('left', 'pause'); const b = c.send('left', 'pause'); release();
  assert.equal((await a).id, (await b).id); assert.equal(calls, 1);
});
test('reload keeps an uncertain saved id without automatically resubmitting', async () => {
  const disk = storage(); let calls = 0;
  const c = new ControlClient({ storage: disk, api: async () => { calls++; throw new Error('response lost'); } });
  const first = await c.send('left', 'pause');
  const restarted = new ControlClient({ storage: disk, api: async () => { calls++; } });
  assert.equal(restarted.records()[0].id, first.id); assert.equal(restarted.records()[0].transport, 'outcome_unknown'); assert.equal(calls, 1);
});
test('uncertain routine result blocks another routine attempt but permits a deliberate emergency stop', async () => {
  const c = new ControlClient({ storage: storage(), api: async () => { throw new Error('timeout'); } });
  await c.send('left', 'pause'); await assert.rejects(c.send('left', 'pause'), /uncertain/i);
  assert.equal((await c.send('left', 'emergency_stop')).action, 'emergency_stop');
});
test('fleet results retain independent shutdown and uncertain outcomes', async () => {
  const c = new ControlClient({ storage: storage(), printerIds: ['left', 'right'], api: async (path, body) => reply(body, ['shutdown_observed', 'outcome_unknown']) });
  const result = await c.send('all', 'emergency_stop');
  assert.deepEqual(result.server.targets.map(t => t.status), ['shutdown_observed', 'outcome_unknown']);
});
test('a malformed or mismatched acknowledgment cannot count as accepted', async () => {
  const c = new ControlClient({ storage: storage(), api: async () => ({ id: 'different-id', target: 'right', action: 'pause' }) });
  assert.equal((await c.send('left', 'emergency_stop')).transport, 'outcome_unknown');
});
test('an acknowledgment missing its target remains uncertain', async () => {
  const c = new ControlClient({ storage: storage(), api: async (path, body) => ({ ...body, targets: [] }) });
  assert.equal((await c.send('left', 'pause')).transport, 'outcome_unknown');
});
test('an old pending action is still reconciled after falling outside the recent list', async () => {
  const disk = storage(); let listed = true;
  const saved = { id: 'old-action-id', target: 'left', action: 'pause', createdAt: 1 };
  const c = new ControlClient({ storage: disk, api: async path => path === '/api/v1/actions' ? { actions: listed ? [reply(saved)] : [] } : reply(saved, ['state_observed']) });
  await c.refresh(); assert.equal(c.blocked('left'), true); listed = false;
  await c.refresh(); assert.equal(c.blocked('left'), false);
});
test('unknown status and an incomplete fleet reply retain every target block', async () => {
  for (const statuses of [['made_up_success'], ['shutdown_observed']]) {
    const c = new ControlClient({ storage: storage(), printerIds: ['left', 'right'], api: async (path, body) => reply(body, statuses) });
    const r = await c.send('all', 'emergency_stop');
    assert.equal(r.transport, 'outcome_unknown'); assert.equal(c.blocked('left'), true); assert.equal(c.blocked('right'), true);
  }
});

test('historical all-printer actions keep their original targets after fleet membership changes', () => {
  const client = new ControlClient({ storage: { getItem: () => null, setItem() {} }, api: async () => {}, printerIds: ['alpha', 'beta'] });
  client.adopt([{ id: 'historical-fleet-action', target: 'all', action: 'emergency_stop', createdAt: 1, targets: [{ printerId: 'alpha', status: 'outcome_unknown' }] }]);
  assert.equal(client.records().length, 1); assert.equal(client.blocked('alpha'), true); assert.equal(client.blocked('beta'), false);
  client.printerIds = []; assert.equal(client.records()[0].server.targets[0].printerId, 'alpha');
});
