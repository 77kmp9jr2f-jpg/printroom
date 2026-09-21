import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { Store } from '../src/store.mjs';
import { AssignmentService } from '../src/assignments.mjs';
import { drainAndClose } from '../src/shutdown.mjs';
import { createApiServer } from '../src/server.mjs';

for (const secondary of [false, true]) for (const disconnected of [false, true]) test(`shutdown drains an assignment on the ${secondary ? 'second' : 'only'} listener even when the client is ${disconnected ? 'disconnected' : 'connected'}`, async () => {
  const store = new Store(':memory:');
  let releaseLookup, lookupStarted;
  const started = new Promise(r => lookupStarted = r);
  const spoolman = { getSpool: () => { lookupStarted(); return new Promise(r => releaseLookup = r); } };
  const telemetry = new Map([['left', { snapshot: () => ({ sources: { cfs: { state: 'fresh' } }, cfs: [{ slots: [{ designation: 'T1A' }] }] }) }]]);
  const assignments = new AssignmentService({ store, spoolman, telemetry });
  const noop = { close: async () => {} };
  const server = createApiServer({ token: 'test-secret', store, telemetry, assignments, projects: {}, inventory: noop });
  const primary = secondary ? createApiServer({ token: 'test-secret', store, telemetry }) : null;
  const servers = [primary, server].filter(Boolean);
  let savedBeforeClose = null;
  const closeStore = store.close.bind(store);
  store.close = () => { savedBeforeClose = assignments.current(); closeStore(); };
  for (const s of servers) await new Promise(r => s.listen(0, '127.0.0.1', r));
  let client;
  const response = new Promise(resolve => {
    client = request(`http://127.0.0.1:${server.address().port}/api/v1/assignments`, { method: 'POST',
      headers: { Authorization: 'Bearer test-secret', 'Content-Type': 'application/json' } }, res => {
      let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    client.on('error', () => resolve(null));
    client.end(JSON.stringify({ id: 'shutdown-assign', printerId: 'left', slot: 'T1A', spoolId: 1, confirmed: true, baseVersion: 0 }));
  });
  await started;
  if (disconnected) { client.destroy(); await response; }
  const stopping = drainAndClose({ servers, store, collectors: noop, commands: noop, inventory: noop });
  await new Promise(r => setTimeout(r, 20));
  releaseLookup({ id: 1, archived: false });
  const result = await response;
  await stopping;
  assert.equal(servers.every(s => !s.listening), true);
  if (!disconnected) assert.equal(result.status, 200, result.text);
  assert.equal(savedBeforeClose.assignments[0]?.spoolId, 1);
});
