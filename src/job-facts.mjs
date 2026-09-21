import { posix } from 'node:path';
import { CommandError } from './commands.mjs';
import { getPrinterJson } from './http.mjs';

function safePath(path) {
  return typeof path === 'string' && path.length > 0 && path.length <= 1024 && !path.startsWith('/') && !path.includes('\\') && !/[\x00-\x1f]/.test(path) && !path.split('/').includes('..');
}
async function readPrefix(config, path, limit, signal, truncate = false) {
  const response = await fetch(`${config.moonraker}/server/files/gcodes/${path.split('/').map(encodeURIComponent).join('/')}`, { redirect: 'error', signal,
    headers: { ...(config.apiKey ? { 'X-Api-Key': config.apiKey } : {}), ...(truncate ? { Range: `bytes=0-${limit-1}` } : {}) } });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Preview unavailable'); }
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      if (size + value.length > limit && !truncate) throw new Error('Preview too large');
      chunks.push(Buffer.from(value.subarray(0, limit - size))); size += Math.min(value.length, limit - size);
      if (size >= limit) { if (!truncate) { const extra = await reader.read(); if (!extra.done) throw new Error('Preview too large'); } break; }
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks);
}
function imageData(bytes) {
  const mime = bytes?.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : bytes?.[0] === 255 && bytes?.[1] === 216 && bytes?.[2] === 255 ? 'image/jpeg' : null;
  return mime ? `data:${mime};base64,${bytes.toString('base64')}` : null;
}
export class JobFacts {
  constructor({ telemetry, limit = 4, timeoutMs = 4000 }) { Object.assign(this, { telemetry, limit, timeoutMs }); this.cache = new Map(); this.pending = new Map(); }
  async get(id) {
    const printer = this.telemetry.get(id); if (!printer) throw new CommandError('Unknown printer',404);
    const snapshot = printer.snapshot(), filename = snapshot.job.filename;
    if (!filename || !safePath(filename)) return { filename: filename ?? null, result: {}, header: '', preview: null };
    const key = JSON.stringify([snapshot.configurationId, snapshot.job.id, filename]);
    for (const [cachedId] of this.cache) if (!this.telemetry.has(cachedId)) this.cache.delete(cachedId);
    const cached = this.cache.get(id); if (cached?.key === key && cached.until > Date.now()) return cached.data;
    if (this.pending.has(key)) return this.pending.get(key);
    if (this.pending.size >= this.limit) throw new CommandError('Job previews are busy. Try again shortly.',503);
    const work = this.load(printer.config, filename).then(data => {
      const current = this.telemetry.get(id)?.snapshot();
      if (this.telemetry.get(id) !== printer || current?.job.filename !== filename || current?.job.id !== snapshot.job.id) throw new CommandError('Printer job changed while loading its preview',409);
      this.cache.set(id, { key, data, until: Date.now() + 60000 }); return data;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, work); return work;
  }
  async load(config, filename) {
    const signal = AbortSignal.timeout(this.timeoutMs);
    const [metadata, prefix] = await Promise.allSettled([
      getPrinterJson(config, `/server/files/metadata?filename=${encodeURIComponent(filename)}`, this.timeoutMs),
      readPrefix(config, filename, 24576, signal, true),
    ]);
    if (metadata.status === 'rejected' && prefix.status === 'rejected') throw new CommandError('Job metadata is unavailable',502);
    const raw = metadata.status === 'fulfilled' ? metadata.value?.result ?? {} : {}, result = {};
    for (const key of ['object_height','layer_height','first_layer_height','nozzle_diameter','filament_total','filament_weight_total','size']) if (Number.isFinite(raw[key]) && raw[key] >= 0) result[key] = raw[key];
    for (const key of ['filament_type','slicer','slicer_version']) if (typeof raw[key] === 'string') result[key] = raw[key].slice(0,160);
    const header = prefix.status === 'fulfilled' ? prefix.value.toString('utf8') : '';
    let preview = null;
    const thumbs = Array.isArray(raw.thumbnails) ? raw.thumbnails.filter(t => t && typeof t.relative_path === 'string').sort((a,b) => (b.width ?? 0) - (a.width ?? 0)) : [];
    const rel = thumbs[0]?.relative_path;
    if (rel && !rel.startsWith('/') && !rel.includes('\\')) {
      const path = posix.normalize(posix.join(posix.dirname(filename), rel));
      if (safePath(path)) { try { preview = imageData(await readPrefix(config, path, 262144, signal)); } catch { /* Header thumbnail remains available. */ } }
    }
    return { filename, result, header, preview };
  }
}
