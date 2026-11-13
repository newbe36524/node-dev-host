// Unit tests for the project host's workspace configuration module (.node-dev-host.yaml).
// Run from the repository root: node --test tests/unit/control/workspace-config.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(path.join(here, '../../../rootfs/usr/local/lib/dev-host/workspace-config.mjs'));
const {
  buildExcludes, envFile, loadWorkspace, parseConfig, resolveSettings, ruleLines, statusFragment,
  validateConfig, validateIgnoreEntry,
} = mod;

const reject = (text, pattern) => {
  assert.throws(() => validateConfig(parseConfig(text)), (err) => {
    assert.match(err.message, pattern);
    return true;
  });
};
const parseRejects = (text, pattern) => {
  assert.throws(() => parseConfig(text), (err) => {
    assert.match(err.message, pattern);
    return true;
  });
};

// ---- 1.1 parser -----------------------------------------------------------------------------------

test('parser accepts block maps, scalar lists, plain and quoted strings, integers, booleans and comments', () => {
  const doc = parseConfig([
    '# a comment line',
    'version: 1 # trailing comment',
    'name: "jjb # not a comment"',
    "description: 'it''s ok'",
    'build:',
    '  spa: false',
    '  command: pnpm build:site',
    'ignore:',
    '  - .browser-profile/',
    '  - "*.log"',
    '  - apps/scraper/cache/ # inline',
    'serve:',
    '  apiUpstream: 172.25.0.1:3001',
    '',
  ].join('\n'));
  assert.equal(doc.version, 1);
  assert.equal(doc.name, 'jjb # not a comment');
  assert.equal(doc.description, "it's ok");
  assert.equal(doc.build.spa, false);
  assert.equal(doc.build.command, 'pnpm build:site');
  assert.deepEqual(doc.ignore, ['.browser-profile/', '*.log', 'apps/scraper/cache/']);
  assert.equal(doc.serve.apiUpstream, '172.25.0.1:3001');
});

test('parser accepts one-line flow lists, including empty and quoted items', () => {
  const doc = parseConfig('ignore: [.browser-profile/, "a, b/", \'c\']\nother: []\n');
  assert.deepEqual(doc.ignore, ['.browser-profile/', 'a, b/', 'c']);
  assert.deepEqual(doc.other, []);
});

test('parser accepts an empty document as an empty mapping', () => {
  assert.deepEqual(parseConfig('# only a comment\n\n'), {});
});

test('parser rejects unsupported syntax with the line number', () => {
  parseRejects('version: 1\n\tname: x', /line 2: indent with spaces, not tabs/);
  parseRejects('version: 1\nname: x\nname: y', /line 3: duplicate key "name"/);
  parseRejects('version: 1\nname:x', /line 2: expected "key: value"/);
  parseRejects('version: 1\nname: &anchor x', /line 2: "&" is not supported/);
  parseRejects('version: 1\nname: *alias', /line 2: "\*" is not supported/);
  parseRejects('version: 1\nbuild: {spa: true}', /line 2: "\{" is not supported/);
  parseRejects('version: 1\nignore: [a, {b: c}]', /line 2: this syntax is not supported inside a list/);
  parseRejects('version: 1\nignore:\n  - name: x', /line 3: lists of mappings are not supported/);
  parseRejects('version: 1\nname: "open', /line 2: quoted value is not closed/);
  parseRejects('version: 1\nname: "a\\q"', /line 2: unsupported escape/);
  parseRejects('version: 1\nname: a\u0001b', /line 2: control characters are not allowed/);
  parseRejects('version: 1\n  name: x', /line 2: unexpected indentation/);
  parseRejects('- one\n- two', /the top level must be a mapping/);
});

// ---- 1.2 field validation ----------------------------------------------------------------------------

test('a full example is accepted and normalized', () => {
  const config = validateConfig(parseConfig([
    'version: 1',
    'name: jjb',
    'description: Personal JJB site',
    'ignore: [.browser-profile/]',
    'build:',
    '  install: pnpm install --frozen-lockfile',
    '  command: pnpm build:site',
    '  distDir: apps/web/dist/',
    '  spa: true',
    'serve:',
    '  apiUpstream: 172.25.0.1:3001',
  ].join('\n')));
  assert.equal(config.name, 'jjb');
  assert.equal(config.build.distDir, 'apps/web/dist');
  assert.deepEqual(config.ignore, ['.browser-profile/']);
});

test('version must be the integer 1', () => {
  reject('ignore: []', /version must be the integer 1/);
  reject('version: 2', /version must be the integer 1/);
  reject('version: "1"', /version must be the integer 1/);
});

