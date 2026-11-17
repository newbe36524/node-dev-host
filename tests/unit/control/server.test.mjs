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
  let createError = null;
  let pullDelayMs = 0;
  const manual = (name, port, options = {}) => ({
    Id: `id-${name}`,
    name,
    Config: {
      Image: 'node-dev-host:latest',
      Labels: options.label === false ? {} : { 'node-dev-host.port': String(port), 'node-dev-host.name': name },
      Env: [],
      Tty: false,
    },
    HostConfig: {
      PortBindings: { '8080/tcp': [{ HostIp: options.hostIp ?? '127.0.0.1' }] },
      Privileged: false,
      RestartPolicy: { Name: 'no' },
    },
    Mounts: [{ Type: 'bind', Source: `/home/${name}`, Destination: '/workspace', RW: false }],
    NetworkSettings: { Networks: {} },
    State: { Running: false },
  });
  containers.set('nd-existing', manual('nd-existing', 43150));
  containers.set('nd-public', manual('nd-public', 43151, { hostIp: '0.0.0.0' }));
  containers.set('nd-plain', manual('nd-plain', 43152, { label: false }));
  containers.set('nd-control', manual('nd-control', 43153, { label: false }));
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
    if (url.pathname.startsWith('/networks/')) {
      const network = decodeURIComponent(url.pathname.split('/')[2]);
      if (network === 'nd-console_default') return json(res, 200, { Name: network });
      return json(res, 404, { message: `network ${network} not found` });
    }
    if (url.pathname.startsWith('/images/create')) {
      pulls += 1;
      if (pullDelayMs) await new Promise((resolve) => setTimeout(resolve, pullDelayMs));
      return json(res, 200, { status: 'pulled' });
    }
    if (url.pathname.startsWith('/images/')) return json(res, 200, { Config: { Env: [] } });
    if (url.pathname === '/containers/create') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const name = url.searchParams.get('name');
      if (containers.has(name)) return json(res, 409, { message: 'name is already in use' });
      if (createError) {
        const message = createError;
        createError = null;
        return json(res, 500, { message });
      }
      const item = {
        Id: `id-${name}-${Date.now()}`,
        name,
        Config: { Image: body.Image, Labels: body.Labels, Env: body.Env, Tty: false },
        HostConfig: body.HostConfig,
        NetworkingConfig: body.NetworkingConfig,
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
  for (let i = 0; i < 100; i += 1) {
    const list = await (await fetch(`${base}/api/containers`)).json();
    if (list.containers.some((item) => item.name === 'nd-existing' && item.registered)) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

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
  assert.equal(listAfterAdd.containers[0].schedule.state, 'none');
  assert.equal(listAfterAdd.containers[0].operation, null);
  assert.equal(listAfterAdd.containers[0].error, null);
  assert.equal(listAfterAdd.containers[0].warning, null);
  assert.equal(listAfterAdd.persistence.writable, true);
  assert.equal(listAfterAdd.persistence.dir, path.join(dir, 'data'));
  // nd-existing is imported by the startup scan; nd-public is skipped by it and stays unregistered.
  const unregisteredRow = listAfterAdd.containers.find((item) => item.name === 'nd-public');
  assert.equal(unregisteredRow.registered, false);
  assert.equal(unregisteredRow.state, 'exited');
  assert.equal(unregisteredRow.port, 43151);
  assert.equal(unregisteredRow.schedule.state, 'none');
  assert.equal(unregisteredRow.operation, null);
  assert.equal(unregisteredRow.error, null);
  assert.equal(unregisteredRow.warning, null);

  assert.equal((await guarded('/api/nodes', 'POST', recordInput)).status, 409);
  assert.equal((await guarded('/api/nodes', 'POST', { ...recordInput, name: 'nd-other' })).status, 409);
  assert.equal((await guarded('/api/nodes', 'POST', { ...recordInput, name: 'nd-public-node', port: 43151 })).status, 409);
  assert.equal((await guarded('/api/nodes', 'POST', { ...recordInput, name: 'nd-invalid', port: 8080 })).status, 400);
  assert.equal((await guarded('/api/nodes', 'POST', { ...recordInput, image: 'untrusted/image:latest' })).status, 400);
  assert.equal((await guarded('/api/nodes', 'POST', recordInput, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await guarded('/api/nodes', 'POST', 'x'.repeat(16_385))).status, 413);
  assert.equal((await guarded('/api/nodes/nd-missing/auto-start', 'POST')).status, 404);
  assert.equal((await fetch(`${base}/api/nodes`, { method: 'POST', headers: { 'X-Dev-Host-Control': '1', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/api/nodes`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}' })).status, 403);

  assert.equal((await guarded('/api/containers/nd-plain/stop', 'POST')).status, 403);
  assert.equal((await guarded('/api/containers/nd-control/stop', 'POST')).status, 403);
  assert.equal((await guarded('/api/containers/nd-missing/stop', 'POST')).status, 404);
  const refusedRecreate = await guarded('/api/containers/nd-public/recreate', 'POST');
  assert.equal(refusedRecreate.status, 409);
  assert.match((await refusedRecreate.json()).error, /scan/i);
  assert.ok((await (await guarded('/api/containers')).json()).containers.some((item) => item.name === 'nd-public'));
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
  const saved = JSON.parse(await fs.readFile(path.join(dir, 'data', 'nodes.json'), 'utf8'));
  const expiry = Date.parse(saved.nodes.find((node) => node.name === 'nd-created').autoStartUntil);
  assert.ok(expiry >= Date.now() + 7 * 24 * 60 * 60 * 1000 - 1000);
  assert.ok(expiry <= Date.now() + 7 * 24 * 60 * 60 * 1000 + 1000);
  assert.equal(pulls, 1);
  assert.equal(calls.filter((call) => call.startsWith('POST /containers/create')).length, 1);
  assert.equal((await guarded('/api/containers/nd-created/stop', 'POST')).status, 200);
  const stoppedWithWindow = await (await guarded('/api/containers')).json();
  assert.equal(stoppedWithWindow.containers.find((item) => item.name === 'nd-created').schedule.state, 'active');
  assert.equal((await guarded('/api/containers/nd-created/start', 'POST')).status, 200);
  assert.equal(pulls, 1);
  assert.equal(calls.filter((call) => call.startsWith('POST /containers/create')).length, 1);

  containers.set('nd-scan', manual('nd-scan', 43160));
  const scan = await (await guarded('/api/scan', 'POST')).json();
  assert.deepEqual(scan, { imported: ['nd-scan'], skipped: [{ name: 'nd-public', reason: 'published port is not bound to loopback' }] });
  assert.deepEqual(await (await guarded('/api/scan', 'POST')).json(), { imported: [], skipped: [{ name: 'nd-public', reason: 'published port is not bound to loopback' }] });

  assert.equal((await guarded('/api/containers/nd-created/recreate', 'POST')).status, 202);
  for (let i = 0; i < 100; i += 1) {
    const current = await (await guarded('/api/containers')).json();
    if (current.containers[0].state === 'running' && !current.containers[0].operation) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(pulls, 2);
  const afterRecreate = await (await guarded('/api/containers')).json();
  assert.equal(afterRecreate.containers.find((item) => item.name === 'nd-created').schedule.state, 'active');
  assert.equal((await guarded('/api/containers/nd-created/stop', 'POST')).status, 200);
  assert.equal((await guarded('/api/containers/nd-created/recreate', 'POST')).status, 202);
  for (let i = 0; i < 100; i += 1) {
    const current = await (await guarded('/api/containers')).json();
    const row = current.containers.find((item) => item.name === 'nd-created');
    if (row.state === 'running' && !row.operation) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(pulls, 3);
  assert.equal((await guarded('/api/nodes/nd-created/auto-start', 'POST')).status, 200);
  assert.equal((await guarded('/api/nodes/nd-created/auto-start', 'DELETE')).status, 200);
  const optedOut = await (await guarded('/api/containers')).json();
  assert.equal(optedOut.containers.find((item) => item.name === 'nd-created').state, 'running');
  assert.equal(optedOut.containers.find((item) => item.name === 'nd-created').schedule.state, 'none');
  assert.equal((await guarded('/api/containers/nd-created', 'DELETE')).status, 200);
  const removed = await (await guarded('/api/containers')).json();
  assert.equal(removed.containers[0].state, 'not created');
  assert.equal((await guarded('/api/containers/nd-public', 'DELETE')).status, 200);
  assert.ok(!(await (await guarded('/api/containers')).json()).containers.some((item) => item.name === 'nd-public'));
  assert.equal((await guarded('/api/nodes/nd-created', 'DELETE')).status, 200);
  assert.ok(!(await (await guarded('/api/containers')).json()).containers.some((item) => item.name === 'nd-created'));
  assert.equal((await guarded('/api/nodes', 'POST', { ...recordInput, name: 'nd-delete', port: 43101 })).status, 201);
  assert.equal((await guarded('/api/containers/nd-delete/start', 'POST')).status, 202);
  for (let i = 0; i < 100; i += 1) {
    if ((await (await guarded('/api/containers')).json()).containers.some((item) => item.name === 'nd-delete' && item.state === 'running')) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal((await guarded('/api/nodes/nd-delete', 'DELETE')).status, 200);
  assert.ok(!containers.has('nd-delete'));
  assert.equal((await guarded('/api/nodes', 'POST', { ...recordInput, name: 'nd-failed', port: 43102 })).status, 201);
  createError = 'simulated create failure';
  assert.equal((await guarded('/api/containers/nd-failed/start', 'POST')).status, 202);
  let failedRow;
  for (let i = 0; i < 100; i += 1) {
    const current = await (await guarded('/api/containers')).json();
    failedRow = current.containers.find((item) => item.name === 'nd-failed');
    if (!failedRow.operation) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(failedRow.state, 'not created');
  assert.match(failedRow.error, /simulated create failure/);
  assert.ok(!containers.has('nd-failed'));

  const networkedRecord = { ...recordInput, name: 'nd-net', port: 43107, networks: ['nd-console_default'] };
  assert.equal((await guarded('/api/nodes', 'POST', networkedRecord)).status, 201);
  const missingNetwork = await guarded('/api/nodes', 'POST', { ...networkedRecord, name: 'nd-net-missing', port: 43108, networks: ['missing-net'] });
  assert.equal(missingNetwork.status, 400);
  assert.match((await missingNetwork.json()).error, /network not found: missing-net/);
  const hostNetwork = await guarded('/api/nodes', 'POST', { ...networkedRecord, name: 'nd-net-host', port: 43109, networks: ['host'] });
  assert.equal(hostNetwork.status, 400);
  assert.match((await hostNetwork.json()).error, /user-defined/);
  assert.equal((await guarded('/api/containers/nd-net/start', 'POST')).status, 202);
  for (let i = 0; i < 100; i += 1) {
    if ((await (await guarded('/api/containers')).json()).containers.some((item) => item.name === 'nd-net' && item.state === 'running')) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(Object.keys(containers.get('nd-net').NetworkingConfig.EndpointsConfig), ['nd-console_default']);
  assert.equal((await guarded('/api/containers/nd-net', 'DELETE')).status, 200);
  assert.equal((await guarded('/api/nodes/nd-net', 'DELETE')).status, 200);

  assert.equal((await guarded('/api/nodes', 'POST', { ...recordInput, name: 'nd-recreate-failed', port: 43105 })).status, 201);
  assert.equal((await guarded('/api/containers/nd-recreate-failed/start', 'POST')).status, 202);
  for (let i = 0; i < 100; i += 1) {
    const row = (await (await guarded('/api/containers')).json()).containers.find((item) => item.name === 'nd-recreate-failed');
    if (row?.state === 'running' && !row.operation) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  createError = 'simulated recreate failure';
  assert.equal((await guarded('/api/containers/nd-recreate-failed/recreate', 'POST')).status, 202);
  let recreateRow;
  for (let i = 0; i < 100; i += 1) {
    recreateRow = (await (await guarded('/api/containers')).json()).containers.find((item) => item.name === 'nd-recreate-failed');
    if (!recreateRow.operation) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(recreateRow.state, 'not created');
  assert.match(recreateRow.error, /simulated recreate failure/);
  assert.equal(recreateRow.registered, true);
  assert.ok(!containers.has('nd-recreate-failed'));

  const endedData = path.join(dir, 'ended-data');
  await fs.mkdir(endedData);
  await fs.writeFile(path.join(endedData, 'nodes.json'), JSON.stringify({
    version: 1,
    nodes: [{
      name: 'nd-ended',
      workspace: '/home/ended',
      port: 43106,
      image: 'node-dev-host:latest',
      env: {},
      autoStartUntil: new Date(Date.now() - 86_400_000).toISOString(),
    }],
  }));
  const endedPortServer = net.createServer();
  await new Promise((resolve) => endedPortServer.listen(0, '127.0.0.1', resolve));
  const endedPort = endedPortServer.address().port;
  await new Promise((resolve) => endedPortServer.close(resolve));
  const endedBase = `http://127.0.0.1:${endedPort}`;
  const endedChild = spawn(process.execPath, [serverPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HTTP_PORT: String(endedPort),
      DOCKER_SOCKET: socket,
      CONTROL_DATA_DIR: endedData,
      CONTROL_ALLOWED_IMAGES: 'node-dev-host',
      CONTROL_WORKSPACE_ROOTS: '/home',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    endedChild.kill('SIGTERM');
    await new Promise((resolve) => endedChild.once('exit', resolve));
  });
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${endedBase}/__dev-host/status.json`)).status === 200) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const endedGuarded = (pathName, method) => fetch(`${endedBase}${pathName}`, {
    method,
    headers: { Origin: endedBase, 'X-Dev-Host-Control': '1' },
  });
  const endedRow = async () => (await (await fetch(`${endedBase}/api/containers`)).json()).containers.find((item) => item.name === 'nd-ended');
  assert.equal((await endedRow()).schedule.state, 'ended');
  assert.equal((await endedRow()).state, 'not created');
  assert.equal((await endedGuarded('/api/nodes/nd-ended/auto-start', 'POST')).status, 200);
  assert.equal((await endedRow()).schedule.state, 'active');
  const extendedUntil = Date.parse(JSON.parse(await fs.readFile(path.join(endedData, 'nodes.json'), 'utf8')).nodes[0].autoStartUntil);
  assert.ok(extendedUntil >= Date.now() + 7 * 24 * 60 * 60 * 1000 - 1000);
  assert.equal((await endedRow()).state, 'not created');
  assert.equal((await endedGuarded('/api/nodes/nd-ended/auto-start', 'DELETE')).status, 200);
  assert.equal((await endedRow()).schedule.state, 'none');

  const startupData = path.join(dir, 'startup-data');
  await fs.mkdir(startupData);
  await fs.writeFile(path.join(startupData, 'nodes.json'), JSON.stringify({
    version: 1,
    nodes: [{
      name: 'nd-startup',
      workspace: '/home/startup',
      port: 43103,
      image: 'node-dev-host:latest',
      env: {},
      autoStartUntil: new Date(Date.now() + 86_400_000).toISOString(),
    }],
  }));
  const startupPortServer = net.createServer();
  await new Promise((resolve) => startupPortServer.listen(0, '127.0.0.1', resolve));
  const startupPort = startupPortServer.address().port;
  await new Promise((resolve) => startupPortServer.close(resolve));
  const startupBase = `http://127.0.0.1:${startupPort}`;
  pullDelayMs = 600;
  const startupChild = spawn(process.execPath, [serverPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HTTP_PORT: String(startupPort),
      DOCKER_SOCKET: socket,
      CONTROL_DATA_DIR: startupData,
      CONTROL_ALLOWED_IMAGES: 'node-dev-host',
      CONTROL_WORKSPACE_ROOTS: '/home',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    startupChild.kill('SIGTERM');
    await new Promise((resolve) => startupChild.once('exit', resolve));
  });
  let startupReady = false;
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${startupBase}/__dev-host/status.json`)).status === 200) {
        startupReady = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(startupReady, true);
  let pulling = false;
  for (let i = 0; i < 100; i += 1) {
    const list = await (await fetch(`${startupBase}/api/containers`)).json();
    const row = list.containers.find((item) => item.name === 'nd-startup');
    if (row?.operation?.phase === 'pulling') {
      pulling = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(pulling, true);
  assert.equal((await fetch(`${startupBase}/__dev-host/status.json`)).status, 200);
  let startupRow;
  for (let i = 0; i < 100; i += 1) {
    const list = await (await fetch(`${startupBase}/api/containers`)).json();
    startupRow = list.containers.find((item) => item.name === 'nd-startup');
    if (startupRow?.state === 'running') break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(startupRow.state, 'running');
  pullDelayMs = 0;

  const readonlyData = path.join(dir, 'readonly-data');
  await fs.mkdir(readonlyData);
  await fs.writeFile(path.join(readonlyData, 'nodes.json'), JSON.stringify({
    version: 1,
    nodes: [{
      name: 'nd-readonly-startup',
      workspace: '/home/startup',
      port: 43104,
      image: 'node-dev-host:latest',
      env: {},
      autoStartUntil: new Date(Date.now() + 86_400_000).toISOString(),
    }],
  }));
  const readonlyPortServer = net.createServer();
  await new Promise((resolve) => readonlyPortServer.listen(0, '127.0.0.1', resolve));
  const readonlyPort = readonlyPortServer.address().port;
  await new Promise((resolve) => readonlyPortServer.close(resolve));
  const readonlyBase = `http://127.0.0.1:${readonlyPort}`;
  const createsBeforeReadonly = calls.filter((call) => call.startsWith('POST /containers/create')).length;
  const readonlyChild = spawn(process.execPath, [serverPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HTTP_PORT: String(readonlyPort),
      DOCKER_SOCKET: socket,
      CONTROL_DATA_DIR: readonlyData,
      CONTROL_READONLY: 'true',
      CONTROL_ALLOWED_IMAGES: 'node-dev-host',
      CONTROL_WORKSPACE_ROOTS: '/home',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    readonlyChild.kill('SIGTERM');
    await new Promise((resolve) => readonlyChild.once('exit', resolve));
  });
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${readonlyBase}/__dev-host/status.json`)).status === 200) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const readonlyList = await (await fetch(`${readonlyBase}/api/containers`)).json();
  const readonlyRow = readonlyList.containers.find((item) => item.name === 'nd-readonly-startup');
  assert.equal(readonlyRow.state, 'not created');
  assert.equal(readonlyRow.schedule.state, 'active');
  const readonlyHeaders = { Origin: readonlyBase, 'X-Dev-Host-Control': '1', 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${readonlyBase}/api/nodes`, { method: 'POST', headers: readonlyHeaders, body: JSON.stringify(recordInput) })).status, 403);
  assert.equal((await fetch(`${readonlyBase}/api/nodes/nd-readonly-startup/auto-start`, { method: 'POST', headers: readonlyHeaders })).status, 403);
  assert.equal((await fetch(`${readonlyBase}/api/nodes/nd-readonly-startup/auto-start`, { method: 'DELETE', headers: readonlyHeaders })).status, 403);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls.filter((call) => call.startsWith('POST /containers/create')).length, createsBeforeReadonly);
});

test('console npm registry setting is guarded, validated and saved in the node store', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'node-control-settings-'));
  const socket = path.join(dir, 'docker.sock');
  const dockerServer = http.createServer((req, res) => {
    if (req.url === '/_ping') return json(res, 200, 'OK');
    if (req.url.startsWith('/containers/json')) return json(res, 200, []);
    return json(res, 404, { message: 'not found' });
  });
  await new Promise((resolve) => dockerServer.listen(socket, resolve));
  t.after(() => new Promise((resolve) => dockerServer.close(resolve)));
  const portServer = net.createServer();
  await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const dataDir = path.join(dir, 'data');
  const child = spawn(process.execPath, [path.resolve('rootfs/usr/local/lib/dev-host/control/server.mjs')], {
    cwd: process.cwd(),
    env: { ...process.env, HTTP_PORT: String(port), DOCKER_SOCKET: socket, CONTROL_DATA_DIR: dataDir },
    stdio: 'ignore',
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  });
  for (let attempt = 0; ; attempt += 1) {
    try {
      if ((await fetch(`${base}/__dev-host/status.json`)).status === 200) break;
    } catch {}
    if (attempt > 100) throw new Error('control server did not start');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const save = (body, headers = { Origin: base, 'X-Dev-Host-Control': '1' }) => fetch(`${base}/api/settings`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  assert.equal((await save({ npmRegistry: 'http://mirror.test/' }, {})).status, 403);
  assert.equal((await save({ npmRegistry: 'ftp://mirror.test/' })).status, 400);
  assert.equal((await save({ npmRegistry: 'http://u:p@mirror.test/' })).status, 400);
  assert.equal((await save({ npmRegistry: 'http://mirror.test/', other: 1 })).status, 400);
  assert.equal((await save('{bad json')).status, 400);
  assert.equal((await fetch(`${base}/api/settings`)).status, 405);

  const set = await save({ npmRegistry: ' http://mirror.test:4873/ ' });
  assert.equal(set.status, 200);
  assert.deepEqual((await set.json()).settings, { npmRegistry: 'http://mirror.test:4873/' });
  const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'nodes.json'), 'utf8'));
  assert.equal(stored.settings.npmRegistry, 'http://mirror.test:4873/');

  const list = await (await fetch(`${base}/api/containers`)).json();
  assert.deepEqual(list.settings, { npmRegistry: 'http://mirror.test:4873/' });

  assert.equal((await save({ npmRegistry: '' })).status, 200);
  assert.deepEqual((await (await fetch(`${base}/api/containers`)).json()).settings, { npmRegistry: null });
});

