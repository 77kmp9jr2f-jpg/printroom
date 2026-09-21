import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { CameraProxy } from '../src/camera-proxy.mjs';

test('camera signaling can only consume a configured video stream', async t => {
  const calls = [];
  const relay = createServer(async (req, res) => { let body = ''; for await (const c of req) body += c;
    calls.push({ url: req.url, body: JSON.parse(body) }); res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ type: 'answer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendonly\r\n' })); });
  await new Promise(r => relay.listen(0, '127.0.0.1', r));
  t.after(() => { relay.closeAllConnections(); relay.close(); });
  const proxy = new CameraProxy({ base: `http://127.0.0.1:${relay.address().port}`, printerIds: ['left'] });
  const offer = { type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\n' };
  assert.equal((await proxy.offer('left', offer)).type, 'answer');
  assert.equal(calls[0].url, '/api/webrtc?src=left');
  for (const invalid of [{ ...offer, type: 'answer' }, { ...offer, sdp: offer.sdp.replace('recvonly', 'sendrecv') }, { ...offer, sdp: offer.sdp + 'm=audio 9 RTP/AVP 0\r\n' }]) {
    await assert.rejects(proxy.offer('left', invalid));
  }
  await assert.rejects(proxy.offer('http://evil.test', offer));
  for (const direction of ['sendonly:x', 'sendrecv:', 'recvonly:x', 'inactive']) {
    await assert.rejects(proxy.offer('left', { ...offer, sdp: 'v=0\r\na=recvonly\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=' + direction + '\r\n' }));
  }
  await assert.rejects(proxy.offer('left', { ...offer, sdp: 'v=0\r\na=recvonly\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n' }));
  assert.equal(calls.length, 1);
});

test('dynamic cameras register in memory before the pinned relay accepts an offer', async t => {
  const streams = new Map(), calls = [];
  let duringOffer = () => {};
  const relay = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://relay'); calls.push(req.method);
    if (req.method === 'PATCH' && url.pathname === '/api/streams') {
      streams.set(url.searchParams.get('name'), url.searchParams.get('src'));
      res.end(); return;
    }
    // Mirrors go2rtc 1.9.14 outputWebRTC: no automatic URL registration.
    if (!streams.has(url.searchParams.get('src'))) { res.writeHead(404).end(); return; }
    duringOffer();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ type: 'answer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=sendonly\r\n' }));
  });
  await new Promise(r => relay.listen(0, '127.0.0.1', r));
  t.after(() => { relay.closeAllConnections(); relay.close(); });
  const cameraSource = 'webrtc:http://192.168.250.11:8000/call/webrtc_local#format=creality';
  const proxy = new CameraProxy({ base: `http://127.0.0.1:${relay.address().port}`, printers: [{ id: 'bench', cameraSource }] });
  const offer = { type: 'offer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=recvonly\r\n' };
  assert.equal((await proxy.offer('bench', offer)).type, 'answer');
  assert.deepEqual(calls, ['PATCH', 'POST']);
  assert.deepEqual([...streams.values()], [cameraSource]);
  streams.clear(); // Registration is restored after a relay restart.
  assert.equal((await proxy.offer('bench', offer)).type, 'answer');
  duringOffer = () => proxy.update([]);
  await assert.rejects(proxy.offer('bench', offer), /signaling is unavailable/);
  assert.equal(streams.size, 1);
});
