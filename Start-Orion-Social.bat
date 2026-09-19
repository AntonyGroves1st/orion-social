@echo off
setlocal EnableExtensions

rem Orion Social all-in-one local launcher.
rem Installs missing dependencies, starts bridge/payments/anchor/web, then opens the app.

set "ROOT=%~dp0"
set "WEB_URL=http://127.0.0.1:5732"
set "BRIDGE_URL=http://127.0.0.1:8790"
set "PAYMENTS_URL=http://127.0.0.1:8791"

pushd "%ROOT%" || (
  echo [Orion Social] Could not enter "%ROOT%"
  pause
  exit /b 1
)

echo.
echo ============================================================
echo  ORION SOCIAL LOCAL BOOT
echo ============================================================
echo  Root     : %ROOT%
echo  Web      : %WEB_URL%
echo  Bridge   : %BRIDGE_URL%
echo  Payments : %PAYMENTS_URL%
echo ============================================================
echo.

where node >nul 2>nul || (
  echo [ERROR] Node.js is required. Install Node.js 20+ from https://nodejs.org/
  goto :fail
)

where npm >nul 2>nul || (
  echo [ERROR] npm was not found. Reinstall Node.js and include npm.
  goto :fail
)

set "PYTHON_CMD="
where py >nul 2>nul && set "PYTHON_CMD=py -3"
if not defined PYTHON_CMD (
  where python >nul 2>nul && set "PYTHON_CMD=python"
)
if not defined PYTHON_CMD (
  echo [ERROR] Python 3 is required for services\orion-bridge.
  echo         Install Python 3 and make sure py.exe or python.exe is on PATH.
  goto :fail
)

if not exist "%ROOT%web\package.json" (
  echo [ERROR] Missing web\package.json
  goto :fail
)

if not exist "%ROOT%services\orion-bridge\main.py" (
  echo [ERROR] Missing services\orion-bridge\main.py
  goto :fail
)

echo [1/5] Installing web dependencies if needed...
if not exist "%ROOT%web\node_modules" (
  call npm install --prefix "%ROOT%web" || goto :fail
) else (
  echo       web\node_modules already present.
)

echo.
echo [2/5] Installing payments dependencies if needed...
if exist "%ROOT%services\orion-payments\package.json" (
  if not exist "%ROOT%services\orion-payments\node_modules" (
    call npm install --prefix "%ROOT%services\orion-payments" || goto :fail
  ) else (
    echo       services\orion-payments\node_modules already present.
  )
) else (
  echo       payments package not found; skipping.
)

echo.
echo [3/5] Installing anchor node dependencies if needed...
if exist "%ROOT%services\orion-anchor-node\package.json" (
  if not exist "%ROOT%services\orion-anchor-node\node_modules" (
    call npm install --prefix "%ROOT%services\orion-anchor-node" || goto :fail
  ) else (
    echo       services\orion-anchor-node\node_modules already present.
  )
) else (
  echo       anchor package not found; skipping.
)

echo.
echo [4/5] Installing bridge Python requirements...
if exist "%ROOT%services\orion-bridge\requirements.txt" (
  %PYTHON_CMD% -c "import fastapi, uvicorn" >nul 2>nul
  if errorlevel 1 (
    call %PYTHON_CMD% -m pip install -r "%ROOT%services\orion-bridge\requirements.txt" || goto :fail
  ) else (
    echo       bridge Python deps already import cleanly.
  )
) else (
  echo       requirements.txt not found; skipping pip install.
)

echo.
echo [5/5] Starting services...
echo       Each service opens in its own window. Close those windows to stop Orion.

call :port_open 8790
if errorlevel 1 (
  start "Orion Bridge :8790" /D "%ROOT%services\orion-bridge" cmd /k "%PYTHON_CMD% main.py"
) else (
  echo       Bridge already running on :8790; reusing it.
)

if exist "%ROOT%services\orion-payments\package.json" (
  if exist "%ROOT%services\orion-payments\.env" (
    call :port_open 8791
    if errorlevel 1 (
      start "Orion Payments :8791" /D "%ROOT%services\orion-payments" cmd /k "npm start"
    ) else (
      echo       Payments already running on :8791; reusing it.
    )
  ) else (
    echo       [WARN] services\orion-payments\.env missing; payments not started.
    echo              Copy .env.example to .env and fill Stripe/Supabase secrets.
  )
)

if exist "%ROOT%services\orion-anchor-node\package.json" (
  if exist "%ROOT%services\orion-anchor-node\.env" (
    call :anchor_open
    if errorlevel 1 (
      start "Orion Anchor Node" /D "%ROOT%services\orion-anchor-node" cmd /k "npm start"
    ) else (
      echo       Anchor node already running; reusing it.
    )
  ) else (
    echo       [WARN] services\orion-anchor-node\.env missing; anchor not started.
    echo              Copy .env.example to .env and fill Supabase values.
  )
)

if exist "%ROOT%web\.env" (
  echo       web\.env found.
) else (
  echo       [WARN] web\.env missing. The app can still use the dev paste form,
  echo              but normal startup needs VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.
)

echo       Killing any stale Vite processes and clearing dep cache...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*vite*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; if (Test-Path '%ROOT%web\node_modules\.vite') { Remove-Item '%ROOT%web\node_modules\.vite' -Recurse -Force }"
timeout /t 1 /nobreak >nul
start "Orion Web :5732" /D "%ROOT%web" cmd /k "set NODE_OPTIONS=--use-system-ca&& npm run dev"

timeout /t 3 /nobreak >nul
start "" "%WEB_URL%"

echo.
echo Orion Social is booting.
echo.
echo   App      %WEB_URL%
echo   Bridge   %BRIDGE_URL%
echo   Payments %PAYMENTS_URL%
echo.
echo Leave the opened service windows running while testing.
echo.
popd
pause
exit /b 0

:port_open
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-NetTCPConnection -LocalPort %~1 -State Listen -ErrorAction SilentlyContinue) { exit 0 } exit 1"
exit /b %ERRORLEVEL%

:anchor_open
powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -match 'src[\\/]+anchor-node\\.mjs' }) { exit 0 } exit 1"
exit /b %ERRORLEVEL%

:fail
echo.
echo [Orion Social] Startup failed. Fix the message above, then run this file again.
echo.
popd
pause
exit /b 1
