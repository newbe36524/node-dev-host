import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { createDockerClient } from '../../../rootfs/usr/local/lib/dev-host/control/docker.mjs';
import { createOperationTracker } from '../../../rootfs/usr/local/lib/dev-host/control/operations.mjs';
import { createBody, DEFAULT_ALLOWED_IMAGES, nextPort, parseAllowedImages, parseWorkspaceRoots, validateNode } from '../../../rootfs/usr/local/lib/dev-host/control/nodes.mjs';
import { clearWindow, extendWindow, runStartupPass, scheduleState, WEEK_MS } from '../../../rootfs/usr/local/lib/dev-host/control/schedule.mjs';
import { createStore } from '../../../rootfs/usr/local/lib/dev-host/control/store.mjs';
import { createDiscovery } from '../../../rootfs/usr/local/lib/dev-host/control/discovery.mjs';

const temporary = new Set();
const servers = new Set();

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'node-dev-host-'));
  temporary.add(dir);
  return dir;
}

async function fakeDocker(handler) {
  const socket = path.join(await tempDir(), 'docker.sock');
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(socket, resolve));
  servers.add(server);
  return { socket, server };
}

afterEach(async () => {
  await Promise.all([...servers].map((server) => new Promise((resolve) => server.close(resolve))));
  servers.clear();
  await Promise.all([...temporary].map((dir) => fs.rm(dir, { recursive: true, force: true })));
  temporary.clear();
});

function reply(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(typeof value === 'string' ? value : JSON.stringify(value));
}

test('pullImage treats an error line inside HTTP 200 as a failure', async () => {
  const { socket } = await fakeDocker((req, res) => {
    if (req.url.startsWith('/images/create')) return reply(res, 200, '{"error":"registry denied"}\n');
    reply(res, 404, { message: 'not found' });
  });
  const docker = createDockerClient(socket);
  await assert.rejects(docker.pullImage('node-dev-host:latest'), /registry denied/);
});

test('pullImage uses a local image after an offline failure, otherwise throws', async () => {
  const { socket } = await fakeDocker((req, res) => {
    if (req.url.startsWith('/images/create')) return reply(res, 500, { message: 'offline' });
    if (req.url.includes('local')) return reply(res, 200, { Id: 'local' });
    return reply(res, 404, { message: 'not found' });
  });
  const docker = createDockerClient(socket);
  assert.match((await docker.pullImage('node-dev-host:local')).warning, /latest image could not be pulled: offline/);
  await assert.rejects(docker.pullImage('node-dev-host:missing'), /offline/);
});

test('concurrent pulls of one image are coalesced', async () => {
  let pulls = 0;
  const { socket } = await fakeDocker((req, res) => {
    pulls += 1;
    setTimeout(() => reply(res, 200, '{"status":"done"}\n'), 30);
  });
  const docker = createDockerClient(socket);
  await Promise.all([docker.pullImage('node-dev-host:latest'), docker.pullImage('node-dev-host:latest'), docker.pullImage('node-dev-host:latest')]);
  assert.equal(pulls, 1);
});

test('store reloads records and serializes parallel updates', async () => {
  const dir = await tempDir();
  const store = createStore({ dir });
  await Promise.all([
    store.update((document) => { document.nodes.push({ name: 'one' }); }),
    store.update((document) => { document.nodes.push({ name: 'two' }); }),
  ]);
  assert.deepEqual((await createStore({ dir }).load()).nodes.map((node) => node.name), ['one', 'two']);
  assert.equal((await fs.stat(path.join(dir, 'nodes.json'))).mode & 0o777, 0o600);
});

test('failed rename leaves the previous node store intact', async () => {
  const dir = await tempDir();
  let failRename = false;
  const fsApi = Object.create(fs);
  fsApi.rename = async (...args) => {
    if (failRename) throw new Error('simulated interrupted write');
    return fs.rename(...args);
  };
  const store = createStore({ dir, fsApi });
  await store.update((document) => { document.nodes.push({ name: 'kept' }); });
  failRename = true;
  await assert.rejects(store.update((document) => { document.nodes.push({ name: 'lost' }); }), /interrupted/);
  assert.deepEqual((await createStore({ dir }).load()).nodes, [{ name: 'kept' }]);
});

