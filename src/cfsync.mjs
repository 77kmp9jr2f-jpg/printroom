import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CommandError } from './commands.mjs';
import { readJsonBody } from './http.mjs';

export function summarizeCfsync(payload, printerIds, now = Date.now()) {
  const entries = payload?.result?.printers;
  if (!Array.isArray(entries)) throw new CommandError('CFSync returned invalid state', 502);
  const byId = new Map();
  for (const entry of entries) {
    if (!printerIds.includes(entry?.id)) continue;
    if (byId.has(entry.id) || !entry.state || typeof entry.state !== 'object') throw new CommandError('CFSync returned ambiguous printer state', 502);
    byId.set(entry.id, entry.state);
  }
  const assignments = [];
  const printers = printerIds.map(id => {
    const data = byId.get(id), seconds = data?.cfs_last_update;
    const observedAt = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 && seconds * 1000 <= now + 5000 ? seconds * 1000 : null;
    const ageMs = observedAt === null ? null : Math.max(0, now - observedAt);
    const state = ageMs === null ? 'unavailable' : !data.printer_connected || !data.cfs_connected || ageMs >= 30_000 ? 'disconnected' : ageMs >= 15_000 ? 'stale' : 'fresh';
    let presentSlots = 0;
    for (const [slot, meta] of Object.entries(data?.cfs_slots ?? {})) {
      if (!/^[1-4][ABCD]$/.test(slot) || !meta?.present) continue;
      presentSlots++;
      const spoolId = data.slots?.[slot]?.spoolman_id;
      if (Number.isSafeInteger(spoolId) && spoolId > 0) assignments.push({printerId:id,slot:`T${slot}`,spoolId,source:'cfsync',observedAt,state});
    }
    return {id,state,observedAt,ageMs,presentSlots,trackedJobs:Array.isArray(data?.job_history) ? data.job_history.length : 0};
  });
  return {configured:true,source:'cfsync',mode:'monitor',observedAt:now,printers,assignments,
    version:createHash('sha256').update(JSON.stringify(assignments)).digest('hex').slice(0,16)};
}

export class CfsyncBridge {
  constructor({base='http://cfsync:8005',printerIds}) { this.base=base; this.printerIds=printerIds; this.inventoryCompatible=true; this.connectionRevision=0; this.activeWrites=0; }
  async request(path, options={}) {
    let response;
    try { response=await fetch(this.base+path,{...options,redirect:'error',signal:AbortSignal.timeout(8000)}); }
    catch { throw new CommandError('CFSync is unavailable. Printer monitoring remains independent.',503); }
    const reader=response.body.getReader(), chunks=[]; let size=0;
    try { while(true) { const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2_000_000)throw new Error('large');chunks.push(Buffer.from(value)); } }
    catch { await reader.cancel().catch(()=>{});throw new CommandError('CFSync response was interrupted or too large',502); }
    return {status:response.status,type:response.headers.get('content-type')??'application/octet-stream',body:Buffer.concat(chunks)};
  }
  async snapshot() {
    if (!this.inventoryCompatible) throw new CommandError('CFSync uses a different Spoolman connection. Update its host configuration before using spool links.', 409);
    const revision = this.connectionRevision;
    const r=await this.request('/api/workshop/state');
    if (!this.inventoryCompatible || revision !== this.connectionRevision) throw new CommandError('Spoolman connection changed while loading CFSync state. Refresh inventory.',409);
    if(r.status!==200)throw new CommandError('CFSync state is unavailable',503);
    let data;try{data=JSON.parse(r.body);}catch{throw new CommandError('CFSync returned invalid JSON',502);}
    if(data.result?.workshop?.mode!=='monitor'||data.result.workshop.inventoryWritesEnabled!==false||data.result.workshop.sshEnabled!==false)throw new CommandError('CFSync workshop mode could not be verified',502);
    return summarizeCfsync(data,this.printerIds);
  }
  async asset(path) {
    const r=await this.request(path);
    if(path==='/') {
      r.body=Buffer.from(r.body.toString().replace(/<link[^>]+https:\/\/fonts\.[^>]+>/g,'')
        .replaceAll('"/static/','"/cfsync/static/')
        .replace('</head>','<style>#settingsSpoolmanSection,#settingsSpoolmanUrlSave{display:none!important}input[name="spoolmanMode"]{pointer-events:none}</style><script src="/cfsync/workshop.js"></script></head>')
        .replace(/<body([^>]*)>/,'<body$1><aside style="padding:12px;background:#12302c;color:#fff;font:14px system-ui"><a href="/" style="color:#b5eee0">← Print room</a> · CFSync spool links and monitoring. <strong>Automatic deductions are off.</strong> Link only physically verified spools. Usage history begins when this service starts.</aside>'));
    }
    return r;
  }
  async route(req,res) {
    if(req.url==='/api/v1/cfsync'&&req.method==='GET') {
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(await this.snapshot()));return true;
    }
    if(!req.url.startsWith('/cfsync'))return false;
    if (!this.inventoryCompatible) throw new CommandError('CFSync uses a different Spoolman connection. Update its host configuration before using spool links.', 409);
    let result; const revision = this.connectionRevision;
    if(req.url==='/cfsync'&&req.method==='GET'){res.writeHead(302,{Location:'/cfsync/'});res.end();return true;}
    const path=req.url.slice('/cfsync'.length), parsed=new URL(path,'http://local');
    const reads=['/api/ui/state','/api/printers','/api/health','/api/ui/spoolman/spools','/api/ui/spoolman/spool_detail'];
    if(req.method==='GET'&&path==='/workshop.js') result={status:200,type:'text/javascript',body:readFileSync(new URL('../web/cfsync-workshop.js',import.meta.url))};
    else if(req.method==='GET'&&(path==='/'||/^\/static\/[A-Za-z0-9_.-]+(?:\?[A-Za-z0-9_=&.-]+)?$/.test(path))) result=await this.asset(path);
    else if(req.method==='GET'&&reads.includes(parsed.pathname)) result=await this.request(path);
    else if(req.method==='POST'&&['/api/ui/spoolman/link','/api/ui/spoolman/unlink'].includes(path)) {
      if(req.headers['content-type']?.split(';')[0]!=='application/json')throw new CommandError('Expected application/json',415);
      let body;try{body=await readJsonBody(req,2048);}catch{throw new CommandError('Invalid CFSync request');}
      if(body?.confirmed!==true)throw new CommandError('Confirm the actual physical spool and slot first');
      if(!this.printerIds.includes(body.printer_id)||!/^([1-4][ABCD]|SP)$/.test(body.slot??''))throw new CommandError('Unknown CFSync printer or slot');
      if(path.endsWith('/link')&&(!Number.isSafeInteger(body.spoolman_id)||body.spoolman_id<=0))throw new CommandError('Select a real spool');
      if (!this.inventoryCompatible || revision !== this.connectionRevision || this.connectionRevision && body.expectedSpoolmanVersion !== this.connectionRevision) throw new CommandError('Spoolman connection changed. Reload CFSync before linking a spool.',409);
      this.activeWrites++;
      try { result=await this.request(path.replace('/api/ui/spoolman/','/api/workshop/'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); } finally { this.activeWrites--; }
    } else throw new CommandError('This CFSync setup permits monitoring and confirmed spool links. Change inventory weights in Spoolman; automatic deductions and printer commands are disabled.',403);
    if (!this.inventoryCompatible || revision !== this.connectionRevision) throw new CommandError('Spoolman connection changed. Reload CFSync.',409);
    res.writeHead(result.status,{'Content-Type':result.type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',
      'Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"});
    res.end(result.body);return true;
  }
}
