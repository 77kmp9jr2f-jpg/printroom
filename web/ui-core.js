export function requestId(crypto = globalThis.crypto) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function sourceState(source, now = Date.now()) {
  if (!Number.isFinite(source?.observedAt)) return 'unavailable';
  const age = Math.max(0, now - source.observedAt);
  return age >= 30000 ? 'disconnected' : age >= 15000 ? 'stale' : source.error ? 'error' : 'fresh';
}
const unresolved = new Set(['requested', 'acknowledged', 'outcome_unknown']);
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(id);
const statuses = new Set(['requested', 'acknowledged', 'outcome_unknown', 'shutdown_observed', 'state_observed', 'failed', 'operator_resolved']);
const validTargets = (r, expected) => Array.isArray(r?.targets) && r.targets.length > 0 &&
  r.targets.every(t => typeof t.printerId === 'string' && statuses.has(t.status)) &&
  new Set(r.targets.map(t => t.printerId)).size === r.targets.length &&
  expected.length === r.targets.length && r.targets.every(t => expected.includes(t.printerId));
export class ControlClient {
  constructor({ storage, api, printerIds = [] }) {
    this.storage = storage; this.api = api; this.key = 'print-room-actions-v1';
    this.local = new Map(); this.remote = new Map(); this.pending = new Map(); this.storageWarning = null;
    this.printerIds = printerIds;
    try {
      const saved = JSON.parse(storage.getItem(this.key) ?? '[]');
      if (!Array.isArray(saved)) throw new Error('Invalid journal');
      for (const r of saved) if (validId(r.id)) this.local.set(r.id, { ...r, transport: r.transport === 'submitting' ? 'outcome_unknown' : r.transport });
    } catch { this.storageWarning = 'Saved browser action history is unavailable. Server audit remains authoritative.'; }
  }
  save(record) {
    this.local.set(record.id, record);
    const entries = [...this.local.values()];
    if (entries.length > 128) for (const r of entries) {
      if (this.local.size <= 128) break;
      if (r.transport === 'rejected' || r.server?.targets.every(t => !unresolved.has(t.status))) this.local.delete(r.id);
    }
    try { this.storage.setItem(this.key, JSON.stringify([...this.local.values()])); return true; }
    catch { this.storageWarning = 'Browser could not persist this action ID. Keep this page open and check the server audit.'; return false; }
  }
  blocked(printerId) {
    return this.records().some(r => r.server ? r.server.targets.some(t => t.printerId === printerId && unresolved.has(t.status)) :
      (r.target === printerId || r.target === 'all') && ['submitting', 'accepted', 'outcome_unknown'].includes(r.transport));
  }
  async send(target, action, expectedJobId) {
    const key = `${target}:${action}`;
    if (this.pending.has(key)) return this.pending.get(key);
    if (action !== 'emergency_stop' && this.blocked(target)) throw new Error('Resolve the pending or uncertain action before another routine command.');
    const expectedTargets = target === 'all' ? [...this.printerIds] : [target];
    if (!expectedTargets.length) throw new Error('Wait for the printer list before sending a fleet command.');
    const record = { id: requestId(), target, action, expectedTargets, expectedJobId, createdAt: Date.now(), transport: 'submitting', error: null };
    const persisted = this.save(record);
    if (!persisted && action !== 'emergency_stop') {
      record.transport = 'rejected'; record.error = 'Browser storage unavailable; command was not sent.'; this.save(record); throw new Error(record.error);
    }
    const work = (async () => {
      try {
        const result = await this.api('/api/v1/actions', { id: record.id, target, action, expectedJobId });
        if (result.id !== record.id || result.target !== target || result.action !== action || !validTargets(result, expectedTargets)) throw new Error('Command acknowledgment did not match the saved request.');
        record.transport = 'accepted'; record.server = result;
      } catch (error) {
        record.transport = [400, 401, 403, 404, 405, 409, 413, 415, 422].includes(error.status) ? 'rejected' : 'outcome_unknown';
        record.error = error.message || 'The response was lost. Check the printer and saved request.';
      }
      this.save(record); return record;
    })();
    this.pending.set(key, work);
    try { return await work; } finally { this.pending.delete(key); }
  }
  adopt(records) {
    for (const record of records) {
      if (!validId(record?.id)) continue;
      const local = this.local.get(record.id);
      // Server history binds the fleet membership at dispatch, not today's configured fleet.
      const expected = local?.expectedTargets ?? (record.target === 'all' ? (record.targets ?? []).map(t => t.printerId) : [record.target]);
      if (!validTargets(record, expected)) continue;
      if (local && (local.target !== record.target || local.action !== record.action)) continue;
      this.remote.set(record.id, record);
      if (local) this.save({ ...local, server: record, transport: 'accepted', error: null });
    }
  }
  async refresh() {
    const result = await this.api('/api/v1/actions');
    this.adopt(result.actions);
    const recent = new Set(result.actions.map(r => r.id));
    for (const r of this.records()) if (!recent.has(r.id) && r.transport !== 'rejected' &&
      (!r.server || r.server.targets.some(t => unresolved.has(t.status)))) {
      try { this.adopt([await this.api(`/api/v1/actions/${r.id}`)]); } catch { /* Retain uncertainty; never resend. */ }
    }
  }
  records() {
    const records = new Map(this.local);
    for (const [id, server] of this.remote) records.set(id, { ...(records.get(id) ?? server), server, transport: 'accepted' });
    return [...records.values()].sort((a, b) => b.createdAt - a.createdAt);
  }
}
