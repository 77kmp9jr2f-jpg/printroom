import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request } from 'node:http';
import { Store } from '../src/store.mjs';
import { normalizePrinters, runtimePrinters } from '../src/config.mjs';
import { PrinterRegistry } from '../src/printer-registry.mjs';
import { PrinterDiscovery, subnetHosts, probeMoonraker } from '../src/discovery.mjs';
import { PrinterSettings } from '../src/printer-settings.mjs';
import { LocalBrowser, BrowserPairing } from '../src/local-browser.mjs';
import { createApiServer } from '../src/server.mjs';
import { PrinterTelemetry } from '../src/telemetry.mjs';
import { Collectors } from '../src/collectors.mjs';
import { reconcileFleet } from '../src/fleet.mjs';

const profile = (id = 'alpha', extra = {}) => ({ id, name: id, host: '192.168.20.10', adapter: 'moonraker', ...extra });
function registry(t, initialPrinters = []) { const store = new Store(':memory:'); t.after(() => store.close()); return new PrinterRegistry({ store, initialPrinters }); }

test('profiles support empty and 64-printer fleets, separate instances on one host, and explicit adapter defaults', () => {
  assert.deepEqual(normalizePrinters([]), []);
  const fleet = normalizePrinters(Array.from({ length: 64 }, (_, i) => profile('p' + i, { moonrakerPort: 7125 + i })));
  assert.equal(runtimePrinters(fleet).length, 64);
  assert.equal(fleet[0].cameraMode, 'none'); assert.equal(runtimePrinters(fleet)[0].vendor, null);
  assert.throws(() => normalizePrinters([...fleet, profile('extra')]), /64/);
  assert.throws(() => normalizePrinters([profile(), profile('beta')]), /Duplicate/);
  for (const host of ['8.8.8.8', 'printer.local', '192.168.20.10@evil.test', '169.254.169.254']) assert.throws(() => normalizePrinters([profile('x', { host })]), /host/i);
  assert.throws(() => normalizePrinters([profile('x', { apiKey: 'a\r\nheader: value' })]), /key/);
  assert.throws(() => normalizePrinters([profile('x', { cameraMode: 'relay', cameraStream: 'http://evil.test' })]), /stream/);
  assert.equal(normalizePrinters([{ id: 'legacy', name: 'K2', host: '192.168.20.1' }])[0].adapter, 'creality');
});

