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
  attachExternal, buildExcludes, envFile, externalOutputClash, loadWorkspace, parseConfig, resolveSettings,
  ruleLines, statusFragment, validateConfig, validateIgnoreEntry,
} = mod;
const script = path.join(here, '../../../rootfs/usr/local/lib/dev-host/workspace-config.mjs');

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

// ---- external folders: 1.1 validation ---------------------------------------------------------------

const withExternal = (external) => validateConfig({ version: 1, external });
const lstatIf = (file) => {
  try {
    return fs.lstatSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
};
// The refusal names the entry as JSON, the way the reason is written.
const refusesEntry = (entry) => assert.throws(() => withExternal([entry]), (err) => {
  assert.match(err.message, /^external entry /);
  assert.ok(err.message.includes(JSON.stringify(entry)), err.message);
  return true;
}, JSON.stringify(entry));

test('external is optional, defaults to an empty list, and entries are normalized and merged', () => {
  assert.deepEqual(validateConfig(parseConfig('version: 1')).external, []);
  assert.deepEqual(validateConfig(parseConfig('version: 1\nexternal: [data/covers]')).external, ['data/covers']);
  assert.deepEqual(withExternal(['data/covers/']).external, ['data/covers']);
  assert.deepEqual(withExternal(['./data/covers']).external, ['data/covers']);
  assert.deepEqual(withExternal(['data//covers']).external, ['data/covers']);
  assert.deepEqual(withExternal(['data/covers', 'data/covers/']).external, ['data/covers']);
  assert.deepEqual(withExternal(['data/covers', 'cache/images']).external, ['data/covers', 'cache/images']);
});

test('the external field is spelled exactly; a misspelling is an unknown field', () => {
  reject('version: 1\nexternals: [data/covers]', /unknown field "externals"/);
});

test('external must be a list of strings', () => {
  reject('version: 1\nexternal: data/covers', /external must be a list of strings/);
  assert.throws(() => withExternal('data/covers'), /external must be a list of strings/);
  assert.throws(() => withExternal([5]), /external must be a list of strings/);
});

test('restrict external entries: wildcards, escaping paths, the workspace root, blanks and spaces are refused by name', () => {
  for (const entry of [
    'data/*', 'cache/[a-z]', 'data/?x', // wildcards
    '/srv/covers', '~/covers', '../covers', 'a/../../b', 'C:/covers', // escaping
    'data\\covers', // backslash
    '', '   ', ' data/covers', 'data/covers ', // blank and edge spaces
    '.', './', // the workspace root
    'a\nb', // control character
  ]) {
    refusesEntry(entry);
  }
});

test('keep external entries clear of built-in names, the output folder and each other', () => {
  for (const entry of ['node_modules/.cache', '.git/hooks', 'apps/node_modules']) refusesEntry(entry);
  assert.throws(() => withExternal(['data', 'data/covers']), (err) => {
    assert.equal(err.message, 'external entry "data/covers" lies inside external entry "data"');
    return true;
  });
  // The output folder comes from the resolved settings, so the overlap is checked in loadWorkspace (see 1.2).
  assert.match(externalOutputClash(['dist/media'], 'dist'), /external entry "dist\/media" overlaps the output folder "dist"/);
  assert.match(externalOutputClash(['dist'], 'dist'), /overlaps the output folder "dist"/);
  assert.equal(externalOutputClash(['data/covers'], 'dist'), null);
  assert.match(externalOutputClash(['apps/web'], 'apps/web/dist'), /overlaps/);
});

// ---- 1.2 output folder overlap, from the file or the environment ------------------------------------

test('an external entry that overlaps the output folder rejects the file, whether the folder comes from the file or the environment', () => {
  const dirs = tempDirs();
  const file = path.join(dirs.workspace, '.node-dev-host.yaml');
  fs.writeFileSync(file, 'version: 1\nexternal: [data/covers]\nbuild:\n  distDir: data/covers/out\n');
  let result = loadWorkspace(dirs.workspace, dirs.state, {});
  assert.match(result.error, /external entry "data\/covers" overlaps the output folder "data\/covers\/out"/);
  assert.equal(readStatus(dirs.state).external.length, 0);

  fs.writeFileSync(file, 'version: 1\nexternal: [data/covers]\n');
  result = loadWorkspace(dirs.workspace, dirs.state, { ENV_DIST_DIR: 'data' });
  assert.match(result.error, /external entry "data\/covers" overlaps the output folder "data"/);

  result = loadWorkspace(dirs.workspace, dirs.state, {});
  assert.equal(result.error, null);
  assert.deepEqual(readStatus(dirs.state).external, ['data/covers']);
});

// ---- 1.3 and 1.4 state and status ---------------------------------------------------------------------

test('workspace-config.external is written for a valid or absent file and kept when a later file is rejected', () => {
  const dirs = tempDirs();
  const file = path.join(dirs.workspace, '.node-dev-host.yaml');
  const listFile = path.join(dirs.state, 'workspace-config.external');
  fs.writeFileSync(file, 'version: 1\nexternal: [data/covers, cache/images]\n');
  assert.equal(loadWorkspace(dirs.workspace, dirs.state, {}).error, null);
  assert.equal(fs.readFileSync(listFile, 'utf8'), 'data/covers\ncache/images\n');

  fs.writeFileSync(file, 'version: 1\nexternal: [data/*]\n');
  assert.match(loadWorkspace(dirs.workspace, dirs.state, {}).error, /external entry "data\/\*" must not contain a wildcard/);
  assert.equal(fs.readFileSync(listFile, 'utf8'), 'data/covers\ncache/images\n');
  assert.deepEqual(readStatus(dirs.state).external, []);

  fs.rmSync(file);
  assert.equal(loadWorkspace(dirs.workspace, dirs.state, {}).error, null);
  assert.equal(fs.readFileSync(listFile, 'utf8'), '');
  assert.deepEqual(readStatus(dirs.state).external, []);
});

test('the status fragment carries external: empty without a file, and JSON-encoded with quotes and backslashes', () => {
  assert.deepEqual(JSON.parse(`{${statusFragment({}).slice(1)}}`).external, []);
  const config = { external: ['data/"quoted"', 'back\\slash'] };
  const parsed = JSON.parse(`{${statusFragment({ config }).slice(1)}}`);
  assert.deepEqual(parsed.external, ['data/"quoted"', 'back\\slash']);
});

// ---- 2.1 and 2.2 exclusion rules and the rules command -------------------------------------------------

test('without external entries the rule lines are exactly the ones from before the field existed', () => {
  const before = [
    'protect\t--filter=P node_modules', 'protect\t--filter=P .git', 'protect\t--filter=P .vite', 'protect\t--filter=P .turbo',
    'protect\t--filter=P .cache', 'protect\t--filter=P coverage', 'protect\t--filter=P .pnpm-store', 'protect\t--filter=P /apps/web/dist',
    'copy\t--exclude=node_modules', 'copy\t--exclude=.git', 'copy\t--exclude=.vite', 'copy\t--exclude=.turbo',
    'copy\t--exclude=.cache', 'copy\t--exclude=coverage', 'copy\t--exclude=.pnpm-store', 'copy\t--exclude=/apps/web/dist',
    'copy\t--exclude=.browser-profile/', 'copy\t--exclude=*.log', 'copy\t--exclude=apps/scraper/cache/',
    'hash\t--exclude=node_modules', 'hash\t--exclude=.git', 'hash\t--exclude=.vite', 'hash\t--exclude=.turbo',
    'hash\t--exclude=.cache', 'hash\t--exclude=coverage', 'hash\t--exclude=.pnpm-store', 'hash\t--exclude=/apps/web/dist',
    'hash\t--exclude=.browser-profile/', 'hash\t--exclude=*.log', 'hash\t--exclude=apps/scraper/cache/', 'hash\t--exclude=dist',
    'deps\t--exclude=node_modules', 'deps\t--exclude=.browser-profile/', 'deps\t--exclude=*.log', 'deps\t--exclude=.cache/',
    'deps\t--exclude=apps/scraper/cache/', 'deps\t--include=*/', 'deps\t--include=package.json', 'deps\t--include=pnpm-lock.yaml',
    'deps\t--include=pnpm-workspace.yaml', 'deps\t--include=.npmrc', 'deps\t--include=.pnpmfile.cjs', 'deps\t--exclude=*',
  ].join('\n') + '\n';
  assert.equal(ruleLines(['.browser-profile/', '*.log', '.cache/', 'apps/scraper/cache/'], 'apps/web/dist'), before);
  assert.equal(ruleLines(['.browser-profile/', '*.log', '.cache/', 'apps/scraper/cache/'], 'apps/web/dist', []), before);
});

test('external entries are excluded in every view, anchored at the workspace root, and protected from deletion', () => {
  const views = buildExcludes(['.browser-profile/'], 'dist', ['data/covers']);
  for (const kind of ['copy', 'hash', 'deps']) {
    assert.ok(views[kind].includes('--exclude=/data/covers'), kind);
    assert.ok(!views[kind].includes('--exclude=data/covers'), `${kind} is not unanchored`);
  }
  assert.ok(views.protect.includes('--filter=P /data/covers'));
  assert.ok(views.copy.includes('--exclude=.browser-profile/'));
});

test('an external entry that is also in ignore yields one exclusion', () => {
  const views = buildExcludes(['data/covers/', '.browser-profile/'], 'dist', ['data/covers']);
  for (const kind of ['copy', 'hash', 'deps']) {
    assert.deepEqual(views[kind].filter((arg) => arg.includes('data/covers')), ['--exclude=/data/covers'], kind);
  }
  assert.deepEqual(views.protect.filter((arg) => arg.includes('data/covers')), ['--filter=P /data/covers']);
});

test('rules takes an external file as an optional third argument, and a missing file is an empty list', () => {
  const dirs = tempDirs();
  const ignore = path.join(dirs.root, 'ignore');
  const external = path.join(dirs.root, 'external');
  fs.writeFileSync(ignore, '.browser-profile/\n');
  fs.writeFileSync(external, 'data/covers\n');
  const run = (args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

  const two = run(['rules', 'dist', ignore]);
  assert.equal(two.status, 0, two.stderr);
  assert.equal(two.stdout, ruleLines(['.browser-profile/'], 'dist'));

  const three = run(['rules', 'dist', ignore, external]);
  assert.equal(three.status, 0, three.stderr);
  assert.equal(three.stdout, ruleLines(['.browser-profile/'], 'dist', ['data/covers']));
  assert.match(three.stdout, /^copy\t--exclude=\/data\/covers$/m);

  const missing = run(['rules', 'dist', ignore, path.join(dirs.root, 'no-such-file')]);
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(missing.stdout, two.stdout);

  assert.equal(run(['rules']).status, 64);
});

// A real rsync pass with the same flags as dev-host, so the protect rules are tested against rsync itself.
const RSYNC = spawnSync('rsync', ['--version']).status === 0;
test('a real rsync copy keeps a protected external link, removes an unprotected one, and copies a dropped entry', { skip: !RSYNC }, () => {
  const dirs = tempDirs();
  const ws = dirs.workspace;
  const build = path.join(dirs.root, 'build');
  const original = path.join(ws, 'data/covers');
  fs.mkdirSync(original, { recursive: true });
  fs.writeFileSync(path.join(original, '1.jpg'), 'one');
  fs.writeFileSync(path.join(ws, 'index.js'), 'x');
  const copy = (ignore, external, protect) => {
    const views = buildExcludes(ignore, 'dist', external);
    const args = [...(protect ? views.protect : []), ...views.copy];
    const r = spawnSync('rsync', ['-a', '--delete', '--delete-excluded', ...args, `${ws}/`, `${build}/`], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  const linkAt = path.join(build, 'data/covers');

  copy([], ['data/covers'], true);
  assert.equal(lstatIf(linkAt), null, 'nothing is copied for an external entry');
  attachExternal(ws, build, ['data/covers']);
  assert.ok(lstatIf(linkAt).isSymbolicLink());

  copy([], ['data/covers'], true);
  assert.ok(lstatIf(linkAt).isSymbolicLink(), 'a protected link survives the copy');
  assert.equal(fs.readFileSync(path.join(original, '1.jpg'), 'utf8'), 'one');

  copy([], ['data/covers'], false);
  assert.equal(lstatIf(linkAt), null, 'an unprotected link is removed by --delete-excluded');
  assert.equal(fs.readFileSync(path.join(original, '1.jpg'), 'utf8'), 'one', 'the original survives the removal');

  attachExternal(ws, build, ['data/covers']);
  copy([], [], true);
  const dropped = lstatIf(linkAt);
  assert.ok(dropped.isDirectory() && !dropped.isSymbolicLink(), 'a dropped entry becomes a copied folder');
  assert.equal(fs.readFileSync(path.join(linkAt, '1.jpg'), 'utf8'), 'one');
  assert.equal(fs.readFileSync(path.join(original, '1.jpg'), 'utf8'), 'one', 'the original is intact');

  copy(['data/covers'], [], true);
  assert.equal(lstatIf(linkAt), null, 'an entry moved to ignore leaves the build copy');
  assert.equal(fs.readFileSync(path.join(original, '1.jpg'), 'utf8'), 'one', 'and the original is intact');
});

// ---- 3.1 and 3.2 attach ----------------------------------------------------------------------------

test('attach links an external folder at the same path, creates missing parents, and never changes the original', () => {
  const dirs = tempDirs();
  const build = path.join(dirs.root, 'build');
  fs.mkdirSync(build);
  fs.mkdirSync(path.join(dirs.workspace, 'data/covers'), { recursive: true });
  fs.writeFileSync(path.join(dirs.workspace, 'data/covers/1.jpg'), 'one');
  const before = snapshotTree(dirs.workspace);
  assert.deepEqual(attachExternal(dirs.workspace, build, ['data/covers']), []);
  const link = path.join(build, 'data/covers');
  assert.ok(lstatIf(link).isSymbolicLink());
  assert.equal(fs.readlinkSync(link), path.join(dirs.workspace, 'data/covers'));
  assert.equal(fs.readFileSync(path.join(link, '1.jpg'), 'utf8'), 'one');
  assert.equal(snapshotTree(dirs.workspace), before, 'attaching changes nothing in the original');
  fs.writeFileSync(path.join(link, '2.jpg'), 'two');
  assert.equal(fs.readFileSync(path.join(dirs.workspace, 'data/covers/2.jpg'), 'utf8'), 'two', 'a write reaches the original');
});

test('attach leaves a correct link alone and replaces a link with another target through a temporary name', () => {
  const dirs = tempDirs();
  const build = path.join(dirs.root, 'build');
  fs.mkdirSync(build);
  fs.mkdirSync(path.join(dirs.workspace, 'data/covers'), { recursive: true });
  attachExternal(dirs.workspace, build, ['data/covers']);
  const link = path.join(build, 'data/covers');
  const ino = fs.lstatSync(link).ino;
  attachExternal(dirs.workspace, build, ['data/covers']);
  assert.equal(fs.lstatSync(link).ino, ino, 'a correct link is not recreated');

  const elsewhere = path.join(dirs.root, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.rmSync(link);
  fs.symlinkSync(elsewhere, link);
  assert.deepEqual(attachExternal(dirs.workspace, build, ['data/covers']), []);
  assert.equal(fs.readlinkSync(link), path.join(dirs.workspace, 'data/covers'));
  assert.deepEqual(fs.readdirSync(path.join(build, 'data')), ['covers'], 'no temporary name is left behind');
});

test('attach replaces a stale real folder or file, and a link inside the stale folder never removes the original', () => {
  const dirs = tempDirs();
  const build = path.join(dirs.root, 'build');
  const original = path.join(dirs.workspace, 'data/covers');
  fs.mkdirSync(original, { recursive: true });
  fs.writeFileSync(path.join(original, '1.jpg'), 'one');
  fs.mkdirSync(path.join(build, 'data/covers'), { recursive: true });
  fs.writeFileSync(path.join(build, 'data/covers/stale.jpg'), 'stale');
  fs.symlinkSync(original, path.join(build, 'data/covers/inner'));
  attachExternal(dirs.workspace, build, ['data/covers']);
  assert.ok(lstatIf(path.join(build, 'data/covers')).isSymbolicLink());
  assert.deepEqual(fs.readdirSync(original), ['1.jpg'], 'the original keeps every file');
  assert.equal(fs.readFileSync(path.join(original, '1.jpg'), 'utf8'), 'one');

  fs.rmSync(path.join(build, 'data/covers'));
  fs.writeFileSync(path.join(build, 'data/covers'), 'a file');
  attachExternal(dirs.workspace, build, ['data/covers']);
  assert.ok(lstatIf(path.join(build, 'data/covers')).isSymbolicLink());
});

test('attach skips a missing original, a file, and an original behind a link, with JSON-encoded warnings', () => {
  const dirs = tempDirs();
  const build = path.join(dirs.root, 'build');
  fs.mkdirSync(build);
  fs.writeFileSync(path.join(dirs.workspace, 'notes.txt'), 'x');
  fs.mkdirSync(path.join(dirs.workspace, 'data'));
  fs.symlinkSync(path.join(dirs.workspace, 'data'), path.join(dirs.workspace, 'linked'));
  const warnings = [];
  attachExternal(dirs.workspace, build, ['data/missing', 'notes.txt', 'linked/covers'], warnings);
  assert.deepEqual(warnings, [
    JSON.stringify('external entry "data/missing" skipped: the original folder is missing'),
    JSON.stringify('external entry "notes.txt" skipped: the original is not a folder'),
    JSON.stringify('external entry "linked/covers" skipped: the original is reached through a symbolic link'),
  ]);
  assert.equal(lstatIf(path.join(build, 'data/missing')), null, 'nothing is created for a skipped entry');
  assert.equal(lstatIf(path.join(build, 'notes.txt')), null);
  assert.equal(lstatIf(path.join(dirs.workspace, 'data/missing')), null, 'the workspace is not created in');
});

test('attach skips an entry whose build-copy path is reached through a symbolic link', () => {
  const dirs = tempDirs();
  const build = path.join(dirs.root, 'build');
  const elsewhere = path.join(dirs.root, 'elsewhere');
  fs.mkdirSync(build);
  fs.mkdirSync(elsewhere);
  fs.mkdirSync(path.join(dirs.workspace, 'data/covers'), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(build, 'data'));
  const warnings = attachExternal(dirs.workspace, build, ['data/covers'], []);
  assert.deepEqual(warnings, [JSON.stringify('external entry "data/covers" skipped: its path in the build copy is reached through a symbolic link')]);
  assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing is created through the link');
});

test('the warning is cleared once the original exists and a later attach runs', () => {
  const dirs = tempDirs();
  const build = path.join(dirs.root, 'build');
  fs.mkdirSync(build);
  assert.equal(attachExternal(dirs.workspace, build, ['data/covers'], []).length, 1);
  fs.mkdirSync(path.join(dirs.workspace, 'data/covers'), { recursive: true });
  assert.deepEqual(attachExternal(dirs.workspace, build, ['data/covers'], []), []);
  assert.ok(lstatIf(path.join(build, 'data/covers')).isSymbolicLink());
});

test('attach prints each warning as a JSON string and exits 0 for skipped entries', () => {
  const dirs = tempDirs();
  const build = path.join(dirs.root, 'build');
  fs.mkdirSync(build);
  const list = path.join(dirs.root, 'external');
  fs.writeFileSync(list, 'data/"q"\n');
  const result = spawnSync(process.execPath, [script, 'attach', dirs.workspace, build, list], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]), 'external entry "data/\\"q\\"" skipped: the original folder is missing');
});

test('an unexpected filesystem error makes attach exit 1 after reporting the warnings already found', { skip: process.getuid?.() === 0 }, () => {
  const dirs = tempDirs();
  const build = path.join(dirs.root, 'build');
  fs.mkdirSync(build);
  fs.mkdirSync(path.join(dirs.workspace, 'data/covers'), { recursive: true });
  const list = path.join(dirs.root, 'external');
  fs.writeFileSync(list, 'data/missing\ndata/covers\n');
  fs.chmodSync(build, 0o500);
  try {
    const result = spawnSync(process.execPath, [script, 'attach', dirs.workspace, build, list], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /external folders could not be attached/);
    assert.equal(JSON.parse(result.stdout.trim()), 'external entry "data/missing" skipped: the original folder is missing');
  } finally {
    fs.chmodSync(build, 0o700);
  }
});
