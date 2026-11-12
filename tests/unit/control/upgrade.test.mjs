import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createStore } from '../../../rootfs/usr/local/lib/dev-host/control/store.mjs';
import { createSelfUpgrade, isLatestTag, candidateBody } from '../../../rootfs/usr/local/lib/dev-host/control/upgrade.mjs';

const OLD = 'a'.repeat(64);
const SELF_SHORT = 'a'.repeat(12);
const CAND = 'b'.repeat(64);
const CAND_SHORT = 'b'.repeat(12);
const IMAGE = 'ghcr.io/newbe36524/node-dev-host:latest';
const timings = { healthTimeoutMs: 300, healthPollMs: 5, idleTimeoutMs: 300, ackTimeoutMs: 400, pollMs: 5 };

function selfContainer(image = IMAGE) {
  return {
    Id: OLD,
    Name: '/nd-control',
    Image: 'sha256:old',
    Config: {
      Image: image,
      Cmd: ['control'],
      Env: ['HTTP_PORT=8080', 'CONTROL_DATA_DIR=/var/lib/dev-host/control', 'CONTROL_STANDBY=false'],
      Labels: { 'com.docker.compose.service': 'nd-control', 'node-dev-host.role': 'control' },
      ExposedPorts: { '8080/tcp': {} },
    },
    Mounts: [
      { Type: 'volume', Name: 'node-dev-host-control', Destination: '/var/lib/dev-host/control', RW: true },
      { Type: 'bind', Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: true },
    ],
    HostConfig: { RestartPolicy: { Name: 'unless-stopped' }, LogConfig: { Type: 'json-file', Config: {} }, PortBindings: { '8080/tcp': [{ HostPort: '43180' }] } },
    NetworkSettings: { Networks: { 'nd-console_default': {}, 'hpc-console_default': {} } },
    State: { Running: true },
  };
}

function fakeDocker({ image = IMAGE, newImageId = 'sha256:new', healthy = true } = {}) {
  const calls = [];
  const containers = new Map([[OLD, selfContainer(image)]]);
  const images = new Map([[image, { Id: newImageId }]]);
  let created = null;
  const find = (id) => [...containers.values()].find((c) => c.Id.startsWith(id));
  const reply = (status, value) => ({ status, body: Buffer.from(value === undefined ? '' : JSON.stringify(value)) });
  return {
    calls,
    containers,
    get created() { return created; },
    docker: {
      async dockerRaw(method, p) {
        calls.push(`${method} ${p.split('?')[0]}`);
        let m;
        if (method === 'GET' && (m = p.match(/^\/containers\/([^/?]+)\/json$/))) {
          const c = find(m[1]);
          return c ? reply(200, c) : reply(404, { message: 'no such container' });
        }
        if (method === 'POST' && (m = p.match(/^\/containers\/([^/?]+)\/start$/))) {
          const c = find(m[1]);
          c.State = { Running: true, Health: { Status: healthy ? 'healthy' : 'starting' } };
          return reply(204);
        }
        if (method === 'POST' && (m = p.match(/^\/containers\/([^/?]+)\/rename\?name=(.+)$/))) {
          find(m[1]).Name = `/${decodeURIComponent(m[2])}`;
          return reply(204);
        }
        if (method === 'DELETE' && (m = p.match(/^\/containers\/([^/?]+)\?force=1$/))) {
          const c = find(m[1]);
          if (c) containers.delete(c.Id);
          return reply(c ? 204 : 404);
        }
        return reply(404, { message: `unexpected ${method} ${p}` });
      },
      async pullImage() { return { warning: null }; },
      async imageInfo(ref) { return images.get(ref) ?? null; },
      async createContainer(name, body) {
        created = { name, body };
        containers.set(CAND, {
          Id: CAND, Name: `/${name}`, Image: 'sha256:new', Config: { Env: body.Env, Labels: body.Labels, Image: body.Image },
          Mounts: [], HostConfig: body.HostConfig, NetworkSettings: { Networks: {} }, State: { Running: false },
        });
        return { Id: CAND };
      },
    },
  };
}

