@echo off
setlocal EnableExtensions
title Orion Social - Set Android SDK Path

set "SDK=%LOCALAPPDATA%\Android\Sdk"

if not exist "%SDK%\platform-tools\adb.exe" (
  echo.
  echo  ERROR: Android SDK not found at:
  echo         %SDK%
  echo.
  echo  Install Android Studio, open SDK Manager, install Platform-Tools,
  echo  then run this script again.
  echo.
  pause
  exit /b 1
)

setx ANDROID_HOME "%SDK%" >nul
setx ANDROID_SDK_ROOT "%SDK%" >nul

echo.
echo  ANDROID_HOME set permanently to:
echo    %SDK%
echo.
echo  Close any open cmd windows, then run Build-OrionSocial-APK.bat again.
echo.
pause
exit /b 0
