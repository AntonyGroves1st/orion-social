@echo off
setlocal EnableExtensions
title Orion Social — Build Windows EXE

echo.
echo  ============================================================
echo   ORION SOCIAL  —  BUILD DESKTOP EXE
echo  ============================================================
echo.
echo  This builds OrionSocial.exe — a single file that anyone
echo  can run without installing Node.js or npm.
echo.
echo  Requires: Node.js 18+ and npm (on THIS machine only).
echo  Output  : packaging\output\OrionSocial.exe (~50 MB)
echo.
echo  ============================================================
echo.

:: Move to the repo root (bat file is in packaging\)
cd /d "%~dp0.."

:: ── Check Node.js is available ────────────────────────────────────────
where node >nul 2>nul || (
  echo  ERROR: Node.js not found.
  echo         Install Node.js 18+ from https://nodejs.org/ then run this again.
  pause & exit /b 1
)

:: ── Step 1: Build the Vite web app ───────────────────────────────────
echo  [1/4] Installing web dependencies...
call npm install --prefix web --no-audit
if errorlevel 1 (
  echo  Retrying with a clean web\node_modules...
  if exist "web\node_modules" rd /s /q "web\node_modules"
  call npm install --prefix web --no-audit
)
if errorlevel 1 (
  echo  ERROR: npm install failed for web.
  echo         Close any dev server using web\ then retry.
  echo         Avoid UNC/network paths — copy to C:\Orion if needed.
  pause & exit /b 1
)

echo.
echo  [2/4] Building web app (Vite production build)...
call npm run build --prefix web
if errorlevel 1 (
  echo  ERROR: web build failed. Check web\.env has VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.
  pause & exit /b 1
)

:: ── Step 2: Stage built files into packaging\launcher\www ────────────
echo.
echo  [3/4] Staging built web files into launcher...
if exist "%~dp0launcher\www" (
  rd /s /q "%~dp0launcher\www" 2>nul
)
xcopy /e /i /q "web\dist" "%~dp0launcher\www" >nul
if errorlevel 1 (
  echo  ERROR: Could not copy web\dist to packaging\launcher\www
  pause & exit /b 1
)

:: ── Step 3: Install pkg tool + build EXE ─────────────────────────────
echo.
echo  [4/4] Building OrionSocial.exe (this takes 60-120 seconds)...

if not exist "%~dp0output" mkdir "%~dp0output"

pushd "%~dp0launcher"
call npm install --no-audit
if errorlevel 1 (
  echo  ERROR: launcher npm install failed.
  popd
  pause
  exit /b 1
)

rem Prefetch pkg base Node binary — avoids broken progress bar in non-interactive shells
set "PKG_BIN=%USERPROFILE%\.pkg-cache\v3.5\fetched-v20.18.0-win-x64"
if not exist "%PKG_BIN%" (
  echo        Downloading pkg Node base binary — one-time ~40 MB...
  if not exist "%USERPROFILE%\.pkg-cache\v3.5" mkdir "%USERPROFILE%\.pkg-cache\v3.5"
  powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -Uri 'https://github.com/yao-pkg/pkg-fetch/releases/download/v3.5/node-v20.18.0-win-x64' -OutFile '%PKG_BIN%' -UseBasicParsing } catch { exit 1 }"
  if errorlevel 1 (
    echo  ERROR: Could not download pkg base binary. Check internet access.
    popd
    pause
    exit /b 1
  )
)
set "PKG_NODE_PATH=%PKG_BIN%"

call npm run build:win
if errorlevel 1 (
  echo  ERROR: pkg build failed.
  popd
  pause
  exit /b 1
)

rem Fallback: copy www beside EXE in case pkg missed a dynamic asset path
if exist "www" (
  if exist "..\output\www" rd /s /q "..\output\www" 2>nul
  xcopy /e /i /q "www" "..\output\www" >nul
)

popd

:: ── Done ──────────────────────────────────────────────────────────────
echo.
echo  ============================================================
echo   BUILD COMPLETE
echo.
echo   FILE : packaging\output\OrionSocial.exe
echo   SIZE : (check in Explorer)
echo.
echo   Share OrionSocial.exe with your users.
echo   They just double-click it — no installs needed.
echo  ============================================================
echo.
pause
exit /b 0
