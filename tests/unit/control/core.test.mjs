import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { createDockerClient, isLocalImage } from '../../../rootfs/usr/local/lib/dev-host/control/docker.mjs';
import { createOperationTracker } from '../../../rootfs/usr/local/lib/dev-host/control/operations.mjs';
import { assertPrivilegeAllowed, createBody, DEFAULT_ALLOWED_IMAGES, nextPort, parseAllowedImages, parseHostMountRoots, parsePrivilegedNodes, parseWorkspaceRoots, validateHostMount, validateNode, validateNpmRegistry } from '../../../rootfs/usr/local/lib/dev-host/control/nodes.mjs';
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

test('pullImage uses a local copy after an offline failure, otherwise throws', async () => {
  const { socket } = await fakeDocker((req, res) => {
    if (req.url.startsWith('/images/create')) return reply(res, 500, { message: 'offline' });
    if (req.url.includes('latest')) return reply(res, 200, { Id: 'present' });
    return reply(res, 404, { message: 'not found' });
  });
  const docker = createDockerClient(socket);
  assert.match((await docker.pullImage('node-dev-host:latest')).warning, /latest image could not be pulled: offline/);
  await assert.rejects(docker.pullImage('node-dev-host:missing'), /offline/);
});

test('isLocalImage is true only for a tag of local, not for a registry port or another tag', () => {
  assert.equal(isLocalImage('jjb-ndh:local'), true);
  assert.equal(isLocalImage('registry.example:5000/jjb-ndh:local'), true);
  assert.equal(isLocalImage('registry.example:5000/jjb-ndh'), false);
  assert.equal(isLocalImage('ghcr.io/newbe36524/node-dev-host:latest'), false);
  assert.equal(isLocalImage('jjb-ndh:1.0'), false);
  assert.equal(isLocalImage('jjb-ndh'), false);
});

test('a local tag is never pulled: a present image is used and no pull request is sent', async () => {
  const requests = [];
  const { socket } = await fakeDocker((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url.startsWith('/images/create')) return reply(res, 500, { message: 'must not pull' });
    if (req.url.includes('jjb-ndh%3Alocal')) return reply(res, 200, { Id: 'sha256:local' });
    reply(res, 404, { message: 'not found' });
  });
  const docker = createDockerClient(socket);
  assert.deepEqual(await docker.pullImage('jjb-ndh:local'), { warning: null });
  assert.equal(requests.some((line) => line.includes('/images/create')), false);
});

test('a missing local image fails with a message that names it and says to build it first, and sends no pull', async () => {
  const requests = [];
  const { socket } = await fakeDocker((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    reply(res, 404, { message: 'not found' });
  });
  const docker = createDockerClient(socket);
  await assert.rejects(docker.pullImage('jjb-ndh:local'),
    (err) => err.message === 'image jjb-ndh:local is not on this Docker host; build it first (docker build -t jjb-ndh:local .)');
  assert.equal(requests.some((line) => line.includes('/images/create')), false);
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
  // A port that an unlabelled container publishes (for example a control node started by hand) is taken too.
  assert.equal(nextPort([], [], [43100, 43101]), 43102);
  // Ports a start already found busy are skipped too, even when nothing saved or running holds them.
  assert.equal(nextPort([{ port: 43100 }], [], [], [43101]), 43102);
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

test('npm registry is validated, applied by default and overridden by a node env', async () => {
  assert.equal(validateNpmRegistry(undefined), null);
  assert.equal(validateNpmRegistry('   '), null);
  assert.equal(validateNpmRegistry(' http://mirror.test:4873/ '), 'http://mirror.test:4873/');
  assert.equal(validateNpmRegistry('https://registry.example/npm/'), 'https://registry.example/npm/');
  for (const bad of [42, 'ftp://mirror.test/', 'mirror.test', 'https://user:secret@mirror.test/', 'http://a b/', 'https://m.test/?x=1']) {
    assert.throws(() => validateNpmRegistry(bad), (err) => err.status === 400, `expected rejection of ${JSON.stringify(bad)}`);
  }

  const input = { name: 'nd-npm', workspace: '/home/me/repos/site', port: 43197, image: 'node-dev-host:latest' };
  const options = { allowedImages: ['node-dev-host'], workspaceRoots: [] };
  const plain = validateNode(input, options);
  const envOf = (body) => Object.fromEntries(body.Env.map((entry) => entry.split(/=(.*)/s).slice(0, 2)));
  assert.equal(createBody(plain).Env.length, 0);
  assert.equal(envOf(createBody(plain, { npmRegistry: 'http://mirror.test/' })).NPM_REGISTRY, 'http://mirror.test/');

  const own = validateNode({ ...input, env: { NPM_REGISTRY: 'https://own.test/' } }, options);
  assert.equal(envOf(createBody(own, { npmRegistry: 'http://mirror.test/' })).NPM_REGISTRY, 'https://own.test/');
  assert.equal(envOf(createBody(own, { npmRegistry: null })).NPM_REGISTRY, 'https://own.test/');
});

test('console settings persist beside the nodes and survive node updates', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'node-settings-'));
  temporary.add(dir);
  const store = createStore({ dir });
  assert.deepEqual(await store.getSettings(), {});
  await store.update((document) => {
    document.settings = { npmRegistry: 'http://mirror.test/' };
    return document;
  });
  await store.update((document) => {
    document.nodes.push({ name: 'nd-later' });
    return document;
  });
  assert.deepEqual(await store.getSettings(), { npmRegistry: 'http://mirror.test/' });
  assert.equal((await store.getNodes()).length, 1);
});

