@echo off
REM Alternative launcher with elevated privileges
REM This script will request admin elevation automatically

powershell -Command "Start-Process cmd.exe -ArgumentList '/c cd /d %~dp0 && RUN.cmd' -Verb RunAs"
