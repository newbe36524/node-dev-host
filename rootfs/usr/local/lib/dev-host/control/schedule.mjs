export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function scheduleState(until, now = Date.now()) {
  if (!until) return { state: 'none', until: null, daysLeft: null };
  const expiry = Date.parse(until);
  if (!Number.isFinite(expiry)) return { state: 'none', until: null, daysLeft: null };
  if (expiry <= now) return { state: 'ended', until, daysLeft: null };
  return { state: 'active', until, daysLeft: Math.ceil((expiry - now) / 86_400_000) };
}

export function extendWindow(until, now = Date.now()) {
  const next = now + WEEK_MS;
  const current = Date.parse(until || '');
  return new Date(Math.max(Number.isFinite(current) ? current : 0, next)).toISOString();
}

export function clearWindow() {
  return null;
}

export async function runStartupPass({
  store,
  operations,
  resolveContainer,
  pullImage,
  createContainer,
  createBody,
  startContainer,
  now = Date.now(),
  concurrency = 2,
  log = console.warn,
}) {
  const active = (await store.getNodes()).filter((node) => scheduleState(node.autoStartUntil, now).state === 'active');
  const pulls = new Map();
  let next = 0;
  async function worker() {
    while (next < active.length) {
      const record = active[next++];
      try {
        const container = await resolveContainer(record.name);
        if (container?.State?.Running) continue;
        await operations.run(record.name, container ? 'starting' : 'pulling', async ({ setPhase, setWarning }) => {
          let warning = null;
          if (!container) {
            setPhase('pulling');
            if (!pulls.has(record.image)) pulls.set(record.image, pullImage(record.image));
            const result = await pulls.get(record.image);
            warning = result.warning;
            if (warning) setWarning(warning);
            setPhase('creating');
            await createContainer(record.name, await createBody(record));
          }
          setPhase('starting');
          await startContainer(record.name);
          return { warning };
        });
      } catch (err) {
        log(`startup failed for ${record.name}: ${err.message || err}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, active.length) }, () => worker()));
}
