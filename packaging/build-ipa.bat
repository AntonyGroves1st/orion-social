@echo off
setlocal EnableExtensions
title Orion Social - Build iOS IPA

echo.
echo  ============================================================
echo   ORION SOCIAL  —  BUILD iOS IPA (App Store / TestFlight)
echo  ============================================================
echo.
echo  Output: packaging\output\OrionSocial.ipa
echo.
echo  IMPORTANT: Apple requires a Mac with Xcode to sign and export
echo  an IPA. This script prepares the iOS project on Windows and
echo  prints next steps for your Mac build machine.
echo.
echo  ============================================================
echo.

cd /d "%~dp0.."

where node >nul 2>nul || (
  echo  ERROR: Node.js not found.
  pause & exit /b 1
)

if not exist "web\.env" (
  echo  WARN: web\.env missing. Copy web\.env.example and add Supabase keys.
  echo.
)

echo  [1/4] Installing web dependencies...
call npm install --prefix web --no-audit
if errorlevel 1 pause & exit /b 1

echo.
echo  [2/4] Building web app for Capacitor...
call npm run build:capacitor --prefix web
if errorlevel 1 pause & exit /b 1

echo.
echo  [3/4] Creating iOS Capacitor project (if needed)...
if not exist "web\ios" (
  pushd web
  call npx cap add ios
  if errorlevel 1 (
    echo  ERROR: cap add ios failed.
    popd & pause & exit /b 1
  )
  popd
)

echo.
echo  [4/4] Syncing web assets into iOS project...
pushd web
call npx cap sync ios
if errorlevel 1 (
  echo  ERROR: cap sync ios failed.
  popd & pause & exit /b 1
)
popd

if not exist "packaging\output" mkdir "packaging\output"

echo.
echo  ============================================================
echo   iOS PROJECT READY: web\ios
echo.
echo   On your Mac:
echo     1. Copy this repo folder to the Mac
echo     2. cd packaging && chmod +x build-ipa.sh && ./build-ipa.sh
echo        OR open web/ios/App/App.xcworkspace in Xcode
echo     3. Set your Apple Team under Signing ^& Capabilities
echo     4. Product → Archive → Distribute App → App Store Connect
echo.
echo   Optional env on Mac: set APPLE_TEAM_ID before running build-ipa.sh
echo  ============================================================
echo.
pause
exit /b 0
