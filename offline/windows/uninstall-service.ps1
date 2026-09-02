# RSMS Offline Server - NSSM service uninstaller (Phase C)
#
# ELEVATED prompt:
#   powershell -ExecutionPolicy Bypass -File .\uninstall-service.ps1
#
# The SQLite database in offline\data\ is NOT deleted - take a
# verified backup (/api/admin/backup) before removing the folder.
#
# NOTE: same PS 5.1 stderr rule as install-service.ps1 - nssm chatter
# goes through Run-Nssm, never a bare native call under Stop.
param(
  [string]$ServiceName = "RSMSOffline",
  [string]$NssmDir = $env:ProgramFiles + "\RSMSOffline\nssm"
)

$ErrorActionPreference = "Continue"
$nssm = Join-Path $NssmDir "nssm.exe"
if (-not (Test-Path $nssm)) {
  $cmd = Get-Command nssm -ErrorAction SilentlyContinue
  if ($cmd) { $nssm = $cmd.Source } else {
    Write-Error "nssm.exe not found in $NssmDir or on PATH."
    exit 1
  }
}

function Run-Nssm([string[]]$nssmArgs) {
  & $nssm @nssmArgs 2>&1 | Out-Null
  return $LASTEXITCODE
}

if ((Run-Nssm @("status", $ServiceName)) -eq 0) {
  Run-Nssm @("stop", $ServiceName) | Out-Null
  Start-Sleep 2
}
Run-Nssm @("remove", $ServiceName, "confirm") | Out-Null
Write-Host "Service $ServiceName removed. The database in offline\data\ was kept." -ForegroundColor Green