test('list rows carry project metadata from each node status, sanitized, and null defaults for older or unreadable status', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'node-control-project-'));
  const socket = path.join(dir, 'docker.sock');
  const statusBodies = {
    'nd-full': {
      state: 'ok', builds: 3, failures: 0, finishedAt: '2026-11-12T10:00:00Z',
      name: 'jjb', description: 'Personal JJB site', configSource: '.node-dev-host.yaml', configHash: 'a'.repeat(64),
      configError: null, ignore: ['.browser-profile/'], warnings: ['copy retried once: files changed while copying'],
    },
    'nd-old': { state: 'ok', builds: 1, failures: 0, finishedAt: '2026-11-12T10:00:00Z' },
    'nd-broken': 'not json',
    'nd-long': {
      state: 'failed', builds: 2, failures: 2, finishedAt: null,
      name: 42, description: 'd'.repeat(5000), configSource: '.node-dev-host.yaml', configError: 'e'.repeat(400),
      warnings: Array.from({ length: 7 }, () => 'w'.repeat(300)),
    },
  };
  const statusServers = [];
  const serveStatus = async (body) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    statusServers.push(server);
    return server.address().port;
  };
  // Containers bind 0.0.0.0, which the startup scan skips, so they stay unregistered and only the listing is tested.
  const containers = new Map();
  let labelPort = 43171;
  for (const name of ['nd-full', 'nd-old', 'nd-broken', 'nd-long', 'nd-stopped']) {
    const running = name !== 'nd-stopped';
    const httpPort = running ? await serveStatus(statusBodies[name]) : 8080;
    containers.set(name, {
      Id: `id-${name}`,
      Name: `/${name}`,
      Config: {
        Image: 'node-dev-host:latest',
        Labels: { 'node-dev-host.port': String(labelPort), 'node-dev-host.name': name },
        Env: [`HTTP_PORT=${httpPort}`],
        Tty: false,
      },
      HostConfig: { PortBindings: { '8080/tcp': [{ HostIp: '0.0.0.0' }] }, Privileged: false, RestartPolicy: { Name: 'no' } },
      Mounts: [],
      NetworkSettings: { Networks: running ? { bridge: { IPAddress: '127.0.0.1' } } : {} },
      State: { Running: running },
    });
    labelPort += 1;
  }
  const dockerServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://docker');
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/_ping') return json(200, {});
    if (url.pathname === '/containers/json') {
      return json(200, [...containers.values()].map((item) => ({
        Id: item.Id,
        Names: [item.Name],
        Image: item.Config.Image,
        State: item.State.Running ? 'running' : 'exited',
        Labels: item.Config.Labels,
      })));
    }
    const match = url.pathname.match(/^\/containers\/([^/]+)\/json$/);
    if (match) {
      const item = containers.get(decodeURIComponent(match[1]));
      return item ? json(200, item) : json(404, { message: 'not found' });
    }
    return json(404, { message: 'not found' });
  });
  await new Promise((resolve) => dockerServer.listen(socket, resolve));
  t.after(async () => {
    await new Promise((resolve) => dockerServer.close(resolve));
    await Promise.all(statusServers.map((server) => new Promise((resolve) => server.close(resolve))));
    await fs.rm(dir, { recursive: true, force: true });
  });

  const portServer = net.createServer();
  await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.resolve('rootfs/usr/local/lib/dev-host/control/server.mjs')], {
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
  for (let attempt = 0; ; attempt += 1) {
    try {
      if ((await fetch(`${base}/__dev-host/status.json`)).status === 200) break;
    } catch {}
    if (attempt > 100) throw new Error('control server did not start');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  // A registered node without a container: its row has the null project and the node record stays as it was.
  const added = await fetch(`${base}/api/nodes`, {
    method: 'POST',
    headers: { Origin: base, 'X-Dev-Host-Control': '1', 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'nd-pending', workspace: '/home/pending', port: 43176, image: 'node-dev-host:latest' }),
  });
  assert.equal(added.status, 201);

  const list = await (await fetch(`${base}/api/containers`)).json();
  const row = (name) => list.containers.find((item) => item.name === name);
  const nullProject = { name: null, description: null, configSource: null, configError: null, warnings: [] };

  assert.deepEqual(row('nd-full').project, {
    name: 'jjb',
    description: 'Personal JJB site',
    configSource: '.node-dev-host.yaml',
    configError: null,
    warnings: ['copy retried once: files changed while copying'],
  });
  assert.equal(row('nd-full').build.state, 'ok');
  assert.deepEqual(row('nd-old').project, nullProject);
  assert.equal(row('nd-old').build.state, 'ok');
  assert.deepEqual(row('nd-broken').project, nullProject);
  assert.equal(row('nd-broken').build.state, 'unknown');

  const long = row('nd-long');
  assert.equal(long.project.name, null, 'a numeric name is dropped');
  assert.equal(long.project.description.length, 500);
  assert.equal(long.project.configError.length, 300);
  assert.equal(long.project.warnings.length, 5);
  assert.ok(long.project.warnings.every((warning) => warning.length === 200));
  assert.equal(long.build.state, 'failed');

  assert.equal(row('nd-stopped').state, 'exited');
  assert.deepEqual(row('nd-stopped').project, nullProject);
  assert.equal(row('nd-stopped').build.state, 'unknown');
  assert.deepEqual(row('nd-pending').project, nullProject);
  assert.equal(row('nd-pending').registered, true);

  const stored = await fs.readFile(path.join(dir, 'data', 'nodes.json'), 'utf8');
  assert.equal(stored.includes('"project"'), false, 'project metadata is never stored in the node records');
});

