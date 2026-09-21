import { getPrinterJson } from './http.mjs';

const query = '/printer/objects/query?print_stats&virtual_sdcard&display_status&extruder&heater_bed&pause_resume&webhooks';

async function pollMoonraker(config, telemetry, timeoutMs) {
  await Promise.all([
    (async () => {
      try {
        const json = await getPrinterJson(config, '/server/info', timeoutMs);
        if (!telemetry.updateMoonrakerInfo(json.result)) throw new Error('Missing Klipper state');
      } catch (error) { telemetry.fail('info', error.message); }
    })(),
    (async () => {
      try {
        const json = await getPrinterJson(config, query + (config.vendor ? '&box&filament_rack' : ''), timeoutMs);
        if (!telemetry.updateMoonraker(json.result?.status)) throw new Error('Missing printer objects');
      } catch (error) { telemetry.fail('moonraker', error.message); }
    })(),
  ]);
}

function pollVendor(config, telemetry, timeoutMs) {
  return new Promise(resolve => {
    let socket;
    let finished = false;
    let gotState = false;
    let gotCfs = false;
    const finish = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) {
        if (!gotState) telemetry.fail('vendor', error);
        if (!gotCfs) telemetry.fail('cfs', error);
      }
      try { socket?.close(); } catch { /* The handshake may not have completed. */ }
      resolve();
    };
    const timer = setTimeout(() => finish('Timed out waiting for current printer data'), timeoutMs);
    try { socket = new WebSocket(config.vendor); } catch { finish('WebSocket connection failed'); return; }
    socket.addEventListener('open', () => {
      if (!finished) socket.send(JSON.stringify({ method: 'get', params: { boxsInfo: 1 } }));
    });
    socket.addEventListener('message', event => {
      if (finished) return;
      try {
        if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 262_144) return finish('Invalid or oversized printer message');
        const message = JSON.parse(event.data);
        telemetry.updateVendor(message);
        gotState ||= Number.isFinite(message.state) && Number.isFinite(message.deviceState);
        gotCfs ||= Array.isArray(message.boxsInfo?.materialBoxs);
        if (gotState && gotCfs) finish();
      } catch { finish('Malformed printer message'); }
    });
    socket.addEventListener('error', () => finish('WebSocket connection failed'));
    socket.addEventListener('close', () => finish('WebSocket closed before a full refresh'));
  });
}

export async function pollPrinter(config, telemetry, { timeoutMs = 5000 } = {}) {
  const work = [pollMoonraker(config, telemetry, timeoutMs)];
  if (config.vendor) work.push(pollVendor(config, telemetry, timeoutMs));
  await Promise.allSettled(work);
}

export class Collectors {
  constructor(printers, telemetry, { concurrency = 8, intervalMs = 10000, poll = pollPrinter, now = Date.now } = {}) {
    this.printers = printers; this.telemetry = telemetry; this.concurrency = concurrency; this.intervalMs = intervalMs;
    this.poll = poll; this.now = now; this.active = new Map(); this.due = new Map(); this.closed = false;
  }
  start() { this.tick(); this.timer = setInterval(() => this.tick(), 250); }
  update(printers) {
    const old = new Map(this.printers.map(p => [p.id, p]));
    this.printers = printers;
    const keep = new Set(printers.map(p => p.id));
    for (const id of this.due.keys()) if (!keep.has(id)) this.due.delete(id);
    for (const p of printers) if (JSON.stringify(old.get(p.id)) !== JSON.stringify(p)) this.due.set(p.id, 0);
  }
  tick() {
    if (this.closed) return;
    const now = this.now();
    const ready = this.printers.filter(p => !this.active.has(p.id) && (this.due.get(p.id) ?? 0) <= now)
      .sort((a, b) => (this.due.get(a.id) ?? 0) - (this.due.get(b.id) ?? 0));
    for (const printer of ready.slice(0, Math.max(0, this.concurrency - this.active.size))) {
      const sample = this.telemetry.get(printer.id);
      if (!sample) continue;
      this.due.set(printer.id, now + this.intervalMs);
      const work = Promise.resolve().then(() => this.poll(printer, sample));
      this.active.set(printer.id, work);
      work.finally(() => { this.active.delete(printer.id); this.tick(); }).catch(() => {});
    }
  }
  async close() { this.closed = true; clearInterval(this.timer); await Promise.allSettled(this.active.values()); }
}
