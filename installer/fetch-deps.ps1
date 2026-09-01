# ═══════════════════════════════════════════════════════════════
# RSMS Offline — installer dependency fetcher (Phase C)
#
# Run on the Windows machine that builds the installer:
#   powershell -ExecutionPolicy Bypass -File .\fetch-deps.ps1
#
# Downloads (version-pinned):
#   - Node.js 22.22.3 win-x64 (single node.exe portable runtime)
#   - nssm 2.24 (service wrapper)
# into .\vendor\  — the exact layout installer\rsms-offline.iss expects.
# Requires only PowerShell 5+ and the built-in tar (Windows 10+).
# ═══════════════════════════════════════════════════════════════
$ErrorActionPreference = "Stop"
$vendor = Join-Path $PSScriptRoot "vendor"
$nodeDir = Join-Path $vendor "node-runtime"
$nssmDir = Join-Path $vendor "nssm"
New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
New-Item -ItemType Directory -Force -Path $nssmDir | Out-Null

function Fetch([string]$url, [string]$out) {
  Write-Host "Downloading $url ..."
  Invoke-WebRequest -Uri $url -OutFile $out -UseBasicParsing
  Write-Host ("  saved {0} ({1:N0} bytes)" -f (Split-Path $out -Leaf), ((Get-Item $out).Length))
}

# ── Node 22.22.3 win-x64 ────────────────────────────────────────
$nodeExe = Join-Path $nodeDir "node.exe"
if (-not (Test-Path $nodeExe) -or ((Get-Item $nodeExe).Length -lt 50MB)) {
  $tgz = Join-Path $env:TEMP "node-win-x64-22.22.3.tgz"
  Fetch "https://registry.npmjs.org/node-win-x64/-/node-win-x64-22.22.3.tgz" $tgz
  tar -xzf $tgz -C $env:TEMP
  Copy-Item (Join-Path $env:TEMP "package\bin\node.exe") $nodeExe -Force
  Remove-Item $tgz -Force
  Remove-Item (Join-Path $env:TEMP "package") -Recurse -Force
  if ((Get-Item $nodeExe).Length -lt 50MB) { throw "node.exe too small — download failed" }
} else {
  Write-Host "node.exe already present."
}

# ── nssm 2.24 ───────────────────────────────────────────────────
$nssmExe = Join-Path $nssmDir "nssm.exe"
if (-not (Test-Path $nssmExe)) {
  $tgz = Join-Path $env:TEMP "nssm-0.1.1.tgz"
  Fetch "https://registry.npmjs.org/nssm/-/nssm-0.1.1.tgz" $tgz
  tar -xzf $tgz -C $env:TEMP
  Copy-Item (Join-Path $env:TEMP "package\examples\nssm.exe") $nssmExe -Force
  Remove-Item $tgz -Force
  Remove-Item (Join-Path $env:TEMP "package") -Recurse -Force
} else {
  Write-Host "nssm.exe already present."
}

Write-Host ""
Write-Host "Dependencies ready:" -ForegroundColor Green
Write-Host "  $nodeExe"
Write-Host "  $nssmExe"
Write-Host "Next:  iscc .\rsms-offline.iss"
