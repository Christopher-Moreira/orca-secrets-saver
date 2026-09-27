#!/usr/bin/env bash
#
# One-shot installer: closes Orca, applies the patched app.asar (with backup),
# then relaunches Orca. Survives Orca's shutdown (re-execs itself detached).
#
#   sudo bash install/close-apply-reopen.sh
#
set -euo pipefail

ORCA_RES="${ORCA_RES:-/opt/stably-orca/resources}"
HERE="$(cd "$(dirname "$0")" && pwd)"
PATCHED="$HERE/build/app.asar"
TARGET="$ORCA_RES/app.asar"
BACKUP="$ORCA_RES/app.asar.orca-secrets-bak"

# Private workdir for the log + the cmdline/environ snapshots (which can carry
# tokens/secrets from the running session). mktemp -d is atomic and creates the
# directory mode 0700 regardless of umask, unlike the old fixed /tmp names
# below — those let any local user pre-plant a symlink at a predictable path
# (LOG) or read another user's copied environment (CMDLINE_FILE/ENVIRON_FILE,
# named only by PID, world-readable under the default umask). Reused across
# the detached re-exec via SS_WORKDIR so both phases agree on one directory.
WORKDIR="${SS_WORKDIR:-}"
if [ -z "$WORKDIR" ]; then
  WORKDIR="$(mktemp -d /tmp/orca-secrets-saver.XXXXXX)"
fi
LOG="$WORKDIR/apply.log"

[ "$(id -u)" = "0" ] || { echo "✗ execute com sudo ou autorização do sistema: bash install/close-apply-reopen.sh" >&2; exit 1; }
[ -f "$PATCHED" ] || { echo "✗ falta $PATCHED — rode antes: bash install/build-patched-asar.sh" >&2; exit 1; }
[ -f "$TARGET" ]  || { echo "✗ não achei $TARGET" >&2; exit 1; }

# --- capture the running Orca so we can relaunch it exactly ---
# The GUI main process is an orca-ide whose cmdline has NEITHER the daemon
# entry NOR a --type= flag (those are the daemon and the renderer/gpu children).
# Relaunching the daemon cmdline instead crashes the app (core dump).
find_main() {
  local p cmd
  for p in $(pgrep -x orca-ide); do
    cmd="$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null || true)"
    case "$cmd" in
      *daemon-entry*) continue ;;
      *--type=*) continue ;;
    esac
    echo "$p"; return 0
  done
  echo ""
}

RUN_USER="${ORCA_RUN_USER:-${SUDO_USER:-$(logname 2>/dev/null || echo "")}}"
MAIN_PID="$(find_main || true)"

CMDLINE_FILE=""; ENVIRON_FILE=""
if [ -n "$MAIN_PID" ] && [ -r "/proc/$MAIN_PID/cmdline" ]; then
  CMDLINE_FILE="$WORKDIR/cmdline"; cp "/proc/$MAIN_PID/cmdline" "$CMDLINE_FILE"
  ENVIRON_FILE="$WORKDIR/environ"; cp "/proc/$MAIN_PID/environ" "$ENVIRON_FILE" 2>/dev/null || ENVIRON_FILE=""
fi
if [ -z "$ENVIRON_FILE" ] && [ -n "$RUN_USER" ]; then
  # If Orca is already closed, recover the graphical session environment from
  # Hyprland so the relaunch creates a visible window via the compositor.
  RUN_UID="$(id -u "$RUN_USER")"
  COMPOSITOR_PID="$(pgrep -u "$RUN_UID" -x Hyprland | head -1 || true)"
  if [ -z "$COMPOSITOR_PID" ]; then COMPOSITOR_PID="$(pgrep -u "$RUN_UID" -x hyprland | head -1 || true)"; fi
  if [ -n "$COMPOSITOR_PID" ] && [ -r "/proc/$COMPOSITOR_PID/environ" ]; then
    ENVIRON_FILE="$WORKDIR/environ"
    cp "/proc/$COMPOSITOR_PID/environ" "$ENVIRON_FILE"
  fi
