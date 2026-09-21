// Adapt the upstream UI to Print room's browser session and path.
(() => {
  document.addEventListener('DOMContentLoaded',()=>{
    const input=document.getElementById('settingsSpoolmanUrl');
    if(input){input.readOnly=true;input.title='Configured by Print room';}
  });
  const original=window.fetch.bind(window);
  const session=original('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(async r=>{
    if(!r.ok){location.assign('/');throw new Error('Open Print room to reconnect this browser.');}return r.json();
  });
  window.fetch=async(input,options={})=>{
    if(typeof input!=='string'||!input.startsWith('/api/'))return original(input,options);
    const auth=await session;
    const integration = await original('/api/v1/integrations').then(r => { if (!r.ok) throw new Error('Reconnect Print room to load inventory settings.'); return r.json(); });
    if(options.method&&options.method!=='GET') {
      const body=JSON.parse(options.body||'{}');
      if(!['/api/ui/spoolman/link','/api/ui/spoolman/unlink'].includes(input)) {
        alert('This setup supports spool links and monitoring. Automatic deductions are off. Edit measured weights in Spoolman.');
        return new Response('Operation disabled in this setup',{status:403});
      }
      const label=input.endsWith('/link')?`Link Spoolman spool #${body.spoolman_id} to ${body.printer_id} slot ${body.slot}? Confirm you physically checked this exact spool and slot.`:`Remove the recorded spool link from ${body.printer_id} slot ${body.slot}?`;
      if(!confirm(label))return new Response('No change made',{status:409});
      options={...options,headers:{...options.headers,'X-Print-CSRF':auth.csrf},body:JSON.stringify({...body,confirmed:true,expectedSpoolmanVersion:integration.spoolmanRevision})};
    }
    const response=await original('/cfsync'+input,options);
    if(input==='/api/ui/state'&&response.ok){
      const data=await response.json();
      let browserUrl=integration.spoolmanUrl;
      if(browserUrl){const url=new URL(browserUrl);if(url.hostname==='host.docker.internal')url.hostname=location.hostname;browserUrl=url.href;}
      data.result.spoolman_url=browserUrl ?? '';
      return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
    }
    if(!response.ok&&options.method==='POST')alert(await response.clone().text());
    return response;
  };
})();
