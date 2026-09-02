# ===============================================================
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
# ===============================================================
param(
  [string]$InstallDir = "C:\ProgramData\RSMS-Offline",
  [string]$ServiceName = "RSMSOffline",
  [string]$NodePath = "node",
  [string]$NssmDir = $env:ProgramFiles + "\RSMSOffline\nssm",
  [int]$Port = 8300
)

$ErrorActionPreference = "Stop"
$server = Join-Path $InstallDir "offline\server\index.js"
if (-not (Test-Path $server)) {
  Write-Error "Server not found at $server - run the RSMS installer first."
}
$nssm = Join-Path $NssmDir "nssm.exe"
if (-not (Test-Path $nssm)) {
  $cmd = Get-Command nssm -ErrorAction SilentlyContinue
  if ($cmd) { $nssm = $cmd.Source } else {
    Write-Error "nssm.exe not found in $NssmDir or on PATH."
  }
}
$node = if ((Get-Command $NodePath -ErrorAction SilentlyContinue)) { $NodePath } else { "node" }

$logDir = Join-Path $InstallDir "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$dataDir = Join-Path $InstallDir "offline\data"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

# Idempotent upgrades: remove a previous installation first.
if (& $nssm status $ServiceName 2>$null) { & $nssm stop $ServiceName | Out-Null; Start-Sleep 2 }
& $nssm remove $ServiceName confirm 2>$null
& $nssm install $ServiceName $node | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error "nssm install failed ($LASTEXITCODE)" }

& $nssm set $ServiceName AppParameters "--experimental-sqlite `"$server`""
& $nssm set $ServiceName AppDirectory $InstallDir
& $nssm set $ServiceName Start SERVICE_AUTO_START
& $nssm set $ServiceName AppStdout "$logDir\service-out.log"
& $nssm set $ServiceName AppStderr "$logDir\service-err.log"
& $nssm set $ServiceName AppRotateFiles 1
& $nssm set $ServiceName AppRotateBytes 5242880
# Self-heal: restart after any exit, 5s delay, unlimited attempts.
& $nssm set $ServiceName AppExit Default Restart
& $nssm set $ServiceName AppRestartDelay 5000

# PORT + nightly backup schedule. BACKUP_ENABLED=1 is the default.
& $nssm set $ServiceName AppEnvironmentExtra "PORT=$Port`nBACKUP_HOUR=3`nBACKUP_MINUTE=15`nBACKUP_ENABLED=1"

& $nssm start $ServiceName
Write-Host ""
Write-Host "Service $ServiceName installed and started." -ForegroundColor Green
Write-Host "  Health:      http://localhost:$Port/health"
Write-Host "  Wizard:      http://localhost:$Port/wizard.html (staff session)"
Write-Host "  Logs:        $logDir"
Write-Host "  Data:        $dataDir  (SQLite + backups/ subfolder)"
Write-Host "Uninstall:     .\uninstall-service.ps1"