test('corrupt store is preserved and unwritable directory is reported', async () => {
  const dir = await tempDir();
  await fs.writeFile(path.join(dir, 'nodes.json'), '{');
  const store = createStore({ dir, log: () => {} });
  assert.deepEqual((await store.load()).nodes, []);
  assert.match((await store.status()).warning, /preserved at .*\.corrupt-/);
  await fs.chmod(dir, 0o500);
  assert.equal((await store.status()).writable, false);
  await fs.chmod(dir, 0o700);
});

test('node validation, fixed creation body, and nextPort respect the record contract', () => {
  const input = {
    name: 'nd-site',
    workspace: '/home/me/repos/site',
    port: 43195,
    image: 'registry.example/nd:1.0',
    env: { HTTP_PORT: '8080' },
  };
  const options = { allowedImages: ['registry.example/nd'], workspaceRoots: ['/home/me/repos'] };
  const record = validateNode(input, options);
  assert.deepEqual(createBody(record), {
    Image: 'registry.example/nd:1.0',
    ExposedPorts: { '8080/tcp': {} },
    Env: ['HTTP_PORT=8080'],
    Labels: { 'node-dev-host.port': '43195', 'node-dev-host.name': 'nd-site' },
    HostConfig: {
      Binds: ['/home/me/repos/site:/workspace:ro', 'node-dev-host-pnpm:/var/lib/dev-host/pnpm'],
      PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '43195' }] },
      RestartPolicy: { Name: 'no' },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
    },
  });
  assert.throws(() => validateNode({ ...input, port: 8080 }, options), /43100-43299/);
  assert.throws(() => validateNode({ ...input, image: 'evil.example/nd:1' }, options), /CONTROL_ALLOWED_IMAGES/);
  assert.throws(() => validateNode({ ...input, workspace: '/etc' }, { ...options, workspaceRoots: ['/home/me/repos'] }), /CONTROL_WORKSPACE_ROOTS/);
  assert.throws(() => validateNode({ ...input, workspace: 'relative' }, options), /absolute path/);
  assert.throws(() => validateNode({ ...input, workspace: '/home/../etc' }, options), /\.\./);
  assert.throws(() => validateNode({ ...input, env: { 'bad-key': 'x' } }, options), /environment variable name/);
  assert.throws(() => validateNode({ ...input, capabilities: ['SYS_ADMIN'] }, options), /unknown node field/);
  assert.throws(() => validateNode({ ...input, name: 'bad/name' }, options), /name must match/);
  assert.equal(nextPort([{ port: 43100 }], [{ Labels: { 'node-dev-host.port': '43101' } }]), 43102);
  assert.deepEqual(parseAllowedImages('registry.example/nd'), ['registry.example/nd']);
  assert.deepEqual(parseWorkspaceRoots('/work,/repo'), ['/work', '/repo']);
  assert.deepEqual(parseAllowedImages(''), DEFAULT_ALLOWED_IMAGES);
  assert.deepEqual(DEFAULT_ALLOWED_IMAGES, ['ghcr.io/newbe36524/node-dev-host', 'node-dev-host']);
  assert.deepEqual(parseWorkspaceRoots(''), []);
});

test('node operations lock per node and retain errors until a later success', async () => {
  const operations = createOperationTracker();
  let release;
  const first = operations.run('one', 'pulling', async ({ setPhase }) => {
    setPhase('creating');
    await new Promise((resolve) => { release = resolve; });
  });
  await assert.rejects(operations.run('one', 'starting', async () => {}), /creating/);
  await operations.run('two', 'starting', async () => {});
  release();
  await first;
  await assert.rejects(operations.run('one', 'pulling', async () => { throw new Error('failed'); }), /failed/);
  assert.equal(operations.get('one').error, 'failed');
  await operations.run('one', 'starting', async () => {});
  assert.equal(operations.get('one').error, null);
});