test('registry persists through restart, rejects stale revisions and does not reseed a deliberately empty fleet', t => {
  const dir = mkdtempSync(join(tmpdir(), 'printer-registry-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.sqlite'); let store = new Store(path);
  let r = new PrinterRegistry({ store, initialPrinters: [profile()] });
  r.save({ printer: profile('alpha', { name: 'Updated' }), baseVersion: 1 });
  assert.throws(() => r.save({ printer: profile(), baseVersion: 1 }), /changed/);
  store.close(); store = new Store(path); r = new PrinterRegistry({ store, initialPrinters: [profile('different')] });
  assert.equal(r.snapshot().printers[0].name, 'Updated');
  r.remove({ id: 'alpha', baseVersion: 2 });
  assert.throws(() => r.save({ printer: profile(), baseVersion: 3 }), /retired/);
  store.close(); store = new Store(path); r = new PrinterRegistry({ store, initialPrinters: [profile()] });
  assert.equal(r.snapshot().printers.length, 0); store.close();
});

test('keys are never returned, survive unchanged endpoints, and never follow a retarget', t => {
  const r = registry(t, [profile('alpha', { apiKey: 'secret-fixture' })]);
  assert.equal(JSON.stringify(r.snapshot()).includes('secret-fixture'), false);
  assert.equal(r.snapshot().printers[0].hasApiKey, true);
  r.save({ printer: { ...r.snapshot().printers[0], name: 'Rename' }, baseVersion: 1 });
  assert.equal(r.runtime()[0].apiKey, 'secret-fixture');
  r.save({ printer: { ...r.snapshot().printers[0], moonrakerPort: 7126 }, baseVersion: 2 });
  assert.equal(r.runtime()[0].apiKey, '');
});

test('invalid changes and unresolved commands leave the persisted registry untouched', t => {
  const r = registry(t, [profile()]);
  r.store.createAction({ id: 'pending-action', createdAt: 1, targets: [{ printerId: 'alpha', status: 'outcome_unknown' }] });
  assert.throws(() => r.remove({ id: 'alpha', baseVersion: 1 }), /Resolve/);
  assert.throws(() => r.save({ printer: profile('alpha', { enabled: false }), baseVersion: 1 }), /Resolve/);
  assert.throws(() => r.save({ printer: profile('alpha', { host: '192.168.20.11' }), baseVersion: 1 }), /Resolve/);
  assert.throws(() => r.save({ printer: profile('beta'), baseVersion: 1 }), /Duplicate/);
  assert.equal(r.version, 1); assert.equal(r.printers.length, 1);
});

test('discovery accepts only small explicit private subnets and never public, multicast, metadata or loopback ranges', () => {
  assert.equal(subnetHosts('192.168.20.50/24').length, 254);
  assert.deepEqual(subnetHosts('10.1.2.3/32'), ['10.1.2.3']);
  for (const cidr of ['10.0.0.0/8', '192.168.0.0/16', '8.8.8.8/32', '127.0.0.1/32', '169.254.169.254/32', '224.0.0.0/24', 'example.com/24', '192.168.20.0/24/1']) assert.throws(() => subnetHosts(cidr));
});

test('discovery is bounded, reports only identified/auth candidates, and supports cancellation without additions', async () => {
  let active = 0, peak = 0; const waiters = [];
  const discovery = new PrinterDiscovery({ concurrency: 3, probe: ({ host }) => new Promise(resolve => { active++; peak = Math.max(active, peak); waiters.push(() => { active--; resolve({ host, status: 'moonraker' }); }); }) });
  const scan = discovery.start({ subnet: '192.168.20.0/24' });
  assert.equal(scan.total, 254); assert.equal(peak, 3);
  assert.throws(() => discovery.start({ subnet: '192.168.21.0/24' }), /already/);
  discovery.cancel(); waiters.splice(0).forEach(fn => fn()); await discovery.job.work;
  assert.equal(discovery.snapshot().status, 'cancelled'); assert.equal(discovery.snapshot().results.length, 0); assert.equal(discovery.snapshot().completed, 3);
  await discovery.close();
});

test('connection check identifies Moonraker, handles authentication, rejects unrelated JSON and never follows redirects', async t => {
  let mode = 'good'; const calls = [];
  const device = createServer((req, res) => {
    calls.push({ method: req.method, path: req.url, key: req.headers['x-api-key'] });
    if (mode === 'auth') { res.writeHead(401); return res.end('{}'); }
    if (mode === 'redirect') { res.writeHead(302, { Location: 'http://8.8.8.8/' }); return res.end(); }
    res.end(JSON.stringify(mode === 'good' ? { result: { klippy_state: 'ready', klippy_connected: true, moonraker_version: 'fixture' } } : { hello: 'world' }));
  });
  await new Promise(r => device.listen(0, '127.0.0.1', r)); t.after(() => { device.closeAllConnections(); device.close(); });
  const input = { host: '127.0.0.1', moonrakerPort: device.address().port, apiKey: 'fixture-key' };
  assert.equal((await probeMoonraker(input)).status, 'moonraker');
  mode = 'auth'; assert.equal((await probeMoonraker(input)).status, 'authentication_required');
  mode = 'other'; assert.equal((await probeMoonraker(input)).status, 'not_moonraker');
  mode = 'redirect'; assert.equal((await probeMoonraker(input)).status, 'unreachable');
  assert.ok(calls.every(c => c.method === 'GET' && c.path === '/server/info' && c.key === 'fixture-key'));
});

test('generic Moonraker reports idle without vendor warnings while Creality retains source uncertainty', () => {
  for (const adapter of ['moonraker', 'creality']) {
    const p = new PrinterTelemetry(runtimePrinters(normalizePrinters([profile('alpha', { adapter })]))[0]);
    p.updateMoonrakerInfo({ klippy_state: 'ready', klippy_connected: true });
    p.updateMoonraker({ print_stats: { state: 'standby' }, webhooks: { state: 'ready' } });
    const s = p.snapshot(); assert.equal(s.phase, adapter === 'moonraker' ? 'idle' : 'unknown');
    assert.equal(s.warnings.length === 0, adapter === 'moonraker');
    p.updateMoonraker({ print_stats: { state: 'printing' }, webhooks: { state: 'ready' } });
    assert.equal(p.snapshot().controls.pause, adapter === 'moonraker');
  }
});

test('64-printer collection stays bounded, fair and never overlaps a printer', async () => {
  const printers = Array.from({ length: 64 }, (_, i) => ({ id: 'p' + i })), telemetry = new Map(printers.map(p => [p.id, {}]));
  let active = 0, peak = 0; const seen = new Set(), waiters = [];
  const c = new Collectors(printers, telemetry, { concurrency: 8, now: () => 1, poll: p => new Promise(resolve => {
    assert.equal(seen.has(p.id), false); seen.add(p.id); active++; peak = Math.max(peak, active);
    waiters.push(() => { active--; resolve(); });
  }) });
  c.tick(); c.tick(); await new Promise(setImmediate); assert.equal(peak, 8);
  while (seen.size < 64) { waiters.splice(0).forEach(fn => fn()); await new Promise(setImmediate); }
  const closing = c.close(); waiters.splice(0).forEach(fn => fn()); await closing;
  assert.equal(peak, 8); assert.equal(seen.size, 64); assert.equal(active, 0);
});

test('runtime changes replace stale telemetry, command and camera targets while preserving unchanged printers', () => {
  const printers = runtimePrinters(normalizePrinters([profile()])); const old = new PrinterTelemetry(printers[0]);
  const telemetry = new Map([['alpha', old]]), commands = {}, collectors = { update(p) { this.printers = p; } }, cameras = { update(p) { this.printers = p; } }, cfsync = {};
  const deps = { telemetry, commands, collectors, cameras, cfsync, cfsyncSeed: printers };
  reconcileFleet(printers, deps); assert.equal(telemetry.get('alpha'), old);
  const changed = runtimePrinters(normalizePrinters([profile('alpha', { host: '192.168.20.11' })]));
  reconcileFleet(changed, deps); assert.notEqual(telemetry.get('alpha'), old); assert.equal(telemetry.get('alpha').snapshot().phase, 'unknown');
  assert.equal(commands.printers.get('alpha').host, '192.168.20.11'); assert.deepEqual(cfsync.printerIds, []);
  reconcileFleet([], deps); assert.equal(telemetry.size, 0); assert.equal(commands.printers.size, 0); assert.deepEqual(cameras.printers, []);
});

const http = (base, path, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = request(base + path, { method, headers }, res => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(Buffer.concat(chunks)) })); });
  req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
});
test('settings writes require CSRF and host/paired management, never an open LAN session or integration token', async t => {
  for (const access of ['localhost', 'lan']) {
    const r = registry(t), discovery = new PrinterDiscovery(), host = access === 'localhost' ? 'localhost:7988' : '192.168.20.2:7988';
    const localBrowser = new LocalBrowser({ access, port: 7988, lanHost: '192.168.20.2', lanAccess: 'open' });
    const server = createApiServer({ token: 'a'.repeat(64), telemetry: new Map(), commands: {}, store: r.store, localBrowser,
      settings: new PrinterSettings({ registry: r, discovery }) });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
    const base = `http://127.0.0.1:${server.address().port}`, origin = `http://${host}`;
    const session = await http(base, '/api/session', { method: 'POST', headers: { Host: host, Origin: origin } });
    const headers = { Host: host, Origin: origin, Cookie: session.headers['set-cookie'][0].split(';')[0], 'Content-Type': 'application/json' };
    const path = '/api/v1/settings/printers/save', body = { printer: profile(), baseVersion: 1 };
    assert.equal((await http(base, path, { method: 'POST', headers, body })).status, 403);
    headers['X-Print-CSRF'] = session.data.csrf;
    assert.equal((await http(base, path, { method: 'POST', headers, body })).status, access === 'localhost' ? 200 : 403);
    const view = await http(base, '/api/v1/settings', { headers: { Host: host, Cookie: headers.Cookie } });
    assert.equal(view.data.canManage, access === 'localhost');
    assert.equal((await http(base, path, { method: 'POST', headers: { Host: host, Authorization: 'Bearer ' + 'a'.repeat(64), 'Content-Type': 'application/json' }, body })).status, 403);
  }
});

