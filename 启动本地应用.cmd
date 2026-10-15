@echo off
chcp 65001 >nul
setlocal
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
if exist "%~dp0dist\desktop\steam_and_buff-2.2.1-windows-x64.exe" (
  start "" "%~dp0dist\desktop\steam_and_buff-2.2.1-windows-x64.exe"
  exit /b
)
if exist "%~dp0node_modules\electron\dist\electron.exe" (
  start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0"
  exit /b
)
echo 请先运行 npm ci 安装依赖，然后重试。
pause