test('schedule windows use absolute timestamps and extend without shortening', () => {
  const now = Date.parse('2026-01-01T04:00:00-05:00');
  const activeUntil = new Date(now + 2 * 86_400_000).toISOString();
  assert.deepEqual(scheduleState(activeUntil, now), { state: 'active', until: activeUntil, daysLeft: 2 });
  assert.equal(scheduleState(null, now).state, 'none');
  assert.equal(scheduleState(new Date(now - 1).toISOString(), now).state, 'ended');
  assert.equal(extendWindow(activeUntil, now), new Date(now + WEEK_MS).toISOString());
  assert.equal(extendWindow(new Date(now + 9 * 86_400_000).toISOString(), now), new Date(now + 9 * 86_400_000).toISOString());
  assert.equal(extendWindow(null, now), new Date(now + WEEK_MS).toISOString());
  assert.equal(extendWindow(new Date(now - 86_400_000).toISOString(), now), new Date(now + WEEK_MS).toISOString());
  assert.equal(clearWindow(), null);
});

test('startup pass starts only active records, bounds concurrency, and continues after errors', async () => {
  const records = [
    { name: 'missing', image: 'nd:latest', autoStartUntil: '2027-01-08T00:00:00.000Z' },
    { name: 'exited', image: 'nd:latest', autoStartUntil: '2027-01-08T00:00:00.000Z' },
    { name: 'running', image: 'nd:latest', autoStartUntil: '2027-01-08T00:00:00.000Z' },
    { name: 'ended', image: 'nd:latest', autoStartUntil: '2026-01-01T00:00:00.000Z' },
    ...Array.from({ length: 4 }, (_, i) => ({ name: `batch-${i}`, image: 'nd:latest', autoStartUntil: '2027-01-08T00:00:00.000Z' })),
  ];
  const operations = createOperationTracker();
  const started = [];
  const resolved = [];
  let running = 0;
  let maximum = 0;
  let pulls = 0;
  const errors = [];
  await runStartupPass({
    store: { getNodes: async () => records },
    operations,
    resolveContainer: async (name) => {
      resolved.push(name);
      if (name === 'running') return { State: { Running: true } };
      if (name === 'exited') return { State: { Running: false } };
      return null;
    },
    pullImage: async () => { pulls += 1; return { warning: null }; },
    createBody: (record) => record,
    createContainer: async (name) => {
      running += 1;
      maximum = Math.max(maximum, running);
      try {
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (name === 'missing') throw new Error('port is allocated');
        started.push(name);
      } finally {
        running -= 1;
      }
    },
    startContainer: async (name) => { if (!started.includes(name)) started.push(name); },
    log: (message) => errors.push(message),
  });
  assert.ok(maximum <= 2);
  assert.equal(pulls, 1);
  assert.deepEqual(new Set(started), new Set(['exited', 'batch-0', 'batch-1', 'batch-2', 'batch-3']));
  assert.equal(errors.length, 1);
  assert.equal(operations.get('missing').error, 'port is allocated');
  // Only records with an active window are looked at: the ended record and any container without a record are never touched.
  assert.deepEqual([...new Set(resolved)].sort(), ['batch-0', 'batch-1', 'batch-2', 'batch-3', 'exited', 'missing', 'running']);
  assert.ok(!resolved.includes('ended'));
});

