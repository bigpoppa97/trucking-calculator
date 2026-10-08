# Boots the calculator + a public Cloudflare tunnel for team testing.
#
# Usage: right-click → "Run with PowerShell", or from a terminal:
#   powershell -ExecutionPolicy Bypass -File scripts\start-hosting.ps1
#
# The public URL is printed by cloudflared below (https://….trycloudflare.com)
# and CHANGES on every restart. Keep this window open and the PC awake while
# the team is testing; closing the window stops the tunnel.

$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo

# Node via fnm (no-admin install lives in ~\.fnm)
& "$env:USERPROFILE\.fnm\fnm.exe" env | Out-String | Invoke-Expression
& "$env:USERPROFILE\.fnm\fnm.exe" use lts-latest

# Backend (reads HERE_API_KEY etc. from .env; serves web/dist + /api on :3001).
# If autostart (scripts\kalkulator-serwer.cmd) already runs it, reuse that one.
$backend = $null
if (Get-NetTCPConnection -LocalPort 3001 -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "Backend already running on :3001 (autostart) - reusing it."
} else {
    $node = (Get-Command node).Source
    $backend = Start-Process -FilePath $node -ArgumentList "--env-file=.env", "--import", "tsx", "src/server/index.ts" -NoNewWindow -PassThru
    Write-Host "Backend PID: $($backend.Id) — http://127.0.0.1:3001"
    Start-Sleep 4
}

# Public tunnel (foreground — the URL appears in the box below)
& "$env:USERPROFILE\.cloudflared\cloudflared.exe" tunnel --url http://127.0.0.1:3001 --no-autoupdate

# Tunnel ended — stop the backend too (only if this script started it).
if ($backend) { Stop-Process -Id $backend.Id -Force -Confirm:$false -ErrorAction SilentlyContinue }
