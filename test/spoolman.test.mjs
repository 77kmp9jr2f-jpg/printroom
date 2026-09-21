import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { SpoolmanClient } from '../src/spoolman.mjs';

async function server(t, handler) {
  const s = createServer(handler); await new Promise(r => s.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { s.close(r); s.closeAllConnections(); }));
  return new SpoolmanClient({ host: '127.0.0.1', port: s.address().port, timeoutMs: 100 });
}
test('Spoolman uses fixed API paths and matches whole marker lines while finding an uncertain spool', async t => {
  const urls = [];
  const c = await server(t, (req, res) => {
    urls.push(req.url); res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url.startsWith('/api/v1/spool?') ? [{ id: 1, comment: 'unrelated [marker]' }, { id: 2, comment: '[marker]\nPhysical spool reference: one' }] : { id: 2, archived: false }));
  });
  assert.equal((await c.getSpool(2)).id, 2);
  assert.deepEqual((await c.findCreated('spool', '[marker]')).map(v => v.id), [2]);
  assert.match(urls[1], /allow_archived=true/);
  await assert.rejects(c.getSpool('../vendor'), /id/i);
  await assert.rejects(c.create('http://example.com', {}), /kind/i);
});
test('Spoolman rejects redirects and oversized responses and bounds stalled requests', async t => {
  let mode = 'redirect'; let requests = 0;
  const c = await server(t, (req, res) => {
    requests++;
    if (mode === 'redirect') { res.writeHead(302, { Location: 'http://example.com' }); res.end(); }
    else if (mode === 'oversized') res.end(JSON.stringify({ x: 'a'.repeat(300000) }));
  });
  await assert.rejects(c.getSpool(1)); mode = 'oversized'; await assert.rejects(c.getSpool(1));
  mode = 'stalled'; const start = Date.now(); await assert.rejects(c.getSpool(1)); assert.ok(Date.now() - start < 1000);
  assert.equal(requests, 3);
});
test('Spoolman create sends only JSON to the requested inventory collection', async t => {
  const received = [];
  const c = await server(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received.push({ path: req.url, method: req.method, body: JSON.parse(body) });
    res.setHeader('Content-Type', 'application/json'); res.end('{"id":17}');
  });
  assert.equal((await c.create('spool', { filament_id: 5, remaining_weight: 670 })).id, 17);
  assert.deepEqual(received, [{ path: '/api/v1/spool', method: 'POST', body: { filament_id: 5, remaining_weight: 670 } }]);
});
