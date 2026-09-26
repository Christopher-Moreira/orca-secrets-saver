#!/usr/bin/env bash
#
# Restores the original, un-patched Orca app.asar from the backup.
#
#   sudo bash install/revert.sh
#
set -euo pipefail

ORCA_RES="${ORCA_RES:-/opt/stably-orca/resources}"
TARGET="$ORCA_RES/app.asar"
BACKUP="$ORCA_RES/app.asar.orca-secrets-bak"

[ "$(id -u)" = "0" ] || { echo "✗ rode com sudo: sudo bash install/revert.sh" >&2; exit 1; }
[ -f "$BACKUP" ] || { echo "✗ sem backup em $BACKUP — nada para reverter" >&2; exit 1; }

if pgrep -x orca-ide >/dev/null 2>&1; then
  echo "⚠ Feche o Orca antes de reverter (ele trava o app.asar)." >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
node "$HERE/apply-asar.mjs" --revert
