$ErrorActionPreference = 'Stop'

$sourceDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$zipPath = Join-Path $sourceDir 'SysproSchedulerPackage.zip'
$installDir = Join-Path $env:LOCALAPPDATA 'Programs\Syspro Scheduler'
$startMenuDir = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Syspro Scheduler'
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Syspro Scheduler.lnk'

if (!(Test-Path $zipPath)) {
  throw "Installer payload not found: $zipPath"
}

Write-Host "Installing to $installDir" -ForegroundColor Cyan
if (Test-Path $installDir) {
  Remove-Item $installDir -Recurse -Force
}

New-Item -ItemType Directory -Path $installDir -Force | Out-Null
Expand-Archive -Path $zipPath -DestinationPath $installDir -Force

$envExample = Join-Path $installDir 'backend\.env.example'
$envFile = Join-Path $installDir 'backend\.env'
if (!(Test-Path $envFile) -and (Test-Path $envExample)) {
  Copy-Item $envExample $envFile -Force
}

New-Item -ItemType Directory -Path $startMenuDir -Force | Out-Null

$uninstallScript = @"
`$ErrorActionPreference = 'SilentlyContinue'
`$installDir = Join-Path `$env:LOCALAPPDATA 'Programs\Syspro Scheduler'
`$startMenuDir = Join-Path `$env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Syspro Scheduler'
`$desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Syspro Scheduler.lnk'
if (Test-Path `$desktopShortcut) { Remove-Item `$desktopShortcut -Force }
if (Test-Path `$startMenuDir) { Remove-Item `$startMenuDir -Recurse -Force }
if (Test-Path `$installDir) { Remove-Item `$installDir -Recurse -Force }
Write-Host 'Syspro Scheduler was removed.'
"@

$uninstallPs1 = Join-Path $installDir 'installer\uninstall-local.ps1'
$uninstallCmd = Join-Path $installDir 'Uninstall Syspro Scheduler.cmd'
Set-Content -Path $uninstallPs1 -Value $uninstallScript -Encoding UTF8
Set-Content -Path $uninstallCmd -Value "@echo off`r`npowershell.exe -ExecutionPolicy Bypass -File `"%~dp0installer\uninstall-local.ps1`"`r`n" -Encoding ASCII

$shell = New-Object -ComObject WScript.Shell
$shortcuts = @(
  @{ Path = (Join-Path $startMenuDir 'Syspro Scheduler.lnk'); Target = (Join-Path $installDir 'RUN_SYSPRO_SCHEDULER.cmd') },
  @{ Path = (Join-Path $startMenuDir 'Stop Syspro Scheduler.lnk'); Target = (Join-Path $installDir 'STOP_SYSPRO_SCHEDULER.cmd') },
  @{ Path = (Join-Path $startMenuDir 'Uninstall Syspro Scheduler.lnk'); Target = $uninstallCmd },
  @{ Path = $desktopShortcut; Target = (Join-Path $installDir 'RUN_SYSPRO_SCHEDULER.cmd') }
)

foreach ($item in $shortcuts) {
  $shortcut = $shell.CreateShortcut($item.Path)
  $shortcut.TargetPath = $item.Target
  $shortcut.WorkingDirectory = $installDir
  $shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,13"
  $shortcut.Save()
}

Write-Host 'Installation complete.' -ForegroundColor Green
Start-Process (Join-Path $installDir 'RUN_SYSPRO_SCHEDULER.cmd')
