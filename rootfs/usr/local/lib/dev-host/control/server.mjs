// node-dev-host control node.
//
// A small HTTP server, started by `dev-host control`. It lists the node-dev-host containers (those
// labelled node-dev-host.port) through the Docker Engine API on a unix socket, reads each one's build
// state from its own /__dev-host/status.json, runs the fixed set of actions on them, and serves the
// React dashboard built into control/ui/.
//
// No npm dependencies: node:http talks to the socket directly. The Docker socket is root-equivalent on
// the host, so every request passes the guards in order (Host, then Origin and the control header for
// state changes, then read-only mode), and every action first checks that the target carries the
// node-dev-host.port label. See README "Control node".

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createDockerClient, DockerUnavailable, dockerMessage, HttpError } from './docker.mjs';

const env = process.env;
const PORT = Number(env.HTTP_PORT) > 0 ? Number(env.HTTP_PORT) : 8080;
const SOCKET = env.DOCKER_SOCKET || '/var/run/docker.sock';
const { dockerRaw } = createDockerClient(SOCKET);
const READONLY = /^(1|true|yes|on)$/i.test(env.CONTROL_READONLY || '');
const ALLOWED_HOSTS = new Set([
  '127.0.0.1', 'localhost', '[::1]',
  ...(env.CONTROL_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
]);
const UI_DIR = '/usr/local/lib/dev-host/control/ui';
const PORT_LABEL = 'node-dev-host.port';
const CONTROL_HEADER = 'x-dev-host-control';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ACTIONS = new Set(['start', 'stop', 'restart', 'rebuild']);
const BUILD_STATES = new Set(['starting', 'building', 'ok', 'failed', 'waiting']);
const UNKNOWN_BUILD = Object.freeze({ state: 'unknown', builds: null, failures: null, finishedAt: null });
const MAX_TAIL = 1000;
const DEFAULT_TAIL = 200;

const log = (...parts) => console.log(`[control ${new Date().toISOString().slice(11, 19)}]`, ...parts);

const enc = (name) => encodeURIComponent(name);

// Returns the container's inspect document when it exists and carries the port label, otherwise throws.
// Every action and every logs request goes through here, so a name outside the label scope never reaches Docker.
async function requireTarget(name) {
  const r = await dockerRaw('GET', `/containers/${enc(name)}/json`);
  if (r.status === 404) throw new HttpError(404, `container not found: ${name}`);
  if (r.status !== 200) throw new HttpError(502, dockerMessage(r));
  const info = JSON.parse(r.body.toString('utf8'));
  if (!info.Config?.Labels?.[PORT_LABEL]) {
    throw new HttpError(403, `container ${name} is not managed: it has no ${PORT_LABEL} label`);
  }
  return info;
}

// ---- container list and build state ---------------------------------------------

function httpPortOf(info) {
  const entry = (info.Config?.Env || []).find((e) => e.startsWith('HTTP_PORT='));
  const port = entry ? Number(entry.slice('HTTP_PORT='.length)) : 8080;
  return port > 0 ? port : 8080;
}

// Reads /__dev-host/status.json from the container's own IP. A timeout or any error means "unknown" for
// that row only. Stopped containers are not probed.
async function probeBuild(info) {
  const ip = Object.values(info.NetworkSettings?.Networks || {}).map((n) => n.IPAddress).find(Boolean);
  if (!ip) return { ...UNKNOWN_BUILD };
  try {
    const res = await fetch(`http://${ip}:${httpPortOf(info)}/__dev-host/status.json`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return { ...UNKNOWN_BUILD };
    const status = await res.json();
    const count = (v) => (Number.isInteger(v) ? v : null);
    return {
      state: BUILD_STATES.has(status.state) ? status.state : 'unknown',
      builds: count(status.builds),
      failures: count(status.failures),
      finishedAt: typeof status.finishedAt === 'string' ? status.finishedAt : null,
    };
  } catch {
    return { ...UNKNOWN_BUILD };
  }
}

async function listContainers() {
  const filters = encodeURIComponent(JSON.stringify({ label: [PORT_LABEL] }));
  const r = await dockerRaw('GET', `/containers/json?all=1&filters=${filters}`);
  if (r.status !== 200) throw new HttpError(502, dockerMessage(r));
  const summaries = JSON.parse(r.body.toString('utf8'));

  const rows = await Promise.all(summaries.map(async (c) => {
    const name = (c.Names?.[0] || '').replace(/^\//, '');
    let info;
    try {
      const detail = await dockerRaw('GET', `/containers/${enc(name)}/json`);
      if (detail.status !== 200) return null; // removed between the list and the inspect
      info = JSON.parse(detail.body.toString('utf8'));
    } catch (err) {
      if (err instanceof DockerUnavailable) throw err;
      return null;
    }
    const running = info.State?.Running === true;
    return {
      name,
      id: c.Id.slice(0, 12),
      image: c.Image,
      port: Number(c.Labels?.[PORT_LABEL]),
      state: c.State,
      health: info.State?.Health?.Status ?? null,
      build: running ? await probeBuild(info) : { ...UNKNOWN_BUILD },
    };
  }));
  return rows.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

// ---- logs -------------------------------------------------------------------------

// Docker sends logs of a container without a TTY as frames: an 8-byte header (stream type, 3 zero bytes,
// big-endian payload size) followed by the payload.
function demuxFrames(buf) {
  const parts = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    const size = buf.readUInt32BE(off + 4);
    parts.push(buf.subarray(off + 8, off + 8 + size));
    off += 8 + size;
  }
  return Buffer.concat(parts).toString('utf8');
}

function clampTail(raw) {
  const n = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(n)) return DEFAULT_TAIL;
  return Math.min(Math.max(n, 1), MAX_TAIL);
}

async function containerLogs(name, rawTail) {
  const info = await requireTarget(name);
  const tail = clampTail(rawTail);
  const r = await dockerRaw('GET', `/containers/${enc(name)}/logs?stdout=1&stderr=1&tail=${tail}`);
  if (r.status !== 200) throw new HttpError(502, dockerMessage(r));
  const text = info.Config?.Tty ? r.body.toString('utf8') : demuxFrames(r.body);
  // Docker applies `tail` per stream, so trim the combined text to the requested count here.
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-tail).join('\n') + '\n';
}

// ---- actions ------------------------------------------------------------------------

async function lifecycle(name, action) {
  const info = await requireTarget(name);
  if (action === 'rebuild') {
    if (info.State?.Running !== true) {
      throw new HttpError(409, `container ${name} is not running; start it before rebuilding`);
    }
    return rebuild(name);
  }
  const r = await dockerRaw('POST', `/containers/${enc(name)}/${action}`);
  if (r.status === 204 || r.status === 304) return null; // 304: already in that state
  throw new HttpError(r.status === 409 ? 409 : 500, dockerMessage(r));
}

// The command is a constant. `dev-host rebuild` only touches a trigger file, so the exec finishes at once.
async function rebuild(name) {
  const created = await dockerRaw('POST', `/containers/${enc(name)}/exec`, {
    body: { AttachStdout: false, AttachStderr: false, Cmd: ['dev-host', 'rebuild'] },
  });
  if (created.status !== 201) throw new HttpError(500, dockerMessage(created));
  const { Id } = JSON.parse(created.body.toString('utf8'));
  const started = await dockerRaw('POST', `/exec/${Id}/start`, { body: { Detach: true, Tty: false } });
  if (started.status !== 200) throw new HttpError(500, dockerMessage(started));
  const deadline = Date.now() + 5000;
  for (;;) {
    const exec = JSON.parse((await dockerRaw('GET', `/exec/${Id}/json`)).body.toString('utf8'));
    if (exec.Running === false) {
      if (exec.ExitCode !== 0) throw new HttpError(500, `dev-host rebuild exited with code ${exec.ExitCode}`);
      return null;
    }
    if (Date.now() > deadline) return null; // still running: the build is queued either way
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function removeContainer(name) {
  await requireTarget(name);
  const r = await dockerRaw('DELETE', `/containers/${enc(name)}?force=1`);
  if (r.status === 204) return null;
  throw new HttpError(r.status === 404 ? 404 : 500, dockerMessage(r));
}

// ---- health ------------------------------------------------------------------------

async function health() {
  try {
    const r = await dockerRaw('GET', '/_ping', { timeout: 2000 });
    if (r.status === 200) return [200, { state: 'ok', role: 'control' }];
    return [503, { state: 'error', role: 'control', error: `Docker answered HTTP ${r.status}` }];
  } catch (err) {
    return [503, { state: 'error', role: 'control', error: err.message }];
  }
}

// ---- HTTP plumbing -----------------------------------------------------------------

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function sendError(res, err) {
  if (!(err instanceof HttpError)) log('internal error:', err);
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof HttpError ? err.message : 'internal error';
  if (!res.headersSent) sendJson(res, status, { error: message });
}

// The Host header must name a loopback address or an entry from CONTROL_ALLOWED_HOSTS (blocks DNS rebinding).
function hostAllowed(hostHeader) {
  if (!hostHeader || /[\s@/]/.test(hostHeader)) return false;
  try {
    return ALLOWED_HOSTS.has(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return false;
  }
}

// A state-changing request must come from the same host it was sent to.
function originMatches(req) {
  const origin = req.headers.origin;
  if (!origin) return false;
  try {
    return new URL(origin).host.toLowerCase() === String(req.headers.host).toLowerCase();
  } catch {
    return false;
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

// Serves the built dashboard. Hashed assets are cached for a year, index.html is never cached, and
// any other non-API path falls back to index.html so client-side routes work.
async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET, HEAD' });
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return sendJson(res, 400, { error: 'malformed path' });
  }
  const indexFile = path.join(UI_DIR, 'index.html');
  const file = path.resolve(UI_DIR, '.' + rel);
  if (file !== UI_DIR && !file.startsWith(UI_DIR + path.sep)) return sendJson(res, 400, { error: 'malformed path' });
  let target = file;
  let stat = null;
  try { stat = await fs.promises.stat(file); } catch { stat = null; }
  if (!stat?.isFile()) target = indexFile;
  try { await fs.promises.access(target); } catch {
    return sendText(res, 404, 'The dashboard is not built into this image. Run the control-ui build first.\n');
  }
  const isIndex = target === indexFile;
  const hashed = target !== indexFile && rel.startsWith('/assets/');
  const cache = hashed ? 'public, max-age=31536000, immutable' : 'no-cache';
  res.writeHead(200, {
    'content-type': MIME[path.extname(target)] || 'application/octet-stream',
    'cache-control': isIndex ? 'no-cache' : cache,
    'x-content-type-options': 'nosniff',
    'content-length': (await fs.promises.stat(target)).size,
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(target).pipe(res);
  return undefined;
}

// /api/* routes: a fixed table. Anything else is a JSON 404, so no Docker API path is forwarded.
async function serveApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'containers', name?, action?]
  if (parts.length === 2 && parts[1] === 'containers') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET' });
    return sendJson(res, 200, { readOnly: READONLY, containers: await listContainers() });
  }
  if (parts[1] !== 'containers' || parts.length < 3 || parts.length > 4) {
    return sendJson(res, 404, { error: 'not found' });
  }
  let name;
  try {
    name = decodeURIComponent(parts[2]);
  } catch {
    return sendJson(res, 400, { error: 'malformed container name' });
  }
  if (!NAME_RE.test(name)) return sendJson(res, 400, { error: `invalid container name: ${name}` });

  if (parts.length === 3) {
    if (req.method !== 'DELETE') return sendJson(res, 405, { error: 'method not allowed' }, { allow: 'DELETE' });
    await removeContainer(name);
    return sendJson(res, 200, { ok: true });
  }

  const action = parts[3];
  if (action === 'logs') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET' });
    const text = await containerLogs(name, url.searchParams.get('tail'));
    return sendText(res, 200, text);
  }
  if (!ACTIONS.has(action)) return sendJson(res, 400, { error: `action not supported: ${action}` });
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
  await lifecycle(name, action);
  return sendJson(res, action === 'rebuild' ? 202 : 200, { ok: true, action, queued: action === 'rebuild' });
}

async function handle(req, res) {
  const hostHeader = req.headers.host || '';
  // 1. Host allowlist, for every request.
  if (!hostAllowed(hostHeader)) return sendJson(res, 403, { error: `host not allowed: ${hostHeader}` });

  const url = new URL(req.url || '/', 'http://localhost');
  const stateChanging = req.method === 'POST' || req.method === 'DELETE';
  if (stateChanging) {
    // 2. Origin must match the host, and the custom header must be present.
    if (!originMatches(req)) return sendJson(res, 403, { error: 'cross-origin request rejected' });
    if (req.headers[CONTROL_HEADER] !== '1') {
      return sendJson(res, 403, { error: `missing X-Dev-Host-Control header` });
    }
    // 3. Read-only mode rejects every state change.
    if (READONLY) return sendJson(res, 403, { error: 'read-only mode: changes are disabled' });
  }

  if (url.pathname === '/__dev-host/status.json') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
    const [status, body] = await health();
    return sendJson(res, status, body);
  }
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return serveApi(req, res, url);
  return serveStatic(req, res, url.pathname);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => sendError(res, err));
});

server.listen(PORT, '0.0.0.0', () => {
  log(`listening on :${PORT}; docker socket ${SOCKET}; read-only ${READONLY}; allowed hosts ${[...ALLOWED_HOSTS].join(', ')}`);
  log(fs.existsSync(path.join(UI_DIR, 'index.html')) ? `dashboard from ${UI_DIR}` : `dashboard not built (${UI_DIR} missing)`);
});
