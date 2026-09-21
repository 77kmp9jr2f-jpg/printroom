import { CommandError } from './commands.mjs';
import { readJsonBody } from './http.mjs';

async function requestBody(req) {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new CommandError('Expected application/json', 415);
  if (Number(req.headers['content-length']) > 32768) throw new CommandError('Request exceeds size limit', 413);
  let body;
  try { body = await readJsonBody(req, 32768); } catch { throw new CommandError('Invalid or oversized JSON request'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CommandError('Expected request object');
  return body;
}

// Called only after the server authenticates a local browser session or integration bearer.
export async function integrationRoute(req, res, { json, projects, inventory, assignments, spoolman, spoolmanSettings, cfsync, inventoryWritesEnabled = false, actor = 'home-assistant' }) {
  if (!projects || !inventory || !assignments) return false;
  const send = (body, status = 200) => { json(res, status, body); return true; };
  const spoolmanRevision = spoolmanSettings?.version ?? null;
  const id = '[A-Za-z0-9_-]{8,128}';
  const project = new RegExp(`^/api/v1/projects/(${id})(/history)?$`).exec(req.url);
  const imported = new RegExp(`^/api/v1/imports/(${id})(/commit)?$`).exec(req.url);
  if (req.method === 'GET') {
    if (req.url === '/api/v1/integrations') return send({ spoolmanConfigured: !!spoolman, spoolmanRevision, spoolmanUrl: spoolman && Object.hasOwn(spoolman, 'browserUrl') ? spoolman.browserUrl : spoolman?.base?.replace(/\/api\/v1$/, '/') ?? null, cfsyncConfigured: !!cfsync, inventoryWritesEnabled, nativeSolverVerified: false });
    if (req.url === '/api/v1/projects') return send({ projects: projects.list() });
    if (project) { const value = projects.get(project[1]); return value ? send(project[2] ? { history: projects.history(project[1]) } : value) : send({ error: 'Project not found' }, 404); }
    if (req.url === '/api/v1/assignments') return send({ ...assignments.current(), spoolmanRevision });
    if (req.url === '/api/v1/assignments/history') return send({ history: assignments.history() });
    if (req.url === '/api/v1/imports') return send({ imports: inventory.list().map(r => ({ ...r, spoolmanRevision })), spoolmanRevision });
    if (imported && !imported[2]) { const value = inventory.get(imported[1]); return value ? send({ ...value, spoolmanRevision }) : send({ error: 'Import not found' }, 404); }
    if (req.url === '/api/v1/spools' || req.url.startsWith('/api/v1/spools?')) {
      const params = new URL(req.url, 'http://local').searchParams;
      const offset = Number(params.get('offset') ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0 || [...params.keys()].some(k => k !== 'offset')) throw new CommandError('Invalid inventory offset');
      if (!spoolman) throw new CommandError('Spoolman is not configured', 503);
      const spools = await spoolman.listPage('spool', offset);
      if (spoolmanSettings && spoolmanRevision !== spoolmanSettings.version) throw new CommandError('Spoolman connection changed during inventory loading. Refresh inventory.',409);
      return send({ observedAt: Date.now(), source: 'spoolman', spoolmanRevision, spools, nextOffset: spools.length === 100 ? offset + 100 : null });
    }
  }
  if (req.method !== 'POST') return false;
  const routes = ['/api/v1/projects', '/api/v1/assignments', '/api/v1/imports/preview'];
  if (!routes.includes(req.url) && !(imported && imported[2])) return false;
  if (imported?.[2] && !inventoryWritesEnabled) throw new CommandError('Inventory writes are disabled; review is available without changing Spoolman', 409);
  const body = await requestBody(req);
  if (spoolmanSettings && req.url !== '/api/v1/projects' && (body.expectedSpoolmanVersion !== spoolmanSettings.version || spoolmanRevision !== spoolmanSettings.version)) throw new CommandError('Spoolman connection changed or its revision is missing. Refresh inventory before saving.',409);
  if (req.url === '/api/v1/projects') return send(projects.save(body.handoff, { actor, baseVersion: body.baseVersion, confirmReview: body.confirmReview === true }));
  if (req.url === '/api/v1/assignments') {
    if(cfsync)throw new CommandError('Manage spool links in CFSync to keep one source of associations',409);
    return send({ ...await assignments.assign({ ...body, actor }), spoolmanRevision });
  }
  if (req.url === '/api/v1/imports/preview') return send({ ...inventory.preview(body), spoolmanRevision });
  return send({ ...await inventory.commit({ id: imported[1], confirmed: body.confirmed }), spoolmanRevision });
}