test('a node on a local image is created on start and on recreate with no pull and no pull warning', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'node-control-local-'));
  const socket = path.join(dir, 'docker.sock');
  const containers = new Map();
  const calls = [];
  const dockerServer = http.createServer(async (req, res) => {
    calls.push(`${req.method} ${req.url}`);
    const url = new URL(req.url, 'http://docker');
    const { pathname } = url;
    if (pathname === '/_ping') return json(res, 200, {});
    if (pathname === '/containers/json') {
      return json(res, 200, [...containers.values()].map((item) => ({
        Id: item.Id, Names: [`/${item.name}`], Image: item.Config.Image,
        State: item.State.Running ? 'running' : 'exited', Labels: item.Config.Labels,
      })));
    }
    if (pathname.startsWith('/images/create')) return json(res, 500, { message: 'a local image must not be pulled' });
    if (pathname.startsWith('/images/')) {
      const image = decodeURIComponent(pathname.split('/')[2]);
      return image === 'jjb-ndh:local' ? json(res, 200, { Config: { Env: [] } }) : json(res, 404, { message: 'no such image' });
    }
    if (pathname === '/containers/create') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const name = url.searchParams.get('name');
      if (containers.has(name)) return json(res, 409, { message: 'name is already in use' });
      containers.set(name, {
        Id: `id-${name}-${calls.length}`, name,
        Config: { Image: body.Image, Labels: body.Labels, Env: body.Env, Tty: false },
        HostConfig: body.HostConfig, NetworkingConfig: body.NetworkingConfig,
        NetworkSettings: { Networks: {} }, State: { Running: false },
      });
      return json(res, 201, { Id: containers.get(name).Id });
    }
    const match = pathname.match(/^\/containers\/([^/]+)(?:\/(json|start|stop))?$/);
    if (req.method === 'DELETE' && match) {
      containers.delete(decodeURIComponent(match[1]));
      res.writeHead(204); return res.end();
    }
    if (match) {
      const item = containers.get(decodeURIComponent(match[1]));
      if (!item) return json(res, 404, { message: 'not found' });
      if (!match[2] || match[2] === 'json') return json(res, 200, item);
      if (match[2] === 'start') {
        item.State.Running = true;
        res.writeHead(204); return res.end();
      }
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
  const child = spawn(process.execPath, [path.resolve('rootfs/usr/local/lib/dev-host/control/server.mjs')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HTTP_PORT: String(port),
      DOCKER_SOCKET: socket,
      CONTROL_DATA_DIR: path.join(dir, 'data'),
      CONTROL_ALLOWED_IMAGES: 'node-dev-host,jjb-ndh',
      CONTROL_WORKSPACE_ROOTS: '/home',
    },
    stdio: 'ignore',
  });
  t.after(async () => {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
  });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let attempt = 0; ; attempt += 1) {
    try {
      if ((await fetch(`${base}/__dev-host/status.json`)).status === 200) break;
    } catch {}
    if (attempt > 100) throw new Error('control server did not start');
    await sleep(20);
  }
  const guardedPost = (pathName, body) => fetch(`${base}${pathName}`, {
    method: 'POST',
    headers: { Origin: base, 'X-Dev-Host-Control': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const rowOf = async () => (await (await fetch(`${base}/api/containers`)).json()).containers.find((item) => item.name === 'nd-jjb');
  const settled = async () => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const row = await rowOf();
      if (row.state === 'running' && row.operation === null) return row;
      await sleep(10);
    }
    throw new Error('the row did not settle');
  };

  assert.equal((await guardedPost('/api/nodes', { name: 'nd-jjb', workspace: '/home/jjb', port: 43100, image: 'jjb-ndh:local' })).status, 201);
  assert.equal((await rowOf()).image, 'jjb-ndh:local');
  assert.equal((await rowOf()).state, 'not created');

  assert.equal((await guardedPost('/api/containers/nd-jjb/start')).status, 202);
  const started = await settled();
  assert.equal(started.warning, null);
  assert.equal(started.error, null);
  assert.equal(started.image, 'jjb-ndh:local');

  assert.equal((await guardedPost('/api/containers/nd-jjb/recreate')).status, 202);
  const recreated = await settled();
  assert.equal(recreated.warning, null);
  assert.equal(recreated.error, null);
  assert.equal(recreated.image, 'jjb-ndh:local');

  assert.equal(calls.filter((call) => call.startsWith('POST /images/create')).length, 0);
  assert.equal(calls.filter((call) => call.startsWith('POST /containers/create')).length, 2);
});

