#define MyAppName "Syspro Scheduler"
#define MyAppVersion "1.0.0"
#define MyAppPublisher "AI Development Team"
#define MyAppURL "http://localhost:3000"
#define MyAppExeName "RUN_SYSPRO_SCHEDULER.cmd"
#define MyStageDir AddBackslash(SourcePath) + "..\\dist\\installer-package"
#define MyOutputDir AddBackslash(SourcePath) + "..\\dist\\installer-output"

[Setup]
AppId={{A6A6A699-2B0A-4E42-AF36-39A89B327A10}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
DefaultDirName={localappdata}\Programs\Syspro Scheduler
DefaultGroupName=Syspro Scheduler
UninstallDisplayIcon={app}\{#MyAppExeName}
Compression=lzma
SolidCompression=yes
WizardStyle=modern
OutputDir={#MyOutputDir}
OutputBaseFilename=SysproSchedulerSetup
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"

[Files]
Source: "{#MyStageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Syspro Scheduler"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Stop Syspro Scheduler"; Filename: "{app}\STOP_SYSPRO_SCHEDULER.cmd"
Name: "{group}\Uninstall Syspro Scheduler"; Filename: "{uninstallexe}"
Name: "{autodesktop}\Syspro Scheduler"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Launch Syspro Scheduler"; Flags: nowait postinstall skipifsilent
