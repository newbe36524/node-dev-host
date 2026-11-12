import http from 'node:http';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export class DockerUnavailable extends HttpError {
  constructor(message) { super(503, message); }
}

export function dockerMessage(r) {
  try {
    const parsed = JSON.parse(r.body.toString('utf8'));
    if (parsed && parsed.message) return parsed.message;
  } catch { /* not JSON */ }
  return r.body.toString('utf8').trim() || `Docker returned HTTP ${r.status}`;
}

export function createDockerClient(socket = process.env.DOCKER_SOCKET || '/var/run/docker.sock') {
  function dockerUnavailable(err) {
    if (err.code === 'ENOENT') {
      return new DockerUnavailable(
        `Docker socket not found at ${socket}. Mount it with -v /var/run/docker.sock:/var/run/docker.sock`);
    }
    if (err.code === 'EACCES') {
      return new DockerUnavailable(`Permission denied on the Docker socket ${socket}`);
    }
    if (err.code === 'ECONNREFUSED') {
      return new DockerUnavailable(`Docker is not answering on ${socket}`);
    }
    return new DockerUnavailable(`Docker is unreachable at ${socket}: ${err.message}`);
  }

  function dockerRaw(method, apiPath, { body, timeout, deadline } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
      const headers = payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {};
      let timer;
      const req = http.request({ socketPath: socket, path: apiPath, method, headers }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode, body: Buffer.concat(chunks) });
        });
        res.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      if (timeout) req.setTimeout(timeout, () => req.destroy(new Error(`Docker did not answer within ${timeout} ms`)));
      if (deadline) {
        timer = setTimeout(() => req.destroy(new Error(`Docker request exceeded ${deadline} ms`)), deadline);
        timer.unref?.();
      }
      req.on('error', (err) => {
        clearTimeout(timer);
        reject(err instanceof DockerUnavailable ? err : dockerUnavailable(err));
      });
      req.end(payload ?? undefined);
    });
  }

  async function imageInfo(image) {
    const r = await dockerRaw('GET', `/images/${encodeURIComponent(image)}/json`);
    if (r.status === 404) return null;
    if (r.status !== 200) throw new HttpError(502, dockerMessage(r));
    return JSON.parse(r.body.toString('utf8'));
  }

  const pulls = new Map();
  async function pullImageNow(image) {
    const colon = image.lastIndexOf(':');
    const slash = image.lastIndexOf('/');
    const fromImage = colon > slash ? image.slice(0, colon) : image;
    const tag = colon > slash ? image.slice(colon + 1) : 'latest';
    const path = `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}`;
    let pullError;
    try {
      const r = await dockerRaw('POST', path, { deadline: 600_000 });
      const text = r.body.toString('utf8');
      if (r.status !== 200) throw new HttpError(502, dockerMessage(r));
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let progress;
        try { progress = JSON.parse(line); } catch { continue; }
        if (typeof progress.error === 'string' && progress.error) throw new HttpError(502, progress.error);
      }
      return { warning: null };
    } catch (err) {
      pullError = err;
    }
    if (await imageInfo(image)) {
      const message = pullError instanceof Error ? pullError.message : String(pullError);
      return { warning: `latest image could not be pulled: ${message}` };
    }
    throw pullError;
  }

  function pullImage(image) {
    if (!pulls.has(image)) {
      const pull = pullImageNow(image).finally(() => pulls.delete(image));
      pulls.set(image, pull);
    }
    return pulls.get(image);
  }

  async function createContainer(name, body) {
    const r = await dockerRaw('POST', `/containers/create?name=${encodeURIComponent(name)}`, { body });
    if (r.status !== 201) throw new HttpError(r.status === 409 ? 409 : 500, dockerMessage(r));
    return JSON.parse(r.body.toString('utf8'));
  }

  return { dockerRaw, imageInfo, pullImage, createContainer };
}
