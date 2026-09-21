import fixtures from './fixtures.js';
const key = 'printroom-public-demo-v1';
const fresh = (count=2) => ({ count, version:1, profiles:structuredClone(fixtures.profiles.slice(0,count)), spoolman:{version:1,connection:{host:'192.168.250.200',port:7912},cfsyncCompatible:true}, retired:[] });
let state;
try { const saved=JSON.parse(sessionStorage.getItem(key)); state=saved?.profiles?.length<=64 && saved?.version ? saved : fresh(); } catch { state=fresh(); }
const save = () => { try { sessionStorage.setItem(key,JSON.stringify(state)); } catch {} };
const json = (body,status=200) => new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const settings = () => ({version:state.version,maxPrinters:64,printers:state.profiles,canManage:true,compatibility:fixtures.compatibility,spoolman:state.spoolman,suggestedSubnet:'192.168.250.0/24',controlsEnabled:false,inventoryWritesEnabled:false,cfsyncConfigured:false});
export function resetDemo(count=state.count) { state=fresh(count); save(); }
export function demoSize() { return state.count; }
export function getDemoSnapshot() { return structuredClone(settings()); }
// There is deliberately no network fallback. Even unknown requests return locally.
export async function demoFetch(path, options={}) {
  if (typeof path!=='string'||!path.startsWith('/api/')) return json({error:'The demo does not make network requests.'},400);
  const url=new URL(path,'https://demo.invalid'), route=url.pathname, method=options.method||'GET';
  let body={}; try { if(options.body) body=JSON.parse(options.body); } catch { return json({error:'Invalid demo request'},400); }
  if(route==='/api/session') return json({csrf:'simulation-only',expiresAt:Date.now()+3600000,access:'demo',canPair:false});
  if(route==='/api/v1/settings'&&method==='GET') return json(settings());
  if(route.startsWith('/api/v1/settings')) {
    if(route.endsWith('/probe')) return json({detail:'Simulated connection is ready. No device or network was contacted.',status:'moonraker',klippyState:'ready'});
    if(route.endsWith('/spoolman/save')) {
      if(body.baseVersion!==state.spoolman.version) return json({error:'Demo settings changed. Refresh first.'},409);
      // Never retain real endpoints, browser URLs, API keys or credentials in a public demo.
      state.spoolman={version:state.spoolman.version+1,connection:body.connection?{host:'192.168.250.200',port:7912}:null,cfsyncCompatible:true};save();return json({spoolman:state.spoolman});
    }
    if(route.endsWith('/printers/save')) {
      const p=body.printer;
      if(body.baseVersion!==state.version) return json({error:'Demo settings changed. Refresh first.'},409);
      if(!p||!/^[a-z][a-z0-9_-]{0,31}$/.test(p.id)||!p.name?.trim()||state.retired.includes(p.id)) return json({error:'Use a name and an unused stable ID.'},400);
      const index=state.profiles.findIndex(x=>x.id===p.id);
      if(index<0&&state.profiles.length>=64) return json({error:'The 64-printer limit has been reached.'},409);
      const profile={id:p.id,name:p.name.slice(0,100),host:`192.168.250.${10+(index<0?state.profiles.length:index)}`,moonrakerPort:7125,fluiddPort:null,adapter:p.adapter==='creality'?'creality':'moonraker',cameraMode:'none',enabled:p.enabled!==false,hasApiKey:false};
      if(index<0)state.profiles.push(profile);else state.profiles[index]=profile;
      state.version++;save();return json(settings());
    }
    if(route.endsWith('/printers/remove')) {
      if(body.baseVersion!==state.version) return json({error:'Demo settings changed. Refresh first.'},409);
      state.profiles=state.profiles.filter(p=>p.id!==body.id);state.retired.push(body.id);state.version++;save();return json(settings());
    }
    if(route.endsWith('/discovery')||route.endsWith('/discovery/cancel')) return json({scan:method==='GET'?null:{status:'completed',completed:1,total:1,results:[{host:'192.168.250.90',moonrakerPort:7125,status:'moonraker',detail:'Simulated Moonraker candidate. No network scan occurred.'}]}});
  }
  if(method==='GET') {
    if(route==='/api/v1/fleet') {
      const now=Date.now(); const printers=state.profiles.filter(p=>p.enabled).map((p,i)=>{
        const value=structuredClone(fixtures.printers[i%fixtures.printers.length]); Object.assign(value,{id:p.id,name:p.name,host:'SIMULATED DEVICE',configurationId:p.id+'-'+state.version,cameraConfigured:false});
        for(const source of Object.values(value.sources)) if(source.observedAt!=null){source.observedAt=now;source.ageMs=0;source.state='fresh';}
        for(const temperature of Object.values(value.temperatures)) temperature.observedAt=now;
        return value;
      }); return json({printers,controlsEnabled:false,observedAt:now});
    }
    if(route==='/api/v1/integrations')return json({spoolmanConfigured:!!state.spoolman.connection,spoolmanRevision:state.spoolman.version,spoolmanUrl:null,cfsyncConfigured:false,inventoryWritesEnabled:false,nativeSolverVerified:false});
    if(route==='/api/v1/spools')return state.spoolman.connection?json({spools:fixtures.spools,nextOffset:null,observedAt:Date.now(),spoolmanRevision:state.spoolman.version}):json({error:'Spoolman is disabled in this simulation.'},503);
    if(route==='/api/v1/assignments')return json({version:0,assignments:[],spoolmanRevision:state.spoolman.version});
    if(route==='/api/v1/imports')return json({imports:[],spoolmanRevision:state.spoolman.version});
    if(route==='/api/v1/projects')return json({projects:[]});
    if(route==='/api/v1/actions')return json({actions:[]});
    if(route.endsWith('/job-facts'))return json({result:{object_height:54,layer_height:.2,nozzle_diameter:.4,filament_type:'PLA',filament_total:14800},header:'; total layer number: 270\n'});
  }
  return json({error:'This action is unavailable in the simulated demo. Install Printroom to use your own printers and inventory.'},409);
}
