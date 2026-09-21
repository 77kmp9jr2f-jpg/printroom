import { readJsonBody } from './http.mjs';
import { CommandError } from './commands.mjs';

const kinds = new Set(['vendor', 'filament', 'spool']);
export class SpoolmanClient {
  constructor({ host, port = 7912, timeoutMs = 5000 }) { this.base = `http://${host}:${port}/api/v1`; this.timeoutMs = timeoutMs; }
  async request(path, body) {
    try {
      const res = await fetch(`${this.base}${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
      if (res.status === 404 && body === undefined) { await res.body?.cancel(); return null; }
      if (!res.ok) { await res.body?.cancel(); throw new Error('Inventory request rejected'); }
      return await readJsonBody(res.body);
    } catch { throw new CommandError('Spoolman request did not return a bounded, valid response', 502); }
  }
  async getSpool(id) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new CommandError('Invalid spool id');
    return this.request(`/spool/${id}`);
  }
  async listPage(kind, offset = 0) {
    if (!kinds.has(kind)) throw new CommandError('Invalid inventory kind');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new CommandError('Invalid inventory offset');
    const rows = await this.request(`/${kind}?limit=100&offset=${offset}${kind === 'spool' ? '&allow_archived=true' : ''}`);
    if (!Array.isArray(rows) || rows.length > 100) throw new CommandError('Spoolman returned an invalid inventory page', 502);
    return rows;
  }
  async find(kind, predicate) {
    const matches = [];
    for (let offset = 0; offset < 10000; offset += 100) {
      const rows = await this.listPage(kind, offset); matches.push(...rows.filter(predicate));
      if (rows.length < 100) return matches;
    }
    throw new CommandError('Inventory search exceeded 10,000 records; manual reconciliation is required', 409);
  }
  async findVendor(name) { return this.find('vendor', r => typeof r.name === 'string' && r.name.trim().toLowerCase() === name.toLowerCase()); }
  async findCreated(kind, marker) { return this.find(kind, r => typeof r.comment === 'string' && r.comment.split('\n')[0] === marker); }
  async create(kind, body) {
    if (!kinds.has(kind)) throw new CommandError('Invalid inventory kind');
    return this.request(`/${kind}`, body);
  }
}
