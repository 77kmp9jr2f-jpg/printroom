import {colorLibrary,filterColors,swatchBackground} from './color-library.js';
const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!=null)n.textContent=text;return n;};
const external=(text,href)=>{const a=el('a','',text);a.href=href;a.target='_blank';a.rel='noreferrer';return a;};
function rgb(hex){const n=hex.replace('#','');return [0,2,4].map(i=>parseInt(n.slice(i,i+2)||'00',16));}
function luminance(hex){const [r,g,b]=rgb(hex).map(v=>{const s=v/255;return s<=0.03928?s/12.92:((s+0.055)/1.055)**2.4;});return 0.2126*r+0.7152*g+0.0722*b;}
function hue(hex){if(!hex)return 720;const [r,g,b]=rgb(hex).map(v=>v/255);const max=Math.max(r,g,b),min=Math.min(r,g,b),d=max-min;if(!d)return luminance(hex)<0.08?0:720;let h=max===r?((g-b)/d)%6:max===g?(b-r)/d+2:(r-g)/d+4;return (h*60+360)%360;}
function remain(c){if(c.knownGrams>0){const measured=Math.max(1,c.active-c.unknownWeight);return Math.min(1,Math.max(0.18,c.knownGrams/measured/1000));}return 0.48;}
function wallOrder(colors){return [...colors].sort((a,b)=>hue(a.colors[0])-hue(b.colors[0])||a.vendor.localeCompare(b.vendor)||a.name.localeCompare(b.name));}

