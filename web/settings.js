const $ = selector => document.querySelector(selector);
const el = (tag, text, className = '') => { const n = document.createElement(tag); if (text != null) n.textContent = text; n.className = className; return n; };
const button = (text, action, className = 'quiet') => { const b = el('button', text, className); b.type = 'button'; b.onclick = action; return b; };
let session, configuration, editVersion, removeTarget, scanTimer, lastScan, stopped = false;
const form = $('#printer-form'), field = name => form.elements.namedItem(name);
function message(text, error = false) { $('#settings-message').textContent = text; $('#settings-message').dataset.warning = String(error); }
async function connect(code) {
  const r = await fetch('/api/session', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(code ? { code } : {}), signal: AbortSignal.timeout(5000) });
  const data = await r.json();
  if (!r.ok) { $('#settings-pairing').hidden = !data.pairingRequired; throw new Error(data.error ?? 'Could not connect'); }
  session = data; $('#settings-pairing').hidden = true;
}
async function api(path, body, retry = false) {
  if (!session || session.expiresAt < Date.now() + 10000) await connect();
  const response = await fetch('/api/v1/settings' + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Print-CSRF': session.csrf }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  const result = await response.json();
  if (response.status === 401 && body === undefined && !retry) { await connect(); return api(path, undefined, true); }
  if (!response.ok) throw new Error(result.error ?? 'Request failed');
  return result;
}
async function attempt(button, work, showError = e => message(e.message, true)) {
  button.disabled = true;
  try { await work(); } catch (e) { showError(e); } finally { button.disabled = false; }
}
function render() {
  $('#settings-content').hidden = false;
  const { printers, canManage, maxPrinters } = configuration;
  $('#settings-count').textContent = `${printers.filter(p => p.enabled).length} enabled · ${printers.length} saved · up to ${maxPrinters} printers`;
  $('#printer-add').disabled = !canManage || printers.length >= maxPrinters;
  $('#discovery-start').disabled = !canManage;
  $('#discovery-subnet').disabled = !canManage; $('#discovery-port').disabled = !canManage;
  if (!$('#discovery-subnet').value) $('#discovery-subnet').value = configuration.suggestedSubnet;
  $('#settings-policies').textContent = `Printer controls: ${configuration.controlsEnabled ? 'enabled by host configuration' : 'disabled'}. Inventory writes: ${configuration.inventoryWritesEnabled ? 'enabled by host configuration' : 'disabled'}. Adding printers does not change these policies.`;
  $('#settings-cfsync-note').hidden = !configuration.cfsyncConfigured;
  if (!canManage) {
    $('#settings-message').replaceChildren(el('span', 'Viewing settings. To manage printers, open this page on the Print room host: '));
    const a = el('a', configuration.managementUrl); a.href = configuration.managementUrl; $('#settings-message').append(a, el('span', '. Paired LAN browsers can also manage printers.'));
  }
  renderSpoolman();
  renderPrinters();
  if (lastScan) renderScan(lastScan);
  const compatibility = $('#compatibility-list'); compatibility.replaceChildren();
  for (const item of configuration.compatibility) { const row = el('article', null, 'compatibility-item'); row.append(el('h3', item.system), el('span', item.support, 'support-level'), el('p', item.detail, 'muted')); compatibility.append(row); }
}
function renderPrinters() {
  const list = $('#configured-printers'), query = $('#printer-search').value.toLowerCase(); list.replaceChildren();
  const printers = configuration.printers.filter(p => `${p.name} ${p.id} ${p.host}`.toLowerCase().includes(query));
  if (!printers.length) list.append(el('p', configuration.printers.length ? 'No printers match this search.' : 'Your room is empty. Add a printer or discover one on your network.', 'empty'));
  for (const p of printers) {
    const row = el('article', null, 'configured-printer'), info = el('div'), heading = el('h3', p.name);
    info.append(heading, el('p', `${p.host}:${p.moonrakerPort} · ${p.adapter === 'creality' ? 'Creality + Moonraker' : 'Moonraker'}`, 'small muted'), el('p', `${p.id} · ${p.enabled ? 'Monitoring enabled' : 'Disabled'} · ${p.cameraMode === 'none' ? 'No camera' : p.cameraMode === 'relay' ? 'Camera: ' + p.cameraStream : 'Creality camera'}${p.hasApiKey ? ' · API key saved' : ''}`, 'small muted'));
    const actions = el('div', null, 'settings-row-actions');
    const edit = button('Edit', () => editPrinter(p)), toggle = button(p.enabled ? 'Disable' : 'Enable', () => attempt(toggle, async () => { const result = await api('/printers/save', { printer: { ...p, enabled: !p.enabled }, baseVersion: configuration.version }); Object.assign(configuration, result); render(); message(`${p.name} ${p.enabled ? 'disabled' : 'enabled'}.`); }));
    const remove = button('Remove', () => { removeTarget = { id: p.id, version: configuration.version }; $('#remove-description').textContent = `Remove ${p.name} from Print room?`; $('#remove-error').textContent = ''; $('#remove-dialog').showModal(); });
    for (const b of [edit, toggle, remove]) b.disabled = !configuration.canManage;
    actions.append(edit, toggle, remove); row.append(info, actions); list.append(row);
  }
}
function editPrinter(p = {}, adding = false) {
  if (adding) { const base = p.id; let n = 2; while (configuration.printers.some(x => x.id === p.id)) p.id = base.slice(0, 28) + '-' + n++; }
  form.reset(); editVersion = configuration.version;
  const values = { id: '', name: '', host: '', adapter: 'moonraker', moonrakerPort: 7125, fluiddPort: 80, vendorPort: 9999, cameraMode: 'none', cameraPort: 8000, cameraStream: '', enabled: true, ...p };
  for (const [key, value] of Object.entries(values)) { const input = field(key); if (!input) continue; if (input.type === 'checkbox') input.checked = value; else input.value = value ?? ''; }
  field('apiKey').value = ''; field('clearApiKey').checked = false;
  field('id').readOnly = configuration.printers.some(x => x.id === p.id);
  field('apiKey').placeholder = p.hasApiKey ? 'Leave blank to keep saved key' : 'Optional';
  $('#api-key-help').textContent = p.hasApiKey ? 'Blank keeps the key only while the address and port stay unchanged. Re-enter it when changing the endpoint.' : 'Stored only on the server; never returned to this page.';
  $('#printer-editor-title').textContent = field('id').readOnly ? 'Edit printer' : 'Add printer';
  $('#printer-check-result').textContent = ''; $('#printer-editor-error').textContent = ''; dependentFields(); $('#printer-dialog').showModal();
}
function dependentFields() {
  $('#vendor-port-field').hidden = field('adapter').value !== 'creality';
  $('#camera-port-field').hidden = field('cameraMode').value !== 'creality';
  $('#camera-stream-field').hidden = field('cameraMode').value !== 'relay';
  field('cameraStream').required = field('cameraMode').value === 'relay';
}
function profile() {
  return { id: field('id').value.trim(), name: field('name').value.trim(), host: field('host').value.trim(), adapter: field('adapter').value,
    moonrakerPort: Number(field('moonrakerPort').value), fluiddPort: field('fluiddPort').value ? Number(field('fluiddPort').value) : null,
    vendorPort: field('adapter').value === 'creality' ? Number(field('vendorPort').value || 9999) : null,
    cameraMode: field('cameraMode').value, cameraPort: field('cameraMode').value === 'creality' ? Number(field('cameraPort').value || 8000) : null,
    cameraStream: field('cameraStream').value.trim(), apiKey: field('apiKey').value, clearApiKey: field('clearApiKey').checked, enabled: field('enabled').checked };
}
field('adapter').onchange = () => { if (!field('id').readOnly) { field('fluiddPort').value = field('adapter').value === 'creality' ? 4408 : 80; field('cameraMode').value = field('adapter').value === 'creality' ? 'creality' : 'none'; } dependentFields(); };
field('cameraMode').onchange = dependentFields;
$('#printer-close').onclick = () => $('#printer-dialog').close();
$('#printer-dialog').addEventListener('close', () => { field('apiKey').value = ''; });
$('#printer-add').onclick = () => editPrinter();
$('#printer-search').oninput = renderPrinters;
form.onsubmit = e => { e.preventDefault(); attempt($('#printer-save'), async () => {
  const result = await api('/printers/save', { printer: profile(), baseVersion: editVersion }); Object.assign(configuration, result); $('#printer-dialog').close(); render(); message('Printer saved. The dashboard updates automatically.');
}, e => $('#printer-editor-error').textContent = e.message); };
$('#printer-check').onclick = () => { if (!form.reportValidity()) return; attempt($('#printer-check'), async () => { $('#printer-check-result').textContent = 'Checking Moonraker…'; const result = await api('/probe', { printer: profile() }); $('#printer-check-result').textContent = `${result.detail}${result.klippyState ? ' Klipper: ' + result.klippyState + '.' : ''} This check does not verify cameras or printer controls.`; }, e => $('#printer-check-result').textContent = e.message); };
$('#remove-cancel').onclick = () => $('#remove-dialog').close();
$('#remove-form').onsubmit = e => { e.preventDefault(); attempt(e.submitter, async () => { const result = await api('/printers/remove', { id: removeTarget.id, baseVersion: removeTarget.version }); Object.assign(configuration, result); $('#remove-dialog').close(); render(); message('Printer removed from monitoring.'); }, e => $('#remove-error').textContent = e.message); };
function renderScan(scan) {
  if (!scan) return;
  lastScan = scan;
  const running = scan.status === 'running'; $('#discovery-start').disabled = running || !configuration.canManage; $('#discovery-cancel').hidden = !running;
  $('#discovery-progress').hidden = false; $('#discovery-progress').max = scan.total; $('#discovery-progress').value = scan.completed;
  $('#discovery-status').textContent = `${scan.status === 'running' ? 'Scanning' : scan.status === 'cancelled' ? 'Cancelled' : 'Finished'} · ${scan.completed}/${scan.total} addresses checked · ${scan.results.length} candidates`;
  const list = $('#discovery-results'); list.replaceChildren();
  for (const candidate of scan.results) {
    const row = el('div', null, 'discovery-result'), info = el('div'); info.append(el('strong', `${candidate.host}:${candidate.moonrakerPort}`), el('p', candidate.detail, 'small muted'));
    const existing = configuration.printers.find(p => p.host === candidate.host && p.moonrakerPort === candidate.moonrakerPort);
    row.append(info, existing ? el('span', 'Already configured', 'small muted') : button(candidate.status === 'moonraker' ? 'Review & add' : 'Configure manually', () => editPrinter({ id: 'printer-' + candidate.host.replaceAll('.', '-') + '-' + candidate.moonrakerPort, name: 'Printer ' + candidate.host, host: candidate.host, moonrakerPort: candidate.moonrakerPort }, true)));
    list.append(row);
  }
  if (!running && !scan.results.length) list.append(el('p', 'No candidates found. Check routing, the selected port and firewall, or add a printer manually.', 'muted'));
  clearTimeout(scanTimer); if (running && !stopped) scanTimer = setTimeout(checkScan, 1000);
}
async function checkScan() { try { renderScan((await api('/discovery')).scan); } catch (e) { $('#discovery-status').textContent = e.message + ' Refresh to reconnect to the scan.'; $('#discovery-start').disabled = !configuration.canManage; } }
$('#discovery-form').onsubmit = e => { e.preventDefault(); attempt($('#discovery-start'), async () => { renderScan((await api('/discovery', { subnet: $('#discovery-subnet').value.trim(), moonrakerPort: Number($('#discovery-port').value) })).scan); $('#discovery-start').disabled = true; }, e => $('#discovery-status').textContent = e.message).then(() => { if (!$('#discovery-cancel').hidden) $('#discovery-start').disabled = true; }); };
$('#discovery-cancel').onclick = () => attempt($('#discovery-cancel'), async () => renderScan((await api('/discovery/cancel', {})).scan));
async function load() { configuration = await api(''); message('Changes are saved locally and applied immediately.'); render(); if (configuration.canManage) await checkScan(); }
$('#settings-refresh').onclick = () => attempt($('#settings-refresh'), load);
$('#settings-pair-form').onsubmit = e => { e.preventDefault(); attempt(e.submitter, async () => { await connect($('#settings-pair-code').value); $('#settings-pair-code').value = ''; await load(); }); };
window.addEventListener('pagehide', () => { stopped = true; clearTimeout(scanTimer); });
window.addEventListener('pageshow', e => { if (e.persisted) location.reload(); });
load().catch(e => message(e.message, true));

function spoolmanConnection() { return $('#spoolman-enabled').checked ? { host: $('#spoolman-host').value.trim(), port: Number($('#spoolman-port').value), ...($('#spoolman-browser-url').value.trim() ? { browserUrl: $('#spoolman-browser-url').value.trim() } : {}) } : null; }
function spoolmanChanged() { return JSON.stringify(spoolmanConnection()) !== JSON.stringify(configuration?.spoolman?.connection ?? null); }
function spoolmanFields() {
  const enabled = $('#spoolman-enabled').checked, canManage = configuration?.canManage && !!configuration.spoolman;
  $('#spoolman-host').disabled = !enabled || !canManage; $('#spoolman-port').disabled = !enabled || !canManage;
  $('#spoolman-browser-url').disabled = !enabled || !canManage;
  $('#spoolman-host').required = enabled; $('#spoolman-port').required = enabled;
  $('#spoolman-test').disabled = !enabled || !canManage;
  $('#spoolman-confirm-field').hidden = !configuration?.spoolman?.connection || !spoolmanChanged();
}
function renderSpoolman() {
  const state = configuration.spoolman;
  $('#spoolman-enabled').checked = !!state?.connection;
  $('#spoolman-host').value = state?.connection?.host ?? '';
  $('#spoolman-port').value = state?.connection?.port ?? 7912;
  $('#spoolman-browser-url').value = state?.connection?.browserUrl ?? '';
  $('#spoolman-confirm').checked = false;
  $('#spoolman-enabled').disabled = !configuration.canManage || !state;
  $('#spoolman-save').disabled = !configuration.canManage || !state;
  $('#spoolman-status').textContent = state?.connection ? `Saved: ${state.connection.host}:${state.connection.port}` : 'Spoolman is not connected.';
  $('#spoolman-cfsync-warning').hidden = state?.cfsyncCompatible !== false;
  spoolmanFields();
}
for (const id of ['spoolman-enabled', 'spoolman-host', 'spoolman-port', 'spoolman-browser-url']) $('#' + id).addEventListener('input', () => { $('#spoolman-confirm').checked = false; spoolmanFields(); });
$('#spoolman-test').onclick = () => { if (!$('#spoolman-form').reportValidity()) return; attempt($('#spoolman-test'), async () => { $('#spoolman-status').textContent = 'Checking Spoolman…'; const result = await api('/spoolman/probe', { connection: spoolmanConnection() }); $('#spoolman-status').textContent = result.detail; }, e => $('#spoolman-status').textContent = e.message); };
$('#spoolman-form').onsubmit = e => { e.preventDefault(); attempt($('#spoolman-save'), async () => {
  const result = await api('/spoolman/save', { connection: spoolmanConnection(), baseVersion: configuration.spoolman.version, confirmChange: $('#spoolman-confirm').checked });
  configuration.spoolman = result.spoolman; renderSpoolman(); message('Spoolman connection saved. The dashboard will refresh inventory automatically.');
}, e => $('#spoolman-status').textContent = e.message); };
