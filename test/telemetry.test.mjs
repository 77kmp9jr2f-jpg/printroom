import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PrinterTelemetry, normalizeColor } from '../src/telemetry.mjs';

const now = 1_800_000_000_000;
test('job identity survives pause and resume but changes for a new or repeated print', () => {
  const p = new PrinterTelemetry({ id: 'left', name: 'Left' });
  const update = (state, elapsed, filename = 'same.gcode') => p.updateMoonraker({ print_stats: { state, print_duration: elapsed, filename }, webhooks: { state: 'ready' } });
  update('printing', 50); const first = p.snapshot().job.id;
  update('paused', 55); update('printing', 56); assert.equal(p.snapshot().job.id, first);
  update('printing', 1); const repeat = p.snapshot().job.id; assert.notEqual(repeat, first);
  update('complete', 200); update('printing', 201); assert.notEqual(p.snapshot().job.id, repeat);
  const next = p.snapshot().job.id; update('printing', 202, 'different.gcode'); assert.notEqual(p.snapshot().job.id, next);
});
const fixture = name => JSON.parse(readFileSync(new URL(`fixtures/${name}.json`, import.meta.url)));
function printer(name) {
  const data = fixture(name);
  const p = new PrinterTelemetry({ id: name, name, host: '192.168.250.160' });
  p.updateMoonraker(data.moonraker, now);
  p.updateMoonrakerInfo({ klippy_state: 'ready', klippy_connected: true }, now);
  for (const message of data.vendor) p.updateVendor(message, now);
  return p;
}

test('preparation overrides Moonraker standby and blocks routine controls', () => {
  const s = printer('right').snapshot(now);
  assert.equal(s.phase, 'preparing');
  assert.equal(s.job.filename, 'sample-organizer.gcode');
  assert.equal(s.job.preparationPercent, 22);
  assert.equal(s.controls.pause, false);
  assert.equal(s.controls.resume, false);
  assert.equal(s.controls.cancel, false);
  assert.ok(s.warnings.some(w => w.includes('standby')));
});

test('synthetic multi-CFS identities and reported values survive normalization', () => {
  const s = printer('left').snapshot(now);
  assert.equal(s.phase, 'printing');
  assert.equal(s.cfs.length, 2);
  assert.deepEqual(s.cfs.map(g => g.slots.length), [4, 4]);
  assert.equal(s.cfs[1].slots[2].designation, 'T2C');
  assert.equal(s.cfs[1].slots[2].active, true);
  assert.equal(s.cfs[0].slots[0].color, '#b1bec6');
  assert.equal(s.cfs[0].slots[0].remainingPercent, 11);
  assert.equal(s.cfs[0].slots[0].amountSource, 'printer-reported estimate');
  assert.equal(s.externalSpool, null);
  assert.equal(s.controls.pause, true);
  assert.equal(s.job.layer, 1);
  assert.equal(s.job.totalLayers, 73);
  assert.equal(s.job.filamentUsedMm, 623.3);
  assert.equal(s.links.fluidd, null);
  assert.equal(s.links.moonraker, null);
});

test('snapshot exposes configured Fluidd and Moonraker links', () => {
  const p = new PrinterTelemetry({ id: 'a', name: 'A', host: '192.168.250.10', fluidd: 'http://192.168.250.10:4408', moonraker: 'http://192.168.250.10:7125' });
  assert.deepEqual(p.snapshot(now).links, { fluidd: 'http://192.168.250.10:4408', moonraker: 'http://192.168.250.10:7125' });
});

test('explicit blank CFS slot never acquires retained color or 100 percent remaining', () => {
  const p = printer('right');
  p.updateMoonraker({ ...fixture('right').moonraker, box: { T1: { color_value: ['0009E43', '000678A', '0000000', '0B28B33'] } } }, now);
  const slot = p.snapshot(now).cfs[0].slots[1];
  assert.equal(slot.color, null);
  assert.equal(slot.material, null);
  assert.equal(slot.remainingPercent, null);
  assert.equal(slot.configuration, 'unconfigured');
  assert.ok(slot.warnings.length > 0);
});