export class ColorLibraryView {
 constructor(root) {
  this.root=root;this.colors=[];this.observedAt=null;this.error=null;this.spotlight=null;
  this.filters=Object.fromEntries(['query','material','finish','availability'].map(k=>[k,root.querySelector('[data-filter='+k+']')]));
  Object.values(this.filters).forEach(f=>f.addEventListener('input',()=>this.render()));
 }
 update(spools,{observedAt,error,assignments=[],spoolmanUrl=null}={}) {
  this.colors=colorLibrary(spools);this.observedAt=observedAt;this.error=error;this.assignments=assignments;this.spoolmanUrl=spoolmanUrl;
  for(const key of ['material','finish']) {
   const select=this.filters[key],value=select.value;
   const all=el('option','',key==='material'?'All materials':'All finishes');all.value='';
   select.replaceChildren(all,...[...new Set(this.colors.map(c=>c[key]))].sort().map(v=>{const o=el('option','',v);o.value=v;return o;}));
   if([...select.options].some(o=>o.value===value))select.value=value;
  }
  this.render();
 }
 render() {
  const colors=wallOrder(filterColors(this.colors,Object.fromEntries(Object.entries(this.filters).map(([k,f])=>[k,f.value]))));
  const total=this.colors.reduce((n,c)=>n+c.spools.length,0);
  this.root.querySelector('#color-count').textContent=(colors.length===this.colors.length?this.colors.length+' colors':colors.length+' / '+this.colors.length+' colors')+' · '+total+' rolls';
  const status=this.root.querySelector('#color-status');
  status.textContent=this.error?'Spoolman unavailable · '+this.error+(this.observedAt?' · Showing inventory from '+new Date(this.observedAt).toLocaleTimeString(): ''):
   this.observedAt?'Simulated inventory · '+new Date(this.observedAt).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'}):'Loading Spoolman inventory…';
  status.dataset.warning=String(!!this.error);
  const key=JSON.stringify([this.spoolmanUrl,colors,(this.assignments||[]).map(({printerId,slot,spoolId,state})=>({printerId,slot,spoolId,state}))]);
  if(key===this.key)return;this.key=key;
  const grid=this.root.querySelector('#color-grid'),ribbon=this.root.querySelector('#hue-ribbon');
  const opened=new Set([...grid.querySelectorAll('article:has(details[open])')].map(n=>n.dataset.filament));
  grid.replaceChildren();ribbon.replaceChildren();ribbon.hidden=!colors.length;
  if(!colors.length)grid.append(el('p','empty',this.colors.length?'No matching colors. Adjust your filters.':this.error?'Inventory could not be loaded.':'No spool records yet.'));
  const base=this.spoolmanUrl;
  colors.forEach((c,i)=>{
   const card=el('article','color-card');card.dataset.filament=String(c.id);card.style.setProperty('--i',String(i));
   const lead=c.colors[0]||'';
   card.style.setProperty('--remain',String(remain(c)));
   if(lead)card.style.setProperty('--c',lead);
   const sample=el('div','color-sample');sample.dataset.finish=c.finish.toLowerCase();
   const level=el('div','color-level'),face=el('div','color-face'),background=swatchBackground(c);
   if(background)level.style.background=background;else sample.dataset.unknown='true';
   sample.append(level,face);
   const info=el('div','color-info'),heading=el('h3','',c.name);heading.title=c.name;
   const meta=el('div','sample-meta'),basis=el('span','sample-basis',c.basis==='Published hex'?'Published':c.basis==='Listing photo approximation'?'Approx.':c.basis);
   basis.title=c.basis+(c.note?' · '+c.note:'');
   meta.append(el('span','color-maker',c.vendor),el('span','sample-material',c.material));
   if(c.finish&&c.finish!=='Unspecified')meta.append(el('span','sample-finish',c.finish));
   if(c.colors.length)meta.append(el('code','color-hex',c.colors.join(' · ')));
   meta.append(basis);
   const counts=[c.active?c.active+(c.active===1?' roll':' rolls'):'',c.incoming?c.incoming+' on order':'',c.archived?c.archived+' archived':''].filter(Boolean);
   if(counts.length)meta.append(el('span','color-count-line',counts.join(' · ')));
   info.append(heading,meta);
   const stock=el('div','color-stock');
   const linked=(this.assignments||[]).filter(a=>c.spools.some(s=>s.id===a.spoolId));
   if(linked.length) {const loaded=el('span','color-loaded','Loaded');loaded.title=linked.map(a=>a.printerId+' '+a.slot+(a.state&&a.state!=='fresh'?' (last seen)':'')).join(' · ');stock.append(loaded);info.append(stock);}
   const details=el('details','color-details'),summary=el('summary','','');summary.setAttribute('aria-label','Rolls & details for '+c.name);details.append(summary);details.open=opened.has(String(c.id));
   const body=el('div','color-detail-body');
   const mass=c.active?(c.unknownWeight===c.active?'Remaining weight unknown':Math.round(c.knownGrams)+' g known'+(c.unknownWeight?' · '+c.unknownWeight+' unmeasured':'')):'No active spool records';
   body.append(el('p','small muted',mass));
   if(linked.length)body.append(el('p','small',linked.map(a=>a.printerId+' '+a.slot+(a.state&&a.state!=='fresh'?' (last seen)':'')).join(' · ')));
   for(const s of c.spools) {
    const label='#'+s.id+' · '+(s.archived?'Archived':/^on order/i.test(s.location||'')?'On order':s.remaining_weight==null?'Weight unknown':Math.round(s.remaining_weight)+' g');
    body.append(base ? external(label,base+'?sel=spool%3A'+s.id) : el('p','small',label));
   }
   const actions=el('div','color-links');if(base)actions.append(external('Spoolman ↗',base+'?sel=filament%3A'+c.id));
   if(c.asin)actions.append(external('Amazon ↗','https://www.amazon.com/dp/'+c.asin));
   body.append(actions,el('p','swatch-basis',c.basis));
   if(c.source)body.append(external('Color source ↗',c.source));
   if(c.note)body.append(el('p','small muted',c.note));
   details.append(body);card.append(sample,info,details);grid.append(card);
   const swatch=el('button');
   swatch.type='button';
   swatch.style.setProperty('--c',lead||'#68717b');
   swatch.title=c.name;
   swatch.setAttribute('aria-label','Show '+c.name);
   swatch.setAttribute('aria-pressed',String(this.spotlight===c.id));
   swatch.addEventListener('click',()=>{
    this.spotlight=c.id;
    ribbon.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed','false'));
    swatch.setAttribute('aria-pressed','true');
    card.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'center'});
    card.classList.remove('spotlight');void card.offsetWidth;card.classList.add('spotlight');
   });
   ribbon.append(swatch);
  });
 }
}