test('writable paths become read-write binds under the read-only workspace, and only inside it', () => {
  const options = { allowedImages: ['jjb-ndh'], workspaceRoots: ['/home/me/repos'] };
  const record = validateNode({
    name: 'nd-jjb', workspace: '/home/me/repos/jjb', port: 43103, image: 'jjb-ndh:local', writable: ['data', '.browser-profile/'],
  }, options);
  assert.deepEqual(record.writable, ['data', '.browser-profile']);
  assert.deepEqual(createBody(record).HostConfig.Binds, [
    '/home/me/repos/jjb:/workspace:ro',
    'node-dev-host-pnpm:/var/lib/dev-host/pnpm',
    '/home/me/repos/jjb/data:/workspace/data:rw',
    '/home/me/repos/jjb/.browser-profile:/workspace/.browser-profile:rw',
  ]);
  assert.deepEqual(createBody(validateNode({ name: 'nd-plain', workspace: '/home/me/repos/jjb', port: 43104, image: 'jjb-ndh:local' }, options)).HostConfig.Binds, [
    '/home/me/repos/jjb:/workspace:ro', 'node-dev-host-pnpm:/var/lib/dev-host/pnpm',
  ]);
  const base = { name: 'nd-jjb', workspace: '/home/me/repos/jjb', port: 43103, image: 'jjb-ndh:local' };
  assert.throws(() => validateNode({ ...base, writable: ['/etc'] }, options), /relative to the workspace/);
  assert.throws(() => validateNode({ ...base, writable: ['../x'] }, options), /must not contain \.\./);
  assert.throws(() => validateNode({ ...base, writable: ['data', 'data'] }, options), /more than once/);
  assert.throws(() => validateNode({ ...base, workspace: null, writable: ['data'] }, { ...options, allowWorkspaceNull: false }), /absolute path|needs a workspace/);
});