test('unknown fields are rejected at every level and the reason names them', () => {
  reject('version: 1\nignor: [.cache-x/]', /unknown field "ignor"/);
  reject('version: 1\nnetwork: nd-console_default', /unknown field "network"/);
  reject('version: 1\nserve:\n  network: nd-console_default', /unknown field "serve.network"/);
  reject('version: 1\nbuild:\n  shell: sh', /unknown field "build.shell"/);
});

test('field types are checked and the reason names the field', () => {
  reject('version: 1\nbuild:\n  spa: "true"', /build.spa must be true or false/);
  reject('version: 1\nignore: .cache/', /ignore must be a list of strings/);
  reject('version: 1\nname: 5', /name must be a string/);
  reject('version: 1\nbuild: nope', /build must be a mapping of fields/);
});

test('empty commands are rejected by name', () => {
  reject('version: 1\nbuild:\n  command: ""', /build.command must not be empty/);
  reject('version: 1\nbuild:\n  install: "  "', /build.install must not be empty/);
});

test('distDir must be relative and free of ".." segments', () => {
  reject('version: 1\nbuild:\n  distDir: ../out', /build.distDir must not contain ".." segments/);
  reject('version: 1\nbuild:\n  distDir: /var/www', /build.distDir must be relative to the project root/);
  reject('version: 1\nbuild:\n  distDir: "."', /build.distDir must name a folder/);
});

test('name is 1 to 80 characters and description at most 500, without control characters', () => {
  reject('version: 1\nname: ""', /name must be 1 to 80 characters/);
  reject(`version: 1\nname: "${'x'.repeat(81)}"`, /name must be 1 to 80 characters/);
  reject('version: 1\nname: "a\\nb"', /name must not contain control characters/);
  reject(`version: 1\ndescription: "${'x'.repeat(501)}"`, /description must be at most 500 characters/);
  assert.equal(validateConfig(parseConfig(`version: 1\nname: "${'x'.repeat(80)}"`)).name.length, 80);
});

test('serve.apiUpstream must be host:port and nothing that Caddyfile syntax could read', () => {
  reject('version: 1\nserve:\n  apiUpstream: "172.25.0.1:3001 {"', /serve.apiUpstream must be host:port/);
  reject('version: 1\nserve:\n  apiUpstream: http://api:3001', /serve.apiUpstream must be host:port/);
  reject('version: 1\nserve:\n  apiUpstream: api:99999', /serve.apiUpstream must be host:port/);
  assert.equal(validateConfig(parseConfig('version: 1\nserve:\n  apiUpstream: "[::1]:3001"')).serve.apiUpstream, '[::1]:3001');
});

// ---- 1.3 ignore entries ------------------------------------------------------------------------------

test('ignore entries accept workspace-relative rsync patterns', () => {
  for (const entry of ['.browser-profile/', 'apps/scraper/cache/', '*.log', 'a/b']) {
    assert.equal(validateIgnoreEntry(entry), true, entry);
  }
});

test('ignore entries reject absolute, traversal, blank and rsync-control forms, naming the entry', () => {
  for (const entry of ['/data', '~/x', '!x', '#x', ';x', '+ x', '- x', 'C:/x', '../secrets', 'a/../../b', 'a\\..\\b', '  ', 'a\nb', 'a\u0000b']) {
    assert.throws(() => validateIgnoreEntry(entry), (err) => {
      assert.match(err.message, /ignore entry/);
      return true;
    }, JSON.stringify(entry));
  }
  reject('version: 1\nignore:\n  - /data', /ignore entry "\/data"/);
  reject('version: 1\nignore:\n  - "../secrets"', /ignore entry "..\/secrets"/);
});

// ---- 1.4 precedence and exclusion views -------------------------------------------------------------

test('environment wins over the file, the file wins over the default, and an empty variable is unset', () => {
  const config = validateConfig(parseConfig([
    'version: 1',
    'ignore: []',
    'build:',
    '  install: pnpm i',
    '  command: pnpm build:site',
    '  distDir: apps/web/dist',
    '  spa: false',
    'serve:',
    '  apiUpstream: 10.0.0.1:3001',
  ].join('\n')));
  const fromFile = resolveSettings(config, {});
  assert.deepEqual(fromFile, {
    install: 'pnpm i', build: 'pnpm build:site', distDir: 'apps/web/dist', spa: 'false', apiUpstream: '10.0.0.1:3001',
  });
  const fromEnv = resolveSettings(config, {
    INSTALL_CMD: 'npm ci', BUILD_CMD: 'pnpm build:env', DIST_DIR: 'out', SPA: 'true', API_UPSTREAM: '10.0.0.2:3002',
  });
  assert.deepEqual(fromEnv, {
    install: 'npm ci', build: 'pnpm build:env', distDir: 'out', spa: 'true', apiUpstream: '10.0.0.2:3002',
  });
  const emptyEnv = resolveSettings(config, { BUILD_CMD: '', DIST_DIR: '', API_UPSTREAM: '' });
  assert.equal(emptyEnv.build, 'pnpm build:site');
  assert.equal(emptyEnv.distDir, 'apps/web/dist');
  assert.equal(emptyEnv.apiUpstream, '10.0.0.1:3001');
});

