import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { LocalBrowser, BrowserPairing } from '../src/local-browser.mjs';
import { createApiServer } from '../src/server.mjs';
import { Store } from '../src/store.mjs';

const localHost = '127.0.0.1:7988', lanHost = '192.168.250.30:7988';
const send = (base, host, path, { cookie, csrf, body, origin = `http://${host}`, method = 'POST', headers = {} } = {}) => new Promise((resolve, reject) => {
  const req = request(base + path, { method, headers: { Host: host, Origin: origin, ...(cookie ? { Cookie: cookie } : {}),
    ...(csrf ? { 'X-Print-CSRF': csrf } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers } }, res => {
    let text = ''; res.on('data', c => text += c); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(text), cookie: res.headers['set-cookie']?.[0].split(';')[0] }));
  });
  req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
});
async function setup(t, lanAccess = 'paired') {
  const store = new Store(':memory:'), pairing = new BrowserPairing();
  const common = { token: 'a'.repeat(64), store, telemetry: new Map(), controlsEnabled: false };
  const local = createApiServer({ ...common, localBrowser: new LocalBrowser({ pairing, lanHost: '192.168.250.30', lanAccess }) });
  const lanBrowser = new LocalBrowser({ pairing, lanHost: '192.168.250.30', access: 'lan', lanAccess });
  const lan = createApiServer({ ...common, allowBearer: false, localBrowser: lanBrowser });
  const servers = [local, lan];
  for (const s of servers) await new Promise(r => s.listen(0, '127.0.0.1', r));
  t.after(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } store.close(); });
  const [localBase, lanBase] = servers.map(s => `http://127.0.0.1:${s.address().port}`);
  const session = await send(localBase, localHost, '/api/session');
  const create = () => send(localBase, localHost, '/api/pairing/create', { cookie: session.cookie, csrf: session.data.csrf });
  return { pairing, localBase, lanBase, create, lanBrowser };
}
test('open home LAN needs no pairing, retains write verification and renews after restart', async t => {
  const { lanBase, create, lanBrowser } = await setup(t, 'open');
  const read = await send(lanBase, lanHost, '/api/v1/fleet', { method: 'GET' });
  assert.equal(read.status, 200); assert.equal(read.data.controlsEnabled, false);
  const first = await send(lanBase, lanHost, '/api/session');
  assert.equal(first.status, 200); assert.equal(first.data.pairingRequired, false);
  assert.equal((await create()).status, 403);
  const write = { cookie: first.cookie, body: { id: 'home-lan-monitor', target: 'left', action: 'pause' } };
  assert.equal((await send(lanBase, lanHost, '/api/v1/actions', write)).status, 403);
  assert.equal((await send(lanBase, lanHost, '/api/v1/actions', { ...write, csrf: first.data.csrf })).status, 409);
  lanBrowser.sessions.clear();
  assert.equal((await send(lanBase, lanHost, '/api/v1/fleet', { method: 'GET', cookie: first.cookie })).status, 401);
  const renewed = await send(lanBase, lanHost, '/api/session', { cookie: first.cookie });
  assert.equal(renewed.status, 200); assert.notEqual(renewed.cookie, first.cookie);
  assert.equal(renewed.data.pairingRequired, false);
});
test('open LAN still rejects cross-site requests, forged hosts and sessionless writes', async t => {
  const { lanBase } = await setup(t, 'open');
  assert.equal((await send(lanBase, localHost, '/api/session')).status, 403);
  assert.equal((await send(lanBase, lanHost, '/api/session', { origin: 'http://evil.example' })).status, 403);
  assert.equal((await send(lanBase, lanHost, '/api/v1/fleet', { method: 'GET', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await send(lanBase, lanHost, '/api/v1/actions', { body: { id: 'no-session', target: 'left', action: 'pause' } })).status, 401);
  assert.throws(() => new LocalBrowser({ lanAccess: 'typo' }), /Invalid/);
});
test('LAN listener rejects forged localhost, bearer access and unpaired browsers', async t => {
  const { lanBase } = await setup(t);
  assert.equal((await send(lanBase, localHost, '/api/session')).status, 403);
  const locked = await send(lanBase, lanHost, '/api/session', { body: {} });
  assert.equal(locked.status, 401); assert.equal(locked.data.pairingRequired, true);
  assert.equal((await send(lanBase, lanHost, '/api/v1/fleet', { method: 'GET', headers: { Authorization: `Bearer ${'a'.repeat(64)}` } })).status, 401);
});
test('local CSRF protected pairing grants one LAN session, never grants another or enables controls', async t => {
  const { localBase, lanBase, create } = await setup(t);
  assert.equal((await send(localBase, localHost, '/api/pairing/create')).status, 401);
  const minted = await create(); assert.equal(minted.status, 200); assert.match(minted.data.code, /^\d{8}$/);
  const paired = await send(lanBase, lanHost, '/api/session', { body: { code: minted.data.code } });
  assert.equal(paired.status, 200); assert.equal(paired.data.access, 'lan');
  assert.equal((await send(lanBase, lanHost, '/api/session', { body: { code: minted.data.code } })).status, 401);
  const again = await send(lanBase, lanHost, '/api/session', { cookie: paired.cookie, body: {} });
  assert.equal(again.data.csrf, paired.data.csrf);
  const read = await send(lanBase, lanHost, '/api/v1/fleet', { method: 'GET', cookie: paired.cookie });
  assert.equal(read.status, 200); assert.equal(read.data.controlsEnabled, false);
  assert.equal((await send(lanBase, lanHost, '/api/pairing/create', { cookie: paired.cookie, csrf: paired.data.csrf })).status, 403);
  const write = { cookie: paired.cookie, body: { id: 'lan-no-controls', target: 'left', action: 'pause' } };
  assert.equal((await send(lanBase, lanHost, '/api/v1/actions', write)).status, 403);
  assert.equal((await send(lanBase, lanHost, '/api/v1/actions', { ...write, csrf: paired.data.csrf })).status, 409);
  assert.equal((await send(lanBase, lanHost, '/api/v1/fleet', { cookie: paired.cookie, method: 'GET', origin: 'http://evil.example' })).status, 403);
});
test('pair codes expire, limit guesses and invalidate when replaced', () => {
  let now = 1000;
  const pairing = new BrowserPairing({ now: () => now, ttlMs: 100, maxAttempts: 3 });
  let first = pairing.create(); now += 101; assert.equal(pairing.consume(first.code), false);
  first = pairing.create(); const replacement = pairing.create();
  assert.notEqual(first.code, replacement.code); assert.equal(pairing.consume(first.code), false);
  assert.equal(pairing.consume('wrong'), false); assert.equal(pairing.consume('wrong'), false);
  assert.equal(pairing.consume(replacement.code), false);
  const next = pairing.create(); assert.equal(pairing.consume(next.code), true); assert.equal(pairing.consume(next.code), false);
});
test('LAN pairing checks same origin before consuming a code and bounds malformed input', async t => {
  const { lanBase, create } = await setup(t); const { data } = await create();
  assert.equal((await send(lanBase, lanHost, '/api/session', { body: { code: data.code }, origin: 'http://evil.example' })).status, 403);
  assert.equal((await send(lanBase, lanHost, '/api/session', { body: { code: 'a'.repeat(2500) }, headers: { 'Content-Length': '2511' } })).status, 413);
  assert.equal((await send(lanBase, lanHost, '/api/session', { body: { code: data.code } })).status, 200);
});
