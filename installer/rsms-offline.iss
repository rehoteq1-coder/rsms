; ═══════════════════════════════════════════════════════════════
; RSMS Offline Server — Windows installer (Phase C)
;
; Build with Inno Setup 6 (ISCC):
;   iscc installer\rsms-offline.iss
;
; Layout the source tree as:
;   <root>\offline\            (server, vendor, tests — from this repo)
;   <root>\installer\          (this script)
;   <root>\installer\bin\nssm\nssm.exe   (nssm 2.24+)
;   <root>\installer\node\    (portable Node 22 LTS — node.exe etc.)
;
; The installer copies everything, creates shortcuts, and (as
; post-install) runs the NSSM service installer elevated.
; ═══════════════════════════════════════════════════════════════
#define MyAppName "RSMS Offline Server"
#define MyAppVersion "0.3.0"
#define MyAppPublisher "RSMS Platform"
#define InstallRoot "C:\ProgramData\RSMS-Offline"

[Setup]
AppId={{B7E2C4A1-9F3D-4E5A-8C6B-01A03E3900}}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={#InstallRoot}
DefaultGroupName=RSMS
DisableDirPage=auto
PrivilegesRequired=admin
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=output
OutputBaseFilename=rsms-offline-setup-{#MyAppVersion}
SetupIconFile=
WizardStyle=modern
UninstallDisplayIcon={app}\uninstall.exe
Compression=lzma2
SolidCompression=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; The offline server (server code, vendored assets, tests optional)
Source: "..\offline\server\*"; DestDir: "{app}\offline\server"; Flags: recursesubdirs
Source: "..\offline\rsms-local-adapter.js"; DestDir: "{app}\offline"
Source: "..\offline\package.json"; DestDir: "{app}\offline"
; NSSM service tool
Source: "bin\nssm\nssm.exe"; DestDir: "{app}\nssm"
; Portable Node runtime (the appliance may have no other Node)
Source: "node\*"; DestDir: "{app}\node-runtime"; Flags: recursesubdirs
; Service management scripts
Source: "..\offline\windows\install-service.ps1"; DestDir: "{app}"
Source: "..\offline\windows\uninstall-service.ps1"; DestDir: "{app}"

[Dirs]
Name: "{app}\offline\data"; Permissions: users-modify
Name: "{app}\logs"

[Icons]
Name: "{group}\RSMS Health"; Filename: "http://localhost:8300/health"
Name: "{group}\RSMS First-run Wizard"; Filename: "http://localhost:8300/wizard.html"
Name: "{group}\RSMS Staff Login"; Filename: "http://localhost:8300/staff-login.html"
Name: "{group}\Uninstall RSMS Offline"; Filename: "{uninstallexe}"
Name: "{autodesktop}\RSMS Offline (Health)"; Filename: "http://localhost:8300/health"

[Run]
; Install + start the NSSM service (elevated context is guaranteed).
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install-service.ps1"" -InstallDir ""{app}"" -NodePath ""{app}\node-runtime\node.exe"" -NssmDir ""{app}\nssm"""; \
  Flags: runhidden waittocomplete

[UninstallRun]
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\uninstall-service.ps1"" -NssmDir ""{app}\nssm"""; \
  Flags: runhidden waittocomplete

[UninstallDelete]
; The service was stopped/removed above; the database is intentionally
; kept — the operator decides after a final backup.
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\nssm"
Type: filesandordirs; Name: "{app}\node-runtime"
