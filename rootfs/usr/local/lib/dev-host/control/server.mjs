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
import os from 'node:os';
import path from 'node:path';
import { createDiscovery } from './discovery.mjs';
import { createDockerClient, DockerUnavailable, dockerMessage, HttpError } from './docker.mjs';
import { addNodeRecord, createBody, deleteNodeRecord, nextPort, parseAllowedImages, parseWorkspaceRoots, validateNode, validateNpmRegistry } from './nodes.mjs';
import { createOperationTracker } from './operations.mjs';
import { clearWindow, extendWindow, runStartupPass, scheduleState, WEEK_MS } from './schedule.mjs';
import { createStore } from './store.mjs';
import { createSelfUpgrade, isLatestTag } from './upgrade.mjs';

const env = process.env;
const PORT = Number(env.HTTP_PORT) > 0 ? Number(env.HTTP_PORT) : 8080;
const SOCKET = env.DOCKER_SOCKET || '/var/run/docker.sock';
const docker = createDockerClient(SOCKET);
const { dockerRaw } = docker;
const READONLY = /^(1|true|yes|on)$/i.test(env.CONTROL_READONLY || '');
// Standby: a candidate started by a self-upgrade. It answers only its health check until the running
// control node hands the node store over (see upgrade.mjs).
const STANDBY = /^(1|true|yes|on)$/i.test(env.CONTROL_STANDBY || '');
// Self-upgrade follows a `latest` image. Set CONTROL_SELF_UPDATE=false to keep the running version.
const SELF_UPDATE = !/^(0|false|no|off)$/i.test(env.CONTROL_SELF_UPDATE || 'true');
const SELF_UPDATE_HOURS = Number(env.CONTROL_SELF_UPDATE_INTERVAL_HOURS) > 0 ? Number(env.CONTROL_SELF_UPDATE_INTERVAL_HOURS) : 6;
const DATA_DIR = env.CONTROL_DATA_DIR || '/var/lib/dev-host/control';
const ALLOWED_IMAGES = parseAllowedImages(env.CONTROL_ALLOWED_IMAGES || '');
const WORKSPACE_ROOTS = parseWorkspaceRoots(env.CONTROL_WORKSPACE_ROOTS || '');
const ALLOWED_HOSTS = new Set([
  '127.0.0.1', 'localhost', '[::1]',
  ...(env.CONTROL_ALLOWED_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean),
]);
const UI_DIR = '/usr/local/lib/dev-host/control/ui';
const PORT_LABEL = 'node-dev-host.port';
const CONTROL_HEADER = 'x-dev-host-control';
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ACTIONS = new Set(['start', 'stop', 'restart', 'rebuild', 'recreate']);
const BUILD_STATES = new Set(['starting', 'building', 'ok', 'failed', 'waiting']);
const UNKNOWN_BUILD = Object.freeze({ state: 'unknown', builds: null, failures: null, finishedAt: null });
const MAX_TAIL = 1000;
const DEFAULT_TAIL = 200;

const log = (...parts) => console.log(`[control ${new Date().toISOString().slice(11, 19)}]`, ...parts);
const store = createStore({ dir: DATA_DIR, readOnly: READONLY, log: (...parts) => log(...parts) });
const operations = createOperationTracker();
const discovery = createDiscovery({ docker, store, allowedImages: ALLOWED_IMAGES, workspaceRoots: WORKSPACE_ROOTS, log });
const upgrade = createSelfUpgrade({ docker, store, operations, dataDir: DATA_DIR, selfId: os.hostname(), log });

const enc = (name) => encodeURIComponent(name);

async function inspectContainer(name) {
  const r = await dockerRaw('GET', `/containers/${enc(name)}/json`);
  if (r.status === 404) return null;
  if (r.status !== 200) throw new HttpError(502, dockerMessage(r));
  return JSON.parse(r.body.toString('utf8'));
}

