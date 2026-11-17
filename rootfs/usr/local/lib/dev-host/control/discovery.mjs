import { HOST_MOUNT_PREFIX, NO_HOST_MOUNT_ROOTS, validateHostMount, validateNode } from './nodes.mjs';

const PNPM_VOLUME = '/var/lib/dev-host/pnpm';

const isHostMount = (mount) => (mount.Destination || '').startsWith(`${HOST_MOUNT_PREFIX}/`);

function containerName(info) {
  return info.Name?.replace(/^\//, '') || info.Config?.Labels?.['node-dev-host.name'] || '';
}

function imageEnv(info) {
  const names = new Set((info.Config?.Env || []).map((entry) => entry.split('=', 1)[0]));
  return names;
}

function workspaceMount(info) {
  return (info.Mounts || []).find((mount) => mount.Destination === '/workspace');
}

// A read-write bind under /workspace whose source is inside the workspace: the writable paths of a node record.
function isWritableWorkspaceBind(mount, workspace) {
  return Boolean(workspace && mount.RW && mount.Destination.startsWith('/workspace/')
    && mount.Source.startsWith(`${workspace.Source}/`));
}

// A host mount is read-only, sits at /host plus its host path, and has a path that validateHostMount accepts.
// Only an allowlisted name may have one, the same as privileged mode.
function hostMountReason(mount, allowlisted, hostMountRoots) {
  if (!allowlisted) return `unsupported mount: ${mount.Destination} (name is not on the privileged-node allowlist)`;
  if (mount.RW) return `unsupported mount: ${mount.Destination} (host mounts must be read-only)`;
  if (mount.Destination !== `${HOST_MOUNT_PREFIX}${mount.Source}`) {
    return `unsupported mount: ${mount.Destination} (host mounts must sit at ${HOST_MOUNT_PREFIX} plus the host path)`;
  }
  try {
    validateHostMount(mount.Source, hostMountRoots);
  } catch (err) {
    return `unsupported mount: ${mount.Destination} (${err.message})`;
  }
  return null;
}

function unsupportedReason(info, httpPort, privilegedNodes, name, hostMountRoots = NO_HOST_MOUNT_ROOTS) {
  const allowedMounts = new Set(['/workspace', PNPM_VOLUME]);
  const workspace = workspaceMount(info);
  const allowlisted = privilegedNodes.has(name);
  for (const mount of info.Mounts || []) {
    if (allowedMounts.has(mount.Destination) || isWritableWorkspaceBind(mount, workspace)) continue;
    if (!isHostMount(mount)) return `unsupported mount: ${mount.Destination}`;
    const reason = hostMountReason(mount, allowlisted, hostMountRoots);
    if (reason) return reason;
  }
  const port = info.HostConfig?.PortBindings?.[`${httpPort}/tcp`]
    || info.NetworkSettings?.Ports?.[`${httpPort}/tcp`]
    || [];
  if (port.some((binding) => binding.HostIp !== '127.0.0.1')) {
    return 'published port is not bound to loopback';
  }
  // A privileged container is imported only when its name is on the allowlist; the other checks still apply to it.
  if (info.HostConfig?.Privileged && !allowlisted) return 'container is privileged';
  // The host PID namespace is imported only for an allowlisted name, and any other PID mode cannot be recreated.
  const pidMode = info.HostConfig?.PidMode || '';
  if (pidMode === 'host' && !allowlisted) return 'container uses the host PID namespace';
  if (pidMode && pidMode !== 'host') return `unsupported PID mode: ${pidMode}`;
  const demo = /(^|[/@:])[^/]*demo(?:-alpine)?(?:[:@]|$)/i.test(info.Config?.Image || '');
  if (!workspaceMount(info) && !demo) return 'no /workspace bind';
  return null;
}

export function createDiscovery({
  docker,
  store,
  allowedImages,
  workspaceRoots,
  httpPort = 8080,
  privilegedNodes = new Set(),
  hostMountRoots = NO_HOST_MOUNT_ROOTS,
  log = console.warn,
}) {
  async function scan() {
    const [existingRecords, list] = await Promise.all([
      store.getNodes(),
      docker.dockerRaw('GET', `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: ['node-dev-host.port'] }))}`),
    ]);
    if (list.status !== 200) throw new Error(`Docker returned HTTP ${list.status} while scanning`);
    const summaries = JSON.parse(list.body.toString('utf8'));
    const known = new Set(existingRecords.map((record) => record.name));
    const imported = [];
    const skipped = [];
    for (const summary of summaries) {
      const name = (summary.Names?.[0] || '').replace(/^\//, '');
      if (!name || known.has(name)) continue;
      const detail = await docker.dockerRaw('GET', `/containers/${encodeURIComponent(name)}/json`);
      if (detail.status !== 200) continue;
      const info = JSON.parse(detail.body.toString('utf8'));
      const reason = unsupportedReason(info, httpPort, privilegedNodes, name, hostMountRoots);
      if (reason) {
        skipped.push({ name, reason });
        continue;
      }
      const mount = workspaceMount(info);
      const image = info.Config?.Image || summary.Image;
      const imageInfo = await docker.imageInfo(image);
      const builtInEnv = new Map((imageInfo?.Config?.Env || []).map((entry) => {
        const index = entry.indexOf('=');
        return index < 0 ? [entry, ''] : [entry.slice(0, index), entry.slice(index + 1)];
      }));
      const env = {};
      for (const entry of info.Config?.Env || []) {
        const at = entry.indexOf('=');
        const key = at < 0 ? entry : entry.slice(0, at);
        const value = at < 0 ? '' : entry.slice(at + 1);
        if (at >= 0 && (!builtInEnv.has(key) || builtInEnv.get(key) !== value)) env[key] = value;
      }
      const networks = Object.keys(info.NetworkSettings?.Networks || {})
        .filter((network) => !['bridge', 'host', 'none'].includes(network));
      try {
        const record = validateNode({
          name,
          workspace: mount?.Source || null,
          port: Number(info.Config?.Labels?.['node-dev-host.port']),
          image,
          env,
          restartPolicy: info.HostConfig?.RestartPolicy?.Name || 'no',
          networks,
          privileged: info.HostConfig?.Privileged === true,
          pidHost: info.HostConfig?.PidMode === 'host',
          hostMounts: (info.Mounts || []).filter(isHostMount).map((mount) => mount.Source),
          source: 'imported',
        }, { allowedImages, workspaceRoots, allowWorkspaceNull: true, privilegedNodes, hostMountRoots });
        await store.update((document) => {
          if (!document.nodes.some((node) => node.name === name)) document.nodes.push(record);
          return document;
        });
        known.add(name);
        imported.push(name);
      } catch (err) {
        const why = err.message || String(err);
        skipped.push({ name, reason: why });
        log(`scan skipped ${name}: ${why}`);
      }
    }
    return { imported, skipped };
  }

  return { scan };
}
