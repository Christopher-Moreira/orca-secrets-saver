import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import * as asar from '@electron/asar';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(process.env.ORCA_RES || '/opt/stably-orca/resources', 'app.asar');
const build = path.join(here, 'build');
const digest = async (file) => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
// Patch the installed version. Reusing an old backup could downgrade Orca.
const sourceSha256 = await digest(target);
const originalList = asar.listPackage(target).sort();
const sourceMain = asar.extractFile(target, 'out/main/index.js').toString();
const sourcePatched = sourceMain.includes('await this.invokeCommand(e,n.commandId,n.args)');
const version = JSON.parse(asar.extractFile(target, 'package.json').toString()).version;
await fs.rm(build, { recursive: true, force: true });
await fs.mkdir(build, { recursive: true });
console.log(`Preparing Orca ${version} from ${target}`);
asar.extractAll(target, path.join(build, 'app'));
execFileSync(process.execPath, [path.join(here, 'edit-bundles.mjs'), path.join(build, 'app')], { stdio: 'inherit' });
const patched = path.join(build, 'app.asar');
await asar.createPackage(path.join(build, 'app'), patched);
const patchedList = asar.listPackage(patched).sort();
if (JSON.stringify(originalList) !== JSON.stringify(patchedList)) throw new Error('Archive file list changed. Installation aborted.');
if (!asar.extractFile(patched, 'out/main/index.js').toString().includes('await this.invokeCommand(e,n.commandId,n.args)')) {
  throw new Error('Missing worker bridge in built archive.');
}
if (await digest(target) !== sourceSha256) throw new Error('Orca changed during build. Run the installer again.');
await fs.writeFile(path.join(build, 'metadata.json'), JSON.stringify({ target, version, sourceSha256, sourcePatched, patchedSha256: await digest(patched) }, null, 2));
console.log(`Prepared ${patched}`);