test('discovery imports a node with a read-write writable bind, and still skips a read-write bind outside the workspace', async () => {
  const dir = await tempDir();
  const store = createStore({ dir });
  const info = (name, extra) => ({
    Name: `/${name}`,
    Config: { Image: 'jjb-ndh:local', Labels: { 'node-dev-host.port': '43103' }, Env: ['NODE_VERSION=24'] },
    State: { Running: false },
    HostConfig: { PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1' }] }, Privileged: false },
    Mounts: [
      { Type: 'bind', Source: '/home/me/repos/jjb', Destination: '/workspace', RW: false },
      { Type: 'bind', Source: '/home/me/repos/jjb/data', Destination: '/workspace/data', RW: true },
      ...extra,
    ],
    NetworkSettings: { Networks: { bridge: { IPAddress: '' } } },
  });
  const containers = [info('nd-jjb', []), info('nd-rw-outside', [{ Type: 'bind', Source: '/home/me/other', Destination: '/workspace/x', RW: true }])];
  const docker = {
    dockerRaw: async (method, apiPath) => {
      if (apiPath.startsWith('/containers/json')) return { status: 200, body: Buffer.from(JSON.stringify(containers.map((c) => ({ Names: [c.Name] })))) };
      const name = decodeURIComponent(apiPath.split('/')[2]);
      return { status: 200, body: Buffer.from(JSON.stringify(containers.find((c) => c.Name === `/${name}`))) };
    },
    imageInfo: async () => ({ Config: { Env: ['NODE_VERSION=24'] } }),
  };
  const discovery = createDiscovery({ docker, store, allowedImages: ['jjb-ndh'], log: () => {} });
  assert.deepEqual(await discovery.scan(), {
    imported: ['nd-jjb'],
    skipped: [{ name: 'nd-rw-outside', reason: 'unsupported mount: /workspace/x' }],
  });
});

test('CONTROL_PRIVILEGED_NODES parses to trimmed, exact, de-duplicated names and reports invalid entries', () => {
  assert.deepEqual(parsePrivilegedNodes(''), { names: [], ignored: [] });
  assert.deepEqual(parsePrivilegedNodes(undefined), { names: [], ignored: [] });
  assert.deepEqual(parsePrivilegedNodes('nd-my-ansible'), { names: ['nd-my-ansible'], ignored: [] });
  assert.deepEqual(parsePrivilegedNodes(' nd-my-ansible ,nd-lab,, '), { names: ['nd-my-ansible', 'nd-lab'], ignored: [] });
  assert.deepEqual(parsePrivilegedNodes('nd-lab,nd-lab,nd-lab'), { names: ['nd-lab'], ignored: [] });
  // Case is kept as typed, so ND-LAB is a different name from nd-lab and never matches it.
  assert.deepEqual(parsePrivilegedNodes('ND-LAB'), { names: ['ND-LAB'], ignored: [] });
  assert.deepEqual(parsePrivilegedNodes('nd-my-ansible,bad name!,-leading,nd-lab'), {
    names: ['nd-my-ansible', 'nd-lab'],
    ignored: ['bad name!', '-leading'],
  });
});

test('a node record may be privileged only when its name is allowlisted, and defaults to not privileged', () => {
  const options = { allowedImages: ['node-dev-host'], workspaceRoots: ['/home'], privilegedNodes: new Set(['nd-my-ansible']) };
  const input = { name: 'nd-my-ansible', workspace: '/home/me/repos/site', port: 43120, image: 'node-dev-host:latest' };
  assert.equal(validateNode(input, options).privileged, false);
  assert.equal(validateNode({ ...input, privileged: false }, options).privileged, false);
  assert.equal(validateNode({ ...input, privileged: true }, options).privileged, true);
  assert.throws(() => validateNode({ ...input, name: 'nd-other', privileged: true }, options), (err) => {
    assert.equal(err.status, 400);
    assert.match(err.message, /CONTROL_PRIVILEGED_NODES/);
    return true;
  });
  // Without an allowlist, nothing is privileged.
  assert.throws(() => validateNode({ ...input, privileged: true }, { allowedImages: ['node-dev-host'], workspaceRoots: ['/home'] }), /CONTROL_PRIVILEGED_NODES/);
  assert.throws(() => validateNode({ ...input, privileged: 'yes' }, options), (err) => err.status === 400 && /must be a boolean/.test(err.message));
  assert.throws(() => validateNode({ ...input, privileged: 1 }, options), /must be a boolean/);
});

test('a privileged record gets Privileged in its create body; an ordinary record has no Privileged key; loopback, binds and socket are unchanged', () => {
  const options = { allowedImages: ['node-dev-host'], workspaceRoots: ['/home'], privilegedNodes: new Set(['nd-my-ansible']) };
  const base = { name: 'nd-my-ansible', workspace: '/home/me/repos/site', port: 43120, image: 'node-dev-host:latest' };
  const ordinary = createBody(validateNode({ ...base, name: 'nd-plain' }, { ...options, privilegedNodes: new Set() }));
  assert.equal('Privileged' in ordinary.HostConfig, false);
  const privileged = createBody(validateNode({ ...base, privileged: true }, options), { privilegedNodes: options.privilegedNodes });
  assert.equal(privileged.HostConfig.Privileged, true);
  // Everything else about the container is the same as an ordinary node of the same shape.
  const { Privileged, ...rest } = privileged.HostConfig;
  assert.deepEqual(rest, ordinary.HostConfig);
  assert.deepEqual(privileged.HostConfig.PortBindings, { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '43120' }] });
  assert.deepEqual(privileged.HostConfig.Binds, ['/home/me/repos/site:/workspace:ro', 'node-dev-host-pnpm:/var/lib/dev-host/pnpm']);
  assert.equal(privileged.HostConfig.Binds.some((bind) => bind.includes('docker.sock')), false);
  assert.equal(privileged.HostConfig.NetworkMode, undefined);
  // A privileged record whose name is not on the list cannot produce a create body at all.
  const notListed = validateNode({ ...base, privileged: true }, options);
  assert.throws(() => createBody({ ...notListed, name: 'nd-other' }, { privilegedNodes: options.privilegedNodes }), (err) => {
    assert.equal(err.status, 403);
    assert.match(err.message, /CONTROL_PRIVILEGED_NODES/);
    return true;
  });
  assert.throws(() => createBody(notListed), (err) => err.status === 403 && /CONTROL_PRIVILEGED_NODES/.test(err.message));
});

