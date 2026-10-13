$ErrorActionPreference = "SilentlyContinue"

$base = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $base

try {
  $res = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:8080" -TimeoutSec 3
  if ($res.StatusCode -ge 200 -and $res.StatusCode -lt 500) {
    exit 0
  }
} catch {}

$env:PORT = "8080"
node server.js