test('unrelated socket messages cannot make CFS or status fresh', () => {
  const p = printer('left');
  p.updateVendor({ connectionCount: 5 }, now + 16_000);
  let s = p.snapshot(now + 16_000);
  assert.equal(s.sources.vendor.state, 'stale');
  assert.equal(s.sources.cfs.state, 'stale');
  assert.equal(s.controls.pause, false);
  assert.equal(s.cfs[1].slots[2].color, '#474747');
  s = p.snapshot(now + 31_000);
  assert.equal(s.sources.cfs.state, 'disconnected');
  assert.equal(s.phase, 'unknown');
});

test('full CFS refresh removes disconnected groups; explicit empty snapshot clears them', () => {
  const p = printer('left');
  const boxes = fixture('right').vendor.find(m => m.boxsInfo).boxsInfo;
  p.updateVendor({ boxsInfo: boxes }, now + 10_000);
  assert.equal(p.snapshot(now + 10_000).cfs.length, 1);
  p.updateVendor({ boxsInfo: { materialBoxs: [] } }, now + 11_000);
  assert.equal(p.snapshot(now + 11_000).cfs.length, 0);
});

test('partial vendor updates retain omitted job fields without refreshing their timestamps', () => {
  const p = printer('left');
  p.updateVendor({ lightSw: 0, boxsInfo: { enable: 1 } }, now + 14_000);
  const s = p.snapshot(now + 16_000);
  assert.equal(s.sources.cfs.state, 'stale');
  assert.equal(s.job.filename, 'sample-planter.gcode');
  assert.equal(s.sources.vendor.observedAt, now);
});

test('fresh shutdown observation overrides older job state', () => {
  const p = printer('left');
  p.updateMoonrakerInfo({ klippy_state: 'shutdown', klippy_connected: true }, now + 2000);
  const s = p.snapshot(now + 2000);
  assert.equal(s.phase, 'shutdown');
  assert.equal(s.controls.pause, false);
  assert.equal(s.shutdownObservedAt, now + 2000);
});

test('new printer has unknown values rather than reassuring zeroes', () => {
  const s = new PrinterTelemetry({ id: 'new', name: 'New' }).snapshot(now);
  assert.equal(s.phase, 'unknown');
  assert.equal(s.job.progressPercent, null);
  assert.equal(s.temperatures.nozzle.current, null);
  assert.equal(s.sources.cfs.state, 'unavailable');
});

test('fresh Moonraker standby cannot establish idle when vendor preparation data expired', () => {
  const p = printer('right');
  p.updateMoonraker(fixture('right').moonraker, now + 16_000);
  p.updateMoonrakerInfo({ klippy_state: 'ready', klippy_connected: true }, now + 16_000);
  assert.equal(p.snapshot(now + 16_000).phase, 'unknown');
});

test('new preparing job does not inherit layers from a previous completed job', () => {
  const p = printer('right');
  const old = fixture('left').moonraker;
  old.print_stats.state = 'complete';
  old.virtual_sdcard.layer = 73;
  p.updateMoonraker(old, now);
  const s = p.snapshot(now);
  assert.equal(s.phase, 'preparing');
  assert.equal(s.job.layer, 0);
  assert.equal(s.job.totalLayers, null);
});

test('printing the same filename again does not reuse the previous run layer count', () => {
  const p = printer('right');
  const old = fixture('right').moonraker;
  old.print_stats.filename = 'sample-organizer.gcode';
  old.print_stats.state = 'complete';
  old.virtual_sdcard.layer = 73;
  old.virtual_sdcard.layer_count = 73;
  p.updateMoonraker(old, now);
  assert.equal(p.snapshot(now).job.layer, 0);
  assert.equal(p.snapshot(now).job.totalLayers, null);
});

test('fallback progress identifies the vendor source that supplied its value', () => {
  const p = printer('left');
  const m = fixture('left').moonraker;
  delete m.virtual_sdcard.progress;
  p.updateMoonraker(m, now);
  p.updateVendor({ printProgress: 42 }, now);
  assert.equal(p.snapshot(now).job.progressPercent, 42);
  assert.equal(p.snapshot(now).job.progressSource, 'vendor');
});

test('color decoding accepts proven formats and rejects malformed values', () => {
  for (const [raw, expected] of [['#0000000', '#000000'], ['000678A', '#00678a'], ['#b1bec6', '#b1bec6'], ['#ab1bec6', null], ['', null], ['red', null], ['#fff', null], [123, null]]) {
    assert.equal(normalizeColor(raw), expected);
  }
});