test('assertPrivilegeAllowed refuses a privileged record or container whose name left the allowlist, and nothing else', () => {
  const allowed = new Set(['nd-my-ansible']);
  const privilegedContainer = { HostConfig: { Privileged: true } };
  const plainContainer = { HostConfig: { Privileged: false } };
  assert.doesNotThrow(() => assertPrivilegeAllowed('nd-my-ansible', { record: { privileged: true }, container: privilegedContainer }, allowed));
  assert.doesNotThrow(() => assertPrivilegeAllowed('nd-plain', { record: { privileged: false }, container: plainContainer }, allowed));
  assert.doesNotThrow(() => assertPrivilegeAllowed('nd-plain', { record: { }, container: null }, new Set()));
  for (const args of [
    { record: { privileged: true }, container: null },
    { record: { privileged: true }, container: plainContainer },
    { record: null, container: privilegedContainer },
  ]) {
    assert.throws(() => assertPrivilegeAllowed('nd-gone', args, allowed), (err) => {
      assert.equal(err.status, 403);
      assert.match(err.message, /CONTROL_PRIVILEGED_NODES/);
      return true;
    });
  }
});

test('the node store loads a nodes.json from before the privileged field and leaves the file byte-identical', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'nodes.json');
  const old = `${JSON.stringify({ version: 1, nodes: [{ name: 'nd-old', workspace: '/home/me/repos/old', port: 43100, image: 'node-dev-host:latest', env: {}, restartPolicy: 'no', networks: [], writable: [], source: 'added', createdAt: '2026-01-01T00:00:00.000Z', autoStartUntil: null }] }, null, 2)}\n`;
  await fs.writeFile(file, old, 'utf8');
  const before = await fs.readFile(file);
  const store = createStore({ dir });
  const [node] = await store.getNodes();
  assert.equal(node.name, 'nd-old');
  assert.equal(node.privileged, undefined);
  assert.equal(createBody(node).HostConfig.Privileged, undefined);
  assert.deepEqual(await fs.readFile(file), before);
});

