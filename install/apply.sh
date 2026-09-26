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

node "$HERE/apply-asar.mjs"
bash "$HERE/configure-secret-store-launcher.sh"
echo ""
echo "Agora abra o Orca e ative o plugin (veja install/README.md):"
echo "  1. Settings → Plugins → habilite o sistema de plugins (dev)"
echo "  2. Adicione o dev plugin path:"
echo "       $(cd "$HERE/../orca-plugin/dist" 2>/dev/null && pwd || echo '<repo>/orca-plugin/dist')"
echo "  3. Aprove o consent do 'Secrets Saver' e clique no ícone na sidebar."
echo ""
echo "Reverter a qualquer momento: sudo bash install/revert.sh"
