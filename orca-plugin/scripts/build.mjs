import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');

/**
 * Assembles the installable plugin directory in ./dist:
 *   - worker.mjs   (esbuild-bundled: worker + scanner + orca-context + deps)
 *   - panel.html   (copied verbatim)
 *   - orca-plugin.json (manifest, copied verbatim)
 * Point Orca's devPluginPaths at ./dist.
 */
async function main() {
  const settings = JSON.parse(await fs.readFile(path.join(root, 'settings.json'), 'utf8'));
  if (typeof settings.followOrcaLanguage !== 'boolean' || !['en', 'pt', 'es'].includes(settings.language)) {
    throw new Error('settings.json: followOrcaLanguage must be boolean; language must be en, pt or es.');
  }
  await fs.rm(dist, { recursive: true, force: true });
  await fs.mkdir(dist, { recursive: true });

  await build({
    entryPoints: [path.join(root, 'src', 'worker.mjs')],
    outfile: path.join(dist, 'worker.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    // Node built-ins stay external; npm deps (dotenv, ini, json5, smol-toml, yaml) get bundled in.
    // createRequire shim: some deps are CJS and call require('fs') etc. — give the
    // ESM bundle a real `require` so esbuild's __require uses it instead of throwing.
    banner: {
      js: "// secrets-saver worker — bundled, do not edit by hand\nimport{createRequire as __ssCreateRequire}from'node:module';var require=__ssCreateRequire(import.meta.url);",
    },
    logLevel: 'info',
  });

  await fs.copyFile(path.join(root, 'panel.html'), path.join(dist, 'panel.html'));
  await fs.copyFile(path.join(root, 'orca-plugin.json'), path.join(dist, 'orca-plugin.json'));

  const files = await fs.readdir(dist);
  console.log('\n✓ dist pronto:', dist);
  for (const f of files) {
    const s = await fs.stat(path.join(dist, f));
    console.log('  ', f, `(${s.size} B)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