fi

# --- re-exec detached so we outlive Orca (and any shell tied to it) ---
if [ "${_SS_DETACHED:-}" != "1" ]; then
  echo "▸ destacando o instalador (log: $LOG) — o Orca vai fechar e reabrir sozinho…"
  _SS_DETACHED=1 RUN_USER="$RUN_USER" CMDLINE_FILE="$CMDLINE_FILE" ENVIRON_FILE="$ENVIRON_FILE" SS_WORKDIR="$WORKDIR" \
    setsid bash "$0" </dev/null >>"$LOG" 2>&1 &
  disown || true
  echo "✓ iniciado. Acompanhe: tail -f $LOG"
  exit 0
fi

# ============ detached section ============
exec >>"$LOG" 2>&1
echo "==== $(date) : instalando patch ===="

# 1. close Orca gracefully, then force if needed
if [ -n "$(pgrep -x orca-ide || true)" ]; then
  echo "fechando Orca (SIGTERM)…"
  pkill -TERM -x orca-ide || true
  for i in $(seq 1 20); do pgrep -x orca-ide >/dev/null || break; sleep 0.5; done
  if pgrep -x orca-ide >/dev/null; then echo "⚠ Orca não encerrou em 10 segundos; não forcei o fechamento."; exit 1; fi
fi
echo "Orca fechado."

# Use the same verified installer as the normal installation path.
bash "$HERE/apply.sh"

# 3. relaunch Orca as the user, with its original env + cmdline
relaunch() {
  [ -n "$RUN_USER" ] || { echo "sem RUN_USER, não relanço"; return 1; }
  local -a cmd=() envs=()
  if [ -n "${CMDLINE_FILE:-}" ] && [ -r "$CMDLINE_FILE" ]; then mapfile -d '' cmd < "$CMDLINE_FILE"; fi
  [ "${#cmd[@]}" -gt 0 ] || cmd=(/opt/stably-orca/orca-ide)
  # Ensure this restart uses libsecret even when Orca was launched directly.
  local -a relaunch_cmd=("${cmd[0]}" --password-store=gnome-libsecret)
  local skip_password_store_value=0 arg
  for arg in "${cmd[@]:1}"; do
    if [ "$skip_password_store_value" = 1 ]; then skip_password_store_value=0; continue; fi
    case "$arg" in
      --password-store) skip_password_store_value=1 ;;
      --password-store=*) ;;
      *) relaunch_cmd+=("$arg") ;;
    esac
  done
  cmd=("${relaunch_cmd[@]}")
  if [ -n "${ENVIRON_FILE:-}" ] && [ -r "$ENVIRON_FILE" ]; then
    mapfile -d '' envs < "$ENVIRON_FILE"
  fi
  echo "relançando: ${cmd[*]} (user=$RUN_USER)"
  if [ "${#envs[@]}" -gt 0 ]; then
    if [[ "$(printf '%s\n' "${envs[@]}")" == *"XDG_CURRENT_DESKTOP=Hyprland"* ]] && command -v hyprctl >/dev/null 2>&1; then
      # Launch from the compositor so the app attaches to the visible Wayland session.
      setsid -f runuser -u "$RUN_USER" -- env -i "${envs[@]}" hyprctl dispatch exec '/usr/bin/stably-orca --password-store=gnome-libsecret' || return 1
      return 0
    fi
    setsid -f runuser -u "$RUN_USER" -- env -i "${envs[@]}" "${cmd[@]}" || return 1
  else
    setsid -f runuser -u "$RUN_USER" -- "${cmd[@]}" || return 1
  fi
}
sleep 1
if relaunch; then echo "Orca relançado ✓"; else echo "⚠ não consegui relançar — abra o Orca manualmente (o patch já está aplicado)."; fi

for temp_file in "$CMDLINE_FILE" "$ENVIRON_FILE"; do
  [ -n "$temp_file" ] && rm -f -- "$temp_file"
done
echo "log preservado em: $LOG"
echo "==== concluído ===="