test('with no file and no environment, every setting falls back to the old default', () => {
  assert.deepEqual(resolveSettings(null, {}), {
    install: '', build: 'pnpm build', distDir: 'dist', spa: 'true', apiUpstream: '',
  });
});

test('a configured ignore of ".cache/" yields one ".cache" rule and never drops a built-in', () => {
  const views = buildExcludes(['.cache/', '.browser-profile/'], 'dist');
  const cacheRules = views.copy.filter((arg) => /^--exclude=\.cache\/?$/.test(arg));
  assert.deepEqual(cacheRules, ['--exclude=.cache']);
  for (const name of ['node_modules', '.git', '.vite', '.turbo', '.cache', 'coverage', '.pnpm-store']) {
    assert.ok(views.copy.includes(`--exclude=${name}`), name);
    assert.ok(views.protect.includes(`--filter=P ${name}`), name);
  }
  assert.ok(views.copy.includes('--exclude=/dist'));
  assert.ok(views.copy.includes('--exclude=.browser-profile/'));
});

test('the change hash view adds dist at any depth, the dependency view keeps only node_modules and the ignore list', () => {
  const views = buildExcludes(['.browser-profile/'], 'dist');
  assert.ok(views.hash.includes('--exclude=dist'));
  assert.ok(!views.copy.includes('--exclude=dist'));
  assert.ok(views.deps.includes('--exclude=node_modules'));
  assert.ok(views.deps.includes('--exclude=.browser-profile/'));
  assert.ok(views.deps.includes('--include=package.json'));
  assert.equal(views.deps.at(-1), '--exclude=*');
});

test('the rule listing that dev-host reads has one kind and one rsync argument per line', () => {
  const lines = ruleLines(['.browser-profile/'], 'apps/web/dist').trimEnd().split('\n');
  assert.ok(lines.every((line) => /^(protect|copy|hash|deps)\t--/.test(line)), lines.join('\n'));
  assert.ok(lines.includes('copy\t--exclude=/apps/web/dist'));
});

// ---- 1.5 state files ------------------------------------------------------------------------------

function tempDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-config-'));
  const workspace = path.join(root, 'workspace');
  const state = path.join(root, 'state');
  fs.mkdirSync(workspace, { recursive: true });
  return { root, workspace, state };
}

