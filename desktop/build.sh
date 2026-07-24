#!/usr/bin/env bash
# Verlaut Desktop (Windows) — baut eine herunterladbare Electron-App.
#
#   ./build.sh "https://<hostname>.<tailnet>.ts.net:8444"  [win32|linux|darwin]
#
# Erzeugt out/Verlaut-<plat>-x64/ und verlaut-<plat>.zip. Kein Installer, kein
# Store: entpacken und Verlaut(.exe) starten. Nur Node.js nötig; Electron +
# Packager werden lokal installiert, die Plattform-Binaries geladen.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SERVER_URL="${1:-${VERLAUT_URL:-@@SERVER_URL@@}}"
PLATFORM="${2:-win32}"
cd "$HERE"

echo "SERVER_URL=$SERVER_URL  PLATFORM=$PLATFORM"

# Große Downloads/Artefakte lokal cachen (nicht global).
export ELECTRON_CACHE="$HERE/.electron-cache"
export electron_config_cache="$HERE/.electron-cache"
export npm_config_cache="$HERE/.npm"
mkdir -p "$ELECTRON_CACHE"

# Server-URL in eine Arbeitskopie einsetzen.
sed "s|@@SERVER_URL@@|$SERVER_URL|g" main.js > main.built.js
cp -f package.json package.build.json

# Electron + Packager lokal installieren (exFAT-freundlich: --no-bin-links).
npm install --no-bin-links --no-fund --no-audit electron @electron/packager

EV="$(node -e "console.log(require('./node_modules/electron/package.json').version)")"
echo "electron $EV"

# Nur main.built.js als Einstieg verwenden.
node - <<NODE
const fs=require('fs');const p=require('./package.json');p.main='main.built.js';
fs.writeFileSync('package.json',JSON.stringify(p,null,2));
NODE

node ./node_modules/@electron/packager/bin/electron-packager.mjs \
  . Verlaut --platform="$PLATFORM" --arch=x64 --out="$HERE/out" \
  --overwrite --app-version=0.2.0 --electron-version="$EV"

# package.json zurücksetzen.
mv -f package.build.json package.json
rm -f main.built.js

APPDIR="Verlaut-${PLATFORM}-x64"
python3 - "$HERE/out" "$APPDIR" "$HERE/verlaut-${PLATFORM}.zip" <<'PY'
import shutil, sys
out, appdir, dest = sys.argv[1], sys.argv[2], sys.argv[3]
shutil.make_archive(dest[:-4], 'zip', root_dir=out, base_dir=appdir)
print("ZIP:", dest)
PY
echo "Fertig: $HERE/verlaut-${PLATFORM}.zip"
