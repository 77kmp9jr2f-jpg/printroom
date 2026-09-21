import { PrinterTelemetry } from './telemetry.mjs';

// All consumers retain the same telemetry Map while changed profiles receive new samples.
export function reconcileFleet(printers, { telemetry, collectors, commands, cameras, cfsync, cfsyncSeed = [] }) {
  const ids = new Set(printers.map(p => p.id));
  for (const id of telemetry.keys()) if (!ids.has(id)) telemetry.delete(id);
  for (const p of printers) {
    if (JSON.stringify(telemetry.get(p.id)?.config) !== JSON.stringify(p)) telemetry.set(p.id, new PrinterTelemetry(p));
  }
  commands.printers = new Map(printers.map(p => [p.id, p]));
  cameras.update(printers);
  if (cfsync) cfsync.printerIds = printers.filter(p => cfsyncSeed.some(old => old.id === p.id && old.moonraker === p.moonraker && old.vendor === p.vendor)).map(p => p.id);
  collectors.update(printers);
}
