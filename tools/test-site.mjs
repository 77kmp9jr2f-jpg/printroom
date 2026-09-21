import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const build=spawnSync(process.execPath,['tools/build-site.mjs'],{encoding:'utf8'});
assert.equal(build.status,0,build.stderr);
const out=resolve('dist-site');
const storage=new Map();globalThis.sessionStorage={getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v)};
const {demoFetch,resetDemo,getDemoSnapshot}=await import(pathToFileURL(resolve(out,'demo/demo-api.js')));
const request=async(path,body)=>{const r=await demoFetch(path,body===undefined?{}:{method:'POST',body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};

test('the public demo never forwards requests and cannot enable device actions',async()=>{
 const original=globalThis.fetch;globalThis.fetch=()=>{throw new Error('Network was attempted');};
 try {
  resetDemo(64);const fleet=await request('/api/v1/fleet');assert.equal(fleet.data.printers.length,64);assert.equal(fleet.data.controlsEnabled,false);
  for(const p of fleet.data.printers){assert.equal(p.cameraConfigured,false);assert.deepEqual(p.links,{fluidd:null,moonraker:null});}
  for(const p of ['http://192.168.1.50','/api/v1/cameras/demo-1/offer','/api/v1/actions','/api/v1/imports/secret/commit']) assert.ok((await request(p,{})).status>=400);
  const r=await request('/api/v1/settings/discovery',{subnet:'192.168.1.0/24'});assert.equal(r.data.scan.results[0].host,'192.168.250.90');
 } finally {globalThis.fetch=original;}
});
test('demo settings persist fictional profiles while discarding credentials and destinations',async()=>{
 resetDemo(2);const saved=await request('/api/v1/settings/printers/save',{baseVersion:1,printer:{id:'bench',name:'Demo bench',host:'10.99.0.50',apiKey:'never-retain-this',cameraMode:'creality',enabled:true}});assert.equal(saved.status,200);
 assert.equal(saved.data.printers.length,3);assert.equal(saved.data.printers[2].host,'192.168.250.12');assert.equal(saved.data.printers[2].hasApiKey,false);
 await request('/api/v1/settings/spoolman/save',{baseVersion:1,connection:{host:'10.99.0.60',port:1234,browserUrl:'https://private.invalid'}});
 const serialized=JSON.stringify([...storage.values()]);for(const secret of ['never-retain-this','10.99.0.50','10.99.0.60','private.invalid'])assert.ok(!serialized.includes(secret));
 const removed=await request('/api/v1/settings/printers/remove',{baseVersion:2,id:'bench'});assert.equal(removed.data.printers.length,2);
 resetDemo(12);assert.equal(getDemoSnapshot().printers.length,12);
});
test('generated pages have isolated demo policy, correct relative routes and real local assets',async()=>{
 const roots=await readdir(out);assert.ok(roots.includes('installation.html'));assert.ok(roots.includes('operations.html'));
 for(const file of ['index.html','settings.html']){
  const html=await readFile(resolve(out,'demo',file),'utf8');assert.match(html,/connect-src 'none'/);assert.match(html,/media-src 'none'/);assert.match(html,/SIMULATED DEMO/);assert.doesNotMatch(html,/fonts\.google/);assert.doesNotMatch(html,/(?:href|src)="\/(?:settings|style|app)/);
 }
 const app=await readFile(resolve(out,'demo/app.js'),'utf8');assert.match(app,/import \{ demoFetch as fetch \}/);
 const settings=await readFile(resolve(out,'demo/settings.js'),'utf8');assert.match(settings,/import \{ demoFetch as fetch \}/);
 for(const file of roots.filter(f=>f.endsWith('.html'))){const html=await readFile(resolve(out,file),'utf8');for(const match of html.matchAll(/(?:href|src)="([^"#?]+)(?:[?#][^"]*)?"/g)){
  const link=match[1];if(/^[a-z]+:/.test(link))continue;
  const path=resolve(out,link.endsWith('/')?link+'index.html':link);await readFile(path);
 }}
});
