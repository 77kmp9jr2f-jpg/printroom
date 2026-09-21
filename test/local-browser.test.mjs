import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createApiServer } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { LocalBrowser } from '../src/local-browser.mjs';

const host = 'localhost:7988'; const origin = `http://${host}`;
// Native HTTP allows deliberate Host-header rebinding probes; fetch normalizes Host.
const fetch = (url, options = {}) => new Promise((resolve, reject) => {
  const req = request(url, { method: options.method ?? 'GET', headers: options.headers }, res => {
    const chunks = []; res.on('data', c => chunks.push(c));
    res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
  });
  req.on('error', reject); req.end(options.body);
});
async function setup(t, { assetDir } = {}) {
  const store = new Store(':memory:'); const calls = [];
  const commands = { submit: body => { calls.push(body); return body; } };
  const localBrowser = new LocalBrowser({ port: 7988, assetDir });
  const server = createApiServer({ token: 'a'.repeat(64), store, telemetry: new Map(), commands, controlsEnabled: true, localBrowser });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => { server.closeAllConnections(); server.close(); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const session = async () => {
    const r = await fetch(base + '/api/session', { method: 'POST', headers: { Host: host, Origin: origin } });
    assert.equal(r.status, 200); return { csrf: (await r.json()).csrf, cookie: r.headers.get('set-cookie').split(';')[0], cookieHeader: r.headers.get('set-cookie') };
  };
  return { base, session, calls };
}
test('localhost browser session uses HttpOnly cookie and never exposes the integration credential', async t => {
  const { base, session } = await setup(t); const s = await session();
  assert.match(s.cookieHeader, /HttpOnly/); assert.match(s.cookieHeader, /SameSite=Strict/);
  assert.equal(s.csrf.includes('a'.repeat(64)), false);
  const r = await fetch(base + '/api/v1/fleet', { headers: { Host: host, Cookie: s.cookie } });
  assert.equal(r.status, 200);
});
test('cross-site and DNS-rebinding attempts cannot establish a browser session or reach data', async t => {
  const { base, session } = await setup(t);
  for (const headers of [{ Host: host, Origin: 'https://evil.example' }, { Host: 'evil.example', Origin: 'http://evil.example' }, { Host: host }]) {
    assert.equal((await fetch(base + '/api/session', { method: 'POST', headers })).status, 403);
  }
  const s = await session();
  assert.equal((await fetch(base + '/api/v1/fleet', { headers: { Host: host, Cookie: s.cookie, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(base + '/api/v1/fleet', { headers: { Host: 'evil.example', Cookie: s.cookie } })).status, 403);
});
test('browser commands require same origin and CSRF and have truthful local actor provenance', async t => {
  const { base, session, calls } = await setup(t); const s = await session();
  const headers = { Host: host, Origin: origin, Cookie: s.cookie, 'Content-Type': 'application/json' };
  const body = JSON.stringify({ id: 'browser-stop-test', target: 'left', action: 'emergency_stop', actor: 'forged' });
  assert.equal((await fetch(base + '/api/v1/actions', { method: 'POST', headers, body })).status, 403);
  headers['X-Print-CSRF'] = s.csrf;
  const r = await fetch(base + '/api/v1/actions', { method: 'POST', headers, body });
  assert.equal(r.status, 202); assert.equal((await r.json()).actor, 'local-browser');
  assert.equal(calls.length, 1);
});
test('opening a second tab keeps the first tab session usable', async t => {
  const { base, session } = await setup(t); const first = await session();
  const second = await fetch(base + '/api/session', { method: 'POST', headers: { Host: host, Origin: origin, Cookie: first.cookie } });
  const data = await second.json();
  assert.equal(data.csrf, first.csrf);
  assert.equal(second.headers.get('set-cookie').split(';')[0], first.cookie);
});
test('versioned dashboard assets load before authentication without relaxing origin checks', async t => {
  const assetDir = fileURLToPath(new URL('../web/', import.meta.url));
  const { base } = await setup(t, { assetDir });
  for (const [name, mime] of [['app.js', 'text/javascript'], ['style.css', 'text/css']]) {
    const path = '/' + name + '?v=hub11';
    const response = await fetch(base + path, { headers: { Host: host } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), new RegExp(mime));
    assert.equal(await response.text(), readFileSync(new URL('../web/' + name, import.meta.url), 'utf8'));
    assert.equal((await fetch(base + path, { headers: { Host: host, Origin: 'https://evil.example' } })).status, 403);
  }
  assert.equal((await fetch(base + '/config/printers.json?v=hub11', { headers: { Host: host } })).status, 401);
});
