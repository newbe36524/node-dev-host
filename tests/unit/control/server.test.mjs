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
