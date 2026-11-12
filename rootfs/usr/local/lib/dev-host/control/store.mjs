import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_DATA_DIR = '/var/lib/dev-host/control';

export function createStore({
  dir = process.env.CONTROL_DATA_DIR || DEFAULT_DATA_DIR,
  fsApi = fs.promises,
  log = console.warn,
  readOnly = false,
} = {}) {
  const file = path.join(dir, 'nodes.json');
  let state = { version: 1, nodes: [] };
  let warning = null;
  let loaded = false;
  let serial = Promise.resolve();
  let frozen = null; // reason string while a control-node upgrade hands the store over

  async function load() {
    if (loaded) return structuredClone(state);
    if (!readOnly) await fsApi.mkdir(dir, { recursive: true });
    try {
      const text = await fsApi.readFile(file, 'utf8');
      try {
        const parsed = JSON.parse(text);
        if (parsed?.version !== 1 || !Array.isArray(parsed.nodes)) throw new Error('invalid node store shape');
        state = parsed;
      } catch (err) {
        const damaged = `${file}.corrupt-${Date.now()}`;
        if (!readOnly) await fsApi.rename(file, damaged);
        warning = readOnly
          ? `node store could not be parsed in read-only mode: ${err.message}`
          : `node store could not be parsed; preserved at ${damaged}: ${err.message}`;
        log(warning);
        state = { version: 1, nodes: [] };
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    loaded = true;
    return structuredClone(state);
  }

  async function save(next) {
    await fsApi.mkdir(dir, { recursive: true });
    const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
    let handle;
    try {
      handle = await fsApi.open(temp, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fsApi.rename(temp, file);
    } catch (err) {
      await handle?.close().catch(() => {});
      await fsApi.unlink(temp).catch(() => {});
      throw err;
    }
  }

  // While frozen, every write fails with status 503 so the caller can retry after the handover.
  function freeze(reason) {
    frozen = reason;
  }

  function thaw() {
    frozen = null;
  }

  // Resolves once every write that started before the call has been saved (or failed).
  async function drain() {
    await serial;
  }

  function update(mutator) {
    if (readOnly) return Promise.reject(new Error('node store is read-only'));
    if (frozen) {
      const err = new Error(`node records are frozen: ${frozen}`);
      err.status = 503;
      return Promise.reject(err);
    }
    const result = serial.then(async () => {
      await load();
      const current = structuredClone(state);
      const next = await mutator(current);
      const document = next ?? current;
      if (document.version !== 1 || !Array.isArray(document.nodes)) {
        throw new TypeError('node store update must return a version 1 document with a nodes array');
      }
      await save(document);
      state = document;
      warning = null;
      return structuredClone(state);
    });
    serial = result.catch(() => {});
    return result;
  }

  async function getNodes() {
    await serial;
    const current = await load();
    return structuredClone(current.nodes);
  }

  // Console-wide settings live beside the nodes in nodes.json; update() keeps them when it saves nodes.
  async function getSettings() {
    await serial;
    const current = await load();
    return structuredClone(current.settings ?? {});
  }

  async function status() {
    await load();
    let writable = false;
    let mounted = false;
    try {
      const [dirStat, rootStat] = await Promise.all([fsApi.stat(dir), fsApi.stat('/')]);
      mounted = dirStat.dev !== rootStat.dev;
      writable = (dirStat.mode & 0o222) !== 0;
      if (writable) await fsApi.access(dir, fs.constants.W_OK);
    } catch {
      writable = false;
    }
    return { dir, writable, mounted, warning };
  }

  return { dir, file, load, getNodes, getSettings, update, status, freeze, thaw, drain };
}

export { DEFAULT_DATA_DIR };
