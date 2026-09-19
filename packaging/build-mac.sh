#!/usr/bin/env bash
# Orion Social — macOS desktop launcher (Intel + Apple Silicon)
# Requires macOS with Node.js 18+

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCHER="$ROOT/packaging/launcher"
OUT="$ROOT/packaging/output"

echo ""
echo " ============================================================"
echo "  ORION SOCIAL  —  BUILD macOS DESKTOP"
echo " ============================================================"
echo ""
echo " Output:"
echo "   $OUT/OrionSocial-mac-x64    (Intel)"
echo "   $OUT/OrionSocial-mac-arm64  (Apple Silicon)"
echo ""

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: Mac binaries must be built on macOS."
  echo "On Windows, run packaging/build-mac.bat to stage www, then copy to a Mac."
  exit 1
fi

command -v node >/dev/null || { echo "ERROR: Node.js not found"; exit 1; }

if [[ ! -f "$ROOT/web/.env" ]]; then
  echo "WARN: web/.env missing — copy web/.env.example and add Supabase keys."
fi

echo " [1/4] Installing web dependencies..."
npm install --prefix "$ROOT/web" --no-audit

echo ""
echo " [2/4] Building web app..."
npm run build --prefix "$ROOT/web"

echo ""
echo " [3/4] Staging www into launcher..."
rm -rf "$LAUNCHER/www"
cp -R "$ROOT/web/dist" "$LAUNCHER/www"

mkdir -p "$OUT"

echo ""
echo " [4/4] Building pkg binaries (60–120s each)..."
pushd "$LAUNCHER" >/dev/null
npm install --no-audit
npm run build:mac
popd >/dev/null

chmod +x "$OUT/OrionSocial-mac-x64" "$OUT/OrionSocial-mac-arm64" 2>/dev/null || true

echo ""
echo " BUILD COMPLETE"
echo "   Intel:         $OUT/OrionSocial-mac-x64"
echo "   Apple Silicon: $OUT/OrionSocial-mac-arm64"
echo ""
echo " Share the file that matches the user's Mac chip."
echo " If Gatekeeper blocks: System Settings → Privacy & Security → Open Anyway"
echo ""
