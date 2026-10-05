import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'orca-plugin/package.json'), 'utf8'));
const name = `secrets-saver-${pkg.version}`;
const release = path.join(root, 'release');
await fs.mkdir(release, { recursive: true });
execFileSync(process.execPath, [path.join(root, 'orca-plugin/scripts/build.mjs')], { stdio: 'inherit' });
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'secrets-saver-package-'));
try {
  const dest = path.join(temp, name);
  // Explicit allowlist: no user secrets, node_modules, reverse-engineering
  // dumps, profile data, backups or Orca binaries can enter the release.
  const files = [
    'README.md', '.gitignore', 'install.sh', 'scripts/package.mjs',
    'orca-plugin/package.json', 'orca-plugin/package-lock.json',
    'orca-plugin/orca-plugin.json', 'orca-plugin/settings.json', 'orca-plugin/panel.html',
    'orca-plugin/src/worker.mjs', 'orca-plugin/src/scanner.mjs', 'orca-plugin/src/orca-context.mjs',
    'orca-plugin/scripts/build.mjs', 'orca-plugin/dist/worker.mjs',
    'orca-plugin/dist/panel.html', 'orca-plugin/dist/orca-plugin.json',
    'install/package.json', 'install/package-lock.json', 'install/README.md',
    'install/build-patched-asar.sh', 'install/build-asar.mjs', 'install/edit-bundles.mjs',
    'install/apply.sh', 'install/apply-asar.mjs', 'install/revert.sh',
    'install/configure-secret-store-launcher.sh', 'install/close-apply-reopen.sh',
    'install/do-install.sh',
  ];
  for (const file of files) {
    await fs.mkdir(path.dirname(path.join(dest, file)), { recursive: true });
    await fs.copyFile(path.join(root, file), path.join(dest, file));
  }
  const archive = path.join(release, `${name}.tar.gz`);
  execFileSync('tar', ['-czf', archive, '-C', temp, name]);
  const digest = crypto.createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  await fs.writeFile(`${archive}.sha256`, `${digest}  ${path.basename(archive)}\n`);
  console.log(`Release: ${archive}`);
} finally { await fs.rm(temp, { recursive: true, force: true }); }