// The mounts Docker would report for a create body's binds ("source:destination[:ro]").
function mountsOfBinds(binds = []) {
  return binds.map((bind) => {
    const [source, destination, mode] = bind.split(':');
    return { Type: 'bind', Source: source, Destination: destination, RW: mode !== 'ro' };
  });
}

// A Docker stand-in for the privileged-node tests: containers live in a Map and every request is recorded.
function privilegedDocker(socket, containers, calls) {
  const sum = (item) => ({ Id: item.Id, Names: [`/${item.name}`], Image: item.Config.Image, State: item.State.Running ? 'running' : 'exited', Labels: item.Config.Labels, Ports: [] });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://docker');
    calls.push(`${req.method} ${url.pathname}`);
    const { pathname } = url;
    if (pathname === '/_ping') return json(res, 200, {});
    if (pathname === '/containers/json') return json(res, 200, [...containers.values()].filter((item) => item.Config.Labels?.['node-dev-host.port']).map(sum));
    if (pathname.startsWith('/images/')) return json(res, 200, { Config: { Env: [] } });
    if (pathname.endsWith('/logs')) { res.writeHead(200); return res.end(); }
    if (pathname === '/containers/create') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      const name = url.searchParams.get('name');
      if (containers.has(name)) return json(res, 409, { message: 'name is already in use' });
      const item = {
        Id: `id-${name}-${calls.length}`, name,
        Config: { Image: body.Image, Labels: body.Labels, Env: body.Env, Tty: false },
        HostConfig: body.HostConfig, Mounts: mountsOfBinds(body.HostConfig.Binds), NetworkSettings: { Networks: {} }, State: { Running: false },
      };
      containers.set(name, item);
      return json(res, 201, { Id: item.Id });
    }
    const match = pathname.match(/^\/containers\/([^/]+)(?:\/(json|start|stop|restart))?$/);
    if (match) {
      const name = decodeURIComponent(match[1]);
      const item = containers.get(name);
      if (req.method === 'DELETE') {
        containers.delete(name);
        res.writeHead(204); return res.end();
      }
      if (!item) return json(res, 404, { message: 'not found' });
      if (!match[2] || match[2] === 'json') return json(res, 200, item);
      item.State.Running = match[2] !== 'stop';
      res.writeHead(204); return res.end();
    }
    return json(res, 404, { message: 'not found' });
  });
  return new Promise((resolve) => server.listen(socket, () => resolve(server)));
}

