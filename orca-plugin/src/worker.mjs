import crypto from 'node:crypto';
import { homedir } from 'node:os';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { scanProject, revealLocal, readLocalFile, writeLocalFile } from './scanner.mjs';
import { readOrcaContext } from './orca-context.mjs';

/**
 * Plugin worker (Orca `main` entry). Runs out-of-process as a trusted Node
 * worker: full fs access (used by the scanner + orca-context) plus the host
 * SDK (`ctx.host.call`) for the encrypted secrets store.
 *
 * The sandboxed panel cannot talk to a worker on stock Orca; the local
 * `app.asar` patch adds a `worker.invoke` panel action that routes to the
 * `secrets.rpc` command registered here. Everything the panel needs flows
 * through that one command as { op, ... } → result.
 */

const VAULT_KEY = (id) => `vault:${crypto.createHash('sha256').update(id).digest('hex').slice(0, 32)}`;
// The vault is a single user-wide store, not tied to any repo/worktree.
const GLOBAL_VAULT = '__global__';
const MAX_VALUE = 16 * 1024;
const MAX_NOTE = 4000;
const MAX_NAME = 200;
const MAX_FOLDER = 100;
const LOCAL_PAGE = 200;

const str = (v, max, label, required = false) => {
  if (typeof v !== 'string' || v.length > max || (required && !v.trim())) throw new Error(`${label} inválido.`);
  return v;
};
// Folder is a flat, optional label (not a tag list): '' means "no folder".
const meta = (e) => ({ id: e.id, name: e.name, folder: e.folder || '', note: e.note ? true : false, createdAt: e.createdAt, updatedAt: e.updatedAt });

// --- portable export/import (plaintext JSON — leaves the encrypted store) ---
const EXPORT_TYPE = 'orca-secrets-saver-vault';
const MAX_IMPORT = 10 * 1024 * 1024; // guard against pasting a huge blob

// Only the portable fields travel; id/timestamps are internal and regenerated.
const buildExport = (entries) =>
  JSON.stringify(
    {
      type: EXPORT_TYPE,
      version: 1,
      exportedAt: new Date().toISOString(),
      entries: entries.map((e) => ({ name: e.name, value: e.value, note: e.note || '', folder: e.folder || '' })),
    },
    null,
    2,
  );

