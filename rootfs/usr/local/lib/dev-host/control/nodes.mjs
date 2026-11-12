import path from 'node:path';
import { HttpError } from './docker.mjs';

export const PORT_LABEL = 'node-dev-host.port';
export const NAME_LABEL = 'node-dev-host.name';
export const DEFAULT_ALLOWED_IMAGES = ['ghcr.io/newbe36524/node-dev-host', 'node-dev-host'];
export const DEFAULT_HTTP_PORT = 8080;
export const MIN_PORT = 43100;
export const MAX_PORT = 43299;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const ENV_RE = /^[A-Z0-9_]+$/;
const USER_KEYS = new Set(['name', 'workspace', 'port', 'image', 'env']);

function repository(image) {
  const withoutDigest = image.split('@', 1)[0];
  const colon = withoutDigest.lastIndexOf(':');
  return colon > withoutDigest.lastIndexOf('/') ? withoutDigest.slice(0, colon) : withoutDigest;
}

function isWithinRoot(workspace, root) {
  const relative = path.relative(root, workspace);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function validateNode(input, {
  allowedImages = DEFAULT_ALLOWED_IMAGES,
  workspaceRoots = [],
  allowWorkspaceNull = false,
} = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('node must be a JSON object');
  for (const key of Object.keys(input)) {
    if (!USER_KEYS.has(key) && !(allowWorkspaceNull && ['restartPolicy', 'networks', 'source', 'createdAt', 'autoStartUntil'].includes(key))) {
      throw new Error(`unknown node field: ${key}`);
    }
  }
  if (typeof input.name !== 'string' || !NAME_RE.test(input.name)) {
    throw new Error('name must match [A-Za-z0-9][A-Za-z0-9_.-]*');
  }
  if (!Number.isInteger(input.port) || input.port < MIN_PORT || input.port > MAX_PORT) {
    throw new Error(`port must be in ${MIN_PORT}-${MAX_PORT}`);
  }
  if (typeof input.image !== 'string' || !input.image.trim()) throw new Error('image is required');
  const repo = repository(input.image.trim());
  if (!allowedImages.some((allowed) => repo === repository(allowed))) {
    throw new Error(`image repository is not allowed; configure CONTROL_ALLOWED_IMAGES`);
  }
  const workspace = input.workspace;
  if (workspace === null && allowWorkspaceNull) {
    // Demo images may bundle their own project and need no workspace bind.
  } else {
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace) || workspace.split(path.sep).includes('..')) {
      throw new Error('workspace must be an absolute path without .. segments');
    }
    if (workspaceRoots.length && !workspaceRoots.some((root) => isWithinRoot(workspace, root))) {
      throw new Error(`workspace must be under CONTROL_WORKSPACE_ROOTS: ${workspaceRoots.join(', ')}`);
    }
  }
  const env = input.env ?? {};
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new Error('env must be an object');
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_RE.test(key)) throw new Error(`invalid environment variable name: ${key}`);
    if (typeof value !== 'string') throw new Error(`environment variable ${key} must have a string value`);
  }
  return {
    name: input.name,
    workspace,
    port: input.port,
    image: input.image.trim(),
    env: { ...env },
    restartPolicy: input.restartPolicy || 'no',
    networks: Array.isArray(input.networks) ? [...input.networks] : [],
    source: input.source || 'added',
    createdAt: input.createdAt || new Date().toISOString(),
    autoStartUntil: input.autoStartUntil ?? null,
  };
}

export function createBody(record, { httpPort = DEFAULT_HTTP_PORT } = {}) {
  const portKey = `${httpPort}/tcp`;
  const binds = ['node-dev-host-pnpm:/var/lib/dev-host/pnpm'];
  if (record.workspace) binds.unshift(`${record.workspace}:/workspace:ro`);
  const body = {
    Image: record.image,
    ExposedPorts: { [portKey]: {} },
    Env: Object.entries(record.env || {}).map(([key, value]) => `${key}=${value}`),
    Labels: { [PORT_LABEL]: String(record.port), [NAME_LABEL]: record.name },
    HostConfig: {
      Binds: binds,
      PortBindings: { [portKey]: [{ HostIp: '127.0.0.1', HostPort: String(record.port) }] },
      RestartPolicy: { Name: record.restartPolicy || 'no' },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m', 'max-file': '3' } },
    },
  };
  if (record.networks?.length) {
    body.NetworkingConfig = { EndpointsConfig: Object.fromEntries(record.networks.map((network) => [network, {}])) };
  }
  return body;
}

export function nextPort(records = [], containers = []) {
  const used = new Set(records.map((record) => Number(record.port)));
  for (const container of containers) {
    const port = container.port ?? container.Config?.Labels?.[PORT_LABEL] ?? container.Labels?.[PORT_LABEL];
    if (Number.isInteger(Number(port))) used.add(Number(port));
  }
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

export async function addNodeRecord(store, input, { allowedImages, workspaceRoots, containers = [] } = {}) {
  const record = validateNode(input, { allowedImages, workspaceRoots });
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
