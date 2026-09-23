# Install the remote MCP server as an NSSM Windows service.
# Run elevated.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
#
# Prereqs: `.env` present (copy from .env.example — no secrets), `npm ci` done, Node >= 20.
# After install, put an HTTPS reverse proxy / tunnel in front of it, mapping your public hostname
# to 127.0.0.1:$MCP_HTTP_PORT.

$ErrorActionPreference = 'Stop'
$svc  = 'jwx-mcp'
$dir  = Split-Path -Parent $PSScriptRoot           # repo root
$node = (Get-Command node).Source
$log  = Join-Path $dir 'jwx-mcp.log'

if (-not (Test-Path (Join-Path $dir '.env'))) { throw "Missing $dir\.env — copy from .env.example first." }

if (Get-Service -Name $svc -ErrorAction SilentlyContinue) {
  Write-Host "Service $svc exists — stopping to reconfigure."
  & nssm stop $svc
} else {
  & nssm install $svc $node
}

& nssm set $svc AppDirectory   $dir
& nssm set $svc AppParameters  '--env-file=.env src\http-entry.js'
& nssm set $svc AppStdout      $log
& nssm set $svc AppStderr      $log
& nssm set $svc AppRotateFiles 1
& nssm set $svc Start          SERVICE_AUTO_START
& nssm start $svc

Start-Sleep -Seconds 3
Get-Service $svc | Select-Object Name, Status
Write-Host "--- last log lines ---"
if (Test-Path $log) { Get-Content $log -Tail 8 }
$port = if ($env:MCP_HTTP_PORT) { $env:MCP_HTTP_PORT } else { '8791' }
Write-Host "Smoke: curl http://127.0.0.1:$port/healthz"
