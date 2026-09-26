#!/usr/bin/env bash
# Configure the current user's Orca desktop launcher to use the OS Secret Service.
set -euo pipefail

RUN_USER="${ORCA_RUN_USER:-${SUDO_USER:-$(id -un)}}"
USER_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"
if [ -z "$USER_HOME" ] || [ ! -d "$USER_HOME" ]; then
  echo "⚠ não encontrei a pasta pessoal de $RUN_USER; abra o Orca com --password-store=gnome-libsecret." >&2
  exit 0
fi

SYSTEM_ENTRY="${ORCA_DESKTOP_FILE:-/usr/share/applications/stably-orca.desktop}"
USER_ENTRY_DIR="$USER_HOME/.local/share/applications"
USER_ENTRY="$USER_ENTRY_DIR/stably-orca.desktop"
if [ ! -f "$SYSTEM_ENTRY" ] && [ ! -f "$USER_ENTRY" ]; then
  echo "⚠ entrada de desktop do Orca não encontrada; abra o Orca com --password-store=gnome-libsecret." >&2
  exit 0
fi

mkdir -p "$USER_ENTRY_DIR"
if [ ! -e "$USER_ENTRY" ]; then
  cp "$SYSTEM_ENTRY" "$USER_ENTRY"
else
  BACKUP="${USER_ENTRY}.secrets-saver-bak"
  if [ ! -e "$BACKUP" ]; then cp -p "$USER_ENTRY" "$BACKUP"; fi
fi

if ! grep -Fq -- '--password-store=gnome-libsecret' "$USER_ENTRY"; then
  if ! grep -q '^Exec=' "$USER_ENTRY"; then
    echo "⚠ $USER_ENTRY não contém Exec=; não foi alterado." >&2
    exit 0
  fi
  sed -i '/^Exec=/ s|^Exec=\([^ ]*\)|Exec=\1 --password-store=gnome-libsecret|' "$USER_ENTRY"
fi

if [ "$(id -u)" = "0" ]; then chown "$RUN_USER":"$(id -gn "$RUN_USER")" "$USER_ENTRY_DIR" "$USER_ENTRY"; fi
echo "✓ menu do Orca configurado para GNOME libsecret: $USER_ENTRY"
