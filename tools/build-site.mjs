// Build a static Pages site and an isolated demo from the production UI.
import { readFile, writeFile, mkdir, cp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';
import { PrinterTelemetry } from '../src/telemetry.mjs';
import { compatibility } from '../src/printer-settings.mjs';
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const out = resolve(root, process.env.PRINTROOM_SITE_OUT || 'dist-site');
if (out === root || !out.startsWith(root + '/')) throw new Error('Build directory must be inside the project');
await rm(out, { recursive: true, force: true }); await mkdir(join(out, 'demo'), { recursive: true });
await cp(join(root, 'site'), out, { recursive: true });
await writeFile(join(out, '.nojekyll'), '');
const escape = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function inline(s) {
  return escape(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" rel="noreferrer">$1</a>');
}
function markdown(s) {
  const lines = s.split('\n'); let html = '', fence = false, list = false, table = false;
  for (const line of lines) {
    if (line.startsWith('```')) { if (list) { html += '</ul>'; list = false; } html += fence ? '</code></pre>' : '<pre><code>'; fence = !fence; continue; }
    if (fence) { html += escape(line) + '\n'; continue; }
    if (line.startsWith('|')) {
      if (/^\|[\s:|-]+\|$/.test(line)) continue;
      if (!table) { html += '<div class="table-wrap"><table>'; table = true; }
      html += '<tr>' + line.split('|').slice(1,-1).map(c => '<td>' + inline(c.trim()) + '</td>').join('') + '</tr>'; continue;
    }
    if (table) { html += '</table></div>'; table = false; }
    if (/^[-*] /.test(line)) { if (!list) { html += '<ul>'; list = true; } html += '<li>' + inline(line.slice(2)) + '</li>'; continue; }
    if (list) { html += '</ul>'; list = false; }
    const h = /^(#{1,4}) (.+)$/.exec(line);
    if (h) html += `<h${h[1].length} id="${slug(h[2])}">${inline(h[2])}</h${h[1].length}>`;
    else if (line.trim()) html += '<p>' + inline(line) + '</p>';
  }
  return html + (list ? '</ul>' : '') + (table ? '</table></div>' : '');
}
const guides = [ ['installation','Install & connect'], ['compatibility','Compatibility & scale'], ['cfs','CFS trays & spool links'], ['operations','Operate & troubleshoot'], ['integration-api','Integration API'] ];
const template = await readFile(join(root, 'site/guide.template.html'), 'utf8');
for (const [id,title] of guides) {
  const content = markdown(await readFile(join(root, 'docs', id + '.md'), 'utf8'));
  await writeFile(join(out, id + '.html'), template.replaceAll('{{TITLE}}', title).replace('{{NAV}}', guides.map(([path,label]) => `<a data-guide ${path===id ? 'aria-current="page" ' : ''}href="${path}.html">${label}</a>`).join('')).replace('{{CONTENT}}', content));
}
await rm(join(out, 'guide.template.html'));
for (const name of ['app.js','settings.js','ui-core.js','color-library.js','color-library-view.js','camera.js','style.css']) {
  let code = await readFile(join(root,'web',name),'utf8');
  if (['app.js','settings.js'].includes(name)) code = `import { demoFetch as fetch } from './demo-api.js';\n` + code;
  if (name === 'camera.js') code = code.replaceAll('NO CAMERA CONFIGURED', 'STATIC PRINTER PREVIEW');
  if (name === 'app.js') {
    code = code.replaceAll('Local connection', 'Simulated data').replaceAll('LAN connection', 'Simulated data');
    // Static local images replace the disabled video only in the public build.
    const anchor = 'camera.dataset.configured = String(p.cameraConfigured !== false);';
    if (!code.includes(anchor)) throw new Error('Demo preview insertion point is missing');
    code = code.replace(anchor, anchor + `
  const previewSide = Number(p.id.split('-').at(-1)) % 2 === 0 ? 'right' : 'left';
  const cameraPreview = node('img', 'demo-camera-preview');
  cameraPreview.src = './printer-' + previewSide + '.jpg';
  cameraPreview.alt = 'Static K2 Plus preview recreated from a real Printroom camera view';
  cameraPreview.loading = 'lazy'; cameraPreview.decoding = 'async';
  camera.append(cameraPreview); video.setAttribute('aria-hidden', 'true');`);
  }
  if (name === 'color-library-view.js') code = code.replaceAll('Live inventory', 'Simulated inventory');
  code = code.replace(/href = '\/settings'/g, "href = './settings.html'");
  await writeFile(join(out,'demo',name),code);
}
const banner = `<aside class="demo-banner" aria-label="Simulated demo"><a href="../">← Printroom</a><strong>SIMULATED DEMO</strong><span>Sample data · camera-based previews</span><label>Room size <select id="demo-size"><option value="2">2 printers</option><option value="12">12 printers</option><option value="64">64 printers</option></select></label><button id="demo-reset" type="button">Reset demo</button><a href="../installation.html">Install your own ↗</a></aside>`;
for (const name of ['index.html','settings.html']) {
  let html = await readFile(join(root,'web',name),'utf8');
  html = html.replaceAll('href="/style.css','href="./style.css').replaceAll('src="/app.js','src="./app.js').replaceAll('src="/settings.js','src="./settings.js').replaceAll('href="/settings"','href="./settings.html"').replaceAll('href="/#','href="./index.html#').replaceAll('href="/"','href="./index.html"');
  html = html.replace(/<link[^>]+https:\/\/fonts[^>]+>/g,'');
  html = html.replace('</head>', '<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data:; font-src \'self\'; connect-src \'none\'; media-src \'none\'; object-src \'none\'; base-uri \'self\'; form-action \'none\'"><link rel="stylesheet" href="./demo.css"><script type="module" src="./demo-ui.js"></script></head>');
  html = html.replace('</head>', '<link rel="icon" type="image/svg+xml" href="../icon.svg"></head>');
  html = html.replace(/(<body[^>]*>)/, '$1' + banner);
  await writeFile(join(out,'demo',name),html);
}
const swatches=[['Sage','91B3A0'],['Terracotta','C98265'],['Graphite','454D55'],['Pearl','E8E4D9'],['Ocean','457EAA'],['Lavender','A994C4'],['Marigold','E1B14C'],['Coral','CF7877'],['Forest','497767'],['Ice','A6CDD4'],['Clay','BA967E'],['Cobalt','4D62AF']];
const profiles = Array.from({length:64},(_,i) => ({id:`demo-${i+1}`, name:i<2?['Left K2 Plus','Right K2 Plus'][i]:`Workshop ${String(i+1).padStart(2,'0')}`,host:`192.168.250.${i+10}`,moonrakerPort:7125,fluiddPort:null,adapter:i<2?'creality':'moonraker',vendorPort:i<2?9999:null,cameraMode:'none',enabled:true,hasApiKey:false}));
const printers = profiles.map((p,i) => {
  const t=new PrinterTelemetry({...p,moonraker:null,fluidd:null,cameraSource:null,vendor:null});
  const active=i!==1 && i%4!==3;
  t.updateMoonrakerInfo({klippy_state:'ready',klippy_connected:true});
  t.updateMoonraker({print_stats:{state:active?'printing':'standby',filename:active?['workshop-fixture.gcode','mounting-plate.gcode','cable-guide.gcode'][i%3]:null,print_duration:2850+i*90,filament_used:active?8200+i*200:0},webhooks:{state:'ready'},extruder:{temperature:active?215:24,target:active?215:0},heater_bed:{temperature:active?60:24,target:active?60:0},virtual_sdcard:{progress:0.24+(i%7)*.08,layer:47+i*3,layer_count:180}});
  // Match the observed 8-slot / 4-slot workshop layout using synthetic values only.
  if (i < 2) t.updateVendor({state:active?1:0,deviceState:active?1:0,boxTemp:active?29:24,boxsInfo:{materialBoxs:Array.from({length:i===0?2:1},(_,boxIndex)=>({
    id:boxIndex+1,type:0,state:1,temp:25+boxIndex,humidity:24+boxIndex*3,
    materials:Array.from({length:4},(_,slotId)=>{
      const colorIndex=(i===0?0:8)+boxIndex*4+slotId, [name,color]=swatches[colorIndex];
      return {id:slotId,color:'#'+color,vendor:'Demo Materials',type:colorIndex%3===0?'PETG':'PLA',name,percent:Math.max(12,90-colorIndex*6),selected:active&&boxIndex===0&&slotId===1?1:0,state:1};
    })
  }))}});
  const s=t.snapshot();s.configurationId=`demo-config-${i}`;s.job.id=`demo-job-${i}`;s.job.remainingSeconds=6200-i*60;return s;
});
const spools=swatches.map(([name,color],i)=>({id:i+1,filament:{id:i+1,name,material:i%3===0?'PETG':'PLA',vendor:{name:'Demo Materials'},color_hex:color,weight:1000,extra:{printroom_finish:JSON.stringify(i%4===0?'Matte':'Standard')}},remaining_weight:Math.max(80,930-i*65),initial_weight:1000,archived:false,location:i===10?'On order':'Demo shelf'}));
await writeFile(join(out,'demo/fixtures.js'), `// Fabricated fixture data only.\nexport default ${JSON.stringify({profiles,printers,spools,compatibility})};\n`);
console.log(`Built ${out}`);
