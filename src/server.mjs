import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readJsonBody } from './http.mjs';
import { CommandError } from './commands.mjs';
import { JobFacts } from './job-facts.mjs';
import { integrationRoute } from './integrations-api.mjs';

const hash = value => createHash('sha256').update(value).digest();
function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(body));
}
export function createApiServer({ token, telemetry, commands, store, controlsEnabled = false, localBrowser, allowBearer = true, cameras, cfsync, settings, ...integrations }) {
  const expected = hash(`Bearer ${token}`);
  const handlers = new Set();
  const jobFacts = integrations.jobFacts ?? new JobFacts({ telemetry });
  const server = createServer((req, res) => {
    const work = handle(req, res);
    handlers.add(work);
    work.finally(() => handlers.delete(work)).catch(() => {});
  });
  async function handle(req, res) {
    try {
      if (req.url === '/healthz' && req.method === 'GET') return json(res, 200, { status: 'ok', service: 'print-companion' });
      if (await localBrowser?.route(req, res)) return;
      let actor = localBrowser?.authenticate(req);
      if (!actor) {
        if (!allowBearer || !timingSafeEqual(hash(req.headers.authorization ?? ''), expected)) return json(res, 401, { error: 'Authentication required' });
        // The integration credential remains server-to-server; local UI uses an isolated session.
        if (req.headers.origin || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Browser-origin bearer requests are not supported' });
        actor = 'home-assistant';
      }
      if (await settings?.route(req, res, { json, canManage: actor === 'local-browser' || actor === 'lan-browser' && localBrowser?.lanAccess === 'paired' })) return;
      if (await cfsync?.route(req,res)) return;
      if (await integrationRoute(req, res, { ...integrations, spoolman: integrations.spoolmanSettings ? integrations.spoolmanSettings.client : integrations.spoolman, cfsync, json, actor })) return;
      const facts = /^\/api\/v1\/printers\/([a-z][a-z0-9_-]{0,31})\/job-facts$/.exec(req.url);
      if (req.method === 'GET' && facts) return json(res, 200, await jobFacts.get(facts[1]));
      const camera = /^\/api\/v1\/cameras\/([a-z][a-z0-9_-]{0,31})\/offer$/.exec(req.url);
      if (req.method === 'POST' && camera && cameras) {
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') throw new CommandError('Expected application/json', 415);
        if (Number(req.headers['content-length']) > 32768) throw new CommandError('Request exceeds size limit', 413);
        let body;
        try { body = await readJsonBody(req, 32768); } catch { throw new CommandError('Invalid or oversized video offer'); }
        return json(res, 200, await cameras.offer(camera[1], body));
      }
      if (req.method === 'GET' && req.url === '/api/v1/fleet') {
        const now = Date.now();
        const printers = [...telemetry.values()].map(p => {
          const snapshot = p.snapshot(now);
          if (!controlsEnabled) snapshot.controls = Object.fromEntries(Object.keys(snapshot.controls).map(k => [k, false]));
          return snapshot;
        });
        return json(res, 200, { schemaVersion: 1, observedAt: now, controlsEnabled, printers });
      }
      if (req.method === 'GET' && req.url === '/api/v1/actions') return json(res, 200, { actions: store.recentActions() });
      const match = /^\/api\/v1\/actions\/([A-Za-z0-9_-]{8,128})$/.exec(req.url);
      const resolution = /^\/api\/v1\/actions\/([A-Za-z0-9_-]{8,128})\/resolve$/.exec(req.url);
      const missing = /^\/api\/v1\/actions\/([A-Za-z0-9_-]{8,128})\/resolve-missing$/.exec(req.url);
      if (req.method === 'GET' && match) {
        const action = commands.get(match[1]);
        return action ? json(res, 200, action) : json(res, 404, { error: 'Action not found' });
      }
      if (req.method === 'POST' && (req.url === '/api/v1/actions' || resolution || missing)) {
        if (!resolution && !missing && !controlsEnabled) return json(res, 409, { error: 'Companion is staged in read-only mode; controls are disabled' });
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return json(res, 415, { error: 'Expected application/json' });
        if (Number(req.headers['content-length']) > 32_768) return json(res, 413, { error: 'Request exceeds size limit' });
        let body;
        try { body = await readJsonBody(req, 32_768); } catch { return json(res, 400, { error: 'Invalid or oversized JSON request' }); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'Expected request object' });
        if (missing) return json(res, 200, commands.resolveMissing({ ...body, id: missing[1], actor }));
        if (resolution) return json(res, 200, commands.resolve({ id: resolution[1], printerId: body.printerId, confirmed: body.confirmed, note: body.note, actor }));
        const action = commands.submit({ id: body.id, action: body.action, target: body.target, expectedJobId: body.expectedJobId, actor });
        return json(res, 202, action);
      }
      json(res, 404, { error: 'Not found' });
    } catch (error) {
      if (!res.headersSent) json(res, error instanceof CommandError ? error.status : 500, { error: error instanceof CommandError ? error.message : 'Internal service error' });
      else res.destroy();
    }
  }
  // Connection close does not cancel asynchronous work already accepted by a handler.
  server.drainHandlers = async () => {
    while (handlers.size) await Promise.allSettled([...handlers]);
  };
  server.requestTimeout = 10_000;
  server.headersTimeout = 5000;
  server.keepAliveTimeout = 5000;
  return server;
}
