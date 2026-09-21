// Isolated configuration UI: simulated devices and probes, temporary data, no LAN requests.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { PrinterRegistry } from '../src/printer-registry.mjs';
import { PrinterSettings } from '../src/printer-settings.mjs';
import { PrinterDiscovery } from '../src/discovery.mjs';
import { Collectors } from '../src/collectors.mjs';
import { CommandService } from '../src/commands.mjs';
import { CameraProxy } from '../src/camera-proxy.mjs';
import { reconcileFleet } from '../src/fleet.mjs';
import { createApiServer } from '../src/server.mjs';
import { LocalBrowser, BrowserPairing } from '../src/local-browser.mjs';
import { ProjectService } from '../src/projects.mjs';
import { AssignmentService } from '../src/assignments.mjs';
import { SpoolmanSettings } from '../src/spoolman-settings.mjs';
import { InventoryService } from '../src/inventory.mjs';

const bindHost = process.env.PRINT_SIM_HOST ?? '127.0.0.1', pairing = new BrowserPairing();
const port = Number(process.env.PRINT_SIM_PORT ?? 7991), count = Number(process.env.PRINT_SIM_FLEET_SIZE ?? 0);
const dir = mkdtempSync(join(tmpdir(), 'print-settings-simulator-')), store = new Store(join(dir, 'simulation.sqlite'));
const initialPrinters = Array.from({ length: Math.max(0, Math.min(64, count)) }, (_, i) => ({ id: 'sim-' + (i + 1), name: 'SIMULATED printer ' + (i + 1), host: '192.168.250.' + (i + 1), adapter: 'moonraker' }));
const registry = new PrinterRegistry({ store, initialPrinters }), telemetry = new Map();
const poll = async (_, p) => { p.updateMoonrakerInfo({ klippy_state: 'ready', klippy_connected: true }); p.updateMoonraker({ print_stats: { state: 'standby' }, webhooks: { state: 'ready' }, extruder: { temperature: 22, target: 0 }, heater_bed: { temperature: 21, target: 0 } }); };
const collectors = new Collectors([], telemetry, { poll });
const commands = new CommandService({ printers: [], telemetry, store });
const cameras = new CameraProxy({ base: 'http://127.0.0.1:1', printerIds: [] });
registry.onChange = printers => reconcileFleet(printers, { telemetry, collectors, commands, cameras }); registry.onChange(registry.runtime());
const probe = async ({ host, moonrakerPort }) => ({ host, moonrakerPort, status: host.endsWith('.11') ? 'moonraker' : 'unreachable', detail: 'SIMULATED Moonraker response. No device connection.', version: 'simulator', klippyState: 'ready' });
const discovery = new PrinterDiscovery({ probe });
const inventory = new InventoryService({ store, spoolman: null });
const assignments = new AssignmentService({ store, telemetry, spoolman: null });
const spoolmanSettings = new SpoolmanSettings({ store, inventory, assignments, makeClient: c => ({ base: `http://${c.host}:${c.port}/api/v1`, listPage: async () => [] }) });
const settings = new PrinterSettings({ registry, discovery, spoolmanSettings, publicPort: port, lanHost: '192.168.250.2', probe });
const server = createApiServer({ token: 'simulation-only-token-not-production', store, telemetry, commands, cameras, settings, spoolmanSettings,
  localBrowser: new LocalBrowser({ port, ...(bindHost === '127.0.0.1' ? {} : { access: 'lan', lanHost: bindHost, lanAccess: 'paired', pairing }), assetDir: fileURLToPath(new URL('../web/', import.meta.url)) }),
  projects: new ProjectService(store), assignments, inventory });
await new Promise(r => server.listen(port, bindHost, r)); collectors.start();
if (bindHost !== '127.0.0.1') console.log('SIMULATOR pairing code: ' + pairing.create().code);
console.log(`SIMULATOR only: http://${bindHost}:${port}/settings; ${count} fake printers; no physical-device network traffic.`);
let stopping = false;
async function stop() { if (stopping) return; stopping = true; server.closeAllConnections(); await new Promise(r => server.close(r)); await server.drainHandlers(); await discovery.close(); await collectors.close(); await commands.close(); await inventory.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