function storeSpy(calls) {
  return {
    freeze: (reason) => calls.push(`freeze:${reason}`),
    thaw: () => calls.push('thaw'),
    drain: async () => calls.push('drain'),
  };
}

async function waitForPhase(upgrade, phases, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!phases.includes(upgrade.status().phase)) {
    if (Date.now() > deadline) throw new Error(`phase stuck at ${upgrade.status().phase}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return upgrade.status();
}

async function waitUntilIdle(upgrade, ms = 3000) {
  const deadline = Date.now() + ms;
  while (upgrade.busy()) {
    if (Date.now() > deadline) throw new Error('upgrade still busy');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return upgrade.status();
}

async function setup(options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'control-upgrade-'));
  const fake = fakeDocker(options);
  const calls = [];
  const logs = [];
  const upgrade = createSelfUpgrade({
    docker: fake.docker, store: storeSpy(calls), operations: { inFlight: () => [] },
    dataDir: dir, selfId: SELF_SHORT, timings, log: (...parts) => logs.push(parts.join(' ')),
  });
  return { dir, fake, calls, logs, upgrade };
}

test('isLatestTag follows only untagged and latest references', () => {
  assert.equal(isLatestTag('ghcr.io/newbe36524/node-dev-host:latest'), true);
  assert.equal(isLatestTag('ghcr.io/newbe36524/node-dev-host'), true);
  assert.equal(isLatestTag('localhost:5000/nd'), true);
  assert.equal(isLatestTag('ghcr.io/newbe36524/node-dev-host:0.2.1'), false);
  assert.equal(isLatestTag('ghcr.io/newbe36524/node-dev-host@sha256:abc'), false);
});

test('candidate body keeps the config, has no host port, and starts in standby', () => {
  const body = candidateBody(selfContainer(), { image: IMAGE });
  assert.equal(body.Image, IMAGE);
  assert.deepEqual(body.Cmd, ['control']);
  assert.ok(body.Env.includes('CONTROL_STANDBY=true'));
  assert.ok(!body.Env.includes('CONTROL_STANDBY=false'));
  assert.equal(body.HostConfig.PortBindings, undefined);
  assert.deepEqual(body.HostConfig.Binds, ['node-dev-host-control:/var/lib/dev-host/control', '/var/run/docker.sock:/var/run/docker.sock']);
  assert.deepEqual(Object.keys(body.NetworkingConfig.EndpointsConfig).sort(), ['hpc-console_default', 'nd-console_default']);
  assert.equal(body.Labels['com.docker.compose.service'], 'nd-control');
});

test('upgrade starts the candidate, freezes, hands over, swaps names and removes the old node', async () => {
  const { dir, fake, calls, upgrade } = await setup();
  const promoted = [];
  // The candidate's own watcher: it takes the store when handed over.
  const candidate = createSelfUpgrade({
    docker: fake.docker, store: storeSpy([]), operations: { inFlight: () => [] },
    dataDir: dir, selfId: CAND_SHORT, timings, log: () => {},
  });
  candidate.watchHandover(async () => { promoted.push(Date.now()); });

  assert.deepEqual(upgrade.start({ auto: false }), { queued: true });
  const done = await waitForPhase(upgrade, ['done', 'failed']);
  assert.equal(done.phase, 'done', done.error);
  assert.equal(promoted.length, 1);

  const order = calls.filter((c) => ['freeze:control node upgrade', 'drain', 'thaw'].includes(c));
  assert.deepEqual(order, ['freeze:control node upgrade', 'drain']);
  assert.ok(fake.created.name.startsWith('nd-control-next-'));
  assert.equal(fake.created.body.HostConfig.PortBindings, undefined);

  // Only the candidate is left, and it has the name the gateway forwards to.
  assert.deepEqual([...fake.containers.values()].map((c) => c.Name), ['/nd-control']);
  assert.equal([...fake.containers.values()][0].Id, CAND);

  const handover = JSON.parse(await fs.readFile(path.join(dir, 'handover.json'), 'utf8'));
  assert.equal(handover.state, 'active');
  assert.equal(handover.by, CAND_SHORT);
});

test('an unhealthy candidate is removed and the running node is never frozen', async () => {
  const { fake, calls, upgrade } = await setup({ healthy: false });
  upgrade.start({ auto: false });
  const done = await waitForPhase(upgrade, ['done', 'failed']);
  assert.equal(done.phase, 'failed');
  assert.match(done.error, /did not become healthy/);
  assert.ok(!calls.some((c) => c.startsWith('freeze')));
  assert.deepEqual([...fake.containers.values()].map((c) => c.Id), [OLD]);
});

test('without an acknowledgement the freeze is lifted and the candidate removed', async () => {
  const { dir, fake, calls, upgrade } = await setup();
  upgrade.start({ auto: false }); // no watcher: the candidate never takes over
  const done = await waitForPhase(upgrade, ['done', 'failed']);
  assert.equal(done.phase, 'failed');
  assert.match(done.error, /did not take over/);
  assert.ok(calls.includes('thaw'), 'store must thaw so the running node keeps working');
  assert.deepEqual([...fake.containers.values()].map((c) => c.Id), [OLD]);
  const handover = JSON.parse(await fs.readFile(path.join(dir, 'handover.json'), 'utf8'));
  assert.equal(handover.state, 'aborted');
});

test('an up-to-date image creates nothing', async () => {
  const { fake, upgrade } = await setup({ newImageId: 'sha256:old' });
  upgrade.start({ auto: false });
  const done = await waitUntilIdle(upgrade);
  assert.equal(done.result, 'up-to-date');
  assert.equal(fake.created, null);
});

test('automatic checks skip a pinned image', async () => {
  const { fake, upgrade } = await setup({ image: 'ghcr.io/newbe36524/node-dev-host:0.2.1', newImageId: 'sha256:new' });
  upgrade.start({ auto: true });
  const done = await waitUntilIdle(upgrade);
  assert.match(done.result, /skipped/);
  assert.equal(fake.created, null);
});

test('a second upgrade is refused while one runs, and changes pause', async () => {
  const { upgrade } = await setup();
  upgrade.start({ auto: false });
  assert.equal(upgrade.busy(), true);
  assert.throws(() => upgrade.start({ auto: false }), (err) => err.status === 409);
  await waitForPhase(upgrade, ['failed', 'done', 'idle']);
});

test('the store refuses writes while frozen, keeps reads, and accepts writes again after thaw', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'control-freeze-'));
  const store = createStore({ dir });
  await store.update((doc) => { doc.nodes.push({ name: 'nd-one' }); return doc; });
  store.freeze('control node upgrade');
  await assert.rejects(store.update((doc) => doc), (err) => err.status === 503 && /frozen/.test(err.message));
  assert.deepEqual((await store.getNodes()).map((n) => n.name), ['nd-one']);
  store.thaw();
  await store.update((doc) => { doc.nodes.push({ name: 'nd-two' }); return doc; });
  assert.deepEqual((await store.getNodes()).map((n) => n.name), ['nd-one', 'nd-two']);
});

test('a standby node ignores handovers addressed to another container', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'control-standby-'));
  await fs.writeFile(path.join(dir, 'handover.json'), JSON.stringify({ state: 'handover', to: 'c'.repeat(12) }));
  const { fake } = await setup();
  let promotions = 0;
  const standby = createSelfUpgrade({ docker: fake.docker, store: storeSpy([]), operations: { inFlight: () => [] }, dataDir: dir, selfId: CAND_SHORT, timings, log: () => {} });
  const timer = standby.watchHandover(async () => { promotions += 1; });
  await new Promise((resolve) => setTimeout(resolve, 60));
  clearInterval(timer);
  assert.equal(promotions, 0);
});
