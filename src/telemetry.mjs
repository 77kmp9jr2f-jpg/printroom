import { randomUUID } from 'node:crypto';
export function normalizeColor(value) {
  if (typeof value !== 'string') return null;
  let hex = value.trim().replace(/^#/, '');
  if (/^0[\da-f]{6}$/i.test(hex)) hex = hex.slice(1);
  return /^[\da-f]{6}$/i.test(hex) ? `#${hex.toLowerCase()}` : null;
}

function number(value, min = -Infinity, max = Infinity) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}
function text(value) { return typeof value === 'string' && value.trim() ? value.trim().slice(0, 1024) : null; }
function basename(value) { return text(value)?.split('/').at(-1) ?? null; }
function source(name, observedAt, now, error) {
  const ageMs = observedAt === null ? null : Math.max(0, now - observedAt);
  return { name, observedAt, ageMs, state: ageMs === null ? 'unavailable' : ageMs >= 30_000 ? 'disconnected' : ageMs >= 15_000 ? 'stale' : 'fresh', error: error ?? null };
}

export class PrinterTelemetry {
  constructor(config) {
    this.config = config; this.configurationId = randomUUID();
    this.moonraker = {};
    this.info = {};
    this.vendor = {};
    this.boxes = [];
    this.at = { moonraker: null, info: null, vendor: null, cfs: null };
    this.vendorFieldAt = {};
    this.errors = {};
    this.jobInstance = randomUUID();
  }

  updateMoonraker(status, observedAt = Date.now()) {
    if (!status || typeof status !== 'object' || !status.print_stats || !status.webhooks) return false;
    const before = this.moonraker.print_stats, after = status.print_stats;
    if (before && (before.filename !== after.filename ||
      !['printing', 'paused'].includes(before.state) && ['printing', 'paused'].includes(after.state) ||
      Number.isFinite(after.print_duration) && Number.isFinite(before.print_duration) && after.print_duration + 1 < before.print_duration)) this.jobInstance = randomUUID();
    this.moonraker = structuredClone(status);
    this.at.moonraker = observedAt;
    delete this.errors.moonraker;
    return true;
  }

  updateMoonrakerInfo(info, observedAt = Date.now()) {
    if (!info || typeof info.klippy_state !== 'string') return false;
    this.info = { klippy_state: info.klippy_state, klippy_connected: info.klippy_connected === true };
    this.at.info = observedAt;
    delete this.errors.info;
    return true;
  }

