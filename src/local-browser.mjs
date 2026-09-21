import { randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommandError } from './commands.mjs';
import { readJsonBody } from './http.mjs';

const equal = (a, b) => typeof a === 'string' && /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const hash = value => createHash('sha256').update(value).digest();
export class BrowserPairing {
  constructor({ now = Date.now, ttlMs = 600000, maxAttempts = 5 } = {}) {
    this.now = now; this.ttlMs = ttlMs; this.maxAttempts = maxAttempts; this.pending = null;
  }
  create() {
    const code = String(randomInt(100000000)).padStart(8, '0'), expiresAt = this.now() + this.ttlMs;
    this.pending = { digest: hash(code), expiresAt, attempts: 0 };
    return { code, expiresAt };
  }
  consume(code) {
    const p = this.pending;
    if (!p || p.expiresAt <= this.now() || p.attempts >= this.maxAttempts) return false;
    p.attempts++;
    if (typeof code !== 'string' || !/^\d{8}$/.test(code) || !timingSafeEqual(p.digest, hash(code))) return false;
    this.pending = null; return true;
  }
}
export class LocalBrowser {
  constructor({ port = 7988, assetDir, ttlMs = 12 * 60 * 60 * 1000, access = 'localhost', lanHost, pairing, lanAccess = 'paired' } = {}) {
    if (!['localhost', 'lan'].includes(access) || !['paired', 'open'].includes(lanAccess) || (access === 'lan' && (!lanHost || (lanAccess === 'paired' && !pairing)))) throw new Error('Invalid browser access configuration');
    this.access = access; this.lanAccess = lanAccess; this.pairing = pairing; this.lanUrl = lanHost ? `http://${lanHost}:${port}/` : null;
    // LAN and loopback are different listeners. A client-supplied Host cannot choose its trust level.
    this.hosts = new Set(access === 'lan' ? [`${lanHost}:${port}`] : [`localhost:${port}`, `127.0.0.1:${port}`]);
    this.cookieName = `print_session_${port}`;
    this.cookieId = req => new RegExp(`(?:^|;\\s*)${this.cookieName}=([a-f0-9]{64})(?:;|$)`).exec(req.headers.cookie ?? '')?.[1];
    this.sessions = new Map(); this.ttlMs = ttlMs; this.assetDir = assetDir;
    this.assets = new Map([['/', ['index.html', 'text/html']], ['/settings', ['settings.html', 'text/html']], ['/settings.js', ['settings.js', 'text/javascript']], ['/app.js', ['app.js', 'text/javascript']],
      ['/color-library.js', ['color-library.js', 'text/javascript']], ['/color-library-view.js', ['color-library-view.js', 'text/javascript']], ['/ui-core.js', ['ui-core.js', 'text/javascript']], ['/camera.js', ['camera.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']]]);
  }
  checkOrigin(req, required = false) {
    const origin = `http://${req.headers.host}`;
    if (!this.hosts.has(req.headers.host) || (req.headers.origin ? req.headers.origin !== origin : required) || req.headers['sec-fetch-site'] === 'cross-site') {
      throw new CommandError('Browser origin does not match this listener', 403);
    }
  }
  async route(req, res) {
    this.checkOrigin(req);
    if (req.url === '/api/pairing/create' && req.method === 'POST') {
      if (this.access !== 'localhost' || this.lanAccess !== 'paired' || !this.pairing || !this.lanUrl) throw new CommandError('Pairing is unavailable for this listener', 403);
      if (!this.authenticate(req)) throw new CommandError('Authentication required', 401);
      const pairing = this.pairing.create();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ...pairing, lanUrl: this.lanUrl })); return true;
    }
    if (req.url === '/api/session' && req.method === 'POST') {
      this.checkOrigin(req, true);
      const now = Date.now();
      for (const [id, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(id);
      let id = this.cookieId(req); let session = this.sessions.get(id);
      if (!session || session.host !== req.headers.host) {
        if (this.access === 'lan' && this.lanAccess === 'paired') {
          let code;
          if (req.headers['content-type']) {
            if (req.headers['content-type'].split(';')[0].trim() !== 'application/json') throw new CommandError('Expected application/json', 415);
            if (Number(req.headers['content-length']) > 2048) throw new CommandError('Request exceeds size limit', 413);
            let body;
            try { body = await readJsonBody(req, 2048); } catch { throw new CommandError('Invalid pairing request'); }
            code = body?.code;
          }
          if (!code || !this.pairing.consume(code)) {
            res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify({ pairingRequired: true, error: code ? 'Code is invalid, expired or already used. Create a new code on the host computer.' : 'Pair this browser using a code from the dashboard on the host computer.' })); return true;
          }
        }
        if (this.sessions.size >= 128) this.sessions.delete(this.sessions.keys().next().value);
        id = randomBytes(32).toString('hex');
        session = { csrf: randomBytes(32).toString('hex'), host: req.headers.host, expiresAt: now + this.ttlMs };
        this.sessions.set(id, session);
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store',
        'Set-Cookie': `${this.cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor((session.expiresAt - now) / 1000)}` });
      res.end(JSON.stringify({ csrf: session.csrf, expiresAt: session.expiresAt, access: this.access, lanUrl: this.lanUrl, pairingRequired: this.lanAccess === 'paired' })); return true;
    }
    const assetPath = req.url.split('?', 1)[0];
    if (req.method === 'GET' && this.assetDir && this.assets.has(assetPath)) {
      this.checkOrigin(req);
      const [name, mime] = this.assets.get(assetPath);
      const content = readFileSync(join(this.assetDir, name));
      res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" });
      res.end(content); return true;
    }
    return false;
  }
  authenticate(req) {
    const id = this.cookieId(req);
    if (!id && this.access === 'lan' && this.lanAccess === 'open' && ['GET', 'HEAD'].includes(req.method)) {
      this.checkOrigin(req);
      return 'lan-browser';
    }
    if (!id) return null;
    this.checkOrigin(req, !['GET', 'HEAD'].includes(req.method));
    const session = this.sessions.get(id);
    if (!session || session.expiresAt <= Date.now() || session.host !== req.headers.host) {
      this.sessions.delete(id); throw new CommandError('Browser session expired', 401);
    }
    if (!['GET', 'HEAD'].includes(req.method) && !equal(req.headers['x-print-csrf'], session.csrf)) throw new CommandError('Browser request verification failed', 403);
    return this.access === 'lan' ? 'lan-browser' : 'local-browser';
  }
}