const bashSource = (file, expression) => {
  const result = spawnSync('bash', ['-c', `set -u; . "$1"; ${expression}`, 'bash', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

test('the env file round-trips values with quotes, command substitution, backticks and newlines through bash', () => {
  const dirs = tempDirs();
  const tricky = "it's $(echo bad) `echo bad` \"q\"\nsecond line \\ end";
  const file = path.join(dirs.root, 'settings.env');
  fs.writeFileSync(file, envFile({ install: tricky, build: tricky, distDir: 'dist', spa: 'true', apiUpstream: '' }));
  assert.equal(bashSource(file, 'printf %s "$WS_BUILD_CMD"'), tricky);
  assert.equal(bashSource(file, 'printf %s "$WS_INSTALL_CMD"'), tricky);
  assert.equal(bashSource(file, 'printf %s "$WS_API_UPSTREAM"'), '');
});

test('the status fragment is valid JSON for quotes, backslashes and non-ASCII text', () => {
  const description = 'Say "hi" \\ 你好 — ünïcode';
  const config = validateConfig(parseConfig(`version: 1\nname: jjb\ndescription: "Say \\"hi\\" \\\\ 你好 — ünïcode"\nignore: [.browser-profile/]`));
  const fragment = statusFragment({ config, configSource: '.node-dev-host.yaml', configHash: 'a'.repeat(64), configError: null });
  assert.ok(fragment.startsWith(','));
  const parsed = JSON.parse(`{${fragment.slice(1)}}`);
  assert.equal(parsed.description, description);
  assert.deepEqual(parsed.ignore, ['.browser-profile/']);
  assert.equal(parsed.configHash.length, 64);
});

// Names and contents of every file under a directory, to show that a load left the workspace as it was.
function snapshotTree(dir) {
  return fs.readdirSync(dir, { recursive: true }).sort().map((name) => {
    const full = path.join(dir, name);
    return fs.statSync(full).isFile() ? `${name}=${fs.readFileSync(full, 'utf8')}` : `${name}/`;
  }).join('\n');
}

const readStatus = (state) => JSON.parse(`{${fs.readFileSync(path.join(state, 'workspace-config.status.json'), 'utf8').slice(1)}}`);

test('loadWorkspace writes state for absent, valid and rejected files, and never touches the workspace', () => {
  const dirs = tempDirs();
  fs.writeFileSync(path.join(dirs.workspace, 'package.json'), '{}\n');

  // absent
  let before = snapshotTree(dirs.workspace);
  let result = loadWorkspace(dirs.workspace, dirs.state, { ENV_BUILD_CMD: 'pnpm build:env' });
  assert.equal(result.error, null);
  assert.equal(snapshotTree(dirs.workspace), before);
  let status = readStatus(dirs.state);
  assert.equal(status.configSource, null);
  assert.equal(status.configHash, null);
  assert.deepEqual(status.ignore, []);
  assert.match(fs.readFileSync(path.join(dirs.state, 'workspace-config.env'), 'utf8'), /WS_BUILD_CMD='pnpm build:env'/);

  // valid
  fs.writeFileSync(path.join(dirs.workspace, '.node-dev-host.yaml'), 'version: 1\nname: jjb\nignore: [.browser-profile/]\n');
  before = snapshotTree(dirs.workspace);
  result = loadWorkspace(dirs.workspace, dirs.state, {});
  assert.equal(result.error, null);
  assert.equal(snapshotTree(dirs.workspace), before);
  status = readStatus(dirs.state);
  assert.equal(status.name, 'jjb');
  assert.equal(status.configSource, '.node-dev-host.yaml');
  assert.match(status.configHash, /^[0-9a-f]{64}$/);
  assert.equal(fs.readFileSync(path.join(dirs.state, 'workspace-config.ignore'), 'utf8'), '.browser-profile/\n');

  // rejected: the reason is recorded, and the last valid ignore list stays for the change signature
  fs.writeFileSync(path.join(dirs.workspace, '.node-dev-host.yaml'), 'version: 1\nignor: [x]\n');
  before = snapshotTree(dirs.workspace);
  result = loadWorkspace(dirs.workspace, dirs.state, {});
  assert.equal(snapshotTree(dirs.workspace), before);
  assert.match(result.error, /unknown field "ignor"/);
  status = readStatus(dirs.state);
  assert.match(status.configError, /unknown field "ignor"/);
  assert.equal(status.name, null);
  assert.deepEqual(status.ignore, []);
  assert.equal(fs.readFileSync(path.join(dirs.state, 'workspace-config.ignore'), 'utf8'), '.browser-profile/\n');
});

// ---- 5.1 and 5.2 documentation examples ---------------------------------------------------------

test('the example in README.md and in skills/node-dev-host/SKILL.md is the checked fixture and passes validation', () => {
  const repo = path.resolve(here, '../../..');
  const example = fs.readFileSync(path.join(here, 'fixtures/workspace-config.example.yaml'), 'utf8');
  const config = validateConfig(parseConfig(example));
  assert.equal(config.name, 'jjb');
  assert.deepEqual(config.ignore, ['.browser-profile/', 'apps/scraper/cache/', '*.log']);
  for (const doc of ['README.md', 'skills/node-dev-host/SKILL.md']) {
    const text = fs.readFileSync(path.join(repo, doc), 'utf8');
    assert.ok(text.includes(`\`\`\`yaml\n${example}\`\`\`\n`), `${doc} shows the example file verbatim`);
  }
});

test('loadWorkspace refuses a symbolic link and an oversized file with a reason', () => {
  const dirs = tempDirs();
  const outside = path.join(dirs.root, 'outside.yaml');
  fs.writeFileSync(outside, 'version: 1\n');
  fs.symlinkSync(outside, path.join(dirs.workspace, '.node-dev-host.yaml'));
  assert.match(loadWorkspace(dirs.workspace, dirs.state, {}).error, /must be a regular file/);
  fs.rmSync(path.join(dirs.workspace, '.node-dev-host.yaml'));
  fs.writeFileSync(path.join(dirs.workspace, '.node-dev-host.yaml'), `version: 1\nname: "${'x'.repeat(65 * 1024)}"\n`);
  assert.match(loadWorkspace(dirs.workspace, dirs.state, {}).error, /could not be read as configuration: larger than 64 KiB/);
});