async function spawnControl(dir, socket, allowlist, cleanup, hostMountRoots = '') {
  const portServer = net.createServer();
  await new Promise((resolve) => portServer.listen(0, '127.0.0.1', resolve));
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const base = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn(process.execPath, [path.resolve('rootfs/usr/local/lib/dev-host/control/server.mjs')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HTTP_PORT: String(port),
      DOCKER_SOCKET: socket,
      CONTROL_DATA_DIR: path.join(dir, 'data'),
      CONTROL_ALLOWED_IMAGES: 'node-dev-host',
      CONTROL_WORKSPACE_ROOTS: '/home',
      CONTROL_SELF_UPDATE: 'false',
      CONTROL_PRIVILEGED_NODES: allowlist,
      CONTROL_HOST_MOUNT_ROOTS: hostMountRoots,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  for (let attempt = 0; ; attempt += 1) {
    try {
      if ((await fetch(`${base}/__dev-host/status.json`)).status === 200) break;
    } catch {}
    if (attempt > 100) throw new Error('control server did not start');
    await sleep(20);
  }
  const guarded = (pathName, method = 'GET', body) => fetch(`${base}${pathName}`, {
    method,
    headers: { ...(method !== 'GET' ? { Origin: base, 'X-Dev-Host-Control': '1' } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const rows = async () => (await (await guarded('/api/containers')).json()).containers;
  const rowOf = async (name) => (await rows()).find((row) => row.name === name);
  const settled = async (name) => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const row = await rowOf(name);
      if (row && row.operation === null && row.state !== 'not created') return row;
      await sleep(10);
    }
    throw new Error(`${name} did not settle`);
  };
  // A child stopped by a signal has exitCode null, so both fields say whether it has already exited.
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
  };
  cleanup.push(stop);
  return { base, guarded, rowOf, settled, stop, log: () => output, sleep };
}

test('privileged nodes: only allowlisted names register and start as privileged, rows show it, and a name that left the list is refused', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'node-control-privileged-'));
  const socket = path.join(dir, 'docker.sock');
  const containers = new Map();
  const calls = [];
  // A privileged container nobody registered: the scan must skip it, and the row must still say so.
  containers.set('nd-priv', {
    Id: 'id-nd-priv', name: 'nd-priv',
    Config: { Image: 'node-dev-host:local', Labels: { 'node-dev-host.port': '43170', 'node-dev-host.name': 'nd-priv' }, Env: [], Tty: false },
    HostConfig: { PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1' }] }, Privileged: true, RestartPolicy: { Name: 'no' } },
    Mounts: [{ Type: 'bind', Source: '/home/priv', Destination: '/workspace', RW: false }],
    NetworkSettings: { Networks: {} }, State: { Running: false },
  });
  const dockerServer = await privilegedDocker(socket, containers, calls);
  // Control nodes stop first: the fake Docker server cannot close while one of them still holds a connection.
  const cleanup = [];
  t.after(async () => {
    for (const stop of cleanup.reverse()) await stop();
    await new Promise((resolve) => dockerServer.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });

  const control = await spawnControl(dir, socket, 'nd-my-ansible, bad name!, nd-lab', cleanup);
  assert.match(control.log(), /CONTROL_PRIVILEGED_NODES ignores "bad name!"/);
  const { guarded, rowOf, settled } = control;
  const node = { workspace: '/home/me/repos/site', image: 'node-dev-host:local' };

  let row = await rowOf('nd-priv');
  assert.equal(row.privileged, true);
  assert.equal(row.registered, false);

  // Registration: a name off the list is refused by the API itself, with nothing saved.
  let response = await guarded('/api/nodes', 'POST', { ...node, name: 'nd-other', port: 43163, privileged: true });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /CONTROL_PRIVILEGED_NODES/);
  assert.equal(await rowOf('nd-other'), undefined);
  response = await guarded('/api/nodes', 'POST', { ...node, name: 'nd-my-ansible', port: 43160, privileged: 'yes' });
  assert.equal(response.status, 400);
  assert.equal(await rowOf('nd-my-ansible'), undefined);

  assert.equal((await guarded('/api/nodes', 'POST', { ...node, name: 'nd-my-ansible', port: 43160, privileged: true })).status, 201);
  assert.equal((await guarded('/api/nodes', 'POST', { ...node, name: 'nd-plain', port: 43161 })).status, 201);
  assert.equal((await guarded('/api/nodes', 'POST', { ...node, name: 'nd-lab', port: 43162, privileged: true })).status, 201);

  // Start: the allowlisted privileged node gets Docker's Privileged flag, and only loopback is published.
  assert.equal((await guarded('/api/containers/nd-my-ansible/start', 'POST')).status, 202);
  await settled('nd-my-ansible');
  const made = containers.get('nd-my-ansible');
  assert.equal(made.HostConfig.Privileged, true);
  assert.deepEqual(made.HostConfig.PortBindings, { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '43160' }] });
  assert.equal(made.HostConfig.Binds.some((bind) => bind.includes('docker.sock')), false);
  assert.equal((await guarded('/api/containers/nd-plain/start', 'POST')).status, 202);
  await settled('nd-plain');
  assert.equal('Privileged' in containers.get('nd-plain').HostConfig, false);

  // Rows: every kind carries privileged, and the marker is not tied to registration.
  assert.equal((await rowOf('nd-my-ansible')).privileged, true);
  assert.equal((await rowOf('nd-plain')).privileged, false);
  assert.equal((await rowOf('nd-lab')).privileged, true);
  assert.equal((await rowOf('nd-lab')).state, 'not created');
  row = await rowOf('nd-priv');
  assert.equal(row.privileged, true);
  assert.equal(row.registered, false);
  assert.equal((await (await guarded('/api/containers')).json()).containers.every((item) => typeof item.privileged === 'boolean'), true);

  // The first control node is replaced by a second one whose list has dropped nd-my-ansible.
  await control.stop();

  // The list changes: nd-lab and nd-my-ansible are both off it now, so both must be refused.
  const second = await spawnControl(dir, socket, 'nd-plain', cleanup);
  const refused = await second.guarded('/api/containers/nd-my-ansible/start', 'POST');
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).error, /CONTROL_PRIVILEGED_NODES/);
  for (const action of ['restart', 'recreate']) {
    const r = await second.guarded(`/api/containers/nd-my-ansible/${action}`, 'POST');
    assert.equal(r.status, 403, action);
    assert.match((await r.json()).error, /CONTROL_PRIVILEGED_NODES/);
  }
  assert.equal(containers.get('nd-my-ansible').State.Running, true);
  assert.equal((await second.rowOf('nd-my-ansible')).privileged, true);
  assert.equal((await second.guarded('/api/containers/nd-lab/start', 'POST')).status, 403);
  assert.equal((await second.guarded('/api/containers/nd-my-ansible/logs')).status, 200);
  assert.equal((await second.guarded('/api/containers/nd-my-ansible/stop', 'POST')).status, 200);
  assert.equal(containers.get('nd-my-ansible').State.Running, false);
  assert.equal((await second.guarded('/api/containers/nd-my-ansible/start', 'POST')).status, 403);
  assert.equal((await second.guarded('/api/containers/nd-my-ansible', 'DELETE')).status, 200);
  assert.equal((await second.guarded('/api/nodes/nd-my-ansible', 'DELETE')).status, 200);
});

