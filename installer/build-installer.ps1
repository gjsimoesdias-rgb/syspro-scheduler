$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$stageDir = Join-Path $repoRoot 'dist\installer-package'
$outputDir = Join-Path $repoRoot 'dist\installer-output'
$backendSrc = Join-Path $repoRoot 'backend'
$frontendSrc = Join-Path $repoRoot 'frontend'
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$iscc = Get-Command ISCC.exe -ErrorAction SilentlyContinue
$defaultIsccPath = Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'
$isccPath = if ($iscc) { $iscc.Source } elseif (Test-Path $defaultIsccPath) { $defaultIsccPath } else { $null }
$iexpressPath = Join-Path $env:WINDIR 'System32\iexpress.exe'

Write-Host ''
Write-Host '========================================' -ForegroundColor Cyan
Write-Host ' Building Syspro Scheduler Installer' -ForegroundColor Cyan
Write-Host '========================================' -ForegroundColor Cyan
Write-Host ''

Write-Host '1. Building application...' -ForegroundColor Yellow
Push-Location $repoRoot
npm.cmd run build
Pop-Location

Write-Host '2. Preparing staging folder...' -ForegroundColor Yellow
if (Test-Path $stageDir) { Remove-Item $stageDir -Recurse -Force }
New-Item -ItemType Directory -Path $stageDir | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stageDir 'backend') | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stageDir 'frontend') | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stageDir 'installer') | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stageDir 'runtime') | Out-Null
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null

Copy-Item (Join-Path $backendSrc 'dist') (Join-Path $stageDir 'backend') -Recurse -Force
Copy-Item (Join-Path $backendSrc 'node_modules') (Join-Path $stageDir 'backend') -Recurse -Force
Copy-Item (Join-Path $backendSrc '.env.example') (Join-Path $stageDir 'backend') -Force
Copy-Item (Join-Path $frontendSrc 'build') (Join-Path $stageDir 'frontend') -Recurse -Force
Copy-Item (Join-Path $repoRoot 'installer\setup-wizard.js') (Join-Path $stageDir 'installer') -Force
Copy-Item (Join-Path $repoRoot 'RUN_SYSPRO_SCHEDULER.cmd') $stageDir -Force
Copy-Item (Join-Path $repoRoot 'STOP_SYSPRO_SCHEDULER.cmd') $stageDir -Force
Copy-Item (Join-Path $repoRoot 'README.md') $stageDir -Force
Copy-Item $nodePath (Join-Path $stageDir 'runtime\node.exe') -Force

Write-Host '3. Packaging installer payload...' -ForegroundColor Yellow
$zipPath = Join-Path $outputDir 'SysproSchedulerPackage.zip'
$installScriptOutput = Join-Path $outputDir 'install-local.ps1'
$setupExe = Join-Path $outputDir 'SysproSchedulerSetup.exe'
$sedPath = Join-Path $outputDir 'SysproSchedulerSetup.sed'

if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
if (Test-Path $setupExe) { Remove-Item $setupExe -Force }
if (Test-Path $sedPath) { Remove-Item $sedPath -Force }

Compress-Archive -Path (Join-Path $stageDir '*') -DestinationPath $zipPath -Force
Copy-Item (Join-Path $repoRoot 'installer\install-local.ps1') $installScriptOutput -Force

if ($isccPath) {
  Write-Host '4. Compiling installer with Inno Setup...' -ForegroundColor Yellow
  & $isccPath (Join-Path $repoRoot 'installer\SysproSchedulerSetup.iss')
} elseif (Test-Path $iexpressPath) {
  Write-Host '4. Compiling installer with IExpress...' -ForegroundColor Yellow
  $sedContent = @"
[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=0
UseLongFileName=1
InsideCompressed=1
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=
DisplayLicense=
FinishMessage=Syspro Scheduler has been installed successfully.
TargetName=$setupExe
FriendlyName=Syspro Scheduler Setup
AppLaunched=cmd /c powershell.exe -ExecutionPolicy Bypass -File install-local.ps1
PostInstallCmd=<None>
AdminQuietInstCmd=cmd /c powershell.exe -ExecutionPolicy Bypass -File install-local.ps1
UserQuietInstCmd=cmd /c powershell.exe -ExecutionPolicy Bypass -File install-local.ps1
SourceFiles=SourceFiles
[Strings]
FILE0=SysproSchedulerPackage.zip
FILE1=install-local.ps1
[SourceFiles]
SourceFiles0=$outputDir
[SourceFiles0]
%FILE0%=
%FILE1%=
"@
  Set-Content -Path $sedPath -Value $sedContent -Encoding ASCII
  $process = Start-Process -FilePath $iexpressPath -ArgumentList "/N", $sedPath -PassThru -Wait
  if ($process.ExitCode -ne 0 -or !(Test-Path $setupExe)) {
    throw "IExpress failed to create the setup executable."
  }
} else {
  throw 'No installer compiler is available. Inno Setup and IExpress were both unavailable.'
}

if (!(Test-Path $setupExe)) {
  throw "Installer was not created at $setupExe"
}

Write-Host ''
Write-Host "Installer ready: $setupExe" -ForegroundColor Green