test('retarget and removal invalidate current physical spool associations atomically while retaining history', t => {
  const r = registry(t, [profile('alpha'), profile('beta', { host: '192.168.20.11' })]);
  r.store.saveRecord('assignments', { id: 'current', assignments: [{ printerId: 'alpha', slot: 'T1A', spoolId: 42 }, { printerId: 'beta', slot: 'T1B', spoolId: 43 }] }, 0);
  r.save({ printer: profile('alpha', { host: '192.168.20.12' }), baseVersion: 1 });
  assert.deepEqual(r.store.getRecord('assignments', 'current').assignments.map(a => a.spoolId), [43]);
  assert.equal(r.store.recordHistory('assignments', 'current').length, 2);
  r.remove({ id: 'beta', baseVersion: 2 });
  assert.deepEqual(r.store.getRecord('assignments', 'current').assignments, []);
  assert.equal(r.store.recordHistory('assignments', 'current').at(-1).assignments.length, 2);
});
test('a paired LAN browser can manage the fleet using its own CSRF session', async t => {
 const r=registry(t), pairing=new BrowserPairing(), code=pairing.create().code;
 const localBrowser=new LocalBrowser({access:'lan',port:7988,lanHost:'192.168.20.2',lanAccess:'paired',pairing});
 const server=createApiServer({token:'a'.repeat(64),telemetry:new Map(),commands:{},store:r.store,localBrowser,settings:new PrinterSettings({registry:r,discovery:new PrinterDiscovery()})});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();server.close();});
 const base=`http://127.0.0.1:${server.address().port}`,headers={Host:'192.168.20.2:7988',Origin:'http://192.168.20.2:7988','Content-Type':'application/json'};
 const session=await http(base,'/api/session',{method:'POST',headers,body:{code}}); assert.equal(session.status,200);
 Object.assign(headers,{Cookie:session.headers['set-cookie'][0].split(';')[0],'X-Print-CSRF':session.data.csrf});
 assert.equal((await http(base,'/api/v1/settings/printers/save',{method:'POST',headers,body:{printer:profile(),baseVersion:1}})).status,200);
 assert.equal(r.printers.length,1);
});
