import { isIPv4 } from 'node:net';

export function privateHost(host) {
  if (typeof host !== 'string' || !isIPv4(host)) return false;
  const [a, b] = host.split('.').map(Number);
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}
export function port(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('Invalid printer port');
  return value;
}
export const MAX_PRINTERS = 64;
export function normalizePrinters(printers) {
  if (!Array.isArray(printers) || printers.length > MAX_PRINTERS) throw new Error(`Configure between 0 and ${MAX_PRINTERS} printers`);
  const ids = new Set(), endpoints = new Set();
  return printers.map(p => {
    if (!p || typeof p.id !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(p.id) || p.id === 'all' || ids.has(p.id)) throw new Error('Invalid or duplicate printer id');
    ids.add(p.id);
    if (!privateHost(p.host)) throw new Error('Printer host must be a private IPv4 address');
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 100) throw new Error('Invalid printer name');
    if (p.vendor !== undefined && typeof p.vendor !== 'boolean') throw new Error('vendor must be boolean');
    const adapter = p.adapter ?? (p.vendor === false || p.vendorPort === null ? 'moonraker' : 'creality');
    if (!['moonraker', 'creality'].includes(adapter)) throw new Error('Select a Moonraker or Creality profile');
    if (p.enabled !== undefined && typeof p.enabled !== 'boolean') throw new Error('enabled must be boolean');
    const moonrakerPort = port(p.moonrakerPort, 7125), endpoint = `${p.host}:${moonrakerPort}`;
    if (endpoints.has(endpoint)) throw new Error('Duplicate Moonraker host and port');
    endpoints.add(endpoint);
    const apiKey = p.apiKey ?? '';
    if (typeof apiKey !== 'string' || apiKey.length > 256 || (apiKey && !/^[!-~]+$/.test(apiKey))) throw new Error('Invalid Moonraker API key');
    const cameraMode = p.cameraMode ?? (p.cameraPort === null || adapter === 'moonraker' ? 'none' : 'creality');
    if (!['none', 'creality', 'relay'].includes(cameraMode)) throw new Error('Invalid camera mode');
    const cameraStream = p.cameraStream ?? '';
    if (typeof cameraStream !== 'string' || cameraStream && !/^[a-zA-Z0-9_-]{1,64}$/.test(cameraStream) || cameraMode === 'relay' && !cameraStream) throw new Error('Use a named go2rtc stream, not a URL');
    return { id: p.id, name: p.name.trim(), host: p.host, adapter, enabled: p.enabled !== false, moonrakerPort, apiKey,
      vendorPort: adapter === 'creality' ? port(p.vendorPort ?? undefined, 9999) : null,
      fluiddPort: p.fluiddPort === null ? null : port(p.fluiddPort, adapter === 'creality' ? 4408 : 80),
      cameraMode, cameraPort: cameraMode === 'creality' ? port(p.cameraPort ?? undefined, 8000) : null, cameraStream };
  });
}
export function runtimePrinters(printers) {
  return printers.filter(p => p.enabled).map(p => ({ ...p,
    moonraker: `http://${p.host}:${p.moonrakerPort}`,
    vendor: p.adapter === 'creality' ? `ws://${p.host}:${p.vendorPort}` : null,
    fluidd: p.fluiddPort === null ? null : `http://${p.host}:${p.fluiddPort}`,
    camera: p.cameraMode === 'creality' ? `http://${p.host}:${p.cameraPort}/call/webrtc_local` : null,
    cameraSource: p.cameraMode === 'relay' ? p.cameraStream : p.cameraMode === 'creality' ? `webrtc:http://${p.host}:${p.cameraPort}/call/webrtc_local#format=creality` : null,
  }));
}
export function parseConfig(input, token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 256 || /\s/.test(token)) throw new Error('Integration token must contain 32–256 non-whitespace characters');
  const printerProfiles = normalizePrinters(input?.printers);
  const printers = runtimePrinters(printerProfiles);
  if (input.controlsEnabled !== undefined && typeof input.controlsEnabled !== 'boolean') throw new Error('controlsEnabled must be boolean');
  if (input.inventoryWritesEnabled !== undefined && typeof input.inventoryWritesEnabled !== 'boolean') throw new Error('inventoryWritesEnabled must be boolean');
  if (input.lanHost != null && (!privateHost(input.lanHost) || input.lanHost.startsWith('127.'))) throw new Error('LAN host must be a private non-loopback IPv4 address');
  const spoolman = normalizeSpoolmanConnection(input.spoolman);
  return { printers, printerProfiles, lanHost: input.lanHost ?? null, controlsEnabled: input.controlsEnabled === true, spoolman, inventoryWritesEnabled: input.inventoryWritesEnabled === true };
}

export function normalizeSpoolmanConnection(input) {
  if (input == null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Spoolman connection');
  if (!['host.docker.internal', 'spoolman', 'localhost'].includes(input.host) && !privateHost(input.host)) throw new Error('Use a private IPv4 address, spoolman, localhost or host.docker.internal for Spoolman');
  let browserUrl;
  if (input.browserUrl) {
    if (typeof input.browserUrl !== 'string') throw new Error('Spoolman browser URL must be text');
    try { const url = new URL(input.browserUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || input.browserUrl.length > 512) throw new Error(); browserUrl = url.href.replace(/\/?$/, '/'); }
    catch { throw new Error('Spoolman browser URL must be HTTP(S), without credentials, query or fragment'); }
  }
  return { host: input.host, port: port(input.port, 7912), ...(browserUrl ? { browserUrl } : {}) };
}
