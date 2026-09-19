@echo off
setlocal EnableExtensions
title Orion Social — Build EXE + APK

echo.
echo  Building Windows EXE...
call "%~dp0build-exe.bat"
if errorlevel 1 exit /b 1

echo.
echo  ============================================================
echo.
echo  Building Android APK...
call "%~dp0build-apk.bat"
if errorlevel 1 exit /b 1

echo.
echo  ============================================================
echo   Windows + Android done.
echo.
echo   Mac desktop : run build-mac.bat  (stage) then build-mac.sh on Mac
echo   iOS IPA     : run build-ipa.bat  (stage) then build-ipa.sh on Mac
echo   See packaging\PLATFORM_SUPPORT.md for the full matrix.
echo  ============================================================
exit /b 0
