import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

test('control API guards writes, persists nodes, and creates only registered containers', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'node-control-server-'));
  const socket = path.join(dir, 'docker.sock');
  const containers = new Map();
  const calls = [];
  let pulls = 0;
  const dockerServer = http.createServer(async (req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const url = new URL(req.url, 'http://docker');
    if (url.pathname === '/_ping') return json(res, 200, {});
    if (url.pathname === '/containers/json') {
      return json(res, 200, [...containers.values()].map((item) => ({
        Id: item.Id,
        Names: [`/${item.name}`],
        Image: item.Config.Image,
        State: item.State.Running ? 'running' : 'exited',
        Labels: item.Config.Labels,
      })).filter((item) => item.Labels?.['node-dev-host.port']));
    }
    if (url.pathname.startsWith('/images/create')) {
      pulls += 1;
      return json(res, 200, { status: 'pulled' });
    }
    if (url.pathname.startsWith('/images/')) return json(res, 200, { Config: { Env: [] } });
    if (url.pathname === '/containers/create') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const name = url.searchParams.get('name');
      if (containers.has(name)) return json(res, 409, { message: 'name is already in use' });
      const item = {
        Id: `id-${name}-${Date.now()}`,
        name,
        Config: { Image: body.Image, Labels: body.Labels, Env: body.Env, Tty: false },
        HostConfig: body.HostConfig,
        NetworkSettings: { Networks: {} },
        State: { Running: false },
      };
      containers.set(name, item);
      return json(res, 201, { Id: item.Id });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/containers/')) {
      const name = decodeURIComponent(url.pathname.split('/')[2]);
      containers.delete(name);
      res.writeHead(204); return res.end();
    }
    const match = url.pathname.match(/^\/containers\/([^/]+)\/(json|start|stop|restart|logs)?$/);
    if (match) {
      const name = decodeURIComponent(match[1]);
      const item = containers.get(name);
      if (!item) return json(res, 404, { message: 'not found' });
      if (match[2] === 'json' || !match[2]) return json(res, 200, item);
      if (match[2] === 'start') {
        item.State.Running = true;
        res.writeHead(204); return res.end();
      }
      if (match[2] === 'stop') {
        item.State.Running = false;
        res.writeHead(204); return res.end();
      }
      return json(res, 200, {});
    }
    return json(res, 404, { message: 'not found' });
  });
  await new Promise((resolve) => dockerServer.listen(socket, resolve));
  t.after(async () => {
    await new Promise((resolve) => dockerServer.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });

  const portServer = net.createServer();
  await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const serverPath = path.resolve('rootfs/usr/local/lib/dev-host/control/server.mjs');
  const child = spawn(process.execPath, [serverPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HTTP_PORT: String(port),
      DOCKER_SOCKET: socket,
      CONTROL_DATA_DIR: path.join(dir, 'data'),
      CONTROL_ALLOWED_IMAGES: 'node-dev-host',
      CONTROL_WORKSPACE_ROOTS: '/home',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  });
  const waitUntilReady = async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        const response = await fetch(`${base}/__dev-host/status.json`);
        if (response.status === 200) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('control server did not start');
  };
  await waitUntilReady();

  const guarded = (pathName, method = 'GET', body, headers = {}) => fetch(`${base}${pathName}`, {
    method,
    headers: {
      ...(method !== 'GET' ? { Origin: base, 'X-Dev-Host-Control': '1' } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const recordInput = { name: 'nd-created', workspace: '/home/project', port: 43100, image: 'node-dev-host:latest' };

  assert.equal((await guarded('/api/nodes', 'POST', recordInput)).status, 201);
  const listAfterAdd = await (await guarded('/api/containers')).json();
  assert.equal(listAfterAdd.nextPort, 43101);
  assert.equal(listAfterAdd.containers[0].state, 'not created');
  assert.equal(listAfterAdd.containers[0].registered, true);
  assert.equal(listAfterAdd.persistence.writable, true);

  assert.equal((await guarded('/api/nodes', 'POST', recordInput)).status, 409);
  assert.equal((await guarded('/api/nodes', 'POST', { ...recordInput, name: 'nd-other' })).status, 409);
  assert.equal((await guarded('/api/nodes', 'POST', { ...recordInput, name: 'nd-invalid', port: 8080 })).status, 400);
  assert.equal((await guarded('/api/nodes', 'POST', recordInput, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await guarded('/api/nodes', 'POST', 'x'.repeat(16_385))).status, 413);
  assert.equal((await fetch(`${base}/api/nodes`, { method: 'POST', headers: { 'X-Dev-Host-Control': '1', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/api/nodes`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);

  assert.equal((await guarded('/api/containers/nd-created/stop', 'POST')).status, 409);
  const started = await guarded('/api/containers/nd-created/start', 'POST', { autoStart: true });
  assert.equal(started.status, 202);
  let afterStart;
  for (let i = 0; i < 100; i += 1) {
    afterStart = await (await guarded('/api/containers')).json();
    if (afterStart.containers[0].state === 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(calls.findIndex((call) => call.startsWith('POST /images/create')) < calls.findIndex((call) => call.startsWith('POST /containers/create')));
  assert.equal(afterStart.containers[0].state, 'running');
  assert.equal(afterStart.containers[0].schedule.state, 'active');
  assert.equal(pulls, 1);
  assert.equal((await guarded('/api/containers/nd-created/start', 'POST')).status, 200);
  assert.equal(pulls, 1);

  assert.equal((await guarded('/api/containers/nd-created/recreate', 'POST')).status, 202);
  for (let i = 0; i < 100; i += 1) {
    const current = await (await guarded('/api/containers')).json();
    if (current.containers[0].state === 'running' && !current.containers[0].operation) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(pulls, 2);
  assert.equal((await guarded('/api/containers/nd-created', 'DELETE')).status, 200);
  const removed = await (await guarded('/api/containers')).json();
  assert.equal(removed.containers[0].state, 'not created');
  assert.equal((await guarded('/api/nodes/nd-created', 'DELETE')).status, 200);
  assert.equal((await (await guarded('/api/containers')).json()).containers.length, 0);
});
