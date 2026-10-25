$base = Split-Path -Parent $MyInvocation.MyCommand.Path
& "$base\start-inventario.ps1" -Restart
