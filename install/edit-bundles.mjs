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
    anchor: 'async executeHostCall(e,t,n,r){return xbo(',
    replacement:
      'async executeHostCall(e,t,n,r){if(t===`worker.invoke`){try{return{ok:!0,value:await this.invokeCommand(e,n.commandId,n.args)}}catch(e){return{ok:!1,code:`action_failed`,error:e instanceof Error?e.message:String(e)}}}return xbo(',
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

  // Ctrl+Shift+S -> open the Secrets panel, the same way built-in sidebar
  // panels (Explorer, Search, Source Control...) get a Mod+Shift+<letter>
  // default. Orca's plugin manifest schema only lets a plugin bind a
  // keybinding to a fixed list of existing built-in actions (none of which
  // reveal an arbitrary plugin's own panel), so this has to be a real
  // keybinding-registry + dispatch-table patch, not a manifest contribution.
  {
    // The renderer's global keydown handler doesn't scan the whole
    // keybindings registry on every keystroke — it only checks the ids in
    // this fixed built-in-action whitelist (imported as `ug`/`S`, the very
    // same list the plugin-manifest validator uses for `commands[].action`).
    // Without this, our registry entry above is visible in Settings and in
    // the dispatch table, but the keydown loop never calls it — Ctrl+Shift+S
    // is silently ignored.
    label: 'renderer plugin-manifest built-in-action list: whitelist plugin.secretsSaver.togglePanel for the global keydown scan',
    file: 'out/renderer/assets',
    match: /^plugin-manifest-.*\.js$/,
    anchor:
      'S=[`worktree.history.back`,`worktree.history.forward`,`sidebar.left.toggle`,`sidebar.sleepingWorkspaces.toggle`,`floatingWorkspace.maximize`,`tab.rename`,`workspace.rename`,`workspace.openBoard`,`view.tasks`,`sidebar.right.toggle`,`sidebar.explorer.toggle`,`sidebar.search.toggle`,`sidebar.sourceControl.toggle`,`sidebar.checks.toggle`,`sidebar.ports.toggle`]',
    replacement:
      'S=[`worktree.history.back`,`worktree.history.forward`,`sidebar.left.toggle`,`sidebar.sleepingWorkspaces.toggle`,`floatingWorkspace.maximize`,`tab.rename`,`workspace.rename`,`workspace.openBoard`,`view.tasks`,`sidebar.right.toggle`,`sidebar.explorer.toggle`,`sidebar.search.toggle`,`sidebar.sourceControl.toggle`,`sidebar.checks.toggle`,`sidebar.ports.toggle`,`plugin.secretsSaver.togglePanel`]',
  },
  {
    label: 'main keybindings registry: register plugin.secretsSaver.togglePanel',
    file: 'out/main/chunks',
    match: /^keybindings-.*\.js$/,
    anchor:
      '{id:`sidebar.explorer.toggle`,title:`Show Explorer`,group:`Global`,scope:`global`,searchKeywords:[`shortcut`,`sidebar`,`explorer`,`files`],defaultBindings:t([`Mod+Shift+E`])}',
    replacement:
      '{id:`sidebar.explorer.toggle`,title:`Show Explorer`,group:`Global`,scope:`global`,searchKeywords:[`shortcut`,`sidebar`,`explorer`,`files`],defaultBindings:t([`Mod+Shift+E`])},{id:`plugin.secretsSaver.togglePanel`,title:`Show Secrets`,group:`Global`,scope:`global`,searchKeywords:[`shortcut`,`sidebar`,`secrets`,`vault`,`env`],defaultBindings:t([`Mod+Shift+S`])}',
  },
  {
    label: 'renderer keybindings registry (Settings list): register plugin.secretsSaver.togglePanel',
    file: 'out/renderer/assets',
    match: /^keybindings-.*\.js$/,
    anchor:
      '{id:`sidebar.explorer.toggle`,title:`Show Explorer`,group:`Global`,scope:`global`,searchKeywords:[`shortcut`,`sidebar`,`explorer`,`files`],defaultBindings:n([`Mod+Shift+E`])}',
    replacement:
      '{id:`sidebar.explorer.toggle`,title:`Show Explorer`,group:`Global`,scope:`global`,searchKeywords:[`shortcut`,`sidebar`,`explorer`,`files`],defaultBindings:n([`Mod+Shift+E`])},{id:`plugin.secretsSaver.togglePanel`,title:`Show Secrets`,group:`Global`,scope:`global`,searchKeywords:[`shortcut`,`sidebar`,`secrets`,`vault`,`env`],defaultBindings:n([`Mod+Shift+S`])}',
  },
  {
    label: 'renderer App dispatch: wire plugin.secretsSaver.togglePanel to the Secrets right-sidebar tab',
    file: 'out/renderer/assets',
    match: /^App-.*\.js$/,
    anchor: '[`sidebar.ports.toggle`,()=>g(`sidebar.ports.toggle`,`ports`)]])}',
    replacement:
      '[`sidebar.ports.toggle`,()=>g(`sidebar.ports.toggle`,`ports`)],[`plugin.secretsSaver.togglePanel`,()=>g(`plugin.secretsSaver.togglePanel`,`plugin:local.secrets-saver/secrets`)]])}',
  },
  {
    label: 'renderer App right-sidebar icons: read the Secrets shortcut label',
    file: 'out/renderer/assets',
    match: /^App-.*\.js$/,
    anchor: 'i=sg(`sidebar.ports.toggle`),a=H(t=>e?t.activeWorktreeId:null)',
    replacement:
      'i=sg(`sidebar.ports.toggle`),y=sg(`plugin.secretsSaver.togglePanel`),a=H(t=>e?t.activeWorktreeId:null)',
  },
  {
    // The generic plugin-panel icon builder (mR) hardcodes shortcut:'' for
    // every plugin tab (built-ins compute theirs via Qm/useShortcutLabel).
    // Override it just for our own tabKey so the sidebar icon's hover
    // tooltip shows "Ctrl+Shift+S" like Explorer/Search/etc. do.
    label: 'renderer App right-sidebar icons: show the Secrets shortcut on hover',
    file: 'out/renderer/assets',
    match: /^App-.*\.js$/,
    anchor: 'cB(f,h)],[r,t,h,f,i,n]);return{visibleItems:',
    replacement:
      'cB(f,h).map(e=>e.id===`plugin:local.secrets-saver/secrets`?{...e,shortcut:y===`Unassigned`?``:y}:e)],[r,t,h,f,i,n,y]);return{visibleItems:',
  },
];

function findFiles(dir, match) {
  const abs = path.join(appDir, dir);
  let names;
  try {
    names = fs.readdirSync(abs);
  } catch {
    return [];
  }
  return names.filter((n) => match.test(n)).map((n) => path.join(abs, n));
}

let applied = 0;
let alreadyPatched = 0;
for (const e of edits) {
  // A glob can match more than one hashed bundle (e.g. two files both
  // starting with `App-`); pick the one that actually carries the anchor
  // (or is already patched), not just the first name alphabetically.
  const candidates = findFiles(e.file, e.match);
  const file =
    candidates.find((f) => {
      const s = fs.readFileSync(f, 'utf8');
      return s.includes(e.anchor) || s.includes(e.replacement);
    }) ?? null;
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