  updateVendor(message, observedAt = Date.now()) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    for (const [key, value] of Object.entries(message)) {
      if (key === 'boxsInfo' || key === '__proto__' || key === 'constructor') continue;
      this.vendor[key] = structuredClone(value);
      this.vendorFieldAt[key] = observedAt;
    }
    // A temperature delta or socket keepalive is not a new job-state observation.
    if (number(message.state) !== null && number(message.deviceState) !== null) {
      this.at.vendor = observedAt;
      delete this.errors.vendor;
    }
    if (Array.isArray(message.boxsInfo?.materialBoxs)) {
      this.boxes = structuredClone(message.boxsInfo.materialBoxs);
      this.at.cfs = observedAt;
      delete this.errors.cfs;
    }
  }

  fail(sourceName, error) { this.errors[sourceName] = String(error).slice(0, 200); }

  snapshot(now = Date.now()) {
    const sources = Object.fromEntries(Object.entries(this.at).map(([key, at]) => [key, source(key === 'vendor' || key === 'cfs' ? 'Printer' : 'Moonraker', at, now, this.errors[key])]));
    const fresh = key => sources[key].state === 'fresh';
    const needsVendor = this.config.adapter !== 'moonraker' && this.config.vendor !== null;
    const v = this.vendor;
    const m = this.moonraker;
    const stats = m.print_stats ?? {};
    const sd = m.virtual_sdcard ?? {};
    const warnings = [];
    const selfTest = number(v.withSelfTest, 0, 100);
    const vendorActive = fresh('vendor') && (v.state === 1 || v.deviceState === 1);
    const preparing = vendorActive && selfTest !== null && selfTest < 100 && now - (this.vendorFieldAt.withSelfTest ?? 0) < 15_000;
    const shutdownAt = this.info.klippy_state === 'shutdown' && fresh('info') ? this.at.info : m.webhooks?.state === 'shutdown' && fresh('moonraker') ? this.at.moonraker : null;
    let phase = 'unknown';
    if (shutdownAt !== null) phase = 'shutdown';
    else if (fresh('info') && (!this.info.klippy_connected || this.info.klippy_state !== 'ready')) phase = 'unavailable';
    else if (fresh('moonraker') && (stats.state === 'paused' || m.pause_resume?.is_paused === true)) phase = 'paused';
    else if (fresh('moonraker') && stats.state === 'printing') phase = 'printing';
    else if (preparing) phase = 'preparing';
    else if (vendorActive) phase = 'busy';
    else if (fresh('moonraker')) phase = ({ standby: !needsVendor || fresh('vendor') ? 'idle' : 'unknown', complete: !needsVendor || fresh('vendor') ? 'complete' : 'unknown', cancelled: !needsVendor || fresh('vendor') ? 'cancelled' : 'unknown', error: 'error' })[stats.state] ?? 'unknown';
    if (vendorActive && stats.state === 'standby') warnings.push('Creality reports an active job while Moonraker reports standby. Do not assume the printer is available.');
    for (const key of (needsVendor ? ['moonraker', 'vendor', 'cfs'] : ['moonraker'])) if (!fresh(key)) warnings.push(`${key} data is ${sources[key].state}. Last values may be outdated.`);

    const vendorJob = basename(v.printFileName);
    const motionJob = basename(stats.filename);
    const filename = ['preparing', 'busy'].includes(phase) ? vendorJob ?? motionJob : motionJob ?? vendorJob;
    const sameJob = filename && filename === vendorJob;
    const fieldFresh = key => now - (this.vendorFieldAt[key] ?? 0) < 15_000;
    const vendorValue = key => sameJob && fieldFresh(key) ? number(v[key], 0) : null;
    const motionMatches = !['preparing', 'busy'].includes(phase) && Boolean(filename && filename === motionJob);
    const progressSource = !['preparing', 'busy'].includes(phase) && motionMatches && number(sd.progress, 0, 1) !== null ? 'moonraker' : 'vendor';
    const progress = progressSource === 'moonraker' ? number(sd.progress) * 100 : vendorValue('printProgress');
    const temperature = (component, currentKey, targetKey) => ({
      current: number(m[component]?.temperature) ?? number(v[currentKey]),
      target: number(m[component]?.target) ?? number(v[targetKey]),
      source: m[component]?.temperature !== undefined ? 'moonraker' : 'vendor',
      observedAt: m[component]?.temperature !== undefined ? this.at.moonraker : this.vendorFieldAt[currentKey] ?? null,
    });
    const cfs = this.boxes.filter(b => b.type === 0 && b.state === 1 && Number.isInteger(b.id) && b.id >= 1 && b.id <= 4).sort((a, b) => a.id - b.id).map(box => ({
      id: box.id, name: `CFS ${box.id}`, temperature: number(box.temp), humidity: number(box.humidity, 0, 100), source: 'cfs',
      slots: Array.from({ length: 4 }, (_, slotId) => {
        const raw = box.materials?.find(s => s.id === slotId);
        const color = normalizeColor(raw?.color);
        const configured = Boolean(text(raw?.vendor) || text(raw?.type) || text(raw?.name) || color);
        const retained = normalizeColor(m.box?.[`T${box.id}`]?.color_value?.[slotId]);
        return {
          id: slotId, designation: `T${box.id}${String.fromCharCode(65 + slotId)}`,
          color, vendor: text(raw?.vendor), material: text(raw?.type), profile: text(raw?.name),
          active: raw?.selected === 1, configuration: !raw ? 'unknown' : configured ? 'configured' : 'unconfigured',
          reportedState: raw?.state ?? null, remainingPercent: configured ? number(raw?.percent, 0, 100) : null,
          amountSource: 'printer-reported estimate', source: 'cfs', observedAt: this.at.cfs,
          warnings: retained && color !== retained ? ['Moonraker retains a different color; current Creality slot details are shown.'] : [],
        };
      }),
    }));
    const external = this.boxes.find(b => b.type === 1 && b.state === 1);
    const routineFresh = fresh('moonraker') && (!needsVendor || fresh('vendor')) && fresh('info') && this.info.klippy_state === 'ready';
    return {
      configurationId: this.configurationId, cameraConfigured: this.config.cameraSource === undefined ? true : !!this.config.cameraSource, adapter: this.config.adapter ?? 'creality',
      id: this.config.id, name: this.config.name, host: this.config.host ?? null,
      links: { fluidd: this.config.fluidd ?? null, moonraker: this.config.moonraker ?? null },
      sources, phase, shutdownObservedAt: shutdownAt,
      job: { id: this.jobInstance, filename, progressPercent: number(progress, 0, 100), preparationPercent: preparing ? selfTest : null,
        layer: (motionMatches ? number(sd.layer, 0) : null) ?? vendorValue('layer'), totalLayers: (motionMatches ? number(sd.layer_count, 1) : null) ?? number(vendorValue('TotalLayer'), 1),
        elapsedSeconds: ['preparing', 'busy'].includes(phase) ? vendorValue('printJobTime') : number(stats.print_duration, 0),
        remainingSeconds: number(vendorValue('printLeftTime'), 1), progressSource: progress === null ? null : progressSource,
        filamentUsedMm: motionMatches ? number(stats.filament_used, 0) : null,
      },
      temperatures: { nozzle: temperature('extruder', 'nozzleTemp', 'targetNozzleTemp'), bed: temperature('heater_bed', 'bedTemp0', 'targetBedTemp0'), chamber: { current: number(v.boxTemp), target: number(v.targetBoxTemp), source: 'vendor', observedAt: this.vendorFieldAt.boxTemp ?? null } },
      cfs, externalSpool: external ? { source: 'cfs', color: normalizeColor(external.materials?.[0]?.color), material: text(external.materials?.[0]?.type) } : null,
      controls: { emergency_stop: true, pause: routineFresh && phase === 'printing', resume: routineFresh && phase === 'paused', cancel: routineFresh && ['printing', 'paused'].includes(phase) }, warnings,
    };
  }
}
