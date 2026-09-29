@echo off
REM SQL Server TCP/IP Enabler - Launcher
REM Right-click this file and select "Run as Administrator"

setlocal enabledelayedexpansion

REM Check for admin
net session >nul 2>&1
if %errorLevel% NEQ 0 (
    echo.
    echo ERROR: This script must run as Administrator!
    echo.
    echo Steps to fix:
    echo   1. Right-click THIS FILE (RUN.cmd)
    echo   2. Select "Run as Administrator"
    echo   3. Click "Yes" on any security prompts
    echo.
    pause
    exit /b 1
)

REM Set Node.js to PATH
set PATH=C:\Program Files\nodejs;%PATH%

REM Change to script directory
cd /d "%~dp0"

REM Install dependencies silently
echo Installing dependencies...
call npm install >nul 2>&1

REM Run the app
echo.
call npm start
