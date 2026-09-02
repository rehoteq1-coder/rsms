# ===============================================================
# RSMS Offline Server - NSSM service uninstaller (Phase C)
#
# ELEVATED prompt:
#   powershell -ExecutionPolicy Bypass -File .\uninstall-service.ps1
#
# The SQLite database in offline\data\ is NOT deleted - take a
# verified backup (/api/admin/backup) before removing the folder.
# ===============================================================
param(
  [string]$ServiceName = "RSMSOffline",
  [string]$NssmDir = $env:ProgramFiles + "\RSMSOffline\nssm"
)

$ErrorActionPreference = "Stop"
$nssm = Join-Path $NssmDir "nssm.exe"
if (-not (Test-Path $nssm)) {
  $cmd = Get-Command nssm -ErrorAction SilentlyContinue
  if ($cmd) { $nssm = $cmd.Source } else { Write-Error "nssm.exe not found." }
}

& $nssm status $ServiceName 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  & $nssm stop $ServiceName | Out-Null
  Start-Sleep 2
}
& $nssm remove $ServiceName confirm
Write-Host "Service $ServiceName removed. The database in offline\data\ was kept." -ForegroundColor Green