test('the startup pass never starts or creates a privileged node that left the allowlist, and still starts the ordinary one', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'node-control-startup-'));
  const socket = path.join(dir, 'docker.sock');
  const containers = new Map();
  const calls = [];
  const window = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const record = (name, port, privileged) => ({
    name, workspace: '/home/me/repos/site', port, image: 'node-dev-host:local', env: {}, restartPolicy: 'no', networks: [], writable: [],
    privileged, source: 'added', createdAt: '2026-01-01T00:00:00.000Z', autoStartUntil: window,
  });
  await fs.mkdir(path.join(dir, 'data'), { recursive: true });
  await fs.writeFile(path.join(dir, 'data', 'nodes.json'), `${JSON.stringify({ version: 1, nodes: [
    record('nd-auto-priv', 43180, true),
    record('nd-auto-stopped', 43181, true),
    record('nd-auto-plain', 43182, false),
  ] }, null, 2)}\n`, 'utf8');
  // A stopped privileged container for a name that is no longer allowlisted.
  containers.set('nd-auto-stopped', {
    Id: 'id-nd-auto-stopped', name: 'nd-auto-stopped',
    Config: { Image: 'node-dev-host:local', Labels: { 'node-dev-host.port': '43181', 'node-dev-host.name': 'nd-auto-stopped' }, Env: [], Tty: false },
    HostConfig: { PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1' }] }, Privileged: true, RestartPolicy: { Name: 'no' } },
    Mounts: [{ Type: 'bind', Source: '/home/me/repos/site', Destination: '/workspace', RW: false }],
    NetworkSettings: { Networks: {} }, State: { Running: false },
  });
  const dockerServer = await privilegedDocker(socket, containers, calls);
  const cleanup = [];
  t.after(async () => {
    for (const stop of cleanup.reverse()) await stop();
    await new Promise((resolve) => dockerServer.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });

  const control = await spawnControl(dir, socket, 'nd-lab', cleanup);
  // The ordinary node is started by the pass; once it is, the pass has reached the other two.
  for (let attempt = 0; attempt < 300 && containers.get('nd-auto-plain')?.State.Running !== true; attempt += 1) await control.sleep(10);
  await control.sleep(200);
  assert.equal(containers.get('nd-auto-plain').State.Running, true);
  assert.equal(containers.has('nd-auto-priv'), false);
  assert.equal(containers.get('nd-auto-stopped').State.Running, false);
  assert.equal(calls.filter((call) => call === 'POST /containers/nd-auto-stopped/start').length, 0);
  assert.equal(calls.filter((call) => call === 'POST /containers/nd-auto-priv/start').length, 0);
  assert.match(control.log(), /startup failed for nd-auto-priv: .*CONTROL_PRIVILEGED_NODES/);
  assert.match(control.log(), /startup failed for nd-auto-stopped: .*CONTROL_PRIVILEGED_NODES/);
});