test('discovery imports an allowlisted privileged container as privileged, keeps the other checks, and still skips the rest', async () => {
  const store = createStore({ dir: await tempDir() });
  const base = (name, overrides = {}) => ({
    Name: `/${name}`,
    Config: { Image: 'node-dev-host:latest', Labels: { 'node-dev-host.port': name === 'nd-my-ansible' ? '43121' : '43122' }, Env: [] },
    State: { Running: false },
    HostConfig: { PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1' }] }, Privileged: true },
    Mounts: [{ Type: 'bind', Source: '/workspace/site', Destination: '/workspace', RW: false }],
    NetworkSettings: { Networks: {} },
    ...overrides,
  });
  const containers = [
    base('nd-my-ansible'),
    base('nd-my-ansible-extra', { Mounts: [{ Type: 'bind', Source: '/workspace/site', Destination: '/workspace', RW: false }, { Type: 'bind', Source: '/etc', Destination: '/etc' }] }),
    base('nd-priv'),
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
  const discovery = createDiscovery({
    docker,
    store,
    allowedImages: ['node-dev-host'],
    workspaceRoots: ['/workspace'],
    privilegedNodes: new Set(['nd-my-ansible', 'nd-my-ansible-extra']),
    log: () => {},
  });
  assert.deepEqual(await discovery.scan(), {
    imported: ['nd-my-ansible'],
    skipped: [
      { name: 'nd-my-ansible-extra', reason: 'unsupported mount: /etc' },
      { name: 'nd-priv', reason: 'container is privileged' },
    ],
  });
  const [record] = await store.getNodes();
  assert.equal(record.name, 'nd-my-ansible');
  assert.equal(record.privileged, true);
  assert.equal(createBody(record, { privilegedNodes: new Set(['nd-my-ansible']) }).HostConfig.Privileged, true);
});

test('a node record from before pidHost and hostMounts normalizes to the defaults, and nodes.json is not rewritten', async () => {
  const dir = await tempDir();
  const file = path.join(dir, 'nodes.json');
  const old = `${JSON.stringify({ version: 1, nodes: [{ name: 'nd-old', workspace: '/home/me/repos/old', port: 43100, image: 'node-dev-host:latest', env: {}, restartPolicy: 'no', networks: [], writable: [], source: 'added', createdAt: '2026-01-01T00:00:00.000Z', autoStartUntil: null }] }, null, 2)}\n`;
  await fs.writeFile(file, old, 'utf8');
  const before = await fs.readFile(file);
  const store = createStore({ dir });
  const [stored] = await store.getNodes();
  assert.equal(stored.pidHost, undefined);
  assert.equal(stored.hostMounts, undefined);
  const { name, workspace, port, image, env } = stored;
  const normalized = validateNode({ name, workspace, port, image, env }, { allowedImages: ['node-dev-host'], workspaceRoots: ['/home'] });
  assert.equal(normalized.pidHost, false);
  assert.deepEqual(normalized.hostMounts, []);
  assert.equal('PidMode' in createBody(normalized).HostConfig, false);
  assert.deepEqual(await fs.readFile(file), before);
});

test('pidHost and hostMounts are type-checked, bounded and unique, and a rejection saves nothing', () => {
  const options = { allowedImages: ['node-dev-host'], workspaceRoots: ['/home'], privilegedNodes: new Set(['nd-my-ansible']) };
  const input = { name: 'nd-my-ansible', workspace: '/home/me/repos/site', port: 43120, image: 'node-dev-host:latest' };
  const rejects = (extra, pattern) => assert.throws(() => validateNode({ ...input, ...extra }, options), (err) => err.status === 400 && pattern.test(err.message));
  rejects({ pidHost: 'yes' }, /pidHost must be a boolean/);
  rejects({ pidHost: 1 }, /pidHost must be a boolean/);
  rejects({ hostMounts: '/var/lib/steam' }, /hostMounts must be a list of host paths/);
  rejects({ hostMounts: [1] }, /hostMounts must be a list of host paths/);
  rejects({ hostMounts: ['/var/lib/steam', '/var/lib/steam'] }, /lists a path more than once/);
  rejects({ hostMounts: ['/var/lib/a', '/var/lib/b', '/var/lib/c', '/var/lib/d', '/var/lib/e'] }, /at most 4 paths/);
  const accepted = validateNode({ ...input, pidHost: true, hostMounts: ['/var/lib/steam'] }, options);
  assert.equal(accepted.pidHost, true);
  assert.deepEqual(accepted.hostMounts, ['/var/lib/steam']);
  assert.equal(validateNode(input, options).pidHost, false);
  assert.deepEqual(validateNode(input, options).hostMounts, []);
});

test('validateHostMount refuses every deny entry, relative, unnormalized and socket paths, and accepts a narrow path', () => {
  const refused = [
    // Socket trees: the whole tree is refused.
    '/run', '/run/user/1000/podman', '/var/run', '/var/run/docker.sock', '/var/lib/docker', '/var/lib/containerd',
    // Sockets by name anywhere.
    '/home/me/podman.sock', '/var/lib/steam/docker.sock',
    // Whole system directories.
    '/', '/home', '/var', '/var/lib', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/opt', '/srv', '/mnt', '/media', '/tmp',
    // Sensitive trees, at any depth.
    '/proc', '/proc/1/environ', '/sys', '/sys/kernel', '/dev', '/dev/shm', '/etc', '/etc/shadow', '/root', '/root/.ssh', '/boot', '/boot/efi',
    // Relative, unnormalized, repeated-slash and trailing-slash forms.
    'var/lib/steam', '', '/var/lib/../steam', '/var/lib/steam/..', '/var/lib/./steam', '/var//lib/steam', '/var/lib/steam/',
  ];
  for (const value of refused) {
    assert.throws(() => validateHostMount(value), (err) => err.status === 400 && err.message.includes(value), value);
  }
  assert.throws(() => validateHostMount('/proc'), /host PID namespace/);
  assert.throws(() => validateHostMount(['/var/lib/steam']), (err) => err.status === 400);
  assert.equal(validateHostMount('/var/lib/steam/instances'), '/var/lib/steam/instances');
  assert.equal(validateHostMount('/home/me/.local/share/containers'), '/home/me/.local/share/containers');
});

test('CONTROL_HOST_MOUNT_ROOTS keeps the valid roots, reports the rest, and a non-empty setting with no valid root refuses every mount', () => {
  assert.deepEqual(parseHostMountRoots(''), { configured: false, roots: [], ignored: [] });
  assert.deepEqual(parseHostMountRoots('/var/lib/steam, var/lib, /srv/x/, /var/lib/steam'), {
    configured: true, roots: ['/var/lib/steam'], ignored: ['var/lib', '/srv/x/'],
  });
  assert.deepEqual(parseHostMountRoots('relative'), { configured: true, roots: [], ignored: ['relative'] });
  // A setting of only separators is not empty: it must narrow to nothing, not to everything.
  assert.deepEqual(parseHostMountRoots(' , '), { configured: true, roots: [], ignored: [] });
});

test('host mounts must lie under CONTROL_HOST_MOUNT_ROOTS by path segment, and an empty setting adds no root restriction', () => {
  const optionsFor = (value) => ({
    allowedImages: ['node-dev-host'], workspaceRoots: ['/home'], privilegedNodes: new Set(['nd-my-ansible']), hostMountRoots: parseHostMountRoots(value),
  });
  const input = { name: 'nd-my-ansible', workspace: '/home/me/repos/site', port: 43120, image: 'node-dev-host:latest', pidHost: true };
  const accept = (mount, value) => validateNode({ ...input, hostMounts: [mount] }, optionsFor(value)).hostMounts;
  assert.deepEqual(accept('/var/lib/steam/instances', '/var/lib/steam'), ['/var/lib/steam/instances']);
  assert.deepEqual(accept('/var/lib/steam', '/var/lib/steam'), ['/var/lib/steam']);
  assert.throws(() => accept('/srv/data', '/var/lib/steam'), (err) => err.status === 400 && /CONTROL_HOST_MOUNT_ROOTS/.test(err.message));
  assert.throws(() => accept('/var/lib/steam-old', '/var/lib/steam'), /CONTROL_HOST_MOUNT_ROOTS/);
  // Every entry invalid: nothing is inside a root, so every mount is refused.
  assert.throws(() => accept('/srv/data', 'relative'), /CONTROL_HOST_MOUNT_ROOTS/);
  assert.throws(() => accept('/var/lib/steam', ','), /CONTROL_HOST_MOUNT_ROOTS/);
  // No setting: only the path rules apply.
  assert.deepEqual(accept('/srv/data', ''), ['/srv/data']);
  assert.throws(() => accept('/proc', ''), /host PID namespace/);
});

test('host access is granted only to an allowlisted name, and does not need privileged: true', () => {
  const options = { allowedImages: ['node-dev-host'], workspaceRoots: ['/home'], privilegedNodes: new Set(['nd-my-ansible']) };
  const input = { name: 'nd-my-ansible', workspace: '/home/me/repos/site', port: 43120, image: 'node-dev-host:latest' };
  const pidOnly = validateNode({ ...input, pidHost: true }, options);
  assert.equal(pidOnly.pidHost, true);
  assert.equal(pidOnly.privileged, false);
  assert.equal(validateNode({ ...input, hostMounts: ['/var/lib/steam'] }, options).privileged, false);
  for (const extra of [{ pidHost: true }, { hostMounts: ['/var/lib/steam'] }, { pidHost: false, hostMounts: ['/var/lib/steam'] }]) {
    assert.throws(() => validateNode({ ...input, name: 'nd-other', ...extra }, options), (err) => err.status === 400 && /CONTROL_PRIVILEGED_NODES/.test(err.message), JSON.stringify(extra));
  }
  assert.throws(() => validateNode({ ...input, pidHost: true }, { allowedImages: ['node-dev-host'], workspaceRoots: ['/home'] }), /CONTROL_PRIVILEGED_NODES/);
  // A name off the list that declares nothing is not refused.
  assert.equal(validateNode({ ...input, name: 'nd-other' }, options).pidHost, false);
});

test('createBody sets PidMode and read-only /host binds only for an allowlisted host-access record, with loopback publishing and no socket', () => {
  const hostMountRoots = parseHostMountRoots('/var/lib/steam,/home/me/.local/share/containers');
  const options = { allowedImages: ['node-dev-host'], workspaceRoots: ['/home'], privilegedNodes: new Set(['nd-my-ansible']), hostMountRoots };
  const base = { name: 'nd-my-ansible', workspace: '/home/me/repos/site', port: 43102, image: 'node-dev-host:latest' };
  const ordinary = createBody(validateNode({ ...base, name: 'nd-plain', port: 43103 }, { ...options, privilegedNodes: new Set() }));
  assert.equal('PidMode' in ordinary.HostConfig, false);
  assert.deepEqual(ordinary.HostConfig.Binds, ['/home/me/repos/site:/workspace:ro', 'node-dev-host-pnpm:/var/lib/dev-host/pnpm']);
  const host = validateNode({ ...base, pidHost: true, hostMounts: ['/var/lib/steam', '/home/me/.local/share/containers'] }, options);
  const body = createBody(host, { privilegedNodes: options.privilegedNodes, hostMountRoots });
  assert.equal(body.HostConfig.PidMode, 'host');
  assert.deepEqual(body.HostConfig.Binds, [
    '/home/me/repos/site:/workspace:ro',
    'node-dev-host-pnpm:/var/lib/dev-host/pnpm',
    '/var/lib/steam:/host/var/lib/steam:ro',
    '/home/me/.local/share/containers:/host/home/me/.local/share/containers:ro',
  ]);
  assert.equal(body.HostConfig.Binds.some((bind) => bind.includes('.sock') || bind.endsWith(':rw')), false);
  assert.equal('Privileged' in body.HostConfig, false);
  assert.deepEqual(body.HostConfig.PortBindings, { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '43102' }] });
  assert.equal(body.HostConfig.NetworkMode, undefined);
  // A name that left the list cannot produce a body, and a path outside the roots is refused at creation too.
  assert.throws(() => createBody({ ...host, name: 'nd-other' }, { privilegedNodes: options.privilegedNodes, hostMountRoots }), (err) => err.status === 403 && /CONTROL_PRIVILEGED_NODES/.test(err.message));
  assert.throws(() => createBody({ ...host, hostMounts: ['/srv/data'] }, { privilegedNodes: options.privilegedNodes, hostMountRoots }), /CONTROL_HOST_MOUNT_ROOTS/);
});