// Parse + validate an export document into clean entries; throws on any problem
// so a bad file never half-writes the vault. Validates each field against the
// same limits the editor enforces, and rejects duplicate names within the file.
function parseImport(jsonStr) {
  let data;
  try {
    data = JSON.parse(jsonStr);
  } catch {
    throw new Error('JSON inválido.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('JSON inválido.');
  if (data.type !== EXPORT_TYPE) throw new Error('Este arquivo não é um export do Secrets Saver.');
  if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error('Versão de export não suportada.');
  const seen = new Set();
  return data.entries.map((raw, i) => {
    const at = `entrada ${i + 1}`;
    if (!raw || typeof raw !== 'object') throw new Error(`Entrada inválida (${at}).`);
    const name = str(raw.name, MAX_NAME, `Nome (${at})`, true).trim();
    const value = str(raw.value, MAX_VALUE, `Valor (${at})`, true);
    const note = raw.note != null ? str(raw.note, MAX_NOTE, `Anotação (${at})`) : '';
    const folder = raw.folder != null ? str(raw.folder, MAX_FOLDER, `Pasta (${at})`).trim() : '';
    if (seen.has(name)) throw new Error(`Nome duplicado no arquivo: "${name}".`);
    seen.add(name);
    return { name, value, note, folder };
  });
}

export default async function activate(ctx) {
  const host = ctx.host;

  // --- project resolution (fresh each call so it tracks the active project) ---
  async function resolveWorktree(worktreeId) {
    const context = await readOrcaContext();
    const wt =
      context.worktrees.find((w) => w.id === worktreeId) ||
      (worktreeId == null ? context.worktrees.find((w) => w.active) : null);
    if (!wt) throw new Error('Projeto não está mais aberto no Orca. Atualize a lista.');
    return wt;
  }

  // --- encrypted vault, backed by Orca's per-plugin secrets store ---
  function errorText(error) {
    if (typeof error === 'string') return error;
    if (error instanceof Error && error.message) return error.message;
    if (error && typeof error.message === 'string') return error.message;
    if (error && typeof error.error === 'string') return error.error;
    if (error && typeof error.code === 'string') return error.code;
    return '';
  }

  function explainSecretsError(error) {
    const message = errorText(error);
    if (!message) return 'O Orca não retornou uma resposta válida do cofre criptografado. Atualize o Orca e tente novamente.';
    if (message.includes('OS-backed encryption is unavailable')) {
      return 'A criptografia do sistema operacional não está disponível para o Orca. Nenhum secret foi salvo. Ative e desbloqueie o cofre de senhas do sistema na mesma sessão gráfica e reinicie o Orca.';
    }
    if (message.includes('internal: malformed secrets.set result') || message.includes('internal: malformed secrets.get result')) {
      return 'O Orca rejeitou o formato de erro da API de secrets. Reaplique o patch local do Secrets Saver e reinicie o Orca.';
    }
    return `Falha no cofre criptografado do Orca: ${message}`;
  }

  async function callSecrets(method, params) {
    let response;
    try {
      response = await host.call(method, params);
    } catch (e) {
      throw new Error(explainSecretsError(e));
    }
    // Some Orca builds return the host-call envelope; others expose the
    // validated method value directly. Normalize both without touching data.
    if (response && response.ok === false) throw new Error(explainSecretsError(response.error || response.code || response));
    if (response && response.ok === true && Object.hasOwn(response, 'value')) return response.value;
    return response;
  }

  async function loadVault(projectId) {
    const res = await callSecrets('secrets.get', { key: VAULT_KEY(projectId) });
    if (!res || typeof res !== 'object' || !Object.hasOwn(res, 'value')) throw new Error(explainSecretsError('resposta inválida de secrets.get'));
    if (!res || res.value == null) return [];
    try {
      const data = JSON.parse(res.value);
      if (data.version !== 1 || !Array.isArray(data.entries)) throw new Error();
      return data.entries;
    } catch {
      throw new Error('Cofre corrompido para este projeto. Os dados não foram alterados.');
    }
  }
  async function saveVault(projectId, entries) {
    const payload = JSON.stringify({ version: 1, entries });
    if (Buffer.byteLength(payload) > 60 * 1024) throw new Error('Limite do cofre deste projeto atingido (~60 KB).');
    const res = await callSecrets('secrets.set', { key: VAULT_KEY(projectId), value: payload });
    if (!res || res.ok !== true) throw new Error(explainSecretsError(res?.error || 'resposta inválida de secrets.set'));
  }

  // --- RPC dispatch ---
  async function rpc(params) {
    if (!params || typeof params !== 'object' || typeof params.op !== 'string') throw new Error('Operação inválida.');
    const op = params.op;

    if (op === 'projects') {
      const c = await readOrcaContext();
      return {
        activeProjectId: c.activeProjectId,
        projects: c.worktrees.map((w) => ({ id: w.id, projectId: w.projectId, name: w.name, path: w.path, active: w.active })),
        locale: c.locale,
        diagnostic: c.diagnostic,
        unavailable: c.unavailable === true,
      };
    }

    // Local ops are per-project (need a worktree path).
    if (op.startsWith('local.')) {
      const wt = await resolveWorktree(params.worktreeId);
      if (op === 'local.list') {
        const result = await scanProject(wt.path);
        const offset = Number.isSafeInteger(params.offset) && params.offset >= 0 ? params.offset : 0;
        return {
          entries: result.entries.slice(offset, offset + LOCAL_PAGE),
          files: result.files,
          total: result.entries.length,
          issues: result.issues,
          limited: result.limited,
          nextOffset: offset + LOCAL_PAGE < result.entries.length ? offset + LOCAL_PAGE : null,
        };
      }
      if (op === 'local.file.read') {
        const file = str(params.file, 1024, 'Arquivo', true);
        return { file, content: await readLocalFile(wt.path, file) };
      }
      if (op === 'local.file.write') {
        const file = str(params.file, 1024, 'Arquivo', true);
        const content = str(params.content, 256 * 1024, 'Conteúdo');
        await writeLocalFile(wt.path, file, content);
        return { saved: true, file };
      }
      if (op === 'local.reveal') {
        const result = await scanProject(wt.path);
        const entry = result.entries.find((e) => e.id === params.id);
        if (!entry) throw new Error('Variável não encontrada. Atualize a lista.');
        return { value: await revealLocal(wt.path, entry) };
      }
    }

    // Vault is a SINGLE user-wide store, independent of projects/repos.
    if (op.startsWith('vault.')) {
      if (op === 'vault.list') {
        return { entries: (await loadVault(GLOBAL_VAULT)).map(meta) };
      }
      if (op === 'vault.reveal') {
        const entry = (await loadVault(GLOBAL_VAULT)).find((e) => e.id === params.id);
        if (!entry) throw new Error('Secret não encontrado.');
        return { value: entry.value, note: entry.note || '' };
      }
      if (op === 'vault.create' || op === 'vault.update') {
        const isCreate = op === 'vault.create';
        const entries = await loadVault(GLOBAL_VAULT);
        const old = isCreate ? null : entries.find((e) => e.id === params.id);
        if (!isCreate && !old) throw new Error('Secret não encontrado.');
        // On update, unspecified fields keep their previous value.
        const name = params.name != null ? str(params.name, MAX_NAME, 'Nome', true).trim() : old.name;
        const value =
          params.value != null ? str(params.value, MAX_VALUE, 'Valor', true) : isCreate ? str(undefined, MAX_VALUE, 'Valor', true) : old.value;
        const note = params.note != null ? str(params.note, MAX_NOTE, 'Anotação') : old ? old.note : '';
        const folder = params.folder != null ? str(params.folder, MAX_FOLDER, 'Pasta').trim() : old ? old.folder || '' : '';
        if (entries.some((e) => e.name === name && e.id !== old?.id)) throw new Error('Já existe um secret com esse nome.');
        if (!old && entries.length >= 500) throw new Error('Limite de 500 secrets no cofre.');
        const now = new Date().toISOString();
        const entry = { id: old?.id || crypto.randomUUID(), name, value, note, folder, createdAt: old?.createdAt || now, updatedAt: now };
        await saveVault(GLOBAL_VAULT, old ? entries.map((e) => (e.id === old.id ? entry : e)) : [...entries, entry]);
        return { entry: meta(entry) };
      }
      if (op === 'vault.export') {
        const entries = await loadVault(GLOBAL_VAULT);
        return { json: buildExport(entries), count: entries.length };
      }
      if (op === 'vault.exportFile') {
        const entries = await loadVault(GLOBAL_VAULT);
        if (!entries.length) throw new Error('O cofre está vazio. Nada para exportar.');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const file = path.join(homedir(), `orca-vault-export-${stamp}.json`);
        // 0o600: plaintext secrets on disk — restrict to the owner.
        await writeFile(file, buildExport(entries), { encoding: 'utf8', mode: 0o600 });
        return { path: file, count: entries.length };
      }
      if (op === 'vault.import') {
        const mode = params.mode === 'overwrite' || params.mode === 'replace' ? params.mode : 'skip';
        const incoming = parseImport(str(params.json, MAX_IMPORT, 'JSON', true));
        const now = new Date().toISOString();
        const fresh = (e) => ({ id: crypto.randomUUID(), name: e.name, value: e.value, note: e.note, folder: e.folder, createdAt: now, updatedAt: now });
        let result;
        let summary;
        if (mode === 'replace') {
          result = incoming.map(fresh);
          summary = { imported: result.length, updated: 0, skipped: 0 };
        } else {
          const byName = new Map((await loadVault(GLOBAL_VAULT)).map((e) => [e.name, e]));
          let imported = 0, updated = 0, skipped = 0;
          for (const e of incoming) {
            const old = byName.get(e.name);
            if (!old) {
              byName.set(e.name, fresh(e));
              imported++;
            } else if (mode === 'overwrite') {
              byName.set(e.name, { ...old, value: e.value, note: e.note, folder: e.folder, updatedAt: now });
              updated++;
            } else {
              skipped++;
            }
          }
          result = Array.from(byName.values());
          summary = { imported, updated, skipped };
        }
        if (result.length > 500) throw new Error('A importação excederia o limite de 500 secrets no cofre.');
        await saveVault(GLOBAL_VAULT, result); // also enforces the ~60 KB cap
        return summary;
      }
      if (op === 'vault.delete') {
        const entries = await loadVault(GLOBAL_VAULT);
        if (!entries.some((e) => e.id === params.id)) throw new Error('Secret não encontrado.');
        await saveVault(GLOBAL_VAULT, entries.filter((e) => e.id !== params.id));
        return { deleted: true };
      }
    }

    throw new Error('Operação não suportada.');
  }

  // Single command the patched panel bridge invokes. Errors are returned as
  // { ok:false, error } so the panel can render a message instead of throwing.
  ctx.commands.register('secrets.rpc', async (args) => {
    try {
      return { ok: true, data: await rpc(args || {}) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : 'erro interno' };
    }
  });

  ctx.log('secrets-saver worker ready');
}
