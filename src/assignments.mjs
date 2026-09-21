import { CommandError } from './commands.mjs';

export class AssignmentService {
  constructor(options) { Object.assign(this, options); }
  async assign({ id, printerId, slot, spoolId, confirmed, baseVersion, actor }) {
    if (confirmed !== true) throw new CommandError('Confirm the spool is physically at this location');
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(id)) throw new CommandError('Invalid assignment id');
    if (typeof actor !== 'string' || !actor || actor.length > 100) throw new CommandError('Invalid actor');
    if (!this.telemetry.has(printerId) || typeof slot !== 'string' || !/^T[1-4][ABCD]$/.test(slot)) throw new CommandError('Unknown printer or CFS slot');
    if (spoolId !== null && (!Number.isSafeInteger(spoolId) || spoolId <= 0)) throw new CommandError('Select a real Spoolman spool id');
    const originalPrinter = this.telemetry.get(printerId), originalSpoolman = this.spoolman;
    const request = { printerId, slot, spoolId, actor };
    const checkExisting = () => {
      const existing = this.store.assignmentEvent(id);
      if (existing && JSON.stringify(existing.event.request) !== JSON.stringify(request)) throw new CommandError('Assignment id is already bound to a different request', 409);
      return existing;
    };
    const previous = checkExisting();
    if (previous) return previous;
    if (baseVersion !== this.current().version) throw new CommandError('Assignment version conflict; reload locations before moving a spool', 409);
    if (spoolId !== null) {
      if (!this.spoolman) throw new CommandError('Spoolman is not configured', 503);
      const spool = await this.spoolman.getSpool(spoolId);
      if (!spool || spool.id !== spoolId || spool.archived) throw new CommandError('Spoolman spool does not exist or is archived');
    }
    if (this.spoolman !== originalSpoolman) throw new CommandError('Spoolman connection changed during this assignment. Reload and confirm the spool again.', 409);
    if (this.telemetry.get(printerId) !== originalPrinter) throw new CommandError('Printer configuration changed during this assignment. Reload and confirm its physical location again.', 409);
    const raced = checkExisting();
    if (raced) return raced;
    const current = this.current();
    if (baseVersion !== current.version) throw new CommandError('Assignment version conflict; reload locations before moving a spool', 409);
    const snapshot = this.telemetry.get(printerId).snapshot();
    const physicalSlot = snapshot.cfs?.flatMap(g => g.slots).find(s => s.designation === slot);
    if (spoolId !== null && (snapshot.sources?.cfs?.state !== 'fresh' || !physicalSlot)) throw new CommandError('A fresh connected CFS slot is required to assign a spool', 409);
    const destination = a => a.printerId === printerId && a.slot === slot;
    const displaced = current.assignments.find(destination) ?? null;
    const from = spoolId === null ? [] : current.assignments.filter(a => a.spoolId === spoolId);
    const assignments = current.assignments.filter(a => !destination(a) && a.spoolId !== spoolId);
    if (spoolId !== null) assignments.push({ printerId, slot, spoolId, source: 'operator_confirmed',
      confirmedAt: Date.now(), confirmedBy: actor, slotAtConfirmation: { material: physicalSlot.material ?? null, color: physicalSlot.color ?? null } });
    return this.store.saveRecord('assignments', { id: 'current', assignments, event: { id, request, from, displaced } }, baseVersion);
  }
  current() { return this.store.getRecord('assignments', 'current') ?? { id: 'current', version: 0, assignments: [] }; }
  history() { return this.store.recordHistory('assignments', 'current'); }
}