test('assertPrivilegeAllowed refuses host PID mode and /host mounts whose name left the allowlist, and nothing else', () => {
  const allowed = new Set(['nd-my-ansible']);
  const hostPid = { HostConfig: { PidMode: 'host' }, Mounts: [] };
  const hostMount = { HostConfig: { PidMode: '' }, Mounts: [{ Destination: '/host/var/lib/steam', Source: '/var/lib/steam', RW: false }] };
  const plain = { HostConfig: { PidMode: '' }, Mounts: [{ Destination: '/workspace', Source: '/home/x', RW: false }] };
  assert.doesNotThrow(() => assertPrivilegeAllowed('nd-my-ansible', { record: { pidHost: true, hostMounts: ['/var/lib/steam'] }, container: hostMount }, allowed));
  assert.doesNotThrow(() => assertPrivilegeAllowed('nd-my-ansible', { record: null, container: hostPid }, allowed));
  assert.doesNotThrow(() => assertPrivilegeAllowed('nd-plain', { record: { pidHost: false, hostMounts: [] }, container: plain }, new Set()));
  for (const args of [
    { record: { pidHost: true }, container: null },
    { record: { hostMounts: ['/var/lib/steam'] }, container: null },
    { record: null, container: hostPid },
    { record: null, container: hostMount },
    { record: {}, container: hostMount },
  ]) {
    assert.throws(() => assertPrivilegeAllowed('nd-gone', args, allowed), (err) => {
      assert.equal(err.status, 403);
      assert.match(err.message, /CONTROL_PRIVILEGED_NODES/);
      return true;
    });
  }
});

