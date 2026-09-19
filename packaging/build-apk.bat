@echo off
setlocal EnableExtensions EnableDelayedExpansion
title Orion Social - Build Android APK

echo.
echo  ============================================================
echo   ORION SOCIAL  —  BUILD ANDROID APK
echo  ============================================================
echo.
echo  Output: packaging\output\OrionSocial.apk
echo.
echo  Requires on THIS machine:
echo    - Node.js 18+
echo    - Java JDK 17+  (java on PATH)
echo    - Android SDK   (ANDROID_HOME or ANDROID_SDK_ROOT)
echo.
echo  ============================================================
echo.

cd /d "%~dp0.."

where node >nul 2>nul || (
  echo  ERROR: Node.js not found. Install from https://nodejs.org/
  pause & exit /b 1
)

where java >nul 2>nul || (
  echo  ERROR: Java JDK not found. Install JDK 17+ and add java to PATH.
  echo         https://adoptium.net/ is a good free option.
  pause & exit /b 1
)

rem Gradle/Android builds break on very new JDKs (e.g. Java 25). Prefer Android Studio JBR.
if exist "%ProgramFiles%\Android\Android Studio\jbr\bin\java.exe" (
  set "JAVA_HOME=%ProgramFiles%\Android\Android Studio\jbr"
  set "PATH=%ProgramFiles%\Android\Android Studio\jbr\bin;%PATH%"
)
if defined JAVA_HOME (
  echo  Using Java for Gradle: !JAVA_HOME!
  echo.
)

rem Auto-detect Android SDK if ANDROID_HOME / ANDROID_SDK_ROOT not set
if not defined ANDROID_HOME if not defined ANDROID_SDK_ROOT (
  if exist "%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe" (
    set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
  ) else if exist "%USERPROFILE%\AppData\Local\Android\Sdk\platform-tools\adb.exe" (
    set "ANDROID_HOME=%USERPROFILE%\AppData\Local\Android\Sdk"
  ) else if exist "C:\Android\Sdk\platform-tools\adb.exe" (
    set "ANDROID_HOME=C:\Android\Sdk"
  ) else if exist "%ProgramFiles(x86)%\Android\android-sdk\platform-tools\adb.exe" (
    set "ANDROID_HOME=%ProgramFiles(x86)%\Android\android-sdk"
  )
)

if defined ANDROID_SDK_ROOT if not defined ANDROID_HOME (
  set "ANDROID_HOME=%ANDROID_SDK_ROOT%"
)

if not defined ANDROID_HOME (
  echo  ERROR: ANDROID_HOME or ANDROID_SDK_ROOT is not set.
  echo         Android Studio SDK was not found in the usual locations.
  echo.
  echo         If SDK is installed elsewhere, run Set-Android-SDK.bat once,
  echo         or set permanently:
  echo           setx ANDROID_HOME "%LOCALAPPDATA%\Android\Sdk"
  pause & exit /b 1
)

echo  Using Android SDK: !ANDROID_HOME!
echo.

if not exist "%ANDROID_HOME%\platform-tools\adb.exe" (
  echo  ERROR: Android SDK not found at %ANDROID_HOME%
  echo         Install Android SDK Platform-Tools via Android Studio.
  pause & exit /b 1
)

if not exist "web\.env" (
  echo  WARN: web\.env missing. Copy web\.env.example and add Supabase keys first.
  echo        The APK will build but login will fail without VITE_SUPABASE_* values.
  echo.
)

echo  [1/5] Installing web dependencies...
call npm install --prefix web --no-audit
if errorlevel 1 (
  if exist "web\node_modules" rd /s /q "web\node_modules"
  call npm install --prefix web --no-audit
)
if errorlevel 1 (
  echo  ERROR: npm install failed for web.
  pause & exit /b 1
)

echo.
echo  [2/5] Building web app for Capacitor (relative asset paths)...
call npm run build:capacitor --prefix web
if errorlevel 1 (
  echo  ERROR: Capacitor web build failed.
  pause & exit /b 1
)

echo.
echo  [3/5] Ensuring Android project exists...
if not exist "web\android" (
  echo        First run — creating Capacitor Android project...
  pushd web
  call npx cap add android
  if errorlevel 1 (
    echo  ERROR: cap add android failed.
    popd & pause & exit /b 1
  )
  popd
)

echo.
echo  [4/5] Syncing web build into Android project...
if not exist "web\dist\index.html" (
  echo  ERROR: web\dist\index.html missing after build.
  pause & exit /b 1
)
pushd web
call npx cap sync android
if errorlevel 1 (
  echo  ERROR: cap sync failed.
  popd & pause & exit /b 1
)
popd

call "%~dp0patch-android-permissions.bat"
if errorlevel 1 (
  echo  ERROR: Could not patch Android permissions.
  pause & exit /b 1
)

if not exist "%~dp0output" mkdir "%~dp0output"

echo.
echo  [5/5] Compiling APK with Gradle (may take several minutes on first run)...
pushd web\android
if exist gradlew.bat (
  call gradlew.bat assembleDebug --no-daemon
) else (
  echo  ERROR: gradlew.bat not found in web\android
  popd & pause & exit /b 1
)
if errorlevel 1 (
  echo  ERROR: Gradle assembleDebug failed.
  popd & pause & exit /b 1
)
popd

set "APK_SRC=web\android\app\build\outputs\apk\debug\app-debug.apk"
if not exist "%APK_SRC%" (
  echo  ERROR: Expected APK not found at %APK_SRC%
  pause & exit /b 1
)

copy /y "%APK_SRC%" "%~dp0output\OrionSocial.apk" >nul
if errorlevel 1 (
  echo  ERROR: Could not copy APK to packaging\output\
  pause & exit /b 1
)

echo.
echo  ============================================================
echo   BUILD COMPLETE
echo.
echo   FILE : packaging\output\OrionSocial.apk
echo.
echo   Install on Android:
echo     adb install packaging\output\OrionSocial.apk
echo     or copy the APK to the phone and open it.
echo  ============================================================
echo.
pause
exit /b 0
