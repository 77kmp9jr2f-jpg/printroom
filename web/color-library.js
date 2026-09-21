const hex = value => typeof value === 'string' && /^#?(?:[a-f0-9]{6}|[a-f0-9]{8})$/i.test(value.trim()) ? '#'+value.trim().replace(/^#/,'').toUpperCase() : null;
function extra(f,key) { try { const v=JSON.parse(f.extra?.['printroom_'+key]);return typeof v==='string'?v:''; } catch{return '';} }
function safeUrl(value) {try {const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;} }
export function colorLibrary(spools) {
 const groups=new Map();
 for (const s of spools) {
  const f=s.filament;if(!Number.isSafeInteger(f?.id))continue;
  if(!groups.has(f.id)) {
   const colors=(f.multi_color_hexes?f.multi_color_hexes.split(','):[f.color_hex]).map(hex).filter(Boolean);
   groups.set(f.id,{id:f.id,name:f.name||'Unnamed filament',vendor:f.vendor?.name||'Unknown maker',material:f.material||'Unknown',
    finish:extra(f,'finish')||'Unspecified',colors,direction:f.multi_color_direction,
    basis:extra(f,'color_basis')||(colors.length?'Spoolman swatch':'No swatch'),note:extra(f,'color_note'),
    source:safeUrl(extra(f,'color_source')),asin:/^[A-Z0-9]{10}$/.test(f.article_number||'')&&f.article_number.startsWith('B')?f.article_number:null,
    spools:[],active:0,incoming:0,archived:0,knownGrams:0,unknownWeight:0});
  }
  const c=groups.get(f.id);c.spools.push(s);
  if(s.archived)c.archived++;
  else if(/^on order/i.test(s.location||''))c.incoming++;
  else {c.active++;if(typeof s.remaining_weight==='number'&&Number.isFinite(s.remaining_weight))c.knownGrams+=s.remaining_weight;else c.unknownWeight++;}
 }
 return [...groups.values()].sort((a,b)=>a.vendor.localeCompare(b.vendor)||a.name.localeCompare(b.name));
}
export function filterColors(colors,{query='',material='',finish='',availability=''}={}) {
 const q=query.trim().toLowerCase();
 return colors.filter(c=>(!q||[c.name,c.vendor,c.material,c.finish,...c.colors,c.asin,...c.spools.map(s=>String(s.id))].join(' ').toLowerCase().includes(q))&&
  (!material||c.material===material)&&(!finish||c.finish===finish)&&(!availability||(availability==='recorded'?c.active>0:availability==='incoming'?c.incoming>0:availability==='archived'?c.archived>0:true)));
}
export function swatchBackground(c) {
 const colors=c.colors.map(hex).filter(Boolean);if(!colors.length)return null;
 if(colors.length===1)return colors[0];
 const stops=c.direction==='coaxial'?colors.flatMap((v,i)=>[v+' '+(100*i/colors.length)+'%',v+' '+(100*(i+1)/colors.length)+'%']):colors;
 return 'linear-gradient(120deg, '+stops.join(', ')+')';
}
export async function loadSpools(api) {
 const found=new Map();let offset=0,observedAt=null,spoolmanRevision;
 for(let page=0;page<100;page++) {
  const data=await api('/api/v1/spools'+(offset?'?offset='+offset:''));
  if (page === 0) spoolmanRevision = data.spoolmanRevision;
  else if (spoolmanRevision !== data.spoolmanRevision) throw new Error('Spoolman connection changed between inventory pages. Refresh inventory.');
  if(!Array.isArray(data.spools))throw new Error('Invalid inventory page');
  for(const s of data.spools)found.set(s.id,s);
  observedAt=data.observedAt;
  if(data.nextOffset==null)return {spools:[...found.values()],observedAt,spoolmanRevision};
  if(!Number.isSafeInteger(data.nextOffset)||data.nextOffset<=offset)throw new Error('Inventory pagination did not advance');
  offset=data.nextOffset;
 }
 throw new Error('Inventory exceeds the library limit; narrow it in Spoolman.');
}
