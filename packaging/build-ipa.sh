#!/usr/bin/env bash
# Orion Social — iOS IPA for App Store / TestFlight
# Requires macOS with Xcode 15+, CocoaPods, Node.js 18+

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/packaging/output"
IOS_DIR="$ROOT/web/ios"

echo ""
echo " ============================================================"
echo "  ORION SOCIAL  —  BUILD iOS IPA"
echo " ============================================================"
echo ""
echo " Output: packaging/output/OrionSocial.ipa"
echo ""

command -v node >/dev/null || { echo "ERROR: Node.js not found"; exit 1; }
command -v xcodebuild >/dev/null || { echo "ERROR: Xcode not found — install from Mac App Store"; exit 1; }

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "ERROR: IPA builds require macOS + Xcode."
  exit 1
fi

if [[ ! -f "$ROOT/web/.env" ]]; then
  echo "WARN: web/.env missing — copy web/.env.example and add Supabase keys."
fi

echo " [1/6] Installing web dependencies..."
npm install --prefix "$ROOT/web" --no-audit

echo ""
echo " [2/6] Building web app for Capacitor..."
npm run build:capacitor --prefix "$ROOT/web"

echo ""
echo " [3/6] Ensuring iOS project exists..."
if [[ ! -d "$IOS_DIR" ]]; then
  pushd "$ROOT/web" >/dev/null
  npx cap add ios
  popd >/dev/null
fi

echo ""
echo " [4/6] Syncing web build into iOS project..."
pushd "$ROOT/web" >/dev/null
npx cap sync ios
popd >/dev/null

mkdir -p "$OUT"

echo ""
echo " [5/6] Installing CocoaPods..."
pushd "$IOS_DIR/App" >/dev/null
if command -v pod >/dev/null; then
  pod install
else
  echo "WARN: CocoaPods not found — run: sudo gem install cocoapods"
fi
popd >/dev/null

SCHEME="App"
WORKSPACE="$IOS_DIR/App/App.xcworkspace"
ARCHIVE="$OUT/OrionSocial.xcarchive"
EXPORT_PLIST="$ROOT/packaging/ios/ExportOptions.plist"

mkdir -p "$ROOT/packaging/ios"
if [[ ! -f "$EXPORT_PLIST" ]]; then
  cat > "$EXPORT_PLIST" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>uploadSymbols</key>
  <true/>
  <key>destination</key>
  <string>export</string>
</dict>
</plist>
PLIST
  echo "Created default ExportOptions.plist — set signing team in Xcode first."
fi

echo ""
echo " [6/6] Archiving (open Xcode to configure signing if this fails)..."
xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Release \
  -archivePath "$ARCHIVE" \
  archive \
  CODE_SIGN_STYLE=Automatic \
  DEVELOPMENT_TEAM="${APPLE_TEAM_ID:-}"

xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$OUT/ios-export" \
  -exportOptionsPlist "$EXPORT_PLIST"

IPA=$(find "$OUT/ios-export" -name "*.ipa" | head -1)
if [[ -n "$IPA" ]]; then
  cp "$IPA" "$OUT/OrionSocial.ipa"
  echo ""
  echo " BUILD COMPLETE: $OUT/OrionSocial.ipa"
  echo " Upload with Transporter or: xcrun altool --upload-app -f \"$OUT/OrionSocial.ipa\""
else
  echo ""
  echo " Archive created at $ARCHIVE"
  echo " Open Xcode → Window → Organizer → Distribute App to export IPA manually."
fi

echo ""
