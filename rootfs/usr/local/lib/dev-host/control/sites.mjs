import fs from 'node:fs';

// Optional site names for the dashboard: a JSON file of { "<node name>": "<host name>" }, written by whatever puts a
// reverse proxy in front of the nodes (CONTROL_SITES_FILE). The control node only reads it: it never writes it and
// never proxies anything. A missing, unreadable or malformed file means no sites, never an error.
const HOST_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]*$/;
const NODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const MAX_BYTES = 256 * 1024;

export function readSites(file) {
  if (!file) return {};
  try {
    if (fs.statSync(file).size > MAX_BYTES) return {};
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const sites = {};
    for (const [node, host] of Object.entries(data)) {
      if (NODE_RE.test(node) && typeof host === 'string' && HOST_RE.test(host)) sites[node] = host;
    }
    return sites;
  } catch {
    return {};
  }
}
