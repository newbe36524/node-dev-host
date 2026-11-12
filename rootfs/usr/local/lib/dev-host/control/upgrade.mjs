// Self-upgrade of the control node.
//
// The running control node (A) starts a candidate (B) from the newly pulled image, in standby: B serves
// /__dev-host/status.json for its health check and nothing else, and it does not read the node store.
// When B is healthy, A stops taking changes, waits for its own store writes to finish, and writes
// handover.json in the data directory. B sees the handover, loads the store, starts its own work and
// acknowledges with state "active". A then renames B to its own name, removes itself, and exits.
//
// The front gateway (nd-gateway) keeps the host port; it forwards to the container named nd-control.
// While A is frozen it still answers reads, and its record writes fail with 503 (retry later).
// If B is not healthy, or does not acknowledge in time, B is removed and A thaws. A never thaws after
// B has acknowledged, so there is only ever one writer for nodes.json.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError, dockerMessage } from './docker.mjs';

const HANDOVER_FILE = 'handover.json';
const DEFAULT_TIMINGS = {
  healthTimeoutMs: 120_000,
  healthPollMs: 2_000,
  idleTimeoutMs: 120_000,
  ackTimeoutMs: 60_000,
  pollMs: 250,
};

// True when the image reference has no tag or the tag `latest`. Digest references are pinned.
export function isLatestTag(image = '') {
  if (image.includes('@')) return false;
  const slash = image.lastIndexOf('/');
  const colon = image.lastIndexOf(':');
  if (colon < slash) return true;
  return image.slice(colon + 1) === 'latest';
}

function mountToBind(mount) {
  const mode = mount.RW === false ? ':ro' : '';
  if (mount.Type === 'volume' && mount.Name) return `${mount.Name}:${mount.Destination}${mode}`;
  if (mount.Type === 'bind' && mount.Source) return `${mount.Source}:${mount.Destination}${mode}`;
  return null;
}

export function candidateBody(self, { image }) {
  const env = (self.Config?.Env || []).filter((entry) => !entry.startsWith('CONTROL_STANDBY='));
  env.push('CONTROL_STANDBY=true');
  const binds = (self.Mounts || []).map(mountToBind).filter(Boolean);
  const body = {
    Image: image,
    Env: env,
    Labels: { ...(self.Config?.Labels || {}) },
    HostConfig: {
      Binds: binds,
      RestartPolicy: self.HostConfig?.RestartPolicy || { Name: 'unless-stopped' },
      LogConfig: self.HostConfig?.LogConfig,
      // No PortBindings: the gateway owns the host port, and the candidate must not compete for it.
    },
    NetworkingConfig: {
      EndpointsConfig: Object.fromEntries(Object.keys(self.NetworkSettings?.Networks || {}).map((net) => [net, {}])),
    },
  };
  if (self.Config?.Cmd) body.Cmd = self.Config.Cmd;
  if (self.Config?.Entrypoint) body.Entrypoint = self.Config.Entrypoint;
  if (self.Config?.ExposedPorts) body.ExposedPorts = self.Config.ExposedPorts;
  return body;
}