test('host access: only allowlisted names get the host PID namespace and /host mounts, the API, rows and scan say so, and a name that left the list is refused', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'node-control-host-access-'));
  const socket = path.join(dir, 'docker.sock');
  const containers = new Map();
  const calls = [];
  // A host-PID container nobody registered, for a name off the list: the scan must skip it and the row must show it.
  containers.set('nd-stray', {
    Id: 'id-nd-stray', name: 'nd-stray',
    Config: { Image: 'node-dev-host:local', Labels: { 'node-dev-host.port': '43190', 'node-dev-host.name': 'nd-stray' }, Env: [], Tty: false },
    HostConfig: { PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1' }] }, Privileged: false, PidMode: 'host', RestartPolicy: { Name: 'no' } },
    Mounts: [{ Type: 'bind', Source: '/home/stray', Destination: '/workspace', RW: false }],
    NetworkSettings: { Networks: {} }, State: { Running: false },
  });
  const dockerServer = await privilegedDocker(socket, containers, calls);
  const cleanup = [];
  t.after(async () => {
    for (const stop of cleanup.reverse()) await stop();
    await new Promise((resolve) => dockerServer.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });

  const control = await spawnControl(dir, socket, 'nd-my-ansible, nd-mounts', cleanup, '/var/lib/steam, relative/path');
  assert.match(control.log(), /CONTROL_HOST_MOUNT_ROOTS ignores "relative\/path"/);
  const { guarded, rowOf, settled } = control;
  const node = { workspace: '/home/me/repos/site', image: 'node-dev-host:local' };
  const post = (body) => guarded('/api/nodes', 'POST', body);

  // Registration: every refusal saves nothing.
  let response = await post({ ...node, name: 'nd-other', port: 43150, pidHost: true });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /CONTROL_PRIVILEGED_NODES/);
  assert.equal(await rowOf('nd-other'), undefined);
  response = await post({ ...node, name: 'nd-my-ansible', port: 43151, hostMounts: ['/proc'] });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /host PID namespace/);
  response = await post({ ...node, name: 'nd-my-ansible', port: 43151, hostMounts: ['/srv/data'] });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /CONTROL_HOST_MOUNT_ROOTS/);
  assert.equal(await rowOf('nd-my-ansible'), undefined);

  // Allowlisted, with a narrow path under the root: saved as declared.
  response = await post({ ...node, name: 'nd-my-ansible', port: 43151, pidHost: true, hostMounts: ['/var/lib/steam/instances'] });
  assert.equal(response.status, 201);
  const saved = (await response.json()).node;
  assert.equal(saved.pidHost, true);
  assert.deepEqual(saved.hostMounts, ['/var/lib/steam/instances']);
  assert.equal((await post({ ...node, name: 'nd-mounts', port: 43152, hostMounts: ['/var/lib/steam'] })).status, 201);
  assert.equal((await post({ ...node, name: 'nd-plain', port: 43153 })).status, 201);
  // A direct call for a name off the list is refused exactly as the helper would be.
  assert.equal((await post({ ...node, name: 'nd-lab', port: 43154, hostMounts: ['/var/lib/steam'] })).status, 400);

  // Start: host PID mode and one read-only /host bind, loopback only, and no privileged flag.
  assert.equal((await guarded('/api/containers/nd-my-ansible/start', 'POST')).status, 202);
  await settled('nd-my-ansible');
  const made = containers.get('nd-my-ansible');
  assert.equal(made.HostConfig.PidMode, 'host');
  assert.ok(made.HostConfig.Binds.includes('/var/lib/steam/instances:/host/var/lib/steam/instances:ro'));
  assert.equal(made.HostConfig.Binds.some((bind) => bind.includes('docker.sock') || bind.endsWith(':rw')), false);
  assert.deepEqual(made.HostConfig.PortBindings, { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '43151' }] });
  assert.equal('Privileged' in made.HostConfig, false);
  assert.equal((await guarded('/api/containers/nd-plain/start', 'POST')).status, 202);
  await settled('nd-plain');
  assert.equal('PidMode' in containers.get('nd-plain').HostConfig, false);

  // Rows: each kind carries both fields.
  let row = await rowOf('nd-my-ansible');
  assert.equal(row.pidHost, true);
  assert.deepEqual(row.hostMounts, ['/var/lib/steam/instances']);
  row = await rowOf('nd-plain');
  assert.equal(row.pidHost, false);
  assert.deepEqual(row.hostMounts, []);
  row = await rowOf('nd-mounts');
  assert.equal(row.state, 'not created');
  assert.equal(row.pidHost, false);
  assert.deepEqual(row.hostMounts, ['/var/lib/steam']);
  // A running container with only a /host mount: the row reads the mount from Docker.
  assert.equal((await guarded('/api/containers/nd-mounts/start', 'POST')).status, 202);
  await settled('nd-mounts');
  assert.ok(containers.get('nd-mounts').HostConfig.Binds.includes('/var/lib/steam:/host/var/lib/steam:ro'));
  row = await rowOf('nd-mounts');
  assert.equal(row.state, 'running');
  assert.equal(row.pidHost, false);
  assert.deepEqual(row.hostMounts, ['/var/lib/steam']);
  row = await rowOf('nd-stray');
  assert.equal(row.registered, false);
  assert.equal(row.pidHost, true);
  assert.deepEqual(row.hostMounts, []);
  assert.ok((await (await guarded('/api/containers')).json()).containers.every((item) => typeof item.pidHost === 'boolean' && Array.isArray(item.hostMounts)));

  // Scan: the unregistered host-PID container is skipped with its reason, and nothing is imported.
  const scan = await (await guarded('/api/scan', 'POST')).json();
  assert.deepEqual(scan, { imported: [], skipped: [{ name: 'nd-stray', reason: 'container uses the host PID namespace' }] });

  // The first control node is replaced by one whose list has dropped nd-my-ansible and nd-mounts.
  await control.stop();
  const second = await spawnControl(dir, socket, 'nd-plain', cleanup, '/var/lib/steam');
  for (const action of ['start', 'restart', 'recreate']) {
    const r = await second.guarded(`/api/containers/nd-my-ansible/${action}`, 'POST');
    assert.equal(r.status, 403, action);
    assert.match((await r.json()).error, /CONTROL_PRIVILEGED_NODES/);
  }
  assert.equal(containers.get('nd-my-ansible').State.Running, true);
  assert.equal((await second.guarded('/api/containers/nd-stray/start', 'POST')).status, 403);
  assert.equal((await second.guarded('/api/containers/nd-mounts/start', 'POST')).status, 403);
  assert.equal((await second.rowOf('nd-my-ansible')).pidHost, true);

  // Stop, logs, remove and delete still work for the node that left the list.
  assert.equal((await second.guarded('/api/containers/nd-my-ansible/logs')).status, 200);
  assert.equal((await second.guarded('/api/containers/nd-my-ansible/stop', 'POST')).status, 200);
  assert.equal(containers.get('nd-my-ansible').State.Running, false);
  assert.equal((await second.guarded('/api/containers/nd-my-ansible/start', 'POST')).status, 403);
  assert.equal((await second.guarded('/api/containers/nd-my-ansible', 'DELETE')).status, 200);
  assert.equal((await second.guarded('/api/nodes/nd-my-ansible', 'DELETE')).status, 200);
});

