@echo off
setlocal EnableExtensions
title Orion Social — Build Android APK

set "ROOT=%~dp0"
cd /d "%ROOT%" || (
  echo [ERROR] Could not enter "%ROOT%"
  pause
  exit /b 1
)

call "%ROOT%packaging\build-apk.bat"
exit /b %ERRORLEVEL%
