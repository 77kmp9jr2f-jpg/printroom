import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createApiServer } from '../src/server.mjs';
import { parseConfig } from '../src/config.mjs';
import { Store } from '../src/store.mjs';
import { CommandService } from '../src/commands.mjs';
import { PrinterTelemetry } from '../src/telemetry.mjs';

const token = 'a'.repeat(64);
async function api(t, controlsEnabled = true) {
  const calls = [];
  const device = createServer((req, res) => { calls.push(req.url); res.end('{"result":"ok"}'); });
  device.listen(0, '127.0.0.1'); await once(device, 'listening');
  const printers = [{ id: 'left', name: 'Left', moonraker: `http://127.0.0.1:${device.address().port}` }];
  const store = new Store(':memory:');
  const telemetry = new Map([['left', new PrinterTelemetry(printers[0])]]);
  const commands = new CommandService({ printers, telemetry, store, observationMs: 10, pollMs: 2 });
  const server = createApiServer({ token, telemetry, commands, store, controlsEnabled });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); server.close(); await commands.close(); store.close(); device.closeAllConnections(); device.close(); });
  return { base: `http://127.0.0.1:${server.address().port}`, calls, commands };
}
const post = (body, headers = {}) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body: JSON.stringify(body) });

test('authentication and browser-origin rejection prevent printer-side effects', async t => {
  const { base, calls } = await api(t);
  const body = { id: 'blocked-action', target: 'left', action: 'emergency_stop' };
  assert.equal((await fetch(base + '/api/v1/actions', post(body, { Authorization: '' }))).status, 401);
  assert.equal((await fetch(base + '/api/v1/actions', post(body, { Origin: 'https://external.example' }))).status, 403);
  assert.equal((await fetch(base + '/api/v1/fleet')).status, 401);
  assert.equal((await fetch(base + '/healthz')).status, 200);
  assert.deepEqual(calls, []);
});

