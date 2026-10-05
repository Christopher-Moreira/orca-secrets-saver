#!/usr/bin/env bash
#
# Simple, robust one-shot: closes Orca, applies the patched app.asar, and logs
# everything to a WORLD-READABLE file so the install can be verified afterwards.
# Runs apply.sh in-process (keeps SUDO_USER, so its node-picker finds a working
# Node), and force-closes Orca if a graceful SIGTERM doesn't take.
#
#   sudo bash install/do-install.sh
#
# After it prints "==== done ok ====", reopen Orca with your normal launcher.
set -uo pipefail

LOG=/tmp/ss-install.log
: > "$LOG"; chmod 644 "$LOG"
exec > >(tee -a "$LOG") 2>&1

HERE="$(cd "$(dirname "$0")" && pwd)"
echo "==== $(date '+%F %T') : do-install ===="
[ "$(id -u)" = "0" ] || { echo "✗ rode com sudo: sudo bash install/do-install.sh"; exit 1; }

# 1. close Orca (graceful, then force if it lingers)
if pgrep -x orca-ide >/dev/null; then
  echo "fechando Orca (SIGTERM)…"
  pkill -TERM -x orca-ide || true
  for i in $(seq 1 20); do pgrep -x orca-ide >/dev/null || break; sleep 0.5; done
  if pgrep -x orca-ide >/dev/null; then
    echo "SIGTERM não encerrou em 10s — forçando (SIGKILL)…"
    pkill -KILL -x orca-ide || true
    sleep 1
  fi
fi
if pgrep -x orca-ide >/dev/null; then echo "✗ Orca ainda está rodando; abortei."; exit 1; fi
echo "Orca fechado."

# 2. apply the patch (same verified installer; in-process so SUDO_USER survives)
if bash "$HERE/apply.sh"; then
  echo "==== done ok ===="
else
  echo "==== done FAIL rc=$? ===="
  exit 1
fi
