import path from 'node:path';
import { HttpError } from './docker.mjs';
import { MAX_WRITABLE, validateWritablePath } from '../workspace-config.mjs';

export const PORT_LABEL = 'node-dev-host.port';
export const NAME_LABEL = 'node-dev-host.name';
export const DEFAULT_ALLOWED_IMAGES = ['ghcr.io/newbe36524/node-dev-host', 'node-dev-host'];
export const DEFAULT_HTTP_PORT = 8080;
export const MIN_PORT = 43100;
export const MAX_PORT = 43299;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ENV_RE = /^[A-Z0-9_]+$/;
const USER_KEYS = new Set(['name', 'workspace', 'port', 'image', 'env', 'networks', 'writable', 'privileged', 'pidHost', 'hostMounts']);
const NETWORK_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const RESERVED_NETWORKS = new Set(['bridge', 'host', 'none']);
const MAX_NETWORKS = 4;
// Host access (pidHost and hostMounts): read-only paths under /host, granted by the same allowlist as privileged.
export const MAX_HOST_MOUNTS = 4;
export const HOST_MOUNT_PREFIX = '/host';
const MAX_HOST_MOUNT_LENGTH = 256;
// Socket trees: the Docker and Podman daemons keep their sockets here, so the whole tree is refused.
const SOCKET_TREES = Object.freeze(['/run', '/var/run', '/var/lib/docker', '/var/lib/containerd']);
// Whole system directories: mounting one would expose everything under it, so only a narrower path is accepted.
const WHOLE_ROOTS = Object.freeze(['/', '/home', '/var', '/var/lib', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/opt', '/srv', '/mnt', '/media', '/tmp']);
// Sensitive trees refused at any depth. /proc is the host PID namespace: a node reads it with pidHost, not a mount.
const SENSITIVE_TREES = Object.freeze(['/proc', '/sys', '/dev', '/etc', '/root', '/boot']);
export const NO_HOST_MOUNT_ROOTS = Object.freeze({ configured: false, roots: Object.freeze([]) });
// Read by dev-host inside each node container: the npm and pnpm package registry (see README "npm registry").
export const NPM_REGISTRY_ENV = 'NPM_REGISTRY';
const MAX_REGISTRY_LENGTH = 2048;
const invalid = (message) => { throw new HttpError(400, message); };

// Returns the trimmed registry URL, or null to clear it. The URL must not carry credentials: the value is
// saved in nodes.json and returned by the API. Put registry credentials in the workspace .npmrc instead.
export function validateNpmRegistry(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') invalid('npmRegistry must be a string or null');
  const text = value.trim();
  if (!text) return null;
  if (text.length > MAX_REGISTRY_LENGTH) invalid(`npmRegistry must be at most ${MAX_REGISTRY_LENGTH} characters`);
  if (/\s/.test(text)) invalid('npmRegistry must not contain whitespace');
  let url;
  try {
    url = new URL(text);
  } catch {
    invalid('npmRegistry must be an absolute http or https URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') invalid('npmRegistry must use http or https');
  if (url.username || url.password) invalid('npmRegistry must not contain credentials; put them in the workspace .npmrc');
  if (url.search || url.hash) invalid('npmRegistry must not contain a query or fragment');
  return text;
}

function repository(image) {
  const withoutDigest = image.split('@', 1)[0];
  const colon = withoutDigest.lastIndexOf(':');
  return colon > withoutDigest.lastIndexOf('/') ? withoutDigest.slice(0, colon) : withoutDigest;
}

function isWithinRoot(workspace, root) {
  const relative = path.relative(root, workspace);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// The privileged-node allowlist (CONTROL_PRIVILEGED_NODES) is a set of node names. Privileged mode gives a container
// host-root-level reach, so it is granted by name and never by a request alone.
const privilegeMessage = (name) => `node ${name} is not on the privileged-node allowlist; add it to CONTROL_PRIVILEGED_NODES and recreate nd-control`;

// Returns { names, ignored }: names are trimmed, exact, de-duplicated; an entry that is not a valid node name is
// ignored (and reported), so a typo narrows the list rather than widening it.
export function parsePrivilegedNodes(value = '') {
  const names = [];
  const ignored = [];
  for (const raw of value.split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    if (!NAME_RE.test(entry)) ignored.push(entry);
    else if (!names.includes(entry)) names.push(entry);
  }
  return { names, ignored };
}

const isCanonicalAbsolute = (value) => path.posix.isAbsolute(value)
  && path.posix.normalize(value) === value && (value === '/' || !value.endsWith('/'));
// Containment by path segment: /var/lib/steam-old is not inside /var/lib/steam.
const isWithinTree = (value, tree) => value === tree || value.startsWith(tree === '/' ? '/' : `${tree}/`);

// Returns { configured, roots, ignored }. configured is true for any non-empty setting, even one whose entries are
// all invalid: then no root is valid and every host mount is refused, so a typo narrows access and never widens it.
export function parseHostMountRoots(value = '') {
  const configured = value.trim() !== '';
  const roots = [];
  const ignored = [];
  for (const raw of value.split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    if (isCanonicalAbsolute(entry)) {
      if (!roots.includes(entry)) roots.push(entry);
    } else if (!ignored.includes(entry)) {
      ignored.push(entry);
    }
  }
  return { configured, roots, ignored };
}

// Lexical checks only: the control node sees its own filesystem, not the host's, so it cannot resolve symlinks.
// A rejection names the path and the rule that refused it.
export function validateHostMount(value, hostMountRoots = NO_HOST_MOUNT_ROOTS) {
  if (typeof value !== 'string' || value.length > MAX_HOST_MOUNT_LENGTH || !isCanonicalAbsolute(value)) {
    invalid(`host mount must be an absolute path of at most ${MAX_HOST_MOUNT_LENGTH} characters with no ., .., empty or repeated segments and no trailing slash: ${String(value)}`);
  }
  if (value.split('/').some((segment) => segment.endsWith('.sock'))) {
    invalid(`host mount ${value} is refused: a socket is never mounted`);
  }
  const socketTree = SOCKET_TREES.find((tree) => isWithinTree(value, tree));
  if (socketTree) invalid(`host mount ${value} is refused: ${socketTree} holds Docker and Podman sockets and is never mounted`);
  if (WHOLE_ROOTS.includes(value)) {
    invalid(`host mount ${value} is refused: a whole system directory is never mounted; name the narrow path the data lives in`);
  }
  const sensitive = SENSITIVE_TREES.find((tree) => isWithinTree(value, tree));
  if (sensitive === '/proc') {
    invalid(`host mount ${value} is refused: /proc is the host PID namespace, not a mount; set pidHost to read host processes`);
  }
  if (sensitive) invalid(`host mount ${value} is refused: ${sensitive} is never mounted from the host`);
  if (hostMountRoots.configured) {
    if (hostMountRoots.roots.length === 0) {
      invalid(`host mount ${value} is refused: CONTROL_HOST_MOUNT_ROOTS is set but lists no valid absolute path`);
    }
    if (!hostMountRoots.roots.some((root) => isWithinTree(value, root))) {
      invalid(`host mount ${value} is outside CONTROL_HOST_MOUNT_ROOTS (${hostMountRoots.roots.join(', ')})`);
    }
  }
  return value;
}

export function validateNode(input, {
  allowedImages = DEFAULT_ALLOWED_IMAGES,
  workspaceRoots = [],
  allowWorkspaceNull = false,
  privilegedNodes = new Set(),
  hostMountRoots = NO_HOST_MOUNT_ROOTS,
} = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('node must be a JSON object');
  for (const key of Object.keys(input)) {
    if (!USER_KEYS.has(key) && !(allowWorkspaceNull && ['restartPolicy', 'networks', 'source', 'createdAt', 'autoStartUntil'].includes(key))) {
      invalid(`unknown node field: ${key}`);
    }
  }
  if (typeof input.name !== 'string' || !NAME_RE.test(input.name)) {
    invalid('name must match [A-Za-z0-9][A-Za-z0-9_.-]*');
  }
  const privileged = input.privileged ?? false;
  if (typeof privileged !== 'boolean') invalid('privileged must be a boolean');
  if (privileged && !privilegedNodes.has(input.name)) invalid(privilegeMessage(input.name));
  const pidHost = input.pidHost ?? false;
  if (typeof pidHost !== 'boolean') invalid('pidHost must be a boolean');
  const hostMounts = input.hostMounts ?? [];
  if (!Array.isArray(hostMounts) || hostMounts.some((entry) => typeof entry !== 'string')) {
    invalid('hostMounts must be a list of host paths');
  }
  if (hostMounts.length > MAX_HOST_MOUNTS) invalid(`hostMounts may list at most ${MAX_HOST_MOUNTS} paths`);
  if (new Set(hostMounts).size !== hostMounts.length) invalid('hostMounts lists a path more than once');
  // Host access is granted by the same allowlist as privileged mode, and does not need privileged: true.
  if ((pidHost || hostMounts.length > 0) && !privilegedNodes.has(input.name)) invalid(privilegeMessage(input.name));
  for (const entry of hostMounts) validateHostMount(entry, hostMountRoots);
  if (!Number.isInteger(input.port) || input.port < MIN_PORT || input.port > MAX_PORT) {
    invalid(`port must be in ${MIN_PORT}-${MAX_PORT}`);
  }
  if (typeof input.image !== 'string' || !input.image.trim()) invalid('image is required');
  const repo = repository(input.image.trim());
  if (!allowedImages.some((allowed) => repo === repository(allowed))) {
    invalid('image repository is not allowed; configure CONTROL_ALLOWED_IMAGES');
  }
  const workspace = input.workspace;
  if (workspace === null && allowWorkspaceNull) {
    // Demo images may bundle their own project and need no workspace bind.
  } else {
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || workspace.split(path.sep).includes('..')) {
      invalid('workspace must be an absolute path without .. segments');
    }
    if (workspaceRoots.length && !workspaceRoots.some((root) => isWithinRoot(workspace, root))) {
      invalid(`workspace must be under CONTROL_WORKSPACE_ROOTS: ${workspaceRoots.join(', ')}`);
    }
  }
  // Paths under the workspace bound read-write on top of the read-only /workspace (see createBody).
  const writable = input.writable ?? [];
  if (!Array.isArray(writable)) invalid('writable must be a list of relative paths');
  if (writable.length > MAX_WRITABLE) invalid(`writable may list at most ${MAX_WRITABLE} paths`);
  if (writable.length && !workspace) invalid('writable needs a workspace');
  const writablePaths = [];
  for (const entry of writable) {
    try {
      writablePaths.push(validateWritablePath(entry));
    } catch (error) {
      invalid(error.message);
    }
  }
  if (new Set(writablePaths).size !== writablePaths.length) invalid('writable lists a path more than once');
  const networks = input.networks ?? [];
  if (!Array.isArray(networks)) invalid('networks must be an array of network names');
  if (networks.length > MAX_NETWORKS) invalid(`networks may list at most ${MAX_NETWORKS} names`);
  for (const network of networks) {
    if (typeof network !== 'string' || !NETWORK_RE.test(network)) invalid(`invalid network name: ${network}`);
    if (RESERVED_NETWORKS.has(network)) invalid(`network ${network} is not a user-defined network`);
  }
  const env = input.env ?? {};
  if (!env || typeof env !== 'object' || Array.isArray(env)) invalid('env must be an object');
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_RE.test(key)) invalid(`invalid environment variable name: ${key}`);
    if (typeof value !== 'string') invalid(`environment variable ${key} must have a string value`);
  }
  return {
    name: input.name,
    workspace,
    port: input.port,
    image: input.image.trim(),
    env: { ...env },
    restartPolicy: input.restartPolicy || 'no',
    networks: [...new Set(networks)],
    writable: writablePaths,
    privileged,
    pidHost,
    hostMounts: [...hostMounts],
    source: input.source || 'added',
    createdAt: input.createdAt || new Date().toISOString(),
    autoStartUntil: input.autoStartUntil ?? null,
  };
}

// npmRegistry is the console-wide default. The node's own env wins, so one node can still use another registry.
// The one place a container is built from a record, so every creation path passes the allowlist check here.
export function assertPrivilegeAllowed(name, { record, container } = {}, privilegedNodes = new Set()) {
  // Fail closed: a privileged or host-access record or container is refused unless its name is listed.
  // Host access is the host PID namespace (PidMode host) or a read-only mount under /host.
  const privileged = container?.HostConfig?.Privileged === true || record?.privileged === true;
  const hostAccess = record?.pidHost === true || (record?.hostMounts?.length ?? 0) > 0
    || container?.HostConfig?.PidMode === 'host'
    || (container?.Mounts || []).some((mount) => String(mount?.Destination ?? '').startsWith(`${HOST_MOUNT_PREFIX}/`));
  if ((privileged || hostAccess) && !privilegedNodes.has(name)) throw new HttpError(403, privilegeMessage(name));
}

export function createBody(record, {
  httpPort = DEFAULT_HTTP_PORT,
  npmRegistry = null,
  privilegedNodes = new Set(),
  hostMountRoots = NO_HOST_MOUNT_ROOTS,
} = {}) {
  const portKey = `${httpPort}/tcp`;
  assertPrivilegeAllowed(record.name, { record }, privilegedNodes);
  const binds = ['node-dev-host-pnpm:/var/lib/dev-host/pnpm'];
  if (record.workspace) binds.unshift(`${record.workspace}:/workspace:ro`);
  // A writable path is bound on top of the read-only /workspace, so only that subtree can be written.
  for (const relative of record.writable || []) binds.push(`${record.workspace}/${relative}:/workspace/${relative}:rw`);
  // Host paths are bound read-only at /host plus the host path. Only the validated paths of an allowlisted record get here.
  for (const source of record.hostMounts || []) {
    validateHostMount(source, hostMountRoots);
    binds.push(`${source}:${HOST_MOUNT_PREFIX}${source}:ro`);
  }
  const env = { ...(npmRegistry ? { [NPM_REGISTRY_ENV]: npmRegistry } : {}), ...(record.env || {}) };
  const body = {
    Image: record.image,
    ExposedPorts: { [portKey]: {} },
    Env: Object.entries(env).map(([key, value]) => `${key}=${value}`),
    Labels: { [PORT_LABEL]: String(record.port), [NAME_LABEL]: record.name },
    HostConfig: {
      Binds: binds,
      PortBindings: { [portKey]: [{ HostIp: '127.0.0.1', HostPort: String(record.port) }] },
      RestartPolicy: { Name: record.restartPolicy || 'no' },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
      // Only a privileged record that passed the allowlist check above gets the flag; otherwise the key is absent.
      ...(record.privileged === true ? { Privileged: true } : {}),
      // Only a record with pidHost that passed the allowlist check above shares the host PID namespace.
      ...(record.pidHost === true ? { PidMode: 'host' } : {}),
    },
  };
  if (record.networks?.length) {
    body.NetworkingConfig = { EndpointsConfig: Object.fromEntries(record.networks.map((network) => [network, {}])) };
  }
  return body;
}

// published: host ports that running containers publish, labelled or not. A port in use by any of them is skipped,
// so the port handed out is one Docker can bind.
export function nextPort(records = [], containers = [], published = []) {
  const used = new Set(records.map((record) => Number(record.port)));
  for (const container of containers) {
    const port = container.port ?? container.Config?.Labels?.[PORT_LABEL] ?? container.Labels?.[PORT_LABEL];
    if (Number.isInteger(Number(port))) used.add(Number(port));
  }
  for (const port of published) if (Number.isInteger(Number(port))) used.add(Number(port));
  for (let port = MIN_PORT; port <= MAX_PORT; port += 1) {
    if (!used.has(port)) return port;
  }
  return null;
}

export function parseAllowedImages(value = '') {
  const configured = value.split(',').map((item) => item.trim()).filter(Boolean);
  return configured.length ? configured : DEFAULT_ALLOWED_IMAGES;
}

export function parseWorkspaceRoots(value = '') {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export async function addNodeRecord(store, input, { allowedImages, workspaceRoots, containers = [], privilegedNodes, hostMountRoots } = {}) {
  const record = validateNode(input, { allowedImages, workspaceRoots, privilegedNodes, hostMountRoots });
  const labels = containers.map((container) => ({
    name: container.name ?? (container.Names?.[0] || '').replace(/^\//, ''),
    port: Number(container.port ?? container.Labels?.[PORT_LABEL]),
  }));
  return store.update((document) => {
    const duplicate = document.nodes.find((node) => node.name === record.name) || labels.find((container) => container.name === record.name);
    if (duplicate) throw new HttpError(409, `node name is already in use: ${record.name}`);
    const portHolder = document.nodes.find((node) => node.port === record.port)
      || labels.find((container) => container.port === record.port);
    if (portHolder) throw new HttpError(409, `port ${record.port} is already in use by ${portHolder.name}`);
    document.nodes.push(record);
    return document;
  });
}

export async function deleteNodeRecord(store, name) {
  return store.update((document) => {
    const index = document.nodes.findIndex((node) => node.name === name);
    if (index < 0) throw new HttpError(404, `node not found: ${name}`);
    document.nodes.splice(index, 1);
    return document;
  });
}
