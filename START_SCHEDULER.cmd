@echo off
setlocal
cd /d "%~dp0"
title SYSPRO Scheduler

echo ============================================
echo  SYSPRO Scheduler - build and start
echo ============================================
echo.
echo [1/4] Installing frontend dependencies...
cd frontend
call npm install --no-audit --no-fund
if errorlevel 1 (cd .. & goto :fail)
cd ..

echo.
echo [2/4] Building backend...
call npm run build:backend
if errorlevel 1 goto :fail

echo.
echo [3/4] Building frontend...
call npm run build:frontend
if errorlevel 1 goto :fail

echo.
echo [4/4] Starting server on http://localhost:3000 ...
cd backend
call npm start
goto :end

:fail
echo.
echo BUILD FAILED - see errors above.
pause

:end
endlocal
