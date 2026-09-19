@echo off
setlocal EnableExtensions
title Orion Social — Build macOS Desktop

echo.
echo  ============================================================
echo   ORION SOCIAL  —  BUILD macOS DESKTOP
echo  ============================================================
echo.
echo  Output (on Mac):
echo    packaging\output\OrionSocial-mac-x64     Intel Macs
echo    packaging\output\OrionSocial-mac-arm64   Apple Silicon (M1/M2/M3/M4)
echo.
echo  IMPORTANT: pkg can only produce Mac binaries ON a Mac.
echo  This script stages the web build on Windows and prints
echo  steps for your Mac build machine.
echo.
echo  ============================================================
echo.

cd /d "%~dp0.."

where node >nul 2>nul || (
  echo  ERROR: Node.js not found.
  pause & exit /b 1
)

echo  [1/3] Installing web dependencies...
call npm install --prefix web --no-audit
if errorlevel 1 pause & exit /b 1

echo.
echo  [2/3] Building web app (Vite production build)...
call npm run build --prefix web
if errorlevel 1 pause & exit /b 1

echo.
echo  [3/3] Staging web files into launcher...
if exist "%~dp0launcher\www" rd /s /q "%~dp0launcher\www" 2>nul
xcopy /e /i /q "web\dist" "%~dp0launcher\www" >nul
if errorlevel 1 (
  echo  ERROR: Could not copy web\dist to packaging\launcher\www
  pause & exit /b 1
)

if not exist "%~dp0output" mkdir "%~dp0output"

echo.
echo  ============================================================
echo   WEB BUILD STAGED — finish on your Mac:
echo.
echo     1. Copy this repo folder to the Mac
echo     2. cd packaging
echo     3. chmod +x build-mac.sh && ./build-mac.sh
echo.
echo   Users run the matching binary for their chip:
echo     Intel:         ./OrionSocial-mac-x64
echo     Apple Silicon: ./OrionSocial-mac-arm64
echo.
echo   First launch: right-click → Open if Gatekeeper blocks.
echo  ============================================================
echo.
pause
exit /b 0
