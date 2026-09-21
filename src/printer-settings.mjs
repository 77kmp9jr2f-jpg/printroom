import { readJsonBody } from './http.mjs';
import { CommandError } from './commands.mjs';
import { probeMoonraker } from './discovery.mjs';

export const compatibility = [
  { system: 'Creality K2 Plus with Moonraker', support: 'Qualified on this installation', detail: 'Two rooted K2 Plus printers: live telemetry, Creality CFS data and cameras. Other firmware revisions require a connection check. Physical control actions remain unqualified.' },
  { system: 'Klipper + Moonraker (Mainsail / Fluidd)', support: 'Implemented; automated coverage', detail: 'Use the Moonraker profile. Job state and nozzle/bed telemetry, custom ports and API keys are supported. Camera is optional. Individual models and multi-tool machines need qualification.' },
  { system: 'Other Creality printers exposing Moonraker', support: 'Conditional', detail: 'Use Moonraker first. The Creality profile additionally requires the compatible port-9999 state/CFS protocol. A brand or model name alone does not establish support.' },
  { system: 'OctoPrint / Marlin via OctoPrint', support: 'No adapter yet', detail: 'Requires a separate OctoPrint REST adapter and API-key flow; it cannot use the Moonraker profile.' },
  { system: 'Bambu Lab / AMS', support: 'No adapter yet', detail: 'Requires a separate, firmware-qualified LAN integration. Moonraker discovery does not detect Bambu printers or AMS.' },
  { system: 'PrusaLink / Prusa Connect', support: 'No adapter yet', detail: 'Requires a dedicated API adapter. A Prusa running Klipper instead can be evaluated as a Moonraker setup.' },
  { system: 'Duet / RepRapFirmware, USB-only or cloud-only', support: 'No adapter yet', detail: 'No Duet, serial USB or vendor cloud integration is implemented.' },
  { system: 'Cameras', support: 'Creality endpoint or named go2rtc stream', detail: 'Other camera sources must be configured in go2rtc first. Reachable WebRTC candidates and browser-compatible codecs are required.' },
];
export class PrinterSettings {
  constructor({ registry, discovery, spoolmanSettings, lanHost, publicPort = 7988, controlsEnabled = false, inventoryWritesEnabled = false, cfsyncConfigured = false, probe = probeMoonraker }) {
    Object.assign(this, { registry, discovery, spoolmanSettings, lanHost, publicPort, controlsEnabled, inventoryWritesEnabled, cfsyncConfigured, probe }); this.activeProbes = 0;
  }
  async route(req, res, { json, canManage }) {
    if (!req.url.startsWith('/api/v1/settings')) return false;
    const send = (body, status = 200) => { json(res, status, body); return true; };
    if (req.method === 'GET' && req.url === '/api/v1/settings') return send({ ...this.registry.snapshot(), canManage, compatibility, spoolman: this.spoolmanSettings?.snapshot() ?? null,
      suggestedSubnet: this.lanHost ? this.lanHost.replace(/\.\d+$/, '.0/24') : '', managementUrl: `http://localhost:${this.publicPort}/settings`,
      controlsEnabled: this.controlsEnabled, inventoryWritesEnabled: this.inventoryWritesEnabled, cfsyncConfigured: this.cfsyncConfigured });
    if (!canManage) throw new CommandError('Manage printers from the host localhost page or an explicitly paired LAN browser. Open LAN viewers cannot change settings.', 403);
    if (req.method === 'GET' && req.url === '/api/v1/settings/discovery') return send({ scan: this.discovery.snapshot() });
    const paths = ['/api/v1/settings/printers/save', '/api/v1/settings/printers/remove', '/api/v1/settings/probe', '/api/v1/settings/discovery', '/api/v1/settings/discovery/cancel', '/api/v1/settings/spoolman/save', '/api/v1/settings/spoolman/probe'];
    if (req.method !== 'POST' || !paths.includes(req.url)) throw new CommandError('Unknown settings operation', 404);
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new CommandError('Expected application/json', 415);
    let body;
    try { body = await readJsonBody(req, 16384); } catch { throw new CommandError('Invalid or oversized settings request'); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CommandError('Expected settings object');
    if (req.url.endsWith('/spoolman/save')) {
      if (!this.spoolmanSettings) throw new CommandError('Spoolman settings are unavailable', 503);
      return send({ spoolman: this.spoolmanSettings.save(body) });
    }
    if (req.url.endsWith('/spoolman/probe')) {
      if (!this.spoolmanSettings) throw new CommandError('Spoolman settings are unavailable', 503);
      if (this.activeProbes >= 4) throw new CommandError('Connection checks are busy. Try again shortly.', 429);
      this.activeProbes++;
      try { return send(await this.spoolmanSettings.probe(body.connection)); } finally { this.activeProbes--; }
    }
    if (req.url.endsWith('/printers/save')) return send(this.registry.save(body));
    if (req.url.endsWith('/printers/remove')) return send(this.registry.remove(body));
    if (req.url.endsWith('/discovery/cancel')) return send({ scan: this.discovery.cancel() });
    if (req.url.endsWith('/discovery')) return send({ scan: this.discovery.start(body) }, 202);
    if (this.activeProbes >= 4) throw new CommandError('Connection checks are busy. Try again shortly.', 429);
    const printer = this.registry.profile(body.printer);
    this.activeProbes++;
    try { return send(await this.probe(printer, { timeoutMs: 3500 })); }
    finally { this.activeProbes--; }
  }
}