export function createSelfUpgrade({
  docker,
  store,
  operations,
  dataDir,
  selfId,
  log = console.warn,
  timings = {},
  now = () => new Date().toISOString(),
}) {
  const t = { ...DEFAULT_TIMINGS, ...timings };
  const handoverPath = path.join(dataDir, HANDOVER_FILE);
  let state = { phase: 'idle', since: null, error: null, result: null };
  let busy = false;
  let promoting = false;

  const setState = (phase, extra = {}) => {
    state = { phase, since: now(), error: null, result: null, ...extra };
  };

  async function readHandover() {
    try {
      return JSON.parse(await fs.readFile(handoverPath, 'utf8'));
    } catch {
      return null;
    }
  }

  async function writeHandover(doc) {
    const temp = `${handoverPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.mkdir(dataDir, { recursive: true });
    await fs.writeFile(temp, `${JSON.stringify({ ...doc, at: now() })}\n`, { mode: 0o600 });
    await fs.rename(temp, handoverPath);
  }

  async function inspect(id) {
    const r = await docker.dockerRaw('GET', `/containers/${encodeURIComponent(id)}/json`);
    if (r.status === 404) return null;
    if (r.status !== 200) throw new HttpError(502, dockerMessage(r));
    return JSON.parse(r.body.toString('utf8'));
  }

  async function forceRemove(id) {
    const r = await docker.dockerRaw('DELETE', `/containers/${encodeURIComponent(id)}?force=1`);
    if (r.status !== 204 && r.status !== 404) throw new HttpError(500, dockerMessage(r));
  }

  async function rename(id, name) {
    const r = await docker.dockerRaw('POST', `/containers/${encodeURIComponent(id)}/rename?name=${encodeURIComponent(name)}`);
    if (r.status !== 204) throw new HttpError(500, dockerMessage(r));
  }

  async function waitUntil(check, timeoutMs, pollMs, failure) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > deadline) throw new Error(failure);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  async function waitHealthy(id) {
    await waitUntil(async () => {
      const info = await inspect(id);
      if (!info) throw new Error('candidate container disappeared');
      return info.State?.Health?.Status === 'healthy';
    }, t.healthTimeoutMs, t.healthPollMs, 'candidate control node did not become healthy in time');
  }

  async function waitIdle() {
    await waitUntil(async () => operations.inFlight().length === 0, t.idleTimeoutMs, t.pollMs,
      `operations still running after ${t.idleTimeoutMs} ms: ${operations.inFlight().join(', ')}`);
  }

  async function waitForAck(shortId) {
    await waitUntil(async () => {
      const doc = await readHandover();
      if (doc?.state === 'failed' && doc.to === shortId) throw new Error(`candidate failed to take over: ${doc.error}`);
      return doc?.state === 'active' && doc.by === shortId;
    }, t.ackTimeoutMs, t.pollMs, 'candidate did not take over in time');
  }

  async function execute({ auto }) {
    const self = await inspect(selfId);
    if (!self) throw new HttpError(404, `control container ${selfId} not found`);
    const image = self.Config.Image;
    if (auto && !isLatestTag(image)) {
      setState('idle', { result: 'skipped: not a latest tag' });
      return { upgraded: false };
    }
    setState('pulling');
    const pulled = await docker.pullImage(image);
    if (pulled.warning) log(`self-upgrade: ${pulled.warning}`);
    const latest = await docker.imageInfo(image);
    if (!latest?.Id) throw new HttpError(502, `image ${image} is not available`);
    if (latest.Id === self.Image) {
      setState('idle', { result: 'up-to-date' });
      return { upgraded: false };
    }

    const selfName = self.Name.replace(/^\//, '');
    const name = `${selfName}-next-${randomBytes(3).toString('hex')}`;
    setState('starting-candidate', { result: { image: latest.Id, auto } });
    const created = await docker.createContainer(name, candidateBody(self, { image }));
    const shortId = created.Id.slice(0, 12);
    const started = await docker.dockerRaw('POST', `/containers/${created.Id}/start`);
    if (started.status !== 204 && started.status !== 304) {
      await forceRemove(created.Id);
      throw new HttpError(500, dockerMessage(started));
    }
    try {
      setState('waiting-for-health');
      await waitHealthy(created.Id);
      setState('waiting-for-operations');
      await waitIdle();
    } catch (err) {
      await forceRemove(created.Id);
      throw err;
    }

    setState('handing-over');
    store.freeze('control node upgrade');
    try {
      await store.drain();
      await writeHandover({ state: 'handover', to: shortId, from: selfId.slice(0, 12) });
      await waitForAck(shortId);
    } catch (err) {
      await writeHandover({ state: 'aborted', to: shortId, error: err.message }).catch(() => {});
      await forceRemove(created.Id);
      store.thaw();
      throw err;
    }

    // Committed: the candidate is the only writer from here on. Failures below must not thaw this node.
    setState('swapping');
    const oldName = `${selfName}-prev-${selfId.slice(0, 12)}`;
    await rename(selfId, oldName).catch((err) => log(`self-upgrade: could not rename old node: ${err.message}`));
    await rename(created.Id, selfName).catch((err) => log(`self-upgrade: could not rename new node: ${err.message}`));
    log(`self-upgrade: ${shortId} took over from ${selfId.slice(0, 12)}; removing this container`);
    await forceRemove(selfId); // this process ends here
    return { upgraded: true, candidate: shortId };
  }

  function start({ auto = false } = {}) {
    if (busy) throw new HttpError(409, 'a control-node upgrade is already running');
    busy = true;
    execute({ auto })
      .then((result) => {
        if (result.upgraded) setState('done', { result: { upgraded: true, candidate: result.candidate } });
      })
      .catch((err) => {
        log(`self-upgrade failed: ${err.message || err}`);
        setState('failed', { error: err.message || String(err) });
      })
      .finally(() => {
        busy = false;
      });
    return { queued: true };
  }

  // The candidate side: wait for a handover addressed to this container, then take over.
  function watchHandover(onPromote) {
    const shortId = selfId.slice(0, 12);
    const timer = setInterval(async () => {
      if (promoting) return;
      const doc = await readHandover();
      if (doc?.state !== 'handover' || doc.to !== shortId) return;
      promoting = true;
      clearInterval(timer);
      try {
        await onPromote();
        await writeHandover({ state: 'active', by: shortId });
        log(`standby ${shortId} took over the node store`);
      } catch (err) {
        log(`standby ${shortId} could not take over: ${err.message || err}`);
        await writeHandover({ state: 'failed', to: shortId, error: err.message || String(err) }).catch(() => {});
      }
    }, t.pollMs);
    timer.unref?.();
    return timer;
  }

  return {
    start,
    watchHandover,
    status: () => ({ ...state, busy }),
    busy: () => busy,
  };
}
