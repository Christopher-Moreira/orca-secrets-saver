import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as asar from '@electron/asar';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(process.env.ORCA_RES || '/opt/stably-orca/resources', 'app.asar');
const backup = `${target}.orca-secrets-bak`;
const stateFile = `${target}.orca-secrets-state.json`;
const hash = async (file) => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const exists = async (file) => fs.access(file).then(() => true, () => false);
const version = (file) => JSON.parse(asar.extractFile(file, 'package.json').toString()).version;
const atomicCopy = async (source, dest, stat) => {
  const temp = `${dest}.tmp-${process.pid}`;
  try {
    await fs.copyFile(source, temp);
    await fs.chmod(temp, stat.mode);
    await fs.chown(temp, stat.uid, stat.gid);
    await fs.rename(temp, dest);
  } finally { await fs.rm(temp, { force: true }); }
};
const stat = await fs.stat(target);
if (process.argv.includes('--revert')) {
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  if (await hash(backup) !== state.backupSha256) throw new Error('Backup changed; refusing to restore.');
  const current = await hash(target);
  if (![state.patchedSha256, state.backupSha256].includes(current)) throw new Error('Orca changed since installation. Refusing to restore an older version.');
  await atomicCopy(backup, target, stat);
  console.log('Original Orca restored. Vault data was preserved.');
} else {
  const patched = path.join(here, 'build/app.asar');
  const meta = JSON.parse(await fs.readFile(path.join(here, 'build/metadata.json'), 'utf8'));
  if (meta.target !== target || await hash(target) !== meta.sourceSha256 || await hash(patched) !== meta.patchedSha256) {
    throw new Error('Orca or the prepared package changed. Rebuild before installing.');
  }
  if (meta.sourcePatched) {
    if (!await exists(backup) || version(backup) !== meta.version) throw new Error('A pristine backup of this Orca version is required.');
  } else {
    if (await exists(backup)) await fs.copyFile(backup, `${backup}.${Date.now()}`);
    await atomicCopy(target, backup, stat);
  }
  const state = { version: meta.version, backupSha256: await hash(backup), patchedSha256: meta.patchedSha256 };
  // Save recovery metadata before replacing the archive.
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2), { mode: 0o644 });
  await atomicCopy(patched, target, stat);
  console.log(`Patch installed for Orca ${meta.version}. Backup: ${backup}`);
}