async function resolveTarget(name, action) {
  const [container, records] = await Promise.all([inspectContainer(name), store.getNodes()]);
  const record = records.find((node) => node.name === name) || null;
  if (container && !container.Config?.Labels?.[PORT_LABEL] && !record) {
    throw new HttpError(403, `container ${name} is not managed: it has no ${PORT_LABEL} label`);
  }
  if (!container && !record) throw new HttpError(404, `container not found: ${name}`);
  if (!container && !['start', 'recreate', 'delete'].includes(action)) {
    throw new HttpError(409, `node ${name} has no container`);
  }
  return { container, record };
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

async function labelledSummaries() {
  const filters = encodeURIComponent(JSON.stringify({ label: [PORT_LABEL] }));
  const r = await dockerRaw('GET', `/containers/json?all=1&filters=${filters}`);
  if (r.status !== 200) throw new HttpError(502, dockerMessage(r));
  return JSON.parse(r.body.toString('utf8'));
}

async function listContainers() {
  const summaries = await labelledSummaries();
  const [records, persistence, settings] = await Promise.all([store.getNodes(), store.status(), store.getSettings()]);
  const byName = new Map(records.map((record) => [record.name, record]));

  const rows = await Promise.all(summaries.map(async (c) => {
    const name = (c.Names?.[0] || '').replace(/^\//, '');
    let info = null;
    try {
      const detail = await dockerRaw('GET', `/containers/${enc(name)}/json`);
      if (detail.status !== 200) return null; // removed between the list and the inspect
      info = JSON.parse(detail.body.toString('utf8'));
    } catch (err) {
      if (err instanceof DockerUnavailable) throw err;
      return null;
    }
    const running = info.State?.Running === true;
    const record = byName.get(name);
    const operation = operations.get(name);
    return {
      name,
      id: c.Id.slice(0, 12),
      image: record?.image || c.Image,
      port: record?.port ?? Number(c.Labels?.[PORT_LABEL]),
      state: c.State,
      health: info.State?.Health?.Status ?? null,
      build: running ? await probeBuild(info) : { ...UNKNOWN_BUILD },
      registered: Boolean(record),
      schedule: scheduleState(record?.autoStartUntil),
      operation: operation?.phase ? { phase: operation.phase, since: operation.since } : null,
      error: operation?.error ?? null,
      warning: operation?.warning ?? null,
    };
  }));
  const listed = rows.filter(Boolean);
  const names = new Set(listed.map((row) => row.name));
  for (const record of records) {
    if (names.has(record.name)) continue;
    const operation = operations.get(record.name);
    listed.push({
      name: record.name,
      id: `node:${record.name}`,
      image: record.image,
      port: record.port,
      state: 'not created',
      health: null,
      build: { ...UNKNOWN_BUILD },
      registered: true,
      schedule: scheduleState(record.autoStartUntil),
      operation: operation?.phase ? { phase: operation.phase, since: operation.since } : null,
      error: operation?.error ?? null,
      warning: operation?.warning ?? null,
    });
  }
  listed.sort((a, b) => a.name.localeCompare(b.name));
  return {
    containers: listed,
    persistence: {
      ...persistence,
      warning: persistence.warning || (persistence.mounted ? null : `node records are not on a separate mount at ${DATA_DIR}`),
    },
    nextPort: nextPort(records, summaries),
    settings: { npmRegistry: settings.npmRegistry ?? null },
  };
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
  const { container: info } = await resolveTarget(name, 'logs');
  if (!info) throw new HttpError(409, `node ${name} has no container`);
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

async function ensureStoreWritable() {
  if (!(await store.status()).writable) {
    throw new HttpError(503, `node records cannot be saved; check CONTROL_DATA_DIR at ${DATA_DIR}`);
  }
}

// The console-wide npm registry that new and recreated node containers receive as NPM_REGISTRY.
async function npmRegistrySetting() {
  return (await store.getSettings()).npmRegistry ?? null;
}

// A network named in an add request must already exist, so a typo fails at add time, not at start.
async function ensureNetworkExists(network) {
  const r = await dockerRaw('GET', `/networks/${enc(network)}`);
  if (r.status === 404) throw new HttpError(400, `network not found: ${network}`);
  if (r.status !== 200) throw new HttpError(502, dockerMessage(r));
}

function nodeHttpPort(record) {
  const value = Number(record.env?.HTTP_PORT);
  return value > 0 ? value : 8080;
}

async function startContainer(name) {
  const r = await dockerRaw('POST', `/containers/${enc(name)}/start`);
  if (r.status === 204 || r.status === 304) return null;
  throw new HttpError(r.status === 409 ? 409 : 500, dockerMessage(r));
}

async function createFromRecord(record, context, pullCache) {
  context.setPhase('pulling');
  if (!pullCache.has(record.image)) pullCache.set(record.image, docker.pullImage(record.image));
  const pulled = await pullCache.get(record.image);
  if (pulled.warning) context.setWarning(pulled.warning);
  context.setPhase('creating');
  const npmRegistry = await npmRegistrySetting();
  await docker.createContainer(record.name, createBody(record, { httpPort: nodeHttpPort(record), npmRegistry }));
  context.setPhase('starting');
  await startContainer(record.name);
  return { warning: pulled.warning };
}

function queueOperation(name, initialPhase, work) {
  void operations.run(name, initialPhase, work).catch((err) => log(`operation failed for ${name}: ${err.message || err}`));
}

async function setAutoStart(name, until) {
  await ensureStoreWritable();
  return store.update((document) => {
    const record = document.nodes.find((node) => node.name === name);
    if (!record) throw new HttpError(404, `node not found: ${name}`);
    record.autoStartUntil = until;
    return document;
  });
}

async function lifecycle(name, action, body = {}) {
  const { container, record } = await resolveTarget(name, action);
  if (action === 'recreate') {
    if (!record) throw new HttpError(409, `container ${name} is not registered; scan first`);
    queueOperation(name, 'pulling', async (context) => {
      context.setPhase('pulling');
      const pulled = await docker.pullImage(record.image);
      if (pulled.warning) context.setWarning(pulled.warning);
      if (container) {
        context.setPhase('removing');
        const removed = await dockerRaw('DELETE', `/containers/${enc(name)}?force=1`);
        if (removed.status !== 204 && removed.status !== 404) throw new HttpError(500, dockerMessage(removed));
      }
      context.setPhase('creating');
      const npmRegistry = await npmRegistrySetting();
      await docker.createContainer(name, createBody(record, { httpPort: nodeHttpPort(record), npmRegistry }));
      context.setPhase('starting');
      await startContainer(name);
      return { warning: pulled.warning };
    });
    return { queued: true };
  }
  if (action === 'start' && body.autoStart === true) {
    if (!record) throw new HttpError(409, `node ${name} is not registered`);
    await setAutoStart(name, new Date(Date.now() + WEEK_MS).toISOString());
  }
  if (action === 'start' && !container) {
    queueOperation(name, 'pulling', (context) => createFromRecord(record, context, new Map()));
    return { queued: true };
  }
  if (action === 'rebuild') {
    if (container.State?.Running !== true) {
      throw new HttpError(409, `container ${name} is not running; start it before rebuilding`);
    }
    return operations.run(name, null, () => rebuild(name));
  }
  if (action === 'start') return operations.run(name, 'starting', () => startContainer(name));
  return operations.run(name, null, async () => {
    const r = await dockerRaw('POST', `/containers/${enc(name)}/${action}`);
    if (r.status === 204 || r.status === 304) return null; // 304: already in that state
    throw new HttpError(r.status === 409 ? 409 : 500, dockerMessage(r));
  });
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
  const { container } = await resolveTarget(name, 'remove');
  if (!container) throw new HttpError(409, `node ${name} has no container`);
  return operations.run(name, 'removing', async () => {
    const r = await dockerRaw('DELETE', `/containers/${enc(name)}?force=1`);
    if (r.status === 204) return null;
    throw new HttpError(r.status === 404 ? 404 : 500, dockerMessage(r));
  });
}

// ---- health ------------------------------------------------------------------------

async function health() {
  try {
    const r = await dockerRaw('GET', '/_ping', { timeout: 2000 });
    if (r.status === 200) return [200, { state: 'ok', role: 'control', ...(STANDBY ? { standby: true } : {}) }];
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
  const known = err instanceof HttpError || Number.isInteger(err?.status);
  if (!known) log('internal error:', err);
  const status = known ? err.status : 500;
  const message = known ? err.message : 'internal error';
  if (!res.headersSent) sendJson(res, status, { error: message });
}

async function readJsonBody(req) {
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new HttpError(415, 'content type must be application/json');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= 16 * 1024) chunks.push(chunk);
  }
  if (size > 16 * 1024) throw new HttpError(413, 'request body exceeds 16 KB');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'request body must be valid JSON');
  }
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
    const list = await listContainers();
    return sendJson(res, 200, { readOnly: READONLY, ...list });
  }

  if (parts.length === 2 && parts[1] === 'settings') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
    const body = await readJsonBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'npmRegistry')) {
      throw new HttpError(400, 'settings body may contain only npmRegistry');
    }
    const npmRegistry = validateNpmRegistry(body.npmRegistry);
    await ensureStoreWritable();
    await store.update((document) => {
      document.settings = { ...(document.settings ?? {}), npmRegistry };
      return document;
    });
    return sendJson(res, 200, { ok: true, settings: { npmRegistry } });
  }

  if (parts.length === 2 && parts[1] === 'nodes') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
    const body = await readJsonBody(req);
    await ensureStoreWritable();
    validateNode(body, { allowedImages: ALLOWED_IMAGES, workspaceRoots: WORKSPACE_ROOTS });
    for (const network of body.networks ?? []) await ensureNetworkExists(network);
    const summaries = await labelledSummaries();
    const result = await addNodeRecord(store, body, {
      allowedImages: ALLOWED_IMAGES,
      workspaceRoots: WORKSPACE_ROOTS,
      containers: summaries,
    });
    return sendJson(res, 201, { ok: true, node: result.nodes.find((node) => node.name === body.name) });
  }

  if (parts.length === 2 && parts[1] === 'upgrade') {
    if (req.method === 'GET') return sendJson(res, 200, upgrade.status());
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' }, { allow: 'GET, POST' });
    return sendJson(res, 202, { ok: true, ...upgrade.start({ auto: false }) });
  }

  if (parts.length === 2 && parts[1] === 'scan') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
    return sendJson(res, 200, await discovery.scan());
  }

  if (parts[1] === 'nodes' && (parts.length === 3 || parts.length === 4)) {
    let name;
    try { name = decodeURIComponent(parts[2]); } catch { return sendJson(res, 400, { error: 'malformed node name' }); }
    if (!NAME_RE.test(name)) return sendJson(res, 400, { error: `invalid node name: ${name}` });
    if (parts.length === 4 && parts[3] === 'auto-start') {
      const record = (await store.getNodes()).find((node) => node.name === name);
      if (!record) throw new HttpError(404, `node not found: ${name}`);
      await ensureStoreWritable();
      const until = req.method === 'POST' ? extendWindow(record.autoStartUntil) : req.method === 'DELETE' ? clearWindow() : undefined;
      if (until === undefined) return sendJson(res, 405, { error: 'method not allowed' }, { allow: 'POST, DELETE' });
      await store.update((document) => {
        const node = document.nodes.find((candidate) => candidate.name === name);
        if (!node) throw new HttpError(404, `node not found: ${name}`);
        node.autoStartUntil = until;
        return document;
      });
      return sendJson(res, 200, { ok: true, autoStartUntil: until });
    }
    if (parts.length !== 3 || req.method !== 'DELETE') {
      return sendJson(res, 405, { error: 'method not allowed' }, { allow: 'DELETE' });
    }
    const { container, record } = await resolveTarget(name, 'delete');
    if (!record) throw new HttpError(404, `node not found: ${name}`);
    await ensureStoreWritable();
    await operations.run(name, 'removing', async () => {
      if (container) {
        const removed = await dockerRaw('DELETE', `/containers/${enc(name)}?force=1`);
        if (removed.status !== 204 && removed.status !== 404) throw new HttpError(500, dockerMessage(removed));
      }
      await deleteNodeRecord(store, name);
    });
    return sendJson(res, 200, { ok: true });
  }

  if (parts[1] !== 'containers' || parts.length < 3 || parts.length > 4) {
    return sendJson(res, 404, { error: 'not found' });
  }
  let name;
  try { name = decodeURIComponent(parts[2]); } catch { return sendJson(res, 400, { error: 'malformed container name' }); }
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
  let body = {};
  if (action === 'start' && (req.headers['content-type'] || Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding'])) {
    body = await readJsonBody(req);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'autoStart')) {
      throw new HttpError(400, 'start body may contain only autoStart');
    }
    if (body.autoStart !== undefined && typeof body.autoStart !== 'boolean') throw new HttpError(400, 'autoStart must be a boolean');
  }
  const result = await lifecycle(name, action, body);
  const queued = result?.queued === true || action === 'rebuild';
  return sendJson(res, queued ? 202 : 200, { ok: true, action, queued });
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
    // 4. Changes pause while this node hands over to a newer control node.
    if (upgrade.busy()) return sendJson(res, 503, { error: 'control node upgrade in progress: retry shortly' });
  }

  if (url.pathname === '/__dev-host/status.json') {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
    const [status, body] = await health();
    return sendJson(res, status, body);
  }
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
    if (STANDBY) return sendJson(res, 503, { error: 'standby control node: waiting to take over from the running one' });
    return serveApi(req, res, url);
  }
  return serveStatic(req, res, url.pathname);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => sendError(res, err));
});

