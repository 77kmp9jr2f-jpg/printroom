import { randomUUID } from 'node:crypto';
import { privateHost, port } from './config.mjs';
import { readJsonBody } from './http.mjs';
import { CommandError } from './commands.mjs';

export function subnetHosts(cidr) {
  if (typeof cidr !== 'string') throw new CommandError('Enter a private IPv4 subnet, /24 or smaller');
  const [host, prefixText, extra] = cidr.trim().split('/'), prefix = Number(prefixText);
  if (extra || !privateHost(host) || host.startsWith('127.') || !/^\d{2}$/.test(prefixText ?? '') || prefix < 24 || prefix > 32) throw new CommandError('Use a private IPv4 subnet from /24 through /32 (at most 256 addresses)');
  const value = host.split('.').reduce((n, v) => n * 256 + Number(v), 0), size = 2 ** (32 - prefix), base = Math.floor(value / size) * size;
  const address = n => [24, 16, 8, 0].map(shift => (n >>> shift) & 255).join('.');
  return Array.from({ length: size }, (_, i) => address(base + i)).filter((_, i) => prefix >= 31 || i > 0 && i < size - 1);
}
export async function probeMoonraker({ host, moonrakerPort = 7125, apiKey = '' }, { signal, timeoutMs = 1800 } = {}) {
  if (!privateHost(host)) throw new CommandError('Use a private IPv4 printer address');
  try { port(moonrakerPort); } catch (e) { throw new CommandError(e.message); }
  const result = { host, moonrakerPort };
  try {
    const response = await fetch(`http://${host}:${moonrakerPort}/server/info`, { method: 'GET', redirect: 'error',
      headers: apiKey ? { 'X-Api-Key': apiKey } : {}, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    if ([401, 403].includes(response.status)) { await response.body?.cancel(); return { ...result, status: 'authentication_required', detail: 'Authentication required; service identity is not yet verified.' }; }
    if (!response.ok) { await response.body?.cancel(); return { ...result, status: 'not_moonraker', detail: `HTTP ${response.status}; Moonraker was not identified.` }; }
    const info = (await readJsonBody(response.body, 65536))?.result;
    if (!info || typeof info.klippy_state !== 'string' || typeof info.klippy_connected !== 'boolean' || !(typeof info.moonraker_version === 'string' || Array.isArray(info.components))) return { ...result, status: 'not_moonraker', detail: 'Response does not identify a Moonraker server.' };
    return { ...result, status: 'moonraker', version: String(info.moonraker_version ?? 'unknown').slice(0, 100), klippyState: info.klippy_state.slice(0, 50),
      detail: info.klippy_connected ? 'Moonraker found; Klipper is connected.' : 'Moonraker found; Klipper is disconnected.' };
  } catch { return { ...result, status: signal?.aborted ? 'cancelled' : 'unreachable', detail: 'No valid response within the connection timeout.' }; }
}
export class PrinterDiscovery {
  constructor({ probe = probeMoonraker, concurrency = 8 } = {}) { this.probe = probe; this.concurrency = concurrency; this.job = null; this.closed = false; }
  start({ subnet, moonrakerPort = 7125 }) {
    if (this.closed) throw new CommandError('Discovery is stopping', 503);
    if (this.job?.status === 'running') throw new CommandError('A discovery scan is already running', 409);
    let checkedPort; try { checkedPort = port(moonrakerPort, 7125); } catch (e) { throw new CommandError(e.message); }
    const hosts = subnetHosts(subnet), controller = new AbortController();
    const job = this.job = { id: randomUUID(), subnet, moonrakerPort: checkedPort, total: hosts.length, completed: 0, status: 'running', results: [], controller };
    let cursor = 0;
    const worker = async () => {
      while (!controller.signal.aborted && cursor < hosts.length) {
        const host = hosts[cursor++];
        try {
          const result = await this.probe({ host, moonrakerPort: checkedPort }, { signal: controller.signal });
          if (!controller.signal.aborted && ['moonraker', 'authentication_required'].includes(result.status)) job.results.push(result);
        } catch { /* One failed host cannot stop the scan. */ }
        job.completed++;
      }
    };
    job.work = Promise.all(Array.from({ length: Math.min(this.concurrency, hosts.length) }, worker)).then(() => { job.status = controller.signal.aborted ? 'cancelled' : 'complete'; });
    return this.snapshot();
  }
  snapshot() {
    if (!this.job) return null;
    const { controller, work, ...job } = this.job;
    return { ...job, results: [...job.results].sort((a, b) => a.host.localeCompare(b.host, undefined, { numeric: true })) };
  }
  cancel() { this.job?.controller.abort(); return this.snapshot(); }
  async close() { this.closed = true; this.cancel(); await this.job?.work; }
}
