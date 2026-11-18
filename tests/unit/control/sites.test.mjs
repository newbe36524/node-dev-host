import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readSites } from '../../../rootfs/usr/local/lib/dev-host/control/sites.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sites-'));
const write = (text) => {
  const file = path.join(dir, `s${Math.random()}.json`);
  fs.writeFileSync(file, text);
  return file;
};

test('readSites returns the valid entries only', () => {
  const file = write(JSON.stringify({ 'nd-docs': 'docs.n.pro', 'nd-bad': 'not a host', 'bad name!': 'x.n.pro', 'nd-n': 5, 'nd-up': 'Docs.N.pro' }));
  assert.deepEqual(readSites(file), { 'nd-docs': 'docs.n.pro' });
});

test('readSites never throws: no path, a missing file, invalid JSON, a list', () => {
  assert.deepEqual(readSites(''), {});
  assert.deepEqual(readSites(path.join(dir, 'missing.json')), {});
  assert.deepEqual(readSites(write('{oops')), {});
  assert.deepEqual(readSites(write('["a"]')), {});
});
