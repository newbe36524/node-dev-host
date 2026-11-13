// Unit tests for the pnpm store lock (rootfs/usr/local/lib/dev-host/store-lock.sh).
// Run from the repository root: node --test tests/unit/store-lock.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const lib = path.resolve(here, '../../rootfs/usr/local/lib/dev-host/store-lock.sh');

// Runs a bash script that sources the lock module with STORE_LOCK and LOG set to files in a temp folder.
function runBash(script, { storeLock } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-lock-'));
  const log = path.join(dir, 'log');
  const lock = storeLock ?? path.join(dir, 'store.lock');
  const body = `export STORE_LOCK=${JSON.stringify(lock)}; export LOG=${JSON.stringify(log)}; . ${JSON.stringify(lib)}\n${script}`;
  const result = spawnSync('bash', ['-c', body], { encoding: 'utf8', timeout: 30000 });
  const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  fs.rmSync(dir, { recursive: true, force: true });
  return { ...result, lines };
}

test('a prune waits for a running install, and the install waits for the prune', () => {
  // The exclusive holder starts first; the shared command must not start until it has finished.
  const { status, lines, stderr } = runBash(`
    with_store_lock exclusive bash -c 'echo prune-start >> "$LOG"; sleep 1; echo prune-end >> "$LOG"' &
    sleep 0.3
    with_store_lock shared bash -c 'echo install >> "$LOG"'
    wait
  `);
  assert.equal(status, 0, stderr);
  assert.deepEqual(lines, ['prune-start', 'prune-end', 'install']);
});

test('installs share the lock: a second install starts before the first one ends', () => {
  const { status, lines, stderr } = runBash(`
    with_store_lock shared bash -c 'echo a-start >> "$LOG"; sleep 1; echo a-end >> "$LOG"' &
    sleep 0.3
    with_store_lock shared bash -c 'echo b-start >> "$LOG"; echo b-end >> "$LOG"'
    wait
  `);
  assert.equal(status, 0, stderr);
  assert.ok(lines.indexOf('b-start') < lines.indexOf('a-end'), lines.join(' '));
});

test('the exit status of the command is returned', () => {
  assert.equal(runBash('with_store_lock shared false').status, 1);
  assert.equal(runBash('with_store_lock exclusive true').status, 0);
});

test('an unknown mode is refused without running the command', () => {
  const { status, lines, stderr } = runBash('with_store_lock sometimes bash -c \'echo ran >> "$LOG"\'');
  assert.equal(status, 2);
  assert.match(stderr, /mode must be shared or exclusive/);
  assert.deepEqual(lines, []);
});

test('a missing store folder is created, so the lock works in a container without the store volume', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-lock-parent-'));
  const storeLock = path.join(dir, 'pnpm', 'store.lock');
  const { status, lines, stderr } = runBash('with_store_lock exclusive bash -c \'echo ran >> "$LOG"\'', { storeLock });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(status, 0, stderr);
  assert.deepEqual(lines, ['ran']);
  assert.equal(stderr, '');
});

test('when the lock file cannot be opened, the command still runs, and the shell says nothing about the redirection', () => {
  // The parent is a regular file, so the lock file can be opened by no user, root included.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-lock-blocked-'));
  const blocker = path.join(dir, 'pnpm');
  fs.writeFileSync(blocker, '');
  const { status, lines, stderr } = runBash('with_store_lock exclusive bash -c \'echo ran >> "$LOG"\'', { storeLock: path.join(blocker, 'store.lock') });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(status, 0);
  assert.deepEqual(lines, ['ran']);
  assert.match(stderr, /running without it/);
  assert.doesNotMatch(stderr, /No such file|Not a directory/);
});
