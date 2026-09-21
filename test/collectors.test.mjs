import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { readFileSync } from 'node:fs';
import { pollPrinter } from '../src/collectors.mjs';
import { PrinterTelemetry } from '../src/telemetry.mjs';

const fixture = JSON.parse(readFileSync(new URL('fixtures/right.json', import.meta.url)));
async function simulator(t, { quiet = false, failMotion = false } = {}) {
  const paths = [];
  const server = createServer((req, res) => {
    paths.push([req.method, req.url]);
    if (req.url === '/server/info') return res.end('{"result":{"klippy_state":"ready","klippy_connected":true}}');
    if (failMotion) { res.statusCode = 503; return res.end('{}'); }
    res.end(JSON.stringify({ result: { status: fixture.moonraker } }));
  });
  const ws = new WebSocketServer({ server });
  ws.on('connection', socket => {
    socket.send(JSON.stringify(quiet ? { connectionCount: 8 } : fixture.vendor[0]));
    socket.on('message', data => {
      const request = JSON.parse(data);
      assert.deepEqual(request, { method: 'get', params: { boxsInfo: 1 } });
      socket.send(JSON.stringify(quiet ? { connectionCount: 9 } : fixture.vendor.find(m => m.boxsInfo)));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { for (const client of ws.clients) client.terminate(); ws.close(); server.closeAllConnections(); server.close(); });
  const base = `127.0.0.1:${server.address().port}`;
  return { config: { id: 'right', name: 'Right', moonraker: `http://${base}`, vendor: `ws://${base}` }, paths };
}

test('collector obtains real HTTP and WebSocket data with only read operations', async t => {
  const { config, paths } = await simulator(t);
  const telemetry = new PrinterTelemetry(config);
  await pollPrinter(config, telemetry, { timeoutMs: 200 });
  const result = telemetry.snapshot();
  assert.equal(result.phase, 'preparing');
  assert.equal(result.sources.cfs.state, 'fresh');
  assert.equal(result.cfs[0].slots[1].color, null);
  assert.equal(paths.length, 2);
  assert.ok(paths.every(([method]) => method === 'GET'));
});

test('quiet connected WebSocket times out without claiming data freshness', async t => {
  const { config } = await simulator(t, { quiet: true });
  const telemetry = new PrinterTelemetry(config);
  await pollPrinter(config, telemetry, { timeoutMs: 40 });
  const result = telemetry.snapshot();
  assert.equal(result.sources.moonraker.state, 'fresh');
  assert.equal(result.sources.cfs.state, 'unavailable');
  assert.equal(result.sources.vendor.state, 'unavailable');
  assert.ok(result.sources.cfs.error);
});

test('Moonraker-only printers skip the vendor socket', async t => {
  const { config, paths } = await simulator(t);
  const telemetry = new PrinterTelemetry({ ...config, vendor: null });
  await pollPrinter({ ...config, vendor: null }, telemetry, { timeoutMs: 200 });
  const result = telemetry.snapshot();
  assert.equal(result.sources.moonraker.state, 'fresh');
  assert.equal(result.sources.vendor.state, 'unavailable');
  assert.equal(result.sources.vendor.error, null);
  assert.equal(result.sources.cfs.state, 'unavailable');
  assert.equal(paths.length, 2);
});

test('motion failure preserves previous values and does not suppress fresh CFS', async t => {
  const { config } = await simulator(t, { failMotion: true });
  const telemetry = new PrinterTelemetry(config);
  telemetry.updateMoonraker(fixture.moonraker, Date.now() - 16_000);
  await pollPrinter(config, telemetry, { timeoutMs: 200 });
  const result = telemetry.snapshot();
  assert.equal(result.sources.moonraker.state, 'stale');
  assert.equal(result.sources.cfs.state, 'fresh');
  assert.equal(result.phase, 'preparing');
  assert.ok(result.sources.moonraker.error);
});
