import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { CfsyncBridge, summarizeCfsync } from '../src/cfsync.mjs';
import { createApiServer } from '../src/server.mjs';

const now = 1_800_000_000_000;
const state = { result: { printers: [{ id: 'left', state: {
  printer_connected: true, cfs_connected: true, cfs_last_update: now / 1000,
  cfs_slots: { '1A': { present: true }, '1B': { present: false } },
  slots: { '1A': { spoolman_id: 7 }, '1B': { spoolman_id: 9 } }, job_history: []
} }, { id: 'unconfigured', state: {} }] } };
test('CFSync associations retain source age and omit absent slots and unknown printers', () => {
  const r = summarizeCfsync(state, ['left', 'right'], now);
  assert.deepEqual(r.assignments.map(a => [a.printerId, a.slot, a.spoolId]), [['left', 'T1A', 7]]);
  assert.equal(r.printers[0].state, 'fresh');
  assert.equal(r.printers[1].state, 'unavailable');
  assert.equal(summarizeCfsync(state, ['left'], now + 31_000).printers[0].state, 'disconnected');
});
test('Malformed or duplicate CFSync printer identities cannot masquerade as good data', () => {
  assert.throws(() => summarizeCfsync({}, ['left'], now));
  const duplicate = structuredClone(state); duplicate.result.printers.push(duplicate.result.printers[0]);
  assert.throws(() => summarizeCfsync(duplicate, ['left'], now));
});
test('CFSync proxy requires authentication and physical confirmation; rejects configuration and weight writes', async t => {
  const requests = [];
  const upstream = createServer((req,res) => { requests.push({method:req.method,url:req.url}); res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(state)); });
  await new Promise(r => upstream.listen(0,'127.0.0.1',r));
  t.after(() => upstream.close());
  const bridge = new CfsyncBridge({base:`http://127.0.0.1:${upstream.address().port}`,printerIds:['left']});
  const token='cfsync-test-token-12345678901234567890';
  const api = createApiServer({token,telemetry:new Map(),commands:{},store:{},cfsync:bridge});
  await new Promise(r => api.listen(0,'127.0.0.1',r));
  t.after(() => api.close());
  const base=`http://127.0.0.1:${api.address().port}`;
  assert.equal((await fetch(base+'/cfsync/api/ui/state')).status,401);
  for(const path of ['/api/ui/set_spoolman_url','/api/ui/jobs/reallocate_spool','/api/feed']) {
    assert.equal((await fetch(base+'/cfsync'+path,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:'{}'})).status,403);
  }
  assert.equal((await fetch(base+'/cfsync/api/ui/spoolman/link',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({printer_id:'left',slot:'1A',spoolman_id:7})})).status,400);
  assert.equal(requests.length,0);
  const r=await fetch(base+'/cfsync/api/ui/state',{headers:{Authorization:`Bearer ${token}`}});
  assert.equal(r.status,200); assert.equal(requests.length,1);
});
test('CFSync embedded UI uses the paired origin and makes offline status explicit', async t => {
  const upstream=createServer((req,res) => { res.setHeader('Content-Type','text/html');res.end('<html><head><link href="/static/style.css"></head><body><script src="/static/app.js"></script></body></html>'); });
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));t.after(()=>upstream.close());
  const bridge=new CfsyncBridge({base:`http://127.0.0.1:${upstream.address().port}`,printerIds:['left']});
  const r=await bridge.asset('/');
  assert.match(r.body.toString(),/\/cfsync\/static\/app.js/);
  assert.match(r.body.toString(),/workshop.js/);
  assert.match(r.body.toString(),/Automatic deductions are off/);
});
test('changing inventory during a CFSync body read prevents dispatch to the old inventory', async () => {
 const { PassThrough } = await import('node:stream');
 const bridge = new CfsyncBridge({printerIds:['left']}); bridge.connectionRevision=1;
 const calls=[]; bridge.request=async (...args)=>{calls.push(args);return {status:200,type:'application/json',body:Buffer.from('{}')};};
 const req=new PassThrough(); Object.assign(req,{url:'/cfsync/api/ui/spoolman/link',method:'POST',headers:{'content-type':'application/json'}});
 const work=bridge.route(req,{}); bridge.inventoryCompatible=false; bridge.connectionRevision=2;
 req.end(JSON.stringify({confirmed:true,printer_id:'left',slot:'1A',spoolman_id:7,expectedSpoolmanVersion:1}));
 await assert.rejects(work,/connection changed/);assert.deepEqual(calls,[]);
});
test('a late CFSync snapshot cannot show old inventory associations after a connection switch', async () => {
 const bridge = new CfsyncBridge({printerIds:['left']});let finish;
 bridge.request=()=>new Promise(r=>{finish=r;});const work=bridge.snapshot();bridge.inventoryCompatible=false;
 finish({status:200,body:Buffer.from(JSON.stringify(state))});await assert.rejects(work,/connection changed/);
});
