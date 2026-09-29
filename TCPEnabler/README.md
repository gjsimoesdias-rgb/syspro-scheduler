# SQL Server TCP/IP Enabler

Automated tool to enable TCP/IP protocol for SQL Server SQLEXPRESS04.

This app configures your SQL Server to listen on port 1433 so the Syspro Scheduler backend can connect.

## Quick Start (Recommended)

### Option 1: One-Click

1. **Right-click** → `RUN.cmd`
2. Select **"Run as Administrator"**
3. Click **"Yes"** on security prompt
4. Wait for completion

### Option 2: Auto-Elevate

**Double-click** → `RUN_ELEVATED.cmd`

Will automatically request Administrator privileges.

---

## What It Does

✅ **Auto-detects** SQL Server version (MSSQL12-17)  
✅ **Enables** TCP/IP protocol  
✅ **Configures** static port 1433  
✅ **Restarts** SQL Server service  
✅ **Verifies** port is listening  
✅ **Shows status** with color-coded output  

---

## Requirements

- Windows with Administrator privileges
- Node.js installed (`npm` command available)
- SQL Server with SQLEXPRESS04 instance

---

## How It Works

1. Checks admin privileges
2. Finds SQL Server registry key
3. Enables TCP/IP protocol via registry
4. Sets port to 1433
5. Restarts MSSQL$SQLEXPRESS04 service
6. Verifies port 1433 is listening

---

## After Completion

Once the app shows "Configuration Complete!", run:

```cmd
C:\Users\Goncalo Dias\SchedulerNEW_01042026\START_ALL.cmd
```

Your backend will now connect to SQL Server successfully!

---

## Troubleshooting

### "This app must run as Administrator"
- Right-click `RUN.cmd` (not the app window)
- Select **"Run as Administrator"**

### "Could not find SQL Server"
- Verify SQL Server SQLEXPRESS04 is installed
- Check Services: `services.msc` → look for SQL Server entries

### "Port still not listening"
- Try closing and reopening the app
- Manually restart SQL Server:
  ```cmd
  net stop "MSSQL$SQLEXPRESS04"
  net start "MSSQL$SQLEXPRESS04"
  ```

---

## Manual Alternative

If the app fails, you can manually enable TCP/IP:

```cmd
REM Find your version (12-17)
reg query "HKLM\SOFTWARE\Microsoft\Microsoft SQL Server" | findstr MSSQL

REM Enable TCP/IP (replace 15 with your version)
reg add "HKLM\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL15.SQLEXPRESS04\MSSQLServer\SuperSocketNetLib\TCP" /v "Enabled" /t REG_DWORD /d 1 /f

REM Set port to 1433
reg add "HKLM\SOFTWARE\Microsoft\Microsoft SQL Server\MSSQL15.SQLEXPRESS04\MSSQLServer\SuperSocketNetLib\TCP\IPAll" /v "TcpPort" /t REG_DWORD /d 1433 /f

REM Restart SQL Server
net stop "MSSQL$SQLEXPRESS04"
timeout /t 2
net start "MSSQL$SQLEXPRESS04"

REM Verify
netstat -ano | findstr ":1433"
```

---

## More Help

For detailed diagnostics, run:

```cmd
REM Check SQL Server is running
tasklist | findstr /i mssql

REM Check port is listening
netstat -ano | findstr ":1433"

REM Test SQL connection directly
sqlcmd -S tcp:localhost,1433 -U sysproadmin -P SysproScheduler123! -d SCHEDULER -Q "SELECT 1"
```
