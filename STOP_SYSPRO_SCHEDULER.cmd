@echo off
setlocal
echo Stopping Syspro Scheduler...
taskkill /FI "WINDOWTITLE eq Syspro Scheduler*" /T /F >nul 2>nul
taskkill /FI "IMAGENAME eq node.exe" /FI "WINDOWTITLE eq Syspro Scheduler*" /T /F >nul 2>nul
echo Done.
endlocal
