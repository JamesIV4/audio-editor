@echo off
rem Double-click launcher. Clears ELECTRON_RUN_AS_NODE, which VS Code / tool shells sometimes set and which makes Electron run as plain Node.
set ELECTRON_RUN_AS_NODE=
cd /d "%~dp0"
if not exist node_modules\electron\dist\electron.exe (
  call npm install || exit /b 1
  if not exist node_modules\electron\dist\electron.exe node node_modules\electron\install.js
)
start "" node_modules\electron\dist\electron.exe .
