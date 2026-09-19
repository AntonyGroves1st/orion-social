@echo off
setlocal EnableExtensions

set "MANIFEST=%~dp0..\web\android\app\src\main\AndroidManifest.xml"
if not exist "%MANIFEST%" exit /b 0

findstr /c:"android.permission.CAMERA" "%MANIFEST%" >nul 2>nul && exit /b 0

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$path = '%MANIFEST%';" ^
  "$xml = Get-Content -Raw -LiteralPath $path;" ^
  "if ($xml -match 'android.permission.CAMERA') { exit 0 };" ^
  "$insert = @('    <uses-permission android:name=\"android.permission.INTERNET\" />','    <uses-permission android:name=\"android.permission.CAMERA\" />','    <uses-permission android:name=\"android.permission.RECORD_AUDIO\" />','    <uses-permission android:name=\"android.permission.MODIFY_AUDIO_SETTINGS\" />');" ^
  "if ($xml -match '<uses-permission android:name=\"android.permission.INTERNET\"') { $xml = $xml -replace '<uses-permission android:name=\"android.permission.INTERNET\" />', ($insert -join \"`n\"); } else { $xml = $xml -replace '<manifest ', ('<manifest ' + \"`n\" + ($insert -join \"`n\")); };" ^
  "Set-Content -LiteralPath $path -Value $xml -NoNewline"

exit /b 0
