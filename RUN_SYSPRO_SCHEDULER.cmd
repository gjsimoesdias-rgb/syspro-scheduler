@echo off
setlocal
cd /d %~dp0

set "NODE_EXE=%~dp0runtime\node.exe"
if not exist "%NODE_EXE%" set "NODE_EXE=node"

if not exist backend\.env (
  "%NODE_EXE%" "%~dp0installer\setup-wizard.js" --defaults --skip-test
)

echo Starting Syspro Scheduler...
start "Syspro Scheduler" cmd /k "cd /d %~dp0backend && call ""%NODE_EXE%"" dist\server.js"
timeout /t 6 /nobreak >nul
start "" http://localhost:3000

endlocal