// Takes over the node store: load it, import labelled containers, restore auto-start windows, and
// start the self-upgrade check. Runs at startup, or when a handover makes this standby node active.
async function activate() {
  try {
    await store.load();
  } catch (err) {
    log('node store could not be loaded:', err.message || err);
  }
  if (READONLY) return;
  try {
    await discovery.scan();
  } catch (err) {
    log('startup scan failed:', err.message || err);
  }
  // Not awaited: a standby node must acknowledge the handover before it pulls images for auto-started nodes.
  runStartupPass({
    store,
    operations,
    resolveContainer: inspectContainer,
    pullImage: docker.pullImage,
    createContainer: docker.createContainer,
    createBody: async (record) => createBody(record, { httpPort: nodeHttpPort(record), npmRegistry: await npmRegistrySetting() }),
    startContainer,
    log,
  }).catch((err) => log('startup pass failed:', err.message || err));
  if (SELF_UPDATE) scheduleSelfUpdateChecks();
}

// Checks the image every few hours. Only a `latest` image upgrades itself; a pinned tag never does.
function scheduleSelfUpdateChecks() {
  const every = SELF_UPDATE_HOURS * 60 * 60 * 1000;
  const check = async () => {
    try {
      const self = await inspectContainer(os.hostname());
      if (self && isLatestTag(self.Config?.Image) && !upgrade.busy()) upgrade.start({ auto: true });
    } catch (err) {
      log(`self-upgrade check failed: ${err.message || err}`);
    }
    setTimeout(check, every).unref?.();
  };
  setTimeout(check, 60_000).unref?.();
  log(`self-upgrade check every ${SELF_UPDATE_HOURS} h for latest images`);
}

server.listen(PORT, '0.0.0.0', () => {
  log(`listening on :${PORT}; docker socket ${SOCKET}; read-only ${READONLY}; allowed hosts ${[...ALLOWED_HOSTS].join(', ')}`);
  log(fs.existsSync(path.join(UI_DIR, 'index.html')) ? `dashboard from ${UI_DIR}` : `dashboard not built (${UI_DIR} missing)`);
  if (STANDBY) {
    log('standby: waiting for the running control node to hand over');
    upgrade.watchHandover(activate);
  } else {
    void activate();
  }
});
