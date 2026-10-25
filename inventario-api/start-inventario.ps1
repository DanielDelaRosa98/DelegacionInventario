param(
  [switch]$Restart
)

$ErrorActionPreference = "SilentlyContinue"

$base = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $base

if ($Restart) {
  $conn = Get-NetTCPConnection -LocalPort 8080 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($pidToKill in $conn) {
    if ($pidToKill -gt 0) {
      Stop-Process -Id $pidToKill -Force -ErrorAction SilentlyContinue
    }
  }
  Start-Sleep -Milliseconds 800
} else {
  try {
    $res = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:8080" -TimeoutSec 3
    if ($res.StatusCode -ge 200 -and $res.StatusCode -lt 500) {
      exit 0
    }
  } catch {}
}

$env:PORT = "8080"
node server.js
