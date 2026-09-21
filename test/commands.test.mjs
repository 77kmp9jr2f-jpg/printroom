import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Store } from '../src/store.mjs';
import { CommandService } from '../src/commands.mjs';

async function device(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
function setup(t, printers, extra = {}) {
  const store = new Store(':memory:');
  const telemetry = new Map(printers.map(p => [p.id, { snapshot: () => ({ phase: 'printing', job: { id: 'job-instance-a' }, shutdownObservedAt: null, sources: { moonraker: { observedAt: Date.now() } }, controls: { pause: true, cancel: true, resume: false } }) }]));
  const service = new CommandService({ printers, store, telemetry, timeoutMs: 80, observationMs: 80, pollMs: 5, ...extra });
  t.after(async () => { await service.close(); store.close(); });
  return { store, service, telemetry };
}
const command = (id, target = 'left', action = 'emergency_stop') => ({ id, target, action, actor: 'test-operator', ...(action === 'cancel' ? { expectedJobId: 'job-instance-a' } : {}) });

test('fleet emergency reaches healthy printer before slow peer times out', async t => {
  let healthyCalled = false;
  const slow = await device(t, () => {});
  const fast = await device(t, (req, res) => {
    assert.equal(req.url, '/printer/emergency_stop');
    assert.equal(req.method, 'POST');
    healthyCalled = true;
    res.setHeader('Content-Type', 'application/json');
    res.end('{"result":"ok"}');
  });
  const { service } = setup(t, [{ id: 'left', moonraker: slow }, { id: 'right', moonraker: fast }]);
  const action = service.submit(command('fleet-first', 'all'));
  assert.equal(action.targets.length, 2);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(healthyCalled, true);
  await service.settled('fleet-first');
  const result = service.get('fleet-first');
  assert.equal(result.targets.find(t => t.printerId === 'left').status, 'outcome_unknown');
  assert.ok(result.targets.find(t => t.printerId === 'right').acknowledgedAt);
  assert.equal(result.targets.find(t => t.printerId === 'right').status, 'outcome_unknown');
});

test('success is observed only from a new shutdown sample', async t => {
  let requestedAt;
  const endpoint = await device(t, (req, res) => { requestedAt = Date.now(); res.end('{"result":"ok"}'); });
  const { service, telemetry } = setup(t, [{ id: 'left', moonraker: endpoint }]);
  telemetry.set('left', { snapshot: () => ({ phase: 'shutdown', shutdownObservedAt: requestedAt ? requestedAt + 1 : 1, controls: {} }) });
  service.submit(command('observed-stop'));
  await service.settled('observed-stop');
  assert.equal(service.get('observed-stop').targets[0].status, 'shutdown_observed');
});

test('preexisting shutdown cannot verify a newly sent emergency request', async t => {
  const endpoint = await device(t, (req, res) => res.end('{"result":"ok"}'));
  const { service, telemetry } = setup(t, [{ id: 'left', moonraker: endpoint }]);
  telemetry.set('left', { snapshot: () => ({ phase: 'shutdown', shutdownObservedAt: 1, controls: {} }) });
  service.submit(command('old-shutdown'));
  await service.settled('old-shutdown');
  assert.equal(service.get('old-shutdown').targets[0].status, 'outcome_unknown');
});

test('idempotent retries never send a second physical request, including after restart', async t => {
  let calls = 0;
  const endpoint = await device(t, (req, res) => { calls++; res.end('{"result":"ok"}'); });
  const dir = mkdtempSync(join(tmpdir(), 'print-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const filename = join(dir, 'store.sqlite');
  const store = new Store(filename);
  const printers = [{ id: 'left', moonraker: endpoint }];
  const first = new CommandService({ printers, store, telemetry: new Map(), timeoutMs: 100, observationMs: 10, pollMs: 2 });
  first.submit(command('same-click'));
  first.submit(command('same-click'));
  await first.settled('same-click');
  await first.close();
  store.close();
  const nextStore = new Store(filename);
  const second = new CommandService({ printers, store: nextStore, telemetry: new Map(), observationMs: 10 });
  second.submit(command('same-click'));
  assert.equal(calls, 1);
  assert.throws(() => second.submit(command('same-click', 'left', 'cancel')), /idempotency/i);
  await second.close(); nextStore.close();
});

test('unauthorized printer ids, arbitrary actions and invalid routine transitions never reach transport', async t => {
  let calls = 0;
  const endpoint = await device(t, (req, res) => { calls++; res.end('{"result":"ok"}'); });
  const { service, telemetry } = setup(t, [{ id: 'left', moonraker: endpoint }]);
  assert.throws(() => service.submit(command('bad-target', 'http://external/')), /target/i);
  assert.throws(() => service.submit(command('bad-action', 'left', 'G28')), /action/i);
  telemetry.set('left', { snapshot: () => ({ phase: 'preparing', controls: { cancel: false } }) });
  assert.throws(() => service.submit(command('bad-state', 'left', 'cancel')), /state/i);
  assert.equal(calls, 0);
});

test('cancel and emergency use distinct endpoints and rejection stays failed', async t => {
  const paths = [];
  const endpoint = await device(t, (req, res) => { paths.push(req.url); res.statusCode = 401; res.end('{"error":{"message":"unauthorized"}}'); });
  const { service } = setup(t, [{ id: 'left', moonraker: endpoint }]);
  service.submit(command('normal-cancel', 'left', 'cancel'));
  service.submit(command('emergency'));
  await Promise.all([service.settled('normal-cancel'), service.settled('emergency')]);
  assert.deepEqual(paths.sort(), ['/printer/emergency_stop', '/printer/print/cancel']);
  assert.equal(service.get('emergency').targets[0].status, 'failed');
  assert.equal(service.get('normal-cancel').targets[0].status, 'failed');
});
test('cancel requires the same job instance that the operator confirmed', async t => {
  const { service } = setup(t, [{ id: 'left', moonraker: 'http://127.0.0.1:1' }]);
  assert.throws(() => service.submit({ ...command('changed-job', 'left', 'cancel'), expectedJobId: 'old-instance' }), /job/i);
  assert.throws(() => service.submit({ ...command('missing-job', 'left', 'cancel'), expectedJobId: undefined }), /job/i);
});
test('missing-request resolution prevents a delayed original request from being dispatched', async t => {
  let calls = 0;
  const endpoint = await device(t, (req, res) => { calls++; res.end('{"result":"ok"}'); });
  const { service } = setup(t, [{ id: 'left', moonraker: endpoint }]);
  const original = command('browser-missing', 'all');
  assert.equal(typeof service.resolveMissing, 'function');
  service.resolveMissing({ ...original, confirmed: true, note: 'Physically checked all printers and pending commands.' });
  assert.equal(service.submit(original).targets[0].status, 'operator_resolved'); assert.equal(calls, 0);
});

test('interrupted audit records recover as unknown without replay', async t => {
  const store = new Store(':memory:');
  store.createAction({ id: 'interrupted', target: 'left', action: 'emergency_stop', actor: 'operator', createdAt: 1, targets: [{ printerId: 'left', status: 'requested', requestedAt: 1 }] });
  const { service } = setup(t, [{ id: 'left', moonraker: 'http://127.0.0.1:1' }], { store });
  assert.equal(service.get('interrupted').targets[0].status, 'outcome_unknown');
});

test('ambiguous routine action blocks a new attempt while no outcome is reconciled', async t => {
  const endpoint = await device(t, (req, res) => res.destroy());
  const { service, telemetry } = setup(t, [{ id: 'left', moonraker: endpoint }]);
  const oldAt = Date.now() - 1000;
  telemetry.set('left', { snapshot: () => ({ phase: 'printing', sources: { moonraker: { observedAt: oldAt } }, controls: { pause: true } }) });
  service.submit(command('ambiguous-pause', 'left', 'pause'));
  await service.settled('ambiguous-pause');
  assert.throws(() => service.submit(command('unsafe-retry', 'left', 'pause')), /reconcil/i);
});

test('unchanged state is not proof that a delayed routine command failed', async t => {
  const endpoint = await device(t, (req, res) => res.destroy());
  const { service, telemetry } = setup(t, [{ id: 'left', moonraker: endpoint }]);
  service.submit(command('lost-pause', 'left', 'pause'));
  await service.settled('lost-pause');
  telemetry.set('left', { snapshot: () => ({ phase: 'printing', sources: { moonraker: { observedAt: Date.now() + 1 } }, controls: { pause: true } }) });
  assert.throws(() => service.submit(command('delayed-retry', 'left', 'pause')), /reconcil/i);
});

test('explicit operator resolution records uncertainty without inventing observed success', async t => {
  let calls = 0;
  const endpoint = await device(t, (req, res) => { calls++; res.destroy(); });
  const { service } = setup(t, [{ id: 'left', moonraker: endpoint }]);
  service.submit(command('resolve-lost-pause', 'left', 'pause'));
  await service.settled('resolve-lost-pause');
  assert.equal(typeof service.resolve, 'function');
  assert.throws(() => service.resolve({ id: 'resolve-lost-pause', printerId: 'left', actor: 'operator', confirmed: false, note: 'Checked the physical printer' }), /confirm/i);
  service.resolve({ id: 'resolve-lost-pause', printerId: 'left', actor: 'operator', confirmed: true, note: 'Checked the physical printer and its current command state.' });
  const result = service.get('resolve-lost-pause').targets[0];
  assert.equal(result.status, 'operator_resolved');
  assert.equal(result.observedAt, null);
  assert.equal(result.resolvedBy, 'operator');
  assert.equal(calls, 1);
  service.submit(command('after-resolution', 'left', 'pause'));
  await service.settled('after-resolution');
  assert.equal(calls, 2);
});
