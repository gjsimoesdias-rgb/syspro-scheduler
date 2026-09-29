@echo off
setlocal
cd /d %~dp0

echo.
echo ========================================
echo   Installing Syspro Scheduler Software
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found.
  echo Install Node.js 18+ and run this installer again.
  exit /b 1
)

echo Installing dependencies...
call npm.cmd install
if errorlevel 1 exit /b 1

echo.
echo Running SYSPRO database setup...
node installer\setup-wizard.js
if errorlevel 1 exit /b 1

echo.
echo Building the software...
call npm.cmd run build:software
if errorlevel 1 exit /b 1

echo.
echo Launching Syspro Scheduler...
call RUN_SYSPRO_SCHEDULER.cmd

echo.
echo Installation complete.
echo The software will open in your browser at http://localhost:3000
echo.
endlocal
