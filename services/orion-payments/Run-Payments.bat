@echo off
setlocal
pushd "%~dp0"

if not exist node_modules (
  call npm install
)

call npm start

popd
endlocal