test('discovery imports reproducible containers once and reports unsupported shapes', async () => {
  const dir = await tempDir();
  const store = createStore({ dir });
  const makeInfo = (name, overrides = {}) => ({
    Name: `/${name}`,
    Config: {
      Image: 'node-dev-host:latest',
      Labels: { 'node-dev-host.port': name === 'nd-public' ? '43102' : name === 'nd-extra' ? '43103' : '43101' },
      Env: ['NODE_VERSION=24', 'CUSTOM=value'],
    },
    State: { Running: false },
    HostConfig: { PortBindings: { '8080/tcp': [{ HostIp: name === 'nd-public' ? '0.0.0.0' : '127.0.0.1' }] }, Privileged: false },
    Mounts: [{ Type: 'bind', Source: '/workspace/site', Destination: '/workspace', RW: false }],
    NetworkSettings: { Networks: { bridge: { IPAddress: '' } } },
    ...overrides,
  });
  const containers = [
    makeInfo('nd-import'),
    makeInfo('nd-extra', { Mounts: [{ Type: 'bind', Source: '/etc', Destination: '/etc' }] }),
    makeInfo('nd-public'),
  ];
  const docker = {
    dockerRaw: async (method, apiPath) => {
      if (apiPath.startsWith('/containers/json')) {
        return { status: 200, body: Buffer.from(JSON.stringify(containers.map((info) => ({ Names: [info.Name] })))) };
      }
      const name = decodeURIComponent(apiPath.split('/')[2]);
      return { status: 200, body: Buffer.from(JSON.stringify(containers.find((info) => info.Name === `/${name}`))) };
    },
    imageInfo: async () => ({ Config: { Env: ['NODE_VERSION=24'] } }),
  };
  const discovery = createDiscovery({ docker, store, allowedImages: ['node-dev-host'], log: () => {} });
  const first = await discovery.scan();
  assert.deepEqual(first, {
    imported: ['nd-import'],
    skipped: [
      { name: 'nd-extra', reason: 'unsupported mount: /etc' },
      { name: 'nd-public', reason: 'published port is not bound to loopback' },
    ],
  });
  assert.deepEqual((await store.getNodes())[0].env, { CUSTOM: 'value' });
  assert.deepEqual(await discovery.scan(), { imported: [], skipped: [
    { name: 'nd-extra', reason: 'unsupported mount: /etc' },
    { name: 'nd-public', reason: 'published port is not bound to loopback' },
  ] });
});

test('discovery skips privileged containers and containers without a /workspace bind, with the documented reasons', async () => {
  const store = createStore({ dir: await tempDir() });
  const base = (name, overrides = {}) => ({
    Name: `/${name}`,
    Config: { Image: 'node-dev-host:latest', Labels: { 'node-dev-host.port': '43111' }, Env: [] },
    State: { Running: false },
    HostConfig: { PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1' }] }, Privileged: false },
    Mounts: [{ Type: 'bind', Source: '/workspace/site', Destination: '/workspace', RW: false }],
    NetworkSettings: { Networks: {} },
    ...overrides,
  });
  const containers = [
    base('nd-priv', { HostConfig: { PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1' }] }, Privileged: true } }),
    base('nd-nows', { Mounts: [] }),
  ];
  const docker = {
    dockerRaw: async (method, apiPath) => {
      if (apiPath.startsWith('/containers/json')) {
        return { status: 200, body: Buffer.from(JSON.stringify(containers.map((info) => ({ Names: [info.Name] })))) };
      }
      const name = decodeURIComponent(apiPath.split('/')[2]);
      return { status: 200, body: Buffer.from(JSON.stringify(containers.find((info) => info.Name === `/${name}`))) };
    },
    imageInfo: async () => ({ Config: { Env: [] } }),
  };
  const discovery = createDiscovery({ docker, store, allowedImages: ['node-dev-host'], log: () => {} });
  assert.deepEqual(await discovery.scan(), {
    imported: [],
    skipped: [
      { name: 'nd-priv', reason: 'container is privileged' },
      { name: 'nd-nows', reason: 'no /workspace bind' },
    ],
  });
  assert.deepEqual(await store.getNodes(), []);
});

test('networks on add are validated as user-defined names and attached through the create body', () => {
  const input = { name: 'nd-net', workspace: '/home/me/repos/site', port: 43196, image: 'node-dev-host:latest' };
  const options = { allowedImages: ['node-dev-host'], workspaceRoots: [] };
  const record = validateNode({ ...input, networks: ['nd-console_default', 'nd-console_default'] }, options);
  assert.deepEqual(record.networks, ['nd-console_default']);
  assert.deepEqual(Object.keys(createBody(record).NetworkingConfig.EndpointsConfig), ['nd-console_default']);
  assert.equal(createBody(validateNode(input, options)).NetworkingConfig, undefined);
  assert.throws(() => validateNode({ ...input, networks: 'nd-console_default' }, options), /array of network names/);
  assert.throws(() => validateNode({ ...input, networks: ['bridge'] }, options), /user-defined/);
  assert.throws(() => validateNode({ ...input, networks: ['host'] }, options), /user-defined/);
  assert.throws(() => validateNode({ ...input, networks: ['bad name'] }, options), /invalid network name/);
  assert.throws(() => validateNode({ ...input, networks: ['a', 'b', 'c', 'd', 'e'] }, options), /at most 4/);
});
