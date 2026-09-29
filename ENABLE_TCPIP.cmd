@echo off
REM Enable TCP/IP for SQL Server SQLEXPRESS04
REM This script modifies the registry and restarts SQL Server

echo.
echo ========================================
echo SQL Server TCP/IP Configuration
echo ========================================
echo.

REM Check if running as admin
net session >nul 2>&1
if %errorLevel% NEQ 0 (
    echo ERROR: This script must be run as Administrator!
    echo Right-click cmd.exe, select "Run as Administrator"
    echo Then run: %0
    echo.
    pause
    exit /b 1
)

echo Step 1: Finding SQL Server Registry Path...
for %%v in (14 15 16 17) do (
    reg query "HKLM\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL%%v.SQLEXPRESS04\MSSQLServer\SuperSocketNetLib\TCP" >nul 2>&1
    if not errorlevel 1 (
        set "VERSION=%%v"
        echo   Found: MSSQL%%v.SQLEXPRESS04
        goto :found
    )
)

echo   Could not find SQL Server registry entry
echo   Check that SQL Server SQLEXPRESS04 is installed
pause
exit /b 1

:found
echo.
echo Step 2: Enabling TCP/IP in registry...
reg add "HKLM\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL%VERSION%.SQLEXPRESS04\MSSQLServer\SuperSocketNetLib\TCP" /v "Enabled" /t REG_DWORD /d 1 /f
echo   ✓ TCP/IP Enabled

echo.
echo Step 3: Setting port to 1433...
reg add "HKLM\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL%VERSION%.SQLEXPRESS04\MSSQLServer\SuperSocketNetLib\TCP\IPAll" /v "TcpDynamicPorts" /t REG_SZ /d "" /f
reg add "HKLM\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL%VERSION%.SQLEXPRESS04\MSSQLServer\SuperSocketNetLib\TCP\IPAll" /v "TcpPort" /t REG_SZ /d "1433" /f
echo   ✓ Port 1433 configured

echo.
echo Step 4: Restarting SQL Server service...
net stop "MSSQL$SQLEXPRESS04" >nul 2>&1
timeout /t 2 /nobreak >nul
net start "MSSQL$SQLEXPRESS04"
if errorlevel 1 (
    echo   ✗ Failed to restart service
    pause
    exit /b 1
)
echo   ✓ SQL Server restarted

echo.
echo Step 5: Checking TCP port listener...
timeout /t 2 /nobreak >nul
netstat -ano | findstr ":1433"
if errorlevel 1 (
    echo   ✗ Port 1433 not listening yet
) else (
    echo   ✓ Port 1433 is listening
)

echo.
echo ========================================
echo Configuration Complete!
echo Now run: START_ALL.cmd
echo ========================================
echo.

pause
