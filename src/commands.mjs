import { setTimeout as delay } from 'node:timers/promises';
import { readJsonBody } from './http.mjs';

const routes = { emergency_stop: '/printer/emergency_stop', pause: '/printer/print/pause', resume: '/printer/print/resume', cancel: '/printer/print/cancel' };
export class CommandError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export class CommandService {
  constructor({ printers, store, telemetry, timeoutMs = 5000, observationMs = 15_000, pollMs = 200 }) {
    this.printers = new Map(printers.map(p => [p.id, p]));
    this.store = store;
    this.telemetry = telemetry;
    this.timeoutMs = timeoutMs;
    this.observationMs = observationMs;
    this.pollMs = pollMs;
    this.pending = new Map();
    this.closed = false;
    store.recoverInterrupted();
  }

  submit({ id, target, action, actor, expectedJobId }) {
    if (this.closed) throw new CommandError('Service is stopping', 503);
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw new CommandError('Invalid idempotency id');
    if (!Object.hasOwn(routes, action)) throw new CommandError('Unsupported action');
    if (typeof actor !== 'string' || !actor || actor.length > 100) throw new CommandError('Invalid actor');
    const existing = this.store.getAction(id);
    if (existing) {
      if (existing.target !== target || existing.action !== action || existing.actor !== actor || existing.expectedJobId !== expectedJobId) throw new CommandError('Idempotency id is already bound to a different request', 409);
      return existing;
    }
    if (target === 'all' && action !== 'emergency_stop') throw new CommandError('Only emergency stop supports all targets');
    const targets = target === 'all' ? [...this.printers.keys()] : this.printers.has(target) ? [target] : [];
    if (!targets.length) throw new CommandError('Unknown target');
    if (action !== 'emergency_stop') {
      for (const printerId of targets) {
        const snapshot = this.telemetry.get(printerId)?.snapshot();
        if (!snapshot?.controls?.[action]) throw new CommandError('Printer state does not allow this action', 409);
        if (action === 'cancel' && (!expectedJobId || expectedJobId !== snapshot.job?.id)) throw new CommandError('The confirmed job changed. Reload and confirm the current job before cancelling.', 409);
        for (const pending of this.store.unresolvedTargets(printerId)) {
          if (['requested', 'acknowledged'].includes(pending.status)) throw new CommandError('Printer state has a pending action', 409);
          throw new CommandError('Reconcile the uncertain outcome with an explicit operator resolution before another routine action', 409);
        }
      }
    }
    const createdAt = Date.now();
    const record = { id, target, action, actor, expectedJobId, createdAt, targets: targets.map(printerId => ({ printerId, status: 'requested', requestedAt: createdAt, acknowledgedAt: null, observedAt: null, finishedAt: null, detail: null })) };
    this.store.createAction(record);
    // Each target dispatches immediately; a slow/offline peer does not serialize the fleet.
    const work = Promise.all(targets.map(printerId => this.dispatch(record, printerId)));
    this.pending.set(id, work);
    work.finally(() => this.pending.delete(id)).catch(() => {});
    return record;
  }

  async dispatch(record, printerId) {
    const printer = this.printers.get(printerId);
    const update = changes => this.store.updateTarget(record.id, printerId, changes);
    try {
      const response = await fetch(`${printer.moonraker}${routes[record.action]}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: printer.apiKey ? { 'X-Api-Key': printer.apiKey } : {},
      });
      if (!response.ok) {
        await response.body?.cancel();
        const rejected = [400, 401, 403, 404, 405, 409, 422].includes(response.status);
        update({ status: rejected ? 'failed' : 'outcome_unknown', finishedAt: Date.now(), detail: `Printer returned HTTP ${response.status}${rejected ? '; request rejected.' : '; execution outcome is uncertain.'}` });
        return;
      }
      const body = await readJsonBody(response.body);
      if (body.result !== 'ok') {
        update({ status: 'outcome_unknown', finishedAt: Date.now(), detail: 'Printer response did not contain the expected acknowledgment.' });
        return;
      }
      update({ status: 'acknowledged', acknowledgedAt: Date.now(), detail: 'Request acknowledged; waiting for a fresh printer-state observation.' });
      const deadline = Date.now() + this.observationMs;
      while (Date.now() <= deadline && !this.closed) {
        const snapshot = this.telemetry.get(printerId)?.snapshot();
        const sampleAt = record.action === 'emergency_stop' ? snapshot?.shutdownObservedAt : snapshot?.sources?.moonraker?.observedAt;
        const expected = { emergency_stop: 'shutdown', pause: 'paused', resume: 'printing', cancel: 'cancelled' }[record.action];
        if (sampleAt > record.createdAt && snapshot.phase === expected) {
          update({ status: record.action === 'emergency_stop' ? 'shutdown_observed' : 'state_observed', observedAt: sampleAt, finishedAt: Date.now(), detail: `New printer telemetry reports ${expected}.` });
          return;
        }
        await delay(this.pollMs);
      }
      update({ status: 'outcome_unknown', finishedAt: Date.now(), detail: 'Acknowledged, but expected printer state was not observed. Check the printer before retrying.' });
    } catch {
      update({ status: 'outcome_unknown', finishedAt: Date.now(), detail: 'No conclusive response. The request may have executed; it will not be replayed automatically.' });
    }
  }

  get(id) { return this.store.getAction(id); }
  resolveMissing({ id, target, action, actor, expectedJobId, confirmed, note }) {
    if (confirmed !== true || typeof note !== 'string' || note.trim().length < 10 || note.length > 1000) throw new CommandError('Confirm the physical printer and pending-command state with an operator note');
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(id) || !Object.hasOwn(routes, action) || typeof actor !== 'string' || !actor || actor.length > 100) throw new CommandError('Invalid missing request identity');
    if (this.get(id)) throw new CommandError('This request is recorded on the server. Refresh and resolve its target outcomes.', 409);
    const ids = target === 'all' && action === 'emergency_stop' ? [...this.printers.keys()] : this.printers.has(target) ? [target] : [];
    if (!ids.length) throw new CommandError('Unknown target');
    const now = Date.now();
    return this.store.createAction({ id, target, action, actor, expectedJobId, createdAt: now, targets: ids.map(printerId => ({
      printerId, status: 'operator_resolved', requestedAt: null, acknowledgedAt: null, observedAt: null, finishedAt: now,
      resolvedAt: now, resolvedBy: actor, resolutionNote: note.trim(), detail: 'No server request existed when the operator recorded a physical check. This ID is closed against a delayed original request; no command was dispatched.' })) });
  }
  resolve({ id, printerId, actor, confirmed, note }) {
    if (confirmed !== true || typeof note !== 'string' || note.trim().length < 10 || note.length > 1000) throw new CommandError('Confirm the physical printer and pending-command state with an operator note');
    if (typeof actor !== 'string' || !actor || actor.length > 100) throw new CommandError('Invalid actor');
    const record = this.get(id);
    const target = record?.targets.find(t => t.printerId === printerId);
    if (!target || target.status !== 'outcome_unknown') throw new CommandError('Only an uncertain target outcome can be resolved', 409);
    return this.store.updateTarget(id, printerId, { status: 'operator_resolved', resolvedAt: Date.now(), resolvedBy: actor, resolutionNote: note.trim(), detail: 'Operator resolved the uncertain result after checking the printer. This is not automated verification of the original command.' });
  }
  async settled(id) { await this.pending.get(id); return this.get(id); }
  async close() { this.closed = true; await Promise.allSettled(this.pending.values()); }
}
