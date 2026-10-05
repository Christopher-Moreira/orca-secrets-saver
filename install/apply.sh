#!/usr/bin/env bash
#
# Installs the patched app.asar into the Orca install. REQUIRES sudo/root
# (writes to /opt). Makes a one-time backup and is safe to re-run.
#
#   sudo bash install/apply.sh
#
set -euo pipefail

ORCA_RES="${ORCA_RES:-/opt/stably-orca/resources}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PATCHED="$HERE/build/app.asar"
TARGET="$ORCA_RES/app.asar"
BACKUP="$ORCA_RES/app.asar.orca-secrets-bak"

[ "$(id -u)" = "0" ] || { echo "✗ rode com sudo: sudo bash install/apply.sh" >&2; exit 1; }
[ -f "$PATCHED" ] || { echo "✗ falta $PATCHED — rode antes: bash install/build-patched-asar.sh" >&2; exit 1; }
[ -f "$TARGET" ]  || { echo "✗ não achei $TARGET" >&2; exit 1; }

if pgrep -x orca-ide >/dev/null 2>&1; then
  echo "⚠ O Orca parece estar ABERTO. Feche-o antes de continuar (ele trava o app.asar)." >&2
  echo "  (Ctrl-C para cancelar, ou feche o Orca e rode de novo.)" >&2
  exit 1
fi

# Pick a Node that actually runs. Under sudo the PATH is often reset to
# secure_path, which can select a /usr/bin/node that is newer than the system
# glibc (partial rolling-release update) and fails to load. Prefer a runnable
# node from PATH, else the newest runnable one under the invoking user's home.
pick_node() {
  local c run_home="${SUDO_USER:+/home/$SUDO_USER}"; run_home="${run_home:-$HOME}"
  for c in "${SS_NODE:-}" "$(command -v node 2>/dev/null || true)"; do
    [ -n "$c" ] && "$c" -e 'process.exit(0)' >/dev/null 2>&1 && { printf '%s\n' "$c"; return 0; }
  done
  for c in "$run_home"/.local/share/mise/installs/node/*/bin/node \
           "$run_home"/.nvm/versions/node/*/bin/node \
           /usr/local/bin/node; do
    [ -x "$c" ] && "$c" -e 'process.exit(0)' >/dev/null 2>&1 && { printf '%s\n' "$c"; return 0; }
  done
  return 1
}
NODE_BIN="$(pick_node || true)"
[ -n "$NODE_BIN" ] || { echo "✗ nenhum Node funcional encontrado (o node do PATH pode exigir uma glibc mais nova que a instalada). Defina SS_NODE=/caminho/para/node e tente de novo." >&2; exit 1; }
echo "• usando node: $NODE_BIN"
"$NODE_BIN" "$HERE/apply-asar.mjs"
bash "$HERE/configure-secret-store-launcher.sh"
echo ""
echo "Agora abra o Orca e ative o plugin (veja install/README.md):"
echo "  1. Settings → Plugins → habilite o sistema de plugins (dev)"
echo "  2. Adicione o dev plugin path:"
echo "       $(cd "$HERE/../orca-plugin/dist" 2>/dev/null && pwd || echo '<repo>/orca-plugin/dist')"
echo "  3. Aprove o consent do 'Secrets Saver' e clique no ícone na sidebar."
echo ""
echo "Reverter a qualquer momento: sudo bash install/revert.sh"
