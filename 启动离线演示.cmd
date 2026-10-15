@echo off
setlocal
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
if exist "%~dp0dist\desktop\SkinLedger-2.2.0-x64.exe" (
  start "" "%~dp0dist\desktop\SkinLedger-2.2.0-x64.exe" --demo
  exit /b
)
if exist "%~dp0node_modules\electron\dist\electron.exe" (
  start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0" --demo
  exit /b
)
echo Please run npm ci, then try again.
pause
