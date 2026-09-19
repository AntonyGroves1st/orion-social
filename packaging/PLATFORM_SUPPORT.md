# Orion Social — Platform Support

Orion Social runs on **all major phone models**, **Windows**, and **Mac** (Intel + Apple Silicon).

## Supported platforms

| Platform | Build output | How users run it |
|----------|--------------|------------------|
| **Android phones & tablets** | `packaging/output/OrionSocial.apk` | Install APK (Android 6.0+, API 23+) |
| **iPhone / iPad** | `packaging/output/OrionSocial.ipa` | TestFlight / App Store (build on Mac) |
| **Windows 10/11** | `packaging/output/OrionSocial.exe` | Double-click — no Node.js needed |
| **macOS Intel** | `packaging/output/OrionSocial-mac-x64` | Run binary from Terminal or Finder |
| **macOS Apple Silicon** | `packaging/output/OrionSocial-mac-arm64` | M1/M2/M3/M4 Macs |
| **Mobile browser / PWA** | Deploy `web/dist` or use dev server | Add to Home Screen for app-like UI |

## Build commands

From repo root:

```bat
packaging\build-apk.bat      REM Android APK (all phone sizes, foldables)
packaging\build-exe.bat      REM Windows EXE
packaging\build-mac.bat      REM Stage www on Windows → finish on Mac
packaging\build-ipa.bat      REM Stage iOS project on Windows → finish on Mac
packaging\build-all.bat      REM Windows EXE + Android APK
```

On **Mac**:

```bash
cd packaging
chmod +x build-mac.sh build-ipa.sh
./build-mac.sh    # OrionSocial-mac-x64 + OrionSocial-mac-arm64
./build-ipa.sh    # OrionSocial.ipa (needs Xcode + Apple Team)
```

## Phone compatibility

- **Android**: minSdk **23** (Android 6.0+) — covers Samsung, Pixel, Xiaomi, OnePlus, budget devices, foldables.
- **Resizeable / foldable**: `resizeableActivity` + `supports-screens` enabled in `AndroidManifest.xml`.
- **Notches / punch-holes / Dynamic Island**: `viewport-fit=cover` + `env(safe-area-inset-*)` CSS.
- **Small screens** (320px): `.orion-narrow-phone` tightens toolbar and footer.
- **Landscape phones**: reduced chrome so the live stage stays visible.
- **iOS**: Capacitor iOS project + safe-area classes (`orion-native-ios`).

## Desktop (Windows & Mac)

The desktop app is a **single-file launcher** (pkg) that:

1. Serves the built web app on `http://127.0.0.1:5732` (or next free port for a second instance).
2. Opens the default browser automatically.
3. Injects `<meta name="orion-shell" content="desktop">` so the UI applies `orion-desktop` styles.

**Second EXE/instance**: run again for port 5733+ — use a **different login** for EXE↔EXE live room tests.

## Runtime detection (web code)

`web/src/lib/platform.ts` adds CSS classes on `<html>`:

- OS: `orion-os-windows`, `orion-os-mac`, `orion-os-android`, `orion-os-ios`
- Form factor: `orion-form-phone`, `orion-form-tablet`, `orion-form-desktop`
- Shell: `orion-native`, `orion-desktop`, `orion-pwa`
- Input: `orion-touch` vs `orion-pointer-fine`

Use these in CSS when tuning layout per device.

## iOS notes

1. Run `packaging/build-ipa.bat` (Windows) or `npx cap add ios` (Mac) once.
2. Open `web/ios/App/App.xcworkspace` in Xcode.
3. Enable **Camera** and **Microphone** under Signing & Capabilities / Info.plist.
4. Set your Apple Team, then Archive → Distribute.

Loudspeaker routing on iOS uses WebRTC defaults (Android has a custom `OrionAudioPlugin`).

## Requirements for developers

- Node.js **18+**
- Android: JDK 17+, Android SDK (for APK)
- Mac: Xcode 15+ (for IPA and Mac desktop binaries)
- `web/.env` with `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`

## Troubleshooting

| Issue | Fix |
|-------|-----|
| EXE build `EPERM` | Close running `OrionSocial.exe` |
| Mac Gatekeeper blocks binary | Right-click → Open, or Security settings |
| iOS project missing | Run `packaging/build-ipa.bat` or `npx cap add ios` on Mac |
| Layout wrong on notch phone | Ensure latest APK + `viewport-fit=cover` in build |
| Second desktop login | Launch EXE again (port 5733+) with different account |