test('discovery imports allowlisted host access and skips every unapproved form with the documented reason', async () => {
  const store = createStore({ dir: await tempDir() });
  const workspaceBind = (overrides = {}) => ({ Type: 'bind', Source: '/workspace/site', Destination: '/workspace', RW: false, ...overrides });
  const hostBind = (source, overrides = {}) => ({ Type: 'bind', Source: source, Destination: `/host${source}`, RW: false, ...overrides });
  const base = (name, port, overrides = {}) => ({
    Name: `/${name}`,
    Config: { Image: 'node-dev-host:latest', Labels: { 'node-dev-host.port': String(port) }, Env: [] },
    State: { Running: false },
    HostConfig: { PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1' }] }, Privileged: false, PidMode: '' },
    Mounts: [workspaceBind()],
    NetworkSettings: { Networks: {} },
    ...overrides,
  });
  const containers = [
    base('nd-my-ansible', 43121, { HostConfig: { PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1' }] }, Privileged: false, PidMode: 'host' }, Mounts: [workspaceBind(), hostBind('/var/lib/steam')] }),
    base('nd-mounts', 43122, { Mounts: [workspaceBind(), hostBind('/var/lib/steam')] }),
    base('nd-other', 43123, { HostConfig: { PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1' }] }, Privileged: false, PidMode: 'host' } }),
    base('nd-pidother', 43124, { HostConfig: { PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1' }] }, Privileged: false, PidMode: 'container:abc123' } }),
    base('nd-writable', 43125, { Mounts: [workspaceBind(), hostBind('/var/lib/steam', { RW: true })] }),
    base('nd-misplaced', 43126, { Mounts: [workspaceBind(), { ...hostBind('/var/lib/steam'), Destination: '/host/var/lib/other' }] }),
    base('nd-proc', 43127, { Mounts: [workspaceBind(), hostBind('/proc')] }),
    base('nd-outside', 43128, { Mounts: [workspaceBind(), hostBind('/srv/data')] }),
    base('nd-nolist', 43129, { Mounts: [workspaceBind(), hostBind('/var/lib/steam')] }),
    base('nd-etc', 43130, { Mounts: [workspaceBind(), { Type: 'bind', Source: '/etc', Destination: '/etc', RW: false }] }),
    base('nd-priv', 43131, { HostConfig: { PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1' }] }, Privileged: true, PidMode: '' } }),
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
  const allowlisted = ['nd-my-ansible', 'nd-mounts', 'nd-pidother', 'nd-writable', 'nd-misplaced', 'nd-proc', 'nd-outside', 'nd-etc'];
  const discovery = createDiscovery({
    docker,
    store,
    allowedImages: ['node-dev-host'],
    workspaceRoots: ['/workspace'],
    privilegedNodes: new Set(allowlisted),
    hostMountRoots: parseHostMountRoots('/var/lib/steam'),
    log: () => {},
  });
  assert.deepEqual(await discovery.scan(), {
    imported: ['nd-my-ansible', 'nd-mounts'],
    skipped: [
      { name: 'nd-other', reason: 'container uses the host PID namespace' },
      { name: 'nd-pidother', reason: 'unsupported PID mode: container:abc123' },
      { name: 'nd-writable', reason: 'unsupported mount: /host/var/lib/steam (host mounts must be read-only)' },
      { name: 'nd-misplaced', reason: 'unsupported mount: /host/var/lib/other (host mounts must sit at /host plus the host path)' },
      { name: 'nd-proc', reason: 'unsupported mount: /host/proc (host mount /proc is refused: /proc is the host PID namespace, not a mount; set pidHost to read host processes)' },
      { name: 'nd-outside', reason: 'unsupported mount: /host/srv/data (host mount /srv/data is outside CONTROL_HOST_MOUNT_ROOTS (/var/lib/steam))' },
      { name: 'nd-nolist', reason: 'unsupported mount: /host/var/lib/steam (name is not on the privileged-node allowlist)' },
      { name: 'nd-etc', reason: 'unsupported mount: /etc' },
      { name: 'nd-priv', reason: 'container is privileged' },
    ],
  });
  const records = Object.fromEntries((await store.getNodes()).map((node) => [node.name, node]));
  assert.equal(records['nd-my-ansible'].pidHost, true);
  assert.deepEqual(records['nd-my-ansible'].hostMounts, ['/var/lib/steam']);
  assert.equal(records['nd-my-ansible'].privileged, false);
  assert.equal(records['nd-mounts'].pidHost, false);
  assert.deepEqual(records['nd-mounts'].hostMounts, ['/var/lib/steam']);
  const body = createBody(records['nd-my-ansible'], { privilegedNodes: new Set(allowlisted), hostMountRoots: parseHostMountRoots('/var/lib/steam') });
  assert.equal(body.HostConfig.PidMode, 'host');
  assert.ok(body.HostConfig.Binds.includes('/var/lib/steam:/host/var/lib/steam:ro'));
});

test('every host-access example record in the README and the node-dev-host skill passes validateNode', async () => {
  const repo = fileURLToPath(new URL('../../..', import.meta.url));
  // The examples name nd-my-ansible and sit under this root list, which the docs state in their prose.
  const options = {
    allowedImages: DEFAULT_ALLOWED_IMAGES,
    workspaceRoots: [],
    privilegedNodes: new Set(['nd-my-ansible']),
    hostMountRoots: parseHostMountRoots('/var/lib/steam,/home/me/.local/share/containers'),
  };
  let checked = 0;
  for (const doc of ['README.md', 'skills/node-dev-host/SKILL.md']) {
    const text = await fs.readFile(path.join(repo, doc), 'utf8');
    for (const [, json] of text.matchAll(/```json\n([\s\S]*?)```/g)) {
      if (!json.includes('"pidHost"')) continue;
      const record = validateNode(JSON.parse(json), options);
      assert.equal(record.pidHost, true, doc);
      assert.deepEqual(record.hostMounts, ['/var/lib/steam', '/home/me/.local/share/containers'], doc);
      checked += 1;
    }
  }
  assert.equal(checked, 2);
});