test('API targets only configured printer and binds actor to authenticated integration', async t => {
  const { base, calls, commands } = await api(t);
  const response = await fetch(base + '/api/v1/actions', post({ id: 'authorized-stop', target: 'left', action: 'emergency_stop', actor: 'forged-actor' }));
  assert.equal(response.status, 202);
  const action = await response.json();
  assert.equal(action.actor, 'home-assistant');
  await commands.settled('authorized-stop');
  const get = await fetch(base + '/api/v1/actions/authorized-stop', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal((await get.json()).targets[0].status, 'outcome_unknown');
  assert.deepEqual(calls, ['/printer/emergency_stop']);
  const rejected = await fetch(base + '/api/v1/actions', post({ id: 'arbitrary-target', target: 'http://attacker.example', action: 'emergency_stop' }));
  assert.equal(rejected.status, 400);
  assert.equal(calls.length, 1);
});

test('authenticated operator resolution requires confirmation and preserves audit provenance', async t => {
  const { base, calls, commands } = await api(t);
  await fetch(base + '/api/v1/actions', post({ id: 'resolve-through-api', target: 'left', action: 'emergency_stop' }));
  await commands.settled('resolve-through-api');
  const url = base + '/api/v1/actions/resolve-through-api/resolve';
  const body = { printerId: 'left', note: 'Checked the printer and its pending command state.', confirmed: false, actor: 'forged' };
  assert.equal((await fetch(url, post(body))).status, 400);
  const response = await fetch(url, post({ ...body, confirmed: true }));
  assert.equal(response.status, 200);
  const result = (await response.json()).targets[0];
  assert.equal(result.status, 'operator_resolved');
  assert.equal(result.resolvedBy, 'home-assistant');
  assert.equal(result.observedAt, null);
  assert.equal(calls.length, 1);
});

test('staging mode makes live validation read-only, including emergency routes', async t => {
  const { base, calls } = await api(t, false);
  const response = await fetch(base + '/api/v1/actions', post({ id: 'staged-action', target: 'left', action: 'emergency_stop' }));
  assert.equal(response.status, 409);
  const fleet = await fetch(base + '/api/v1/fleet', { headers: { Authorization: `Bearer ${token}` } });
  const data = await fleet.json();
  assert.equal(data.controlsEnabled, false);
  assert.equal(data.printers[0].controls.emergency_stop, false);
  assert.deepEqual(calls, []);
});
test('a missing browser request can be closed only by an authenticated explicit check', async t => {
  const { base, calls } = await api(t);
  const path = base + '/api/v1/actions/missing-in-transit/resolve-missing';
  const body = { target: 'left', action: 'pause', confirmed: true, note: 'Checked physical printer and no pending command remains.' };
  assert.equal((await fetch(path, post(body, { Authorization: '' }))).status, 401);
  assert.equal((await fetch(path, post({ ...body, confirmed: false }))).status, 400);
  const response = await fetch(path, post(body)); assert.equal(response.status, 200);
  assert.equal((await response.json()).targets[0].status, 'operator_resolved');
  const delayed = await fetch(base + '/api/v1/actions', post({ id: 'missing-in-transit', action: 'pause', target: 'left' }));
  assert.equal(delayed.status, 202); assert.deepEqual(calls, []);
});

test('API rejects oversized and malformed bodies before command dispatch', async t => {
  const { base, calls } = await api(t);
  assert.equal((await fetch(base + '/api/v1/actions', post({ id: 'oversized', extra: 'x'.repeat(40_000) }))).status, 413);
  const invalid = post({}); invalid.body = '{bad json';
  assert.equal((await fetch(base + '/api/v1/actions', invalid)).status, 400);
  assert.deepEqual(calls, []);
});

test('configuration rejects URL injection, public addresses, duplicate ids and weak credentials', () => {
  const valid = { printers: [{ id: 'left', name: 'Left', host: '192.168.250.160' }], controlsEnabled: false };
  const config = parseConfig(valid, token);
  assert.equal(config.printers[0].moonraker, 'http://192.168.250.160:7125');
  assert.equal(config.printers[0].vendor, 'ws://192.168.250.160:9999');
  assert.equal(config.printers[0].fluidd, 'http://192.168.250.160:4408');
  const three = parseConfig({
    printers: [
      { id: 'alpha', name: 'Alpha', host: '192.168.250.10' },
      { id: 'beta', name: 'Beta', host: '192.168.250.11', fluiddPort: 81 },
      { id: 'gamma', name: 'Gamma', host: '10.0.0.12', vendor: false, cameraPort: null },
    ],
  }, token);
  assert.equal(three.printers.length, 3);
  assert.equal(three.printers[1].fluidd, 'http://192.168.250.11:81');
  assert.equal(three.printers[2].vendor, null);
  assert.equal(three.printers[2].camera, null);
  assert.equal(three.printers[2].moonraker, 'http://10.0.0.12:7125');
  for (const host of ['http://192.168.250.160/', '8.8.8.8', '192.168.250.160@evil.test', '192.168.250.999']) {
    assert.throws(() => parseConfig({ ...valid, printers: [{ ...valid.printers[0], host }] }, token), /host/i);
  }
  assert.throws(() => parseConfig({ ...valid, printers: [valid.printers[0], valid.printers[0]] }, token), /id/i);
  assert.throws(() => parseConfig(valid, 'password'), /token/i);
  assert.equal(parseConfig({ ...valid, lanHost: '192.168.250.30' }, token).lanHost, '192.168.250.30');
  for (const lanHost of ['127.0.0.1', '0.0.0.0', '8.8.8.8', '192.168.250.30:7988', 'evil.example']) {
    assert.throws(() => parseConfig({ ...valid, lanHost }, token), /LAN host/i);
  }
  assert.equal(parseConfig({ ...valid, spoolman: { host: 'host.docker.internal', port: 7912 } }, token).spoolman.host, 'host.docker.internal');
  for (const host of ['example.com', '8.8.8.8', 'http://192.168.250.30', 'user@host.docker.internal']) {
    assert.throws(() => parseConfig({ ...valid, spoolman: { host } }, token), /Spoolman/i);
  }
});
