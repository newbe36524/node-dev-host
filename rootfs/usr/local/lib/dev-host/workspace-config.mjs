// node-dev-host workspace configuration.
//
// Reads the optional .node-dev-host.yaml at the root of the mounted workspace: a parser for the YAML
// subset the file may use, the field validation, the settings a build resolves (environment, then file,
// then default) and the exclusion rules that the copy, the change hash and the dependency hash share.
// No npm dependencies. dev-host never parses the YAML itself: it sources the files this module writes
// into the state directory (see load_config in dev-host).
//
//   node workspace-config.mjs load <workspace> <stateDir>
//     Environment ENV_INSTALL_CMD, ENV_BUILD_CMD, ENV_DIST_DIR, ENV_SPA and ENV_API_UPSTREAM hold the
//     variables as set before dev-host's own defaults. Writes workspace-config.env,
//     workspace-config.status.json and, for a valid or absent file, workspace-config.ignore and
//     workspace-config.external into <stateDir>.
//     Never writes into <workspace>. Exit 0: valid or absent. Exit 2: rejected, the reason goes to stderr.
//   node workspace-config.mjs rules <distDir> <ignoreFile> [externalFile]
//     Prints "kind<TAB>rsync-argument" lines. kind is protect, copy, hash or deps. A missing file is an empty list.
//   node workspace-config.mjs attach <workspace> <buildDir> <externalFile>
//     Makes each external entry in <buildDir> a symbolic link to the folder of the same path in <workspace>.
//     Prints one JSON-encoded string per skipped entry on stdout. Exit 0: done or skipped. Exit 1: a filesystem
//     error the build must fail on; the reason goes to stderr.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_FILE = '.node-dev-host.yaml';
export const MAX_CONFIG_BYTES = 64 * 1024;
export const BUILT_IN_EXCLUDES = Object.freeze([
  'node_modules', '.git', '.vite', '.turbo', '.cache', 'coverage', '.pnpm-store',
]);
// The only files whose changes can require a reinstall; the dependency hash looks at these.
const DEPENDENCY_FILES = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', '.pnpmfile.cjs'];
const TOP_FIELDS = ['version', 'name', 'description', 'ignore', 'external', 'build', 'serve'];
const BUILD_FIELDS = ['install', 'command', 'distDir', 'spa'];
const SERVE_FIELDS = ['apiUpstream'];
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*)[ ]*:(?:[ ]+(.*))?$/;
// YAML constructs the subset does not support. A plain value that starts with one is refused.
// A flow list "[a, b]" on one line is supported; the other flow and block forms are not.
const UNSUPPORTED_START = /^[&!|>%@`*\]{}?,]/;
const DOUBLE_ESCAPES = { '\\': '\\', '"': '"', '/': '/', n: '\n', t: '\t' };
const UPSTREAM = /^(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[0-9A-Fa-f:.]+\]):([0-9]{1,5})$/;

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

const fail = (message) => {
  throw new ConfigError(message);
};
const isMapping = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const syntaxError = (line, message) =>
  new ConfigError(`${CONFIG_FILE} could not be read as configuration: line ${line}: ${message}`);

// ---- parser (block mappings, block sequences of scalars, scalars and comments) --------------------

function tokenize(text) {
  const lines = [];
  text.split('\n').forEach((raw, index) => {
    const no = index + 1;
    const body = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    // Tab is allowed inside a value, but not as a control character and not in the indentation.
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(body)) throw syntaxError(no, 'control characters are not allowed');
    const indent = /^[ \t]*/.exec(body)[0];
    if (indent.includes('\t')) throw syntaxError(no, 'indent with spaces, not tabs');
    const content = body.slice(indent.length).replace(/\s+$/, '');
    if (content === '' || content.startsWith('#')) return;
    lines.push({ no, indent: indent.length, text: content });
  });
  return lines;
}

const isItem = (line) => line.text === '-' || line.text.startsWith('- ');

// Parses the document. Throws a ConfigError whose message starts with the file name and "could not be read
// as configuration", and gives the line number.
export function parseConfig(text) {
  const lines = tokenize(text);
  if (lines.length === 0) return {};
  const cursor = { pos: 0 };
  const root = parseBlock(lines, cursor, lines[0].indent);
  if (cursor.pos < lines.length) throw syntaxError(lines[cursor.pos].no, 'unexpected indentation');
  if (!isMapping(root)) throw syntaxError(lines[0].no, 'the top level must be a mapping of fields');
  return root;
}

function parseBlock(lines, cursor, indent) {
  return isItem(lines[cursor.pos]) ? parseSequence(lines, cursor, indent) : parseMapping(lines, cursor, indent);
}

function parseMapping(lines, cursor, indent) {
  const obj = {};
  while (cursor.pos < lines.length && lines[cursor.pos].indent === indent) {
    const line = lines[cursor.pos];
    if (isItem(line)) throw syntaxError(line.no, 'a list item needs a key above it');
    const match = KEY_LINE.exec(line.text);
    if (!match) throw syntaxError(line.no, 'expected "key: value"');
    const [, key, rest] = match;
    if (Object.hasOwn(obj, key)) throw syntaxError(line.no, `duplicate key "${key}"`);
    cursor.pos += 1;
    const value = (rest ?? '').trim();
    if (value === '' || value.startsWith('#')) {
      // An empty value takes the block that follows: deeper indented, or a list at the same indent.
      const next = lines[cursor.pos];
      const hasBlock = next && (next.indent > indent || (next.indent === indent && isItem(next)));
      obj[key] = hasBlock ? parseBlock(lines, cursor, next.indent) : null;
    } else {
      obj[key] = parseScalar(value, line.no);
    }
  }
  if (cursor.pos < lines.length && lines[cursor.pos].indent > indent) {
    throw syntaxError(lines[cursor.pos].no, 'unexpected indentation');
  }
  return obj;
}

function parseSequence(lines, cursor, indent) {
  const list = [];
  while (cursor.pos < lines.length && lines[cursor.pos].indent === indent && isItem(lines[cursor.pos])) {
    const line = lines[cursor.pos];
    cursor.pos += 1;
    const value = line.text === '-' ? '' : line.text.slice(2).trim();
    if (value === '' || value.startsWith('#')) throw syntaxError(line.no, 'a list item needs its value on the same line');
    if (KEY_LINE.test(value)) throw syntaxError(line.no, 'lists of mappings are not supported');
    list.push(parseScalar(value, line.no));
  }
  return list;
}

function parseScalar(raw, line) {
  if (raw.startsWith('"') || raw.startsWith("'")) return parseQuoted(raw, line);
  if (raw.startsWith('[')) return parseFlowSequence(raw, line);
  if (UNSUPPORTED_START.test(raw)) throw syntaxError(line, `"${raw[0]}" is not supported here; quote the value`);
  const value = raw.replace(/\s+#.*$/, '').trim();
  if (value.includes(': ') || value.endsWith(':')) {
    throw syntaxError(line, 'a mapping cannot appear inside a value; quote the value');
  }
  if (/^-?[0-9]+$/.test(value)) return Number(value);
  if (value === 'true' || value === 'false') return value === 'true';
  if (value === 'null' || value === '~') return null;
  return value;
}

// Reads the quoted string that opens at raw[start]. Returns its value and the index after the closing quote.
function readQuoted(raw, start, line) {
  const quote = raw[start];
  let out = '';
  for (let i = start + 1; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote === '"' && ch === '\\') {
      i += 1;
      const esc = raw[i];
      if (esc === undefined || !Object.hasOwn(DOUBLE_ESCAPES, esc)) {
        throw syntaxError(line, 'unsupported escape in a quoted value');
      }
      out += DOUBLE_ESCAPES[esc];
      continue;
    }
    if (ch === quote) {
      if (quote === "'" && raw[i + 1] === "'") {
        out += "'";
        i += 1;
        continue;
      }
      return { value: out, end: i + 1 };
    }
    out += ch;
  }
  throw syntaxError(line, 'quoted value is not closed on the same line');
}

// A scalar on its own: only a comment may follow it.
function parseQuoted(raw, line) {
  const { value, end } = readQuoted(raw, 0, line);
  const tail = raw.slice(end).trim();
  if (tail !== '' && !tail.startsWith('#')) throw syntaxError(line, 'unexpected text after a quoted value');
  return value;
}

// A flow list on one line: [], [a], [a, "b, c"]. Items are scalars, not lists or mappings.
function parseFlowSequence(raw, line) {
  const list = [];
  let i = 1;
  const skipSpace = () => {
    while (raw[i] === ' ' || raw[i] === '\t') i += 1;
  };
  skipSpace();
  if (raw[i] === ']') {
    i += 1;
  } else {
    for (;;) {
      skipSpace();
      if (raw[i] === '"' || raw[i] === "'") {
        const quoted = readQuoted(raw, i, line);
        list.push(quoted.value);
        i = quoted.end;
      } else {
        const start = i;
        while (i < raw.length && raw[i] !== ',' && raw[i] !== ']') {
          if ('[{"\''.includes(raw[i])) throw syntaxError(line, 'this syntax is not supported inside a list');
          i += 1;
        }
        const plain = raw.slice(start, i).trim();
        if (plain === '') throw syntaxError(line, 'empty list item');
        list.push(parseScalar(plain, line));
      }
      skipSpace();
      if (raw[i] === ',') {
        i += 1;
        continue;
      }
      if (raw[i] === ']') {
        i += 1;
        break;
      }
      throw syntaxError(line, 'list is not closed on the same line');
    }
  }
  const tail = raw.slice(i).trim();
  if (tail !== '' && !tail.startsWith('#')) throw syntaxError(line, 'unexpected text after a list');
  return list;
}

// ---- validation ------------------------------------------------------------------------------------

function rejectUnknown(obj, allowed, prefix) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(`unknown field "${prefix}${key}"`);
  }
}

function checkText(field, value, min, max) {
  if (typeof value !== 'string') fail(`${field} must be a string`);
  if (CONTROL_CHARS.test(value)) fail(`${field} must not contain control characters`);
  const length = [...value].length;
  if (length < min || length > max) {
    fail(min > 0 ? `${field} must be ${min} to ${max} characters` : `${field} must be at most ${max} characters`);
  }
  return value;
}

function checkCommand(field, value) {
  if (typeof value !== 'string') fail(`${field} must be a string`);
  if (value.trim() === '') fail(`${field} must not be empty`);
  if (CONTROL_CHARS.test(value)) fail(`${field} must not contain control characters`);
  return value;
}

function checkDistDir(value) {
  const field = 'build.distDir';
  if (typeof value !== 'string') fail(`${field} must be a string`);
  if (value.trim() === '') fail(`${field} must not be empty`);
  if (CONTROL_CHARS.test(value)) fail(`${field} must not contain control characters`);
  if (/^[/\\~]/.test(value) || /^[A-Za-z]:/.test(value)) fail(`${field} must be relative to the project root`);
  const segments = value.split(/[\\/]/);
  if (segments.includes('..')) fail(`${field} must not contain ".." segments`);
  const kept = segments.filter((segment) => segment !== '' && segment !== '.');
  if (kept.length === 0) fail(`${field} must name a folder inside the project`);
  return kept.join('/');
}

// One ignore entry is an rsync exclude pattern relative to the workspace root. Refuse anything that could
// point outside it or change how rsync reads the line.
export function validateIgnoreEntry(entry) {
  const refuse = (why) => fail(`ignore entry ${JSON.stringify(entry)} ${why}`);
  if (typeof entry !== 'string') fail('ignore must be a list of strings');
  if (entry.trim() === '') refuse('is blank');
  if (CONTROL_CHARS.test(entry)) refuse('contains a control character');
  if (/^[/~!#;]/.test(entry)) refuse('must be relative to the workspace root');
  if (/^[A-Za-z]:/.test(entry)) refuse('must not start with a drive letter');
  if (/^[+-] /.test(entry)) refuse('must not start with "+ " or "- "');
  if (entry.split(/[\\/]/).includes('..')) refuse('must not contain a ".." segment');
  return true;
}

function checkIgnore(value) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    fail('ignore must be a list of strings');
  }
  value.forEach(validateIgnoreEntry);
  return value.slice();
}

// The folder segments of a path: "./data//covers/" gives ["data", "covers"].
const segmentsOf = (folder) => folder.split(/[\\/]/).filter((segment) => segment !== '' && segment !== '.');

// True when one folder is the other or lies inside it. Both are normalized folder paths.
const overlaps = (a, b) => {
  const x = segmentsOf(a);
  const y = segmentsOf(b);
  const shared = Math.min(x.length, y.length);
  return x.slice(0, shared).every((segment, i) => segment === y[i]);
};

// One external entry: a concrete folder below the workspace root. Returns the normalized entry, or refuses it
// by naming the entry. The output folder and the entries among themselves are checked elsewhere.
export function checkExternalEntry(entry) {
  const refuse = (why) => fail(`external entry ${JSON.stringify(entry)} ${why}`);
  if (typeof entry !== 'string') fail('external must be a list of strings');
  if (entry.trim() === '') refuse('is blank');
  if (CONTROL_CHARS.test(entry)) refuse('contains a control character');
  if (entry.includes('\\')) refuse('must use "/" between folders, not "\\"');
  if (entry !== entry.trim()) refuse('must not start or end with a space');
  if (/[*?[]/.test(entry)) refuse('must not contain a wildcard (*, ? or [)');
  if (/^[/~]/.test(entry) || /^[A-Za-z]:/.test(entry)) refuse('must be relative to the workspace root');
  const segments = segmentsOf(entry);
  if (segments.includes('..')) refuse('must not contain a ".." segment');
  if (segments.length === 0) refuse('names the workspace root, not a folder inside it');
  if (segments.some((segment) => BUILT_IN_EXCLUDES.includes(segment))) {
    refuse(`uses a built-in name (${BUILT_IN_EXCLUDES.join(', ')})`);
  }
  return segments.join('/');
}

// The list is normalized: an entry given twice (with or without a trailing "/") counts once. An entry inside
// another one is refused, because the attach step would link the same folder twice.
export function checkExternal(value) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    fail('external must be a list of strings');
  }
  const entries = [];
  for (const raw of value) {
    const entry = checkExternalEntry(raw);
    if (!entries.includes(entry)) entries.push(entry);
  }
  for (const entry of entries) {
    const outer = entries.find((other) => other !== entry && entry.startsWith(`${other}/`));
    if (outer) fail(`external entry ${JSON.stringify(entry)} lies inside external entry ${JSON.stringify(outer)}`);
  }
  return entries;
}

// The entries that overlap the output folder. The output folder comes from the file or the environment, so this
// runs after the settings are resolved (see loadWorkspace).
export function externalOutputClash(external, distDir) {
  const clash = external.find((entry) => overlaps(entry, distDir));
  if (clash === undefined) return null;
  return `external entry ${JSON.stringify(clash)} overlaps the output folder ${JSON.stringify(distDir)}`;
}

function checkBuild(value) {
  rejectUnknown(value, BUILD_FIELDS, 'build.');
  const out = { install: null, command: null, distDir: null, spa: null };
  if (value.install !== undefined) out.install = checkCommand('build.install', value.install);
  if (value.command !== undefined) out.command = checkCommand('build.command', value.command);
  if (value.distDir !== undefined) out.distDir = checkDistDir(value.distDir);
  if (value.spa !== undefined) {
    if (typeof value.spa !== 'boolean') fail('build.spa must be true or false');
    out.spa = value.spa;
  }
  return out;
}

function checkServe(value) {
  rejectUnknown(value, SERVE_FIELDS, 'serve.');
  const out = { apiUpstream: null };
  if (value.apiUpstream !== undefined) {
    const match = typeof value.apiUpstream === 'string' ? UPSTREAM.exec(value.apiUpstream) : null;
    if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) fail('serve.apiUpstream must be host:port');
    out.apiUpstream = value.apiUpstream;
  }
  return out;
}

// Returns the normalized configuration, or throws a ConfigError that names the field at fault.
export function validateConfig(obj) {
  if (!isMapping(obj)) fail('the file must hold a mapping of fields');
  rejectUnknown(obj, TOP_FIELDS, '');
  if (obj.version !== 1) fail('version must be the integer 1');
  const out = {
    version: 1, name: null, description: null, ignore: [], external: [],
    build: { install: null, command: null, distDir: null, spa: null },
    serve: { apiUpstream: null },
  };
  if (obj.name !== undefined) out.name = checkText('name', obj.name, 1, 80);
  if (obj.description !== undefined) out.description = checkText('description', obj.description, 0, 500);
  if (obj.ignore !== undefined) out.ignore = checkIgnore(obj.ignore);
  if (obj.external !== undefined) out.external = checkExternal(obj.external);
  if (obj.build !== undefined) {
    if (!isMapping(obj.build)) fail('build must be a mapping of fields');
    out.build = checkBuild(obj.build);
  }
  if (obj.serve !== undefined) {
    if (!isMapping(obj.serve)) fail('serve must be a mapping of fields');
    out.serve = checkServe(obj.serve);
  }
  return out;
}

// ---- settings and exclusion rules --------------------------------------------------------------------

const nonEmpty = (value) => typeof value === 'string' && value !== '';

// Environment first, then the file, then today's default. An empty environment variable counts as unset.
// The serving values are the ones the container's Caddyfile is written with.
export function resolveSettings(config, env = {}) {
  const file = config?.build ?? {};
  const serve = config?.serve ?? {};
  return {
    install: nonEmpty(env.INSTALL_CMD) ? env.INSTALL_CMD : (file.install || ''),
    build: nonEmpty(env.BUILD_CMD) ? env.BUILD_CMD : (file.command || 'pnpm build'),
    distDir: nonEmpty(env.DIST_DIR) ? env.DIST_DIR : (file.distDir || 'dist'),
    spa: nonEmpty(env.SPA) ? env.SPA : (typeof file.spa === 'boolean' ? String(file.spa) : 'true'),
    apiUpstream: nonEmpty(env.API_UPSTREAM) ? env.API_UPSTREAM : (serve.apiUpstream || ''),
  };
}

const ruleKey = (entry) => entry.replace(/\/+$/, '');

// The exclusion views, as rsync arguments. One list of built-ins and configured entries feeds all of them.
//   protect: keeps built-in names, the output folder and the external entries when --delete-excluded purges
//            a path that became ignored. The external entries must stay, or the attached links would go
//   copy:    the build copy. Built-ins, the output folder at the root, the ignore entries, then the external
//            entries, anchored at the workspace root so they match only there
//   hash:    the change signature. The copy rules plus any "dist", as the old find-based signature skipped it
//   deps:    the dependency signature. node_modules and the configured entries, then the dependency files only
// A configured entry that names a built-in (".cache/" for ".cache") adds no second rule. An ignore entry that is
// also an external entry is treated as external: it yields one exclusion, the anchored one.
export function buildExcludes(ignore = [], distDir = 'dist', external = []) {
  const anchoredDist = `/${distDir}`;
  const externalKeys = new Set(external.map(ruleKey));
  const anchoredExternal = [...externalKeys].map((entry) => `/${entry}`);
  const unique = [];
  const seenKeys = new Set();
  for (const entry of ignore) {
    const key = ruleKey(entry);
    if (seenKeys.has(key) || externalKeys.has(key)) continue;
    seenKeys.add(key);
    unique.push(entry);
  }
  const extra = unique.filter((entry) => !BUILT_IN_EXCLUDES.includes(ruleKey(entry)));
  const copy = [
    ...BUILT_IN_EXCLUDES.map((name) => `--exclude=${name}`),
    `--exclude=${anchoredDist}`,
    ...extra.map((entry) => `--exclude=${entry}`),
    ...anchoredExternal.map((entry) => `--exclude=${entry}`),
  ];
  return {
    protect: [...BUILT_IN_EXCLUDES, anchoredDist, ...anchoredExternal].map((name) => `--filter=P ${name}`),
    copy,
    hash: [...copy, '--exclude=dist'],
    deps: [
      '--exclude=node_modules',
      ...unique.map((entry) => `--exclude=${entry}`),
      ...anchoredExternal.map((entry) => `--exclude=${entry}`),
      '--include=*/',
      ...DEPENDENCY_FILES.map((name) => `--include=${name}`),
      '--exclude=*',
    ],
  };
}

export function ruleLines(ignore, distDir, external = []) {
  const views = buildExcludes(ignore, distDir, external);
  return Object.entries(views)
    .flatMap(([kind, args]) => args.map((arg) => `${kind}\t${arg}`))
    .join('\n') + '\n';
}

// ---- state files --------------------------------------------------------------------------------------

export const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

export function envFile(settings) {
  return [
    `WS_INSTALL_CMD=${shellQuote(settings.install)}`,
    `WS_BUILD_CMD=${shellQuote(settings.build)}`,
    `WS_DIST_DIR=${shellQuote(settings.distDir)}`,
    `WS_SPA=${shellQuote(settings.spa)}`,
    `WS_API_UPSTREAM=${shellQuote(settings.apiUpstream)}`,
  ].join('\n') + '\n';
}

// A JSON fragment, one line, that dev-host appends to status.json. Every value is JSON-encoded here.
export function statusFragment({ config = null, configSource = null, configHash = null, configError = null }) {
  const fields = {
    name: config?.name ?? null,
    description: config?.description ?? null,
    configSource,
    configHash,
    configError,
    ignore: config?.ignore ?? [],
    external: config?.external ?? [],
  };
  return Object.entries(fields).map(([key, value]) => `,${JSON.stringify(key)}:${JSON.stringify(value)}`).join('');
}

function writeAtomic(file, content) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail(`${CONFIG_FILE} could not be read as configuration: the file is not valid UTF-8`);
  }
}

// Reads the workspace file, resolves the settings and writes the state files. Returns { error }, where error is
// the rejection reason or null. A rejected file leaves workspace-config.ignore and workspace-config.external as
// they were, so the change signature and the attach step keep the last valid lists.
export function loadWorkspace(workspace, stateDir, env = {}) {
  const file = path.join(workspace, CONFIG_FILE);
  let stat = null;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  let config = null;
  let hash = null;
  let error = null;
  if (stat) {
    try {
      if (!stat.isFile()) fail(`${CONFIG_FILE} must be a regular file, not a link or a folder`);
      if (stat.size > MAX_CONFIG_BYTES) fail(`${CONFIG_FILE} could not be read as configuration: larger than 64 KiB`);
      const bytes = fs.readFileSync(file);
      if (bytes.length > MAX_CONFIG_BYTES) fail(`${CONFIG_FILE} could not be read as configuration: larger than 64 KiB`);
      hash = crypto.createHash('sha256').update(bytes).digest('hex');
      config = validateConfig(parseConfig(decodeUtf8(bytes)));
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      config = null;
      error = err.message;
    }
  }
  const envSettings = {
    INSTALL_CMD: env.ENV_INSTALL_CMD,
    BUILD_CMD: env.ENV_BUILD_CMD,
    DIST_DIR: env.ENV_DIST_DIR,
    SPA: env.ENV_SPA,
    API_UPSTREAM: env.ENV_API_UPSTREAM,
  };
  let settings = resolveSettings(config, envSettings);
  // The output folder can come from the environment, so an external entry is checked against the resolved one.
  if (config && config.external.length > 0) {
    const clash = externalOutputClash(config.external, settings.distDir);
    if (clash) {
      config = null;
      error = clash;
      settings = resolveSettings(null, envSettings);
    }
  }
  fs.mkdirSync(stateDir, { recursive: true });
  writeAtomic(path.join(stateDir, 'workspace-config.env'), envFile(settings));
  if (!error) {
    writeAtomic(path.join(stateDir, 'workspace-config.ignore'), (config?.ignore ?? []).map((entry) => `${entry}\n`).join(''));
    writeAtomic(path.join(stateDir, 'workspace-config.external'), (config?.external ?? []).map((entry) => `${entry}\n`).join(''));
  }
  writeAtomic(path.join(stateDir, 'workspace-config.status.json'), statusFragment({
    config,
    configSource: stat ? CONFIG_FILE : null,
    configHash: hash,
    configError: error,
  }));
  return { error };
}

// One entry per line. A missing file is an empty list.
function readList(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '');
}

// ---- attach ------------------------------------------------------------------------------------------

const lstatOrNull = (file) => {
  try {
    return fs.lstatSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
};

// Why the original of an external entry cannot be attached, or null when it can. Every part of the path below
// the workspace root is checked with lstat, so a link anywhere on the way is never followed.
function originalProblem(workspace, segments) {
  let current = workspace;
  for (let i = 0; i < segments.length; i += 1) {
    current = path.join(current, segments[i]);
    const st = lstatOrNull(current);
    if (!st) return 'the original folder is missing';
    if (st.isSymbolicLink()) return 'the original is reached through a symbolic link';
    const last = i === segments.length - 1;
    if (last && !st.isDirectory()) return 'the original is not a folder';
    if (!last && !st.isDirectory()) return 'the original folder is missing';
  }
  return null;
}

// Makes the parent folders of an entry in the build copy, creating missing ones. Returns a reason to skip the
// entry when one of them is a link. A folder that is neither a link nor a folder is a filesystem error.
function buildParentsProblem(buildDir, segments) {
  let current = buildDir;
  for (const segment of segments) {
    current = path.join(current, segment);
    const st = lstatOrNull(current);
    if (!st) {
      fs.mkdirSync(current);
      continue;
    }
    if (st.isSymbolicLink()) return 'its path in the build copy is reached through a symbolic link';
    if (!st.isDirectory()) throw Object.assign(new Error(`${current} is not a folder in the build copy`), { code: 'ENOTDIR' });
  }
  return null;
}

// Puts a link at target that points to original. A correct link stays. A link with another target is replaced
// through a temporary name, so the path never disappears. A real folder or file is removed; lstat showed it is not
// a link, and rm does not follow the links inside it, so the original is never touched.
function placeLink(target, original) {
  const st = lstatOrNull(target);
  if (st && st.isSymbolicLink()) {
    if (fs.readlinkSync(target) === original) return;
    const tmp = `${target}.${process.pid}.tmp`;
    fs.rmSync(tmp, { force: true });
    fs.symlinkSync(original, tmp);
    fs.renameSync(tmp, target);
    return;
  }
  if (st) fs.rmSync(target, { recursive: true, force: true });
  fs.symlinkSync(original, target);
}

// Attaches every external entry to the build copy after a copy. Skipped entries are appended to warnings as
// JSON-encoded strings; any other filesystem error throws.
export function attachExternal(workspace, buildDir, entries, warnings = []) {
  for (const entry of entries) {
    const segments = segmentsOf(entry);
    const skip = (why) => warnings.push(JSON.stringify(`external entry ${JSON.stringify(entry)} skipped: ${why}`));
    const problem = originalProblem(workspace, segments);
    if (problem) {
      skip(problem);
      continue;
    }
    const parentProblem = buildParentsProblem(buildDir, segments.slice(0, -1));
    if (parentProblem) {
      skip(parentProblem);
      continue;
    }
    placeLink(path.join(buildDir, ...segments), path.resolve(workspace, ...segments));
  }
  return warnings;
}

export function main(argv, env = process.env) {
  const [command, ...args] = argv;
  if (command === 'load' && args.length === 2) {
    const { error } = loadWorkspace(args[0], args[1], env);
    if (error) {
      process.stderr.write(`configuration rejected: ${error}\n`);
      return 2;
    }
    return 0;
  }
  if (command === 'rules' && (args.length === 2 || args.length === 3)) {
    const external = args.length === 3 ? readList(args[2]) : [];
    process.stdout.write(ruleLines(readList(args[1]), args[0], external));
    return 0;
  }
  if (command === 'attach' && args.length === 3) {
    const warnings = [];
    let code = 0;
    try {
      attachExternal(args[0], args[1], readList(args[2]), warnings);
    } catch (err) {
      process.stderr.write(`external folders could not be attached: ${err.message}\n`);
      code = 1;
    }
    // Warnings of the entries handled before a failure are still reported.
    for (const warning of warnings) process.stdout.write(`${warning}\n`);
    return code;
  }
  process.stderr.write('usage: workspace-config.mjs load <workspace> <stateDir> | rules <distDir> <ignoreFile> [externalFile] | attach <workspace> <buildDir> <externalFile>\n');
  return 64;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
