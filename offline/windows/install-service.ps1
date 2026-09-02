# RSMS Offline Server - NSSM Windows service installer (Phase C)
#
# Run from an ELEVATED prompt on the school PC:
#   powershell -ExecutionPolicy Bypass -File .\install-service.ps1 -InstallDir "C:\ProgramData\RSMS-Offline"
#
# Requires:
#   - Node.js LTS (22.5+) on PATH or -NodePath
#   - nssm.exe (Nt Service Scheduler Manager) in -NssmDir or on PATH
#
# The service:
#   - starts automatically after reboot (SERVICE_AUTO_START)
#   - restarts itself on any exit, after 5 seconds (AppExit)
#   - writes stdout/stderr to %InstallDir%\logs\service-*.log
#   - runs the server with --experimental-sqlite (Node 22)
#
# NOTE: nssm writes diagnostics to stderr in NORMAL operation (e.g.
# "Can't open service!" when the service does not exist yet), so this
# script must never use $ErrorActionPreference = "Stop" with native
# calls. All nssm calls go through Run-Nssm, which swallows stderr and
# checks the exit code.
param(
  [string]$InstallDir = "C:\ProgramData\RSMS-Offline",
  [string]$ServiceName = "RSMSOffline",
  [string]$NodePath = "node",
  [string]$NssmDir = $env:ProgramFiles + "\RSMSOffline\nssm",
  [int]$Port = 8300
)

$ErrorActionPreference = "Continue"
$server = Join-Path $InstallDir "offline\server\index.js"
if (-not (Test-Path $server)) {
  Write-Error "Server not found at $server - run the RSMS installer first."
  exit 1
}
$nssm = Join-Path $NssmDir "nssm.exe"
if (-not (Test-Path $nssm)) {
  $cmd = Get-Command nssm -ErrorAction SilentlyContinue
  if ($cmd) { $nssm = $cmd.Source } else {
    Write-Error "nssm.exe not found in $NssmDir or on PATH."
    exit 1
  }
}
$node = if ((Get-Command $NodePath -ErrorAction SilentlyContinue)) { $NodePath } else { "node" }

$logDir = Join-Path $InstallDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$dataDir = Join-Path $InstallDir "offline\data"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

function Run-Nssm([string[]]$nssmArgs) {
  & $nssm @nssmArgs 2>&1 | Out-Null
  return $LASTEXITCODE
}

# Idempotent upgrades: remove a previous installation first.
if ((Run-Nssm @("status", $ServiceName)) -eq 0) {
  Run-Nssm @("stop", $ServiceName) | Out-Null
  Start-Sleep 2
}
Run-Nssm @("remove", $ServiceName, "confirm") | Out-Null

if ((Run-Nssm @("install", $ServiceName, $node)) -ne 0) {
  Write-Error "nssm install failed (exit code above) - is this prompt elevated (Run as administrator)?"
  exit 1
}

Run-Nssm @("set", $ServiceName, "AppParameters", "--experimental-sqlite `"$server`"") | Out-Null
Run-Nssm @("set", $ServiceName, "AppDirectory", $InstallDir) | Out-Null
Run-Nssm @("set", $ServiceName, "Start", "SERVICE_AUTO_START") | Out-Null
Run-Nssm @("set", $ServiceName, "AppStdout", "$logDir\service-out.log") | Out-Null
Run-Nssm @("set", $ServiceName, "AppStderr", "$logDir\service-err.log") | Out-Null
Run-Nssm @("set", $ServiceName, "AppRotateFiles", "1") | Out-Null
Run-Nssm @("set", $ServiceName, "AppRotateBytes", "5242880") | Out-Null
# Self-heal: restart after any exit, 5s delay.
Run-Nssm @("set", $ServiceName, "AppExit", "Restart", "5000") | Out-Null
Run-Nssm @("set", $ServiceName, "AppRestartDelay", "5000") | Out-Null

# PORT + nightly backup schedule. BACKUP_ENABLED=1 is the default.
Run-Nssm @("set", $ServiceName, "AppEnvironmentExtra", "PORT=$Port`nBACKUP_HOUR=3`nBACKUP_MINUTE=15`nBACKUP_ENABLED=1") | Out-Null

# nssm start can return non-zero even when the service does come up
# (it gives up before the start handshake completes), so verify with
# sc query instead of trusting the exit code.
Run-Nssm @("start", $ServiceName) | Out-Null
$running = $false
for ($i = 0; $i -lt 15; $i++) {
  $q = (sc.exe query $ServiceName 2>$null | Select-String "STATE")
  if ($q -match "RUNNING") { $running = $true; break }
  Start-Sleep 1
}
if (-not $running) {
  Write-Error "Service did not reach RUNNING within 15s - check $logDir\service-err.log"
  exit 1
}

Write-Host ""
Write-Host "Service $ServiceName installed and started." -ForegroundColor Green
Write-Host "  Health:      http://localhost:$Port/health"
Write-Host "  Wizard:      http://localhost:$Port/wizard.html (staff session)"
Write-Host "  Logs:        $logDir"
Write-Host "  Data:        $dataDir  (SQLite + backups/ subfolder)"
Write-Host "Uninstall:     .\uninstall-service.ps1"
