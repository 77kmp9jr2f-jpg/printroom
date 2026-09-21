import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiServer } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { ProjectService } from '../src/projects.mjs';
import { InventoryService } from '../src/inventory.mjs';
import { AssignmentService } from '../src/assignments.mjs';

const token = 'test-token-'.repeat(5);
const auth = { Authorization: `Bearer ${token}` };
const post = body => ({ method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const handoff = () => ({ schemaVersion: 1, source: 'spoolmark', id: 'api-import-0001', spoolReference: 'api-physical-spool', reviewed: true,
  label: { maker: 'Test Vendor', material: 'PLA', color: 'Black' },
  measurements: { diameterMm: 1.75, densityGcm3: 1.24, densitySource: 'Manufacturer specification', initialWeightG: 1000, remainingWeightG: 900 } });
async function setup(t) {
  const store = new Store(':memory:'); const writes = [];
  const telemetry = new Map([['left', { snapshot: () => ({ sources: { cfs: { state: 'fresh' } }, cfs: [{ slots: [{ designation: 'T1A' }] }] }) }]]);
  const spoolman = { getSpool: async id => ({ id, archived: false }), listPage: async () => [], create: async (...args) => { writes.push(args); return { id: 1 }; } };
  const projects = new ProjectService(store); const inventory = new InventoryService({ store, spoolman });
  const assignments = new AssignmentService({ store, telemetry, spoolman });
  const server = createApiServer({ token, telemetry, store, projects, inventory, assignments, spoolman, controlsEnabled: false, inventoryWritesEnabled: false });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); server.close(); await inventory.close(); store.close(); });
  return { base: `http://127.0.0.1:${server.address().port}/api/v1`, writes };
}
test('metadata API requires authentication and stores reviewed project context with trusted actor', async t => {
  const { base } = await setup(t);
  assert.equal((await fetch(base + '/projects')).status, 401);
  const p = { schemaVersion: 1, id: 'test-project', projectUrl: 'https://github.com/77kmp9jr2f-jpg/openFEA', title: 'Bracket', revision: 'v1',
    model: { filename: 'bracket.stl', sha256: 'a'.repeat(64) }, material: 'PLA', orientation: 'Flat on bed', report: null, review: { status: 'needs_review', note: '' } };
  const r = await fetch(base + '/projects', post({ handoff: p, baseVersion: 0, actor: 'forged' }));
  assert.equal(r.status, 200); assert.equal((await r.json()).updatedBy, 'home-assistant');
  assert.equal((await fetch(base + '/projects', post({ handoff: p, baseVersion: 0 }))).status, 409);
  assert.equal((await (await fetch(base + '/projects/test-project/history', { headers: auth })).json()).history.length, 1);
});
test('staged inventory preview works but commit cannot mutate the actual inventory', async t => {
  const { base, writes } = await setup(t);
  const p = await fetch(base + '/imports/preview', post(handoff())); assert.equal(p.status, 200);
  assert.equal((await p.json()).status, 'preview');
  assert.equal((await fetch(base + '/imports/api-import-0001/commit', post({ confirmed: true }))).status, 409);
  assert.equal((await (await fetch(base + '/integrations', { headers: auth })).json()).inventoryWritesEnabled, false);
  assert.deepEqual(writes, []);
});
test('assignment API saves operator-confirmed metadata without inventory writes', async t => {
  const { base, writes } = await setup(t);
  const body = { id: 'api-assignment', printerId: 'left', slot: 'T1A', spoolId: 7, confirmed: true, baseVersion: 0, actor: 'forged' };
  const r = await fetch(base + '/assignments', post(body)); assert.equal(r.status, 200);
  assert.equal((await r.json()).assignments[0].confirmedBy, 'home-assistant');
  const current = await (await fetch(base + '/assignments', { headers: auth })).json();
  assert.equal(current.assignments[0].spoolId, 7); assert.deepEqual(writes, []);
});
test('integration routes bound invalid and oversized metadata', async t => {
  const { base } = await setup(t);
  assert.equal((await fetch(base + '/imports/preview', post({ ...handoff(), notes: 'x'.repeat(40000) }))).status, 413);
  assert.equal((await fetch(base + '/spools?offset=-1', { headers: auth })).status, 400);
  assert.equal((await fetch(base + '/projects/no-such-project', { headers: auth })).status, 404);
});
test('inventory mutations and reads remain bound to the configured Spoolman revision', async t => {
 const {SpoolmanSettings}=await import('../src/spoolman-settings.mjs');
 const store=new Store(':memory:'),telemetry=new Map([['left',{snapshot:()=>({sources:{cfs:{state:'fresh'}},cfs:[{slots:[{designation:'T1A'}]}]})}]]);
 let finish; const inventory=new InventoryService({store}),assignments=new AssignmentService({store,telemetry});
 const settings=new SpoolmanSettings({store,inventory,assignments,initialConnection:{host:'192.168.20.1',port:7912},makeClient:c=>({base:`http://${c.host}:${c.port}/api/v1`,getSpool:async id=>({id}),listPage:()=>new Promise(r=>{finish=r;})})});
 const server=createApiServer({token,telemetry,store,commands:{},projects:new ProjectService(store),inventory,assignments,spoolmanSettings:settings,inventoryWritesEnabled:true});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();store.close();});const base=`http://127.0.0.1:${server.address().port}/api/v1`;
 const body={id:'revision-assignment',printerId:'left',slot:'T1A',spoolId:7,confirmed:true,baseVersion:0,expectedSpoolmanVersion:1};
 const saved=await fetch(base+'/assignments',post(body));assert.equal(saved.status,200);assert.equal((await saved.json()).spoolmanRevision,1);
 const pending=fetch(base+'/spools',{headers:auth});while(!finish)await new Promise(setImmediate);
 settings.save({connection:{host:'192.168.20.2',port:7912},baseVersion:1,confirmChange:true});finish([{id:7}]);assert.equal((await pending).status,409);
 assert.equal((await fetch(base+'/assignments',post(body))).status,409);
 assert.equal((await fetch(base+'/imports/preview',post({...handoff(),expectedSpoolmanVersion:1}))).status,409);
 assert.equal((await fetch(base+'/imports/preview',post({...handoff(),expectedSpoolmanVersion:2}))).status,200);
 assert.deepEqual(assignments.current().assignments,[]);
});