test('the startup pass never starts a host-access node that left the allowlist, and still starts the ordinary one', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'node-control-host-startup-'));
  const socket = path.join(dir, 'docker.sock');
  const containers = new Map();
  const calls = [];
  const window = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const record = (name, port, extra = {}) => ({
    name, workspace: '/home/me/repos/site', port, image: 'node-dev-host:local', env: {}, restartPolicy: 'no', networks: [], writable: [],
    privileged: false, source: 'added', createdAt: '2026-01-01T00:00:00.000Z', autoStartUntil: window, ...extra,
  });
  await fs.mkdir(path.join(dir, 'data'), { recursive: true });
  await fs.writeFile(path.join(dir, 'data', 'nodes.json'), `${JSON.stringify({ version: 1, nodes: [
    record('nd-auto-host', 43180, { pidHost: true, hostMounts: ['/var/lib/steam'] }),
    record('nd-auto-stopped', 43181, { pidHost: true }),
    record('nd-auto-plain', 43182),
  ] }, null, 2)}\n`, 'utf8');
  // A stopped host-PID container for a name that is no longer allowlisted.
  containers.set('nd-auto-stopped', {
    Id: 'id-nd-auto-stopped', name: 'nd-auto-stopped',
    Config: { Image: 'node-dev-host:local', Labels: { 'node-dev-host.port': '43181', 'node-dev-host.name': 'nd-auto-stopped' }, Env: [], Tty: false },
    HostConfig: { PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1' }] }, Privileged: false, PidMode: 'host', RestartPolicy: { Name: 'no' } },
    Mounts: [{ Type: 'bind', Source: '/home/me/repos/site', Destination: '/workspace', RW: false }],
    NetworkSettings: { Networks: {} }, State: { Running: false },
  });
  const dockerServer = await privilegedDocker(socket, containers, calls);
  const cleanup = [];
  t.after(async () => {
    for (const stop of cleanup.reverse()) await stop();
    await new Promise((resolve) => dockerServer.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  });

  const control = await spawnControl(dir, socket, 'nd-lab', cleanup, '/var/lib/steam');
  for (let attempt = 0; attempt < 300 && containers.get('nd-auto-plain')?.State.Running !== true; attempt += 1) await control.sleep(10);
  await control.sleep(200);
  assert.equal(containers.get('nd-auto-plain').State.Running, true);
  assert.equal(containers.has('nd-auto-host'), false);
  assert.equal(containers.get('nd-auto-stopped').State.Running, false);
  assert.equal(calls.filter((call) => call === 'POST /containers/nd-auto-stopped/start').length, 0);
  assert.equal(calls.filter((call) => call === 'POST /containers/nd-auto-host/start').length, 0);
  assert.match(control.log(), /startup failed for nd-auto-host: .*CONTROL_PRIVILEGED_NODES/);
  assert.match(control.log(), /startup failed for nd-auto-stopped: .*CONTROL_PRIVILEGED_NODES/);
});
