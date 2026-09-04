; ===============================================================
; RSMS Offline Server - Windows installer (Phase C)
;
; Build with Inno Setup 6 (ISCC):
;   iscc installer\rsms-offline.iss
;
; Layout the source tree as:
;   <root>\offline\            (server, vendor, tests - from this repo)
;   <root>\offline\node_modules\  (run `npm install` in offline/)
;   <root>\installer\          (this script)
;   <root>\installer\vendor\nssm\nssm.exe   (from fetch-deps.ps1)
;   <root>\installer\vendor\node-runtime\node.exe  (from fetch-deps.ps1)
;
; The installer copies everything, creates shortcuts, and (as
; post-install) runs the NSSM service installer elevated.
;
; NOTE: the built setup.exe is unsigned - Windows SmartScreen will show
; "More info -> Run anyway" on first launch. Obtain a code-signing
; certificate from the operator's CA and sign the output when available.
; ===============================================================
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
; The offline server (server code, vendored portal assets)
Source: "..\offline\server\*"; DestDir: "{app}\offline\server"; Flags: recursesubdirs
; Server runtime dependency (express) - committed-free, from npm
Source: "..\offline\node_modules\*"; DestDir: "{app}\offline\node_modules"; Flags: recursesubdirs
Source: "..\offline\rsms-local-adapter.js"; DestDir: "{app}\offline"
Source: "..\offline\package.json"; DestDir: "{app}\offline"
; Portal pages: the offline server serves the web portal from the
; install root (REPO_ROOT in server/index.js), so every root-level
; portal file must ship. (installer-packaging.test.js enforces this
; list against the repo contents.)
Source: "..\*.html"; DestDir: "{app}"
Source: "..\*.js"; DestDir: "{app}"
Source: "..\rsms-core.css"; DestDir: "{app}"
Source: "..\manifest.json"; DestDir: "{app}"
Source: "..\manifest-control.json"; DestDir: "{app}"
Source: "..\icon-192.png"; DestDir: "{app}"
Source: "..\icon-ctrl-192.png"; DestDir: "{app}"
; NSSM service tool
Source: "vendor\nssm\nssm.exe"; DestDir: "{app}\nssm"
; Portable Node 22 runtime (the appliance may have no other Node)
Source: "vendor\node-runtime\node.exe"; DestDir: "{app}\node-runtime"
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
  Flags: runhidden

[UninstallRun]
Filename: "powershell.exe"; \
  Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\uninstall-service.ps1"" -NssmDir ""{app}\nssm"""; \
  Flags: runhidden; RunOnceId: remove-service

[UninstallDelete]
; The service was stopped/removed above; the database is intentionally
; kept - the operator decides after a final backup.
Type: filesandordirs; Name: "{app}\logs"
Type: filesandordirs; Name: "{app}\nssm"
Type: filesandordirs; Name: "{app}\node-runtime"
