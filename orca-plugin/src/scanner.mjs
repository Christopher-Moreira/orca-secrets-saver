import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parse as parseEnv } from 'dotenv';
import { parse as parseIni } from 'ini';
import JSON5 from 'json5';
import { parse as parseToml } from 'smol-toml';
import { parseDocument } from 'yaml';

export const LIMITS = { bytes: 256 * 1024, files: 300, entries: 1200, depth: 8, visited: 15000 };
const SKIP = new Set(['.git', 'node_modules', '.next', '.nuxt', '.cache', 'dist', 'build', 'coverage', 'vendor', '.venv', 'venv', '__pycache__', '.idea', '.vscode']);
// Detection is by NAMING CONVENTION, not extension: a file counts if its name
// looks like an env/secrets/config file (.env, config.*, secrets.*, .npmrc, …),
// regardless of extension (even no extension). The extension only tells us how
// to parse it for the (optional) variable list; the raw content is shown either
// way.

// Config-looking names that never hold secrets — always skip.
const DENY = new Set([
  'package.json', 'package-lock.json', 'tsconfig.json', 'jsconfig.json', 'pnpm-lock.yaml',
  'composer.json', 'composer.lock', 'deno.json', 'deno.jsonc', 'components.json', 'angular.json', 'nx.json',
]);
// Binary/asset extensions we never open as text.
const BINARY = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.bmp', '.pdf', '.zip', '.gz', '.tar', '.tgz',
  '.7z', '.rar', '.mp3', '.mp4', '.mov', '.wav', '.woff', '.woff2', '.ttf', '.eot', '.otf', '.class', '.jar',
  '.so', '.dylib', '.dll', '.exe', '.bin', '.node', '.wasm', '.lock', '.map',
]);
// Exact dotfile/file names that hold credentials/config by convention.
const EXACT = new Set(['.env', '.envrc', '.npmrc', '.pypirc', '.netrc', '.dockercfg', 'dotenv']);
// Text extensions we may open. '' = no extension (e.g. a file literally named `config`).
const TEXT_EXT = new Set(['.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties', '.py', '.rb', '.go', '.js', '.ts', '.mjs', '.cjs', '']);
// The stem (name without extension) must be EXACTLY one of these — this excludes
// build-tool configs like vite.config.ts / tailwind.config.ts (stem "vite.config").
const EXACT_STEMS = new Set([
  'config', 'configuration', 'settings', 'setting', 'secret', 'secrets', 'credential', 'credentials',
  'appsettings', 'application', 'database', 'env', 'environment', 'dotenv', 'connection', 'connections',
]);
// …or the name clearly contains a secret/credential word as a token.
const CRED_WORD = /(?:^|[._-])(secrets?|credentials?)(?:$|[._-])/;

export function formatFor(relative) {
  const name = path.basename(relative).toLowerCase();
  if (DENY.has(name)) return null;

  // .env family + known credential dotfiles → always.
  if (/^\.env(?:\..+)?$/.test(name) || name.endsWith('.env') || EXACT.has(name)) return 'env';

  // Docs / type-decls are never secrets even when named "config"/"secrets".
  if (name.endsWith('.md') || name.endsWith('.d.ts')) return null;

  const ext = path.extname(name);
  if (BINARY.has(ext) || !TEXT_EXT.has(ext)) return null;
  const stem = ext ? name.slice(0, name.length - ext.length) : name;
  if (!(EXACT_STEMS.has(stem) || CRED_WORD.test(stem))) return null;

  // Parser hint from extension; unknown/script → 'text' (shown raw, no var list).
  if (['.json', '.jsonc', '.json5'].includes(ext)) return ext.slice(1);
  if (['.yaml', '.yml'].includes(ext)) return ext.slice(1);
  if (ext === '.toml') return 'toml';
  if (['.ini', '.cfg', '.conf', '.properties'].includes(ext)) return 'ini';
  return 'text';
}

export function parseConfig(text, format) {
  if (format === 'env') return parseEnv(text);
  if (['json', 'json5', 'jsonc'].includes(format)) return JSON5.parse(text);
  if (['yaml', 'yml'].includes(format)) {
    const doc = parseDocument(text, { uniqueKeys: true, maxAliasCount: 20 });
    if (doc.errors.length) throw new Error('invalid yaml');
    return doc.toJS({ maxAliasCount: 20 });
  }
  if (format === 'toml') return parseToml(text);
  if (format === 'ini') return parseIni(text);
  return {}; // 'text' / unknown → no structured vars; raw content is shown as-is
}

export function flatten(value, prefix = '', out = [], depth = 0, seen = new Set()) {
  if (out.length >= LIMITS.entries || depth > 12) return out;
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return out;
    seen.add(value);
    for (const key of Object.keys(value)) {
      if (out.length >= LIMITS.entries) break;
      flatten(value[key], prefix ? `${prefix}.${key}` : key, out, depth + 1, seen);
    }
    seen.delete(value);
  } else if (prefix && prefix.length <= 512 && value !== undefined) {
    out.push({ name: prefix, value: value === null ? 'null' : String(value) });
  }
  return out;
}

