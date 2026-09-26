#!/usr/bin/env bash
# Run as your desktop user; sudo is used only to replace Orca's archive.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
MODE="${1:---install}"
case "$MODE" in
  --help|-h)
    echo 'Usage: bash install.sh [--install|--prepare|--uninstall]'
    echo 'Linux only. Close Orca before install/uninstall. ORCA_RES overrides its resources directory.'
    exit 0 ;;
  --install|--prepare|--uninstall) ;;
  *) echo "Unknown option: $MODE" >&2; exit 2 ;;
esac
[[ "$(uname -s)" == Linux ]] || { echo 'This installer currently supports Linux only.' >&2; exit 1; }
[[ "$(id -u)" != 0 ]] || { echo 'Run without sudo; the installer requests it when needed.' >&2; exit 1; }
for tool in node npm; do command -v "$tool" >/dev/null || { echo "Missing: $tool" >&2; exit 1; }; done
node -e 'const [a,b]=process.versions.node.split(".").map(Number); if(a<22||(a===22&&b<12)){console.error("Node >=22.12 is required");process.exit(1)}'
if [[ "$MODE" != --prepare ]] && pgrep -x orca-ide >/dev/null; then
  echo 'Close Orca and run this command from an external terminal.' >&2; exit 1
fi
ORCA_RES="${ORCA_RES:-/opt/stably-orca/resources}"
export ORCA_RES
[[ -f "$ORCA_RES/app.asar" ]] || { echo "Orca archive not found: $ORCA_RES/app.asar" >&2; exit 1; }
npm ci --prefix "$ROOT/install" --no-audit --no-fund
if [[ "$MODE" == --uninstall ]]; then
  sudo env "ORCA_RES=$ORCA_RES" "PATH=$PATH" bash "$ROOT/install/revert.sh"
  exit 0
fi
npm ci --prefix "$ROOT/orca-plugin" --no-audit --no-fund
npm run build --prefix "$ROOT/orca-plugin"
bash "$ROOT/install/build-patched-asar.sh"
if [[ "$MODE" == --prepare ]]; then
  echo 'Prepared. Close Orca, then run: sudo bash install/apply.sh'
else
  sudo env "ORCA_RES=$ORCA_RES" "PATH=$PATH" bash "$ROOT/install/apply.sh"
fi
