import { HttpError } from './docker.mjs';

const PHASES = new Set(['pulling', 'creating', 'starting', 'removing']);

export function createOperationTracker() {
  const operations = new Map();
  const locks = new Set();

  function get(name) {
    const current = operations.get(name);
    if (!current) return null;
    const { phase, since, error, warning } = current;
    return { phase, since, error, warning };
  }

  function snapshot() {
    return new Map([...operations].map(([name]) => [name, get(name)]));
  }

  async function run(name, initialPhase, work) {
    if (locks.has(name)) {
      const phase = operations.get(name)?.phase || 'another operation';
      throw new HttpError(409, `node ${name} already has an operation in progress (${phase})`);
    }
    locks.add(name);
    const previous = operations.get(name) || { phase: null, since: null, error: null, warning: null };
    const current = { ...previous, phase: initialPhase, since: new Date().toISOString() };
    operations.set(name, current);
    const setPhase = (phase) => {
      if (!PHASES.has(phase)) throw new TypeError(`unsupported operation phase: ${phase}`);
      current.phase = phase;
    };
    const setWarning = (warning) => { current.warning = warning; };
    try {
      const result = await work({ setPhase, setWarning });
      current.phase = null;
      current.since = null;
      current.error = null;
      if (result?.warning) current.warning = result.warning;
      else if (!result?.keepWarning) current.warning = null;
      return result;
    } catch (err) {
      current.phase = null;
      current.since = null;
      current.error = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      locks.delete(name);
    }
  }

  function setError(name, error) {
    const current = operations.get(name) || { phase: null, since: null, error: null, warning: null };
    current.error = error;
    operations.set(name, current);
  }

  return { get, snapshot, run, setError };
}