function within(root, file) { const rel = path.relative(root, file); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); }
export async function safeRead(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\0')) throw new Error('Arquivo fora do projeto.');
  const file = path.resolve(root, relative);
  if (!within(root, file) || file === root) throw new Error('Arquivo fora do projeto.');
  let current = root;
  for (const segment of path.relative(root, file).split(path.sep)) {
    current = path.join(current, segment);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Links simbólicos não são lidos.');
  }
  const resolved = await fs.realpath(file);
  if (!within(root, resolved)) throw new Error('Arquivo fora do projeto.');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    // Linux: verify the opened descriptor as well, to catch parent-directory swaps.
    if (process.platform === 'linux' && !within(root, await fs.realpath(`/proc/self/fd/${handle.fd}`))) throw new Error('Arquivo fora do projeto.');
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > LIMITS.bytes) throw new Error('Arquivo não suportado ou maior que 256 KiB.');
    const buffer = Buffer.alloc(LIMITS.bytes + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > LIMITS.bytes) throw new Error('Arquivo maior que 256 KiB.');
    return buffer.subarray(0, used).toString('utf8');
  } finally { await handle.close(); }
}

export async function safeWrite(root, relative, content) {
  if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > LIMITS.bytes) {
    throw new Error('O arquivo pode ter no máximo 256 KiB.');
  }
  const format = formatFor(relative);
  if (!format) throw new Error('Este arquivo não é um formato de configuração suportado.');
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.includes('\0')) throw new Error('Arquivo fora do projeto.');

  const projectRoot = await fs.realpath(root);
  const file = path.resolve(projectRoot, relative);
  if (!within(projectRoot, file) || file === projectRoot) throw new Error('Arquivo fora do projeto.');
  const segments = path.relative(projectRoot, file).split(path.sep);
  let current = projectRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error('Links simbólicos não são editados.');
  }

  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > LIMITS.bytes) throw new Error('Arquivo não suportado ou maior que 256 KiB.');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error('Só é possível editar arquivos pertencentes ao usuário atual.');
  }
  if ((stat.mode & 0o222) === 0) throw new Error('Este arquivo está somente para leitura.');

  const dir = path.dirname(file);
  const temp = path.join(dir, `.secrets-saver-${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, stat.mode & 0o777);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;

    // Recheck the project and destination immediately before the atomic rename.
    const currentRoot = await fs.realpath(projectRoot);
    const parent = await fs.realpath(dir);
    if (currentRoot !== projectRoot || !within(projectRoot, parent)) throw new Error('A pasta do arquivo mudou durante a edição.');
    const currentTarget = await fs.lstat(file);
    if (currentTarget.isSymbolicLink() || !currentTarget.isFile()) throw new Error('O arquivo mudou durante a edição.');
    await fs.rename(temp, file);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

function itemId(file, name) { return crypto.createHash('sha256').update(file).update('\0').update(name).digest('hex').slice(0, 24); }
export async function scanProject(directory) {
  let root;
  try { root = await fs.realpath(directory); } catch { return { entries: [], issues: [{ file: '', message: 'Pasta indisponível neste computador.' }], limited: false }; }
  const entries = [], filesFound = [], issues = [];
  let files = 0, visited = 0, limited = false;
  const issue = (file, message) => { if (issues.length < 20) issues.push({ file, message }); };
  async function walk(relative, depth) {
    if (depth > LIMITS.depth) { limited = true; return; }
    let dir;
    try { dir = await fs.opendir(path.join(root, relative)); } catch { issue(relative, 'Não foi possível ler esta pasta.'); return; }
    for await (const ent of dir) {
      if (++visited > LIMITS.visited || files >= LIMITS.files || entries.length >= LIMITS.entries) { limited = true; break; }
      if (ent.isSymbolicLink()) continue;
      const file = path.join(relative, ent.name);
      if (ent.isDirectory()) { if (!SKIP.has(ent.name)) await walk(file, depth + 1); continue; }
      const format = ent.isFile() ? formatFor(file) : null;
      if (!format) continue;
      files++;
      try {
        const text = await safeRead(root, file);
        filesFound.push({ file, format, example: /(?:example|sample|template|dist)(?:\.|$)/i.test(path.basename(file)) });
        let values;
        try { values = flatten(parseConfig(text, format)); } catch { issue(file, 'Formato inválido ou não suportado.'); continue; }
        if (values.length >= LIMITS.entries) limited = true;
        for (const { name } of values) {
          if (entries.length >= LIMITS.entries) { limited = true; break; }
          entries.push({ id: itemId(file, name), name, file, format, example: /(?:example|sample|template|dist)(?:\.|$)/i.test(path.basename(file)) });
        }
      } catch { issue(file, 'Arquivo indisponível, link simbólico ou acima do limite.'); }
    }
  }
  await walk('', 0);
  entries.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  return { entries, files: filesFound, issues, limited };
}

export async function readLocalFile(directory, relative) {
  if (!formatFor(relative)) throw new Error('Arquivo não suportado.');
  return safeRead(directory, relative);
}

export async function writeLocalFile(directory, relative, content) {
  return safeWrite(directory, relative, content);
}

export async function revealLocal(directory, entry) {
  const root = await fs.realpath(directory);
  const format = formatFor(entry.file);
  if (!format) throw new Error('Formato não suportado.');
  const text = await safeRead(root, entry.file);
  let found;
  try { found = flatten(parseConfig(text, format)).find(v => v.name === entry.name); } catch { throw new Error('Não foi possível interpretar o arquivo.'); }
  if (!found) throw new Error('A variável foi removida. Atualize a lista.');
  if (found.value.length > 16384) throw new Error('Valor maior que 16 KiB. Abra o arquivo no editor.');
  return found.value;
}
