import fs from 'node:fs';
import path from 'node:path';

/**
 * Applies the `worker.invoke` panel-bridge patch to an EXTRACTED Orca app tree.
 * Usage: node edit-bundles.mjs <extracted-app-dir>
 *
 * Idempotent: if a file already contains the patched form it's skipped. Fails
 * loudly if an expected anchor is missing (Orca version drift) so we never ship
 * a half-applied patch.
 */

const appDir = process.argv[2];
if (!appDir) {
  console.error('uso: node edit-bundles.mjs <extracted-app-dir>');
  process.exit(2);
}

const WORKER_INVOKE = 'worker.invoke';

// Each edit: file glob, the exact anchor, its replacement, and a marker that
// means "already patched".
const edits = [
  {
    label: 'renderer panel-action gate (isPluginPanelAction)',
    file: 'out/renderer/assets',
    match: /^PluginPanel-.*\.js$/,
    anchor: 'function U(e){return H.includes(e)}',
    replacement: 'function U(e){return H.includes(e)||e===`worker.invoke`}',
  },
  {
    label: 'main executeHostCall guard -> invokeCommand',
    file: 'out/main',
    match: /^index\.js$/,
    anchor: 'async executeHostCall(e,t,n,r){return gNa(',
    replacement:
      'async executeHostCall(e,t,n,r){if(t===`worker.invoke`){try{return{ok:!0,value:await this.invokeCommand(e,n.commandId,n.args)}}catch(e){return{ok:!1,code:`action_failed`,error:e instanceof Error?e.message:String(e)}}}return gNa(',
  },
  {
    label: 'shared isPluginPanelAction (worker-SDK path)',
    file: 'out/shared/plugins',
    match: /^plugin-host-api\.js$/,
    anchor: 'return exports.PLUGIN_PANEL_ACTIONS.includes(action);',
    replacement: "return exports.PLUGIN_PANEL_ACTIONS.includes(action) || action === 'worker.invoke';",
    optional: true,
  },
  // NOTE: earlier builds also rewrote the secrets.get/set result schemas
  // (DCr/kCr) into zod unions to "preserve host errors". That CRASHED Orca on
  // boot — those schemas feed a ZodDiscriminatedUnion that requires object
  // members, not unions (fatal: new ZodDiscriminatedUnion ... reading 'length').
  // The happy path (keyring available) validates fine with the originals, so
  // those 4 patches were removed. Only the worker.invoke bridge is needed.
];

function findFile(dir, match) {
  const abs = path.join(appDir, dir);
  let names;
  try {
    names = fs.readdirSync(abs);
  } catch {
    return null;
  }
  const name = names.find((n) => match.test(n));
  return name ? path.join(abs, name) : null;
}

let applied = 0;
let alreadyPatched = 0;
for (const e of edits) {
  const file = findFile(e.file, e.match);
  if (!file) {
    if (e.optional) {
      console.warn(`~ pulei (arquivo não encontrado, opcional): ${e.label}`);
      continue;
    }
    console.error(`✗ arquivo não encontrado para: ${e.label} (${e.file}/${e.match})`);
    process.exit(1);
  }
  let src = fs.readFileSync(file, 'utf8');
  if (src.includes(e.replacement)) {
    console.log(`= já aplicado: ${e.label}`);
    alreadyPatched++;
    continue;
  }
  const idx = src.indexOf(e.anchor);
  if (idx < 0) {
    console.error(`✗ âncora ausente em ${path.relative(appDir, file)} para: ${e.label}`);
    console.error('  (a versão do Orca pode ter mudado — patch abortado)');
    process.exit(1);
  }
  if (src.indexOf(e.anchor, idx + e.anchor.length) >= 0) {
    console.error(`✗ âncora AMBÍGUA (aparece 2x) para: ${e.label} — abortado por segurança`);
    process.exit(1);
  }
  src = src.replace(e.anchor, e.replacement);
  fs.writeFileSync(file, src);
  console.log(`✓ aplicado: ${e.label}  [${path.relative(appDir, file)}]`);
  applied++;
}

console.log(`\nresumo: ${applied} aplicado(s), ${alreadyPatched} já estava(m), verificando '${WORKER_INVOKE}'…`);
process.exit(0);
