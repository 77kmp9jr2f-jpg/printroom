import { createHash } from 'node:crypto';
import { CommandError } from './commands.mjs';
import { readJsonBody } from './http.mjs';
export class CameraProxy {
  constructor({ base, printerIds = [], printers }) { this.base = base; this.sources = new Map(printerIds.map(id => [id, id])); if (printers) this.update(printers); }
  update(printers) { this.sources = new Map(printers.filter(p => p.cameraSource).map(p => [p.id, p.cameraSource])); }
  async offer(printerId, body) {
    const source = this.sources.get(printerId);
    if (!source) throw new CommandError('Camera is not configured', 404);
    if (body?.type !== 'offer' || typeof body.sdp !== 'string' || body.sdp.length > 32768 || !body.sdp.startsWith('v=0\r\n')) throw new CommandError('Invalid video offer');
    const lines = body.sdp.split('\r\n'); const media = lines.filter(l => l.startsWith('m='));
    const direction = lines.filter(l => /^a=(recvonly|sendrecv|sendonly|inactive)(?:[:\s]|$)/.test(l));
    // Restrict the browser SDP subset before go2rtc interprets producer direction.
    // Exactly one media-level direction; no session inheritance or valued variants.
    if (lines.some(l => /[\r\n\0]/.test(l)) || media.length !== 1 || !media[0].startsWith('m=video ') ||
        direction.length !== 1 || direction[0] !== 'a=recvonly' || lines.indexOf(direction[0]) < lines.indexOf(media[0])) {
      throw new CommandError('Camera offers must only receive one video stream');
    }
    try {
      let stream = source;
      if (source.startsWith('webrtc:')) {
        // go2rtc 1.9.14's synchronous SDP endpoint only accepts registered names.
        // PATCH creates an in-memory source without writing the read-only YAML.
        // Source-derived names keep old negotiations isolated during retargets.
        stream = `printroom-${createHash('sha256').update(source).digest('hex').slice(0, 24)}`;
        const registration = await fetch(`${this.base}/api/streams?${new URLSearchParams({ name: stream, src: source })}`, {
          method: 'PATCH', redirect: 'error', signal: AbortSignal.timeout(3000),
        });
        await registration.body?.cancel();
        if (!registration.ok) throw new Error('Relay rejected camera source');
      }
      if (this.sources.get(printerId) !== source) throw new Error('Camera configuration changed');
      const response = await fetch(`${this.base}/api/webrtc?src=${encodeURIComponent(stream)}`, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'offer', sdp: body.sdp }), signal: AbortSignal.timeout(8000) });
      if (!response.ok) { await response.body?.cancel(); throw new Error('Relay rejected offer'); }
      const answer = await readJsonBody(response.body, 32768);
      if (answer.type !== 'answer' || typeof answer.sdp !== 'string' || !answer.sdp.startsWith('v=0')) throw new Error('Invalid answer');
      if (this.sources.get(printerId) !== source) throw new Error('Camera configuration changed');
      return { type: 'answer', sdp: answer.sdp };
    } catch { throw new CommandError('Camera signaling is unavailable; printer controls remain independent', 502); }
  }
}
