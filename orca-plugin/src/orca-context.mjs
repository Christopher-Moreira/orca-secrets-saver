import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import settings from '../settings.json' with { type: 'json' };

/**
 * Reads Orca's own workspace-state JSON to learn the open projects and which
 * one is active. This is Orca's private state (like VSCode's storage.json),
 * NOT a documented plugin API — it carries a `schemaVersion` and can change
 * across Orca versions, so every read is defensive and failure is non-fatal.
 *
 *   ~/.config/orca/profiles/<profile>/orca-data.json
 *     repos:            [{ id, displayName, path }]
 *     worktreeMeta:     { "<worktreeId>::<path>": { projectId, displayName } }
 *     workspaceSession: { activeRepoId, activeWorktreeId }
 */

function profilesDirs() {
  const homeConfig = path.join(os.homedir(), '.config');
  const configRoots = new Set([process.env.XDG_CONFIG_HOME, homeConfig].filter(Boolean));
  return [...configRoots].map((root) => path.join(root, 'orca', 'profiles'));
}

/** Newest orca-data.json across supported config roots and profiles. */
async function findDataFile() {
  const candidates = [];
  for (const base of profilesDirs()) {
    let profiles;
    try {
      profiles = await fs.readdir(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of profiles) {
      if (!ent.isDirectory()) continue;
      const file = path.join(base, ent.name, 'orca-data.json');
      try {
        const stat = await fs.stat(file);
        candidates.push({ file, mtime: stat.mtimeMs });
      } catch {
        /* no data file in this profile */
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.file ?? null;
}

function pathFromWorktreeKey(key) {
  const idx = key.indexOf('::');
  return idx < 0 ? null : key.slice(idx + 2);
}

/**
 * Returns { worktrees, repos, activeWorktreeId, activeProjectId } or an empty
 * shell if Orca's state can't be read. `worktrees` are the scannable units
 * (each maps to a real directory); `projectId` is stable across a repo's
 * worktrees so a vault stays with the project.
 */
// The plugin UI language follows Orca's. `settings.uiLanguage` is a code
// (e.g. "pt-BR") or "system" → fall back to the OS locale. We normalize to the
// languages the panel ships (pt / es / en).
function resolveLocale(uiLanguage) {
  if (!settings.followOrcaLanguage) return settings.language;
  let code = typeof uiLanguage === 'string' && uiLanguage && uiLanguage !== 'system' ? uiLanguage : '';
  if (!code) {
    const env = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || process.env.LANGUAGE || '';
    code = env.split(/[:.]/)[0].replace('_', '-');
  }
  const lc = code.toLowerCase();
  if (lc.startsWith('pt')) return 'pt';
  if (lc.startsWith('es')) return 'es';
  return 'en';
}

export async function readOrcaContext() {
  const empty = { worktrees: [], repos: [], activeWorktreeId: null, activeProjectId: null, locale: resolveLocale(null), diagnostic: null };
  const file = await findDataFile();
  if (!file) return { ...empty, diagnostic: 'Não encontrei o arquivo de estado do Orca nos perfis de configuração.' };

  let data;
  try {
    data = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    const detail = error?.code === 'EACCES' ? 'sem permissão para ler' : 'JSON ausente ou inválido';
    return { ...empty, diagnostic: `Não consegui ler o estado do Orca (${detail}).` };
  }
  const locale = resolveLocale(data.settings && data.settings.uiLanguage);

  const repos = Array.isArray(data.repos)
    ? data.repos
        .filter((r) => r && typeof r.path === 'string' && typeof r.id === 'string')
        .map((r) => ({ id: r.id, name: r.displayName || path.basename(r.path), path: r.path }))
    : [];

  const session = data.workspaceSession || {};
  const activeWorktreeId = typeof session.activeWorktreeId === 'string' ? session.activeWorktreeId : null;
  const activeRepoId = typeof session.activeRepoId === 'string' ? session.activeRepoId : null;

  const worktrees = [];
  const meta = data.worktreeMeta;
  if (meta && typeof meta === 'object') {
    for (const [key, value] of Object.entries(meta)) {
      const wtPath = pathFromWorktreeKey(key);
      if (!wtPath || typeof wtPath !== 'string' || !path.isAbsolute(wtPath)) continue;
      const projectId = (value && typeof value.projectId === 'string' && value.projectId) || key;
      worktrees.push({
        id: key,
        projectId,
        name: (value && value.displayName) || path.basename(wtPath),
        path: wtPath,
        active: key === activeWorktreeId,
      });
    }
  }

  // Fall back to repos as scannable units if worktreeMeta is empty.
  if (worktrees.length === 0 && repos.length > 0) {
    for (const r of repos) {
      worktrees.push({ id: r.id, projectId: r.id, name: r.name, path: r.path, active: r.id === activeRepoId });
    }
  }

  worktrees.sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || a.name.localeCompare(b.name));

  const activeProjectId = worktrees.find((w) => w.active)?.projectId ?? null;
  return {
    worktrees,
    repos,
    activeWorktreeId,
    activeProjectId,
    locale,
    diagnostic: worktrees.length === 0
      ? `Estado lido, mas não encontrei worktrees válidos (repos: ${repos.length}, metadados: ${Object.keys(meta || {}).length}).`
      : null,
  };
}
