@echo off
REM Start Both Backend and Frontend
REM This launches both servers in separate Command Prompt windows

echo.
echo ========================================
echo Syspro Scheduler - Full Stack Startup
echo ========================================
echo.

REM Add Node.js to PATH
set PATH=C:\Program Files\nodejs;%PATH%

REM Start Backend in new window
echo Starting Backend server...
start "Syspro Scheduler - Backend" cmd /k "set PATH=C:\Program Files\nodejs;%%PATH%% && cd /d C:\Users\Goncalo Dias\SchedulerNEW_01042026\backend && npm run dev"

REM Wait 3 seconds for backend to start
timeout /t 3 /nobreak

REM Start Frontend in new window
echo Starting Frontend server...
start "Syspro Scheduler - Frontend" cmd /k "set PATH=C:\Program Files\nodejs;%%PATH%% && cd /d C:\Users\Goncalo Dias\SchedulerNEW_01042026\frontend && npm start"

echo.
echo ========================================
echo Both servers are starting in separate windows
echo Backend: http://localhost:3000/api
echo Frontend: http://localhost:3000
echo ========================================
echo.

pause
