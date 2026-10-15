# One-time setup on Windows: installs Node.js (and optionally cloudflared) via
# winget if missing, installs npm packages, builds the Activity client, and
# creates .env.
#
# Run from the repo folder:  windows\setup.cmd
# (or: powershell -ExecutionPolicy Bypass -File windows\setup.ps1)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Refresh-Path {
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [Environment]::GetEnvironmentVariable("Path", "User")
}

function Install-WithWinget($id, $name) {
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        throw "$name is not installed and winget isn't available. Install $name manually, then re-run this script."
    }
    Write-Host "Installing $name with winget..." -ForegroundColor Cyan
    winget install --id $id --exact --silent --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "winget failed to install $name (exit $LASTEXITCODE)" }
    Refresh-Path
}

# --- Node.js 22+ -------------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
$nodeMajor = 0
if ($node) { $nodeMajor = [int]((& node --version).TrimStart("v").Split(".")[0]) }
if ($nodeMajor -lt 22) {
    if ($node) { Write-Host "Node.js $(& node --version) is too old (need 22+)." -ForegroundColor Yellow }
    Install-WithWinget "OpenJS.NodeJS.LTS" "Node.js LTS"
}
Write-Host "Node.js $(& node --version)" -ForegroundColor Green

# --- cloudflared (optional) ----------------------------------------------------
# Discord has to reach this server over public HTTPS. A Cloudflare Tunnel is
# the recommended way; see README "Make the server reachable".
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    $answer = Read-Host "Install cloudflared for a Cloudflare Tunnel? [Y/n]"
    if ($answer -notmatch "^[nN]") { Install-WithWinget "Cloudflare.cloudflared" "cloudflared" }
}

# --- npm packages + client build -----------------------------------------------
Write-Host "Installing npm packages..." -ForegroundColor Cyan
& npm ci
if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE)" }

Write-Host "Building the Activity client..." -ForegroundColor Cyan
& npm run build
if ($LASTEXITCODE -ne 0) { throw "npm run build failed (exit $LASTEXITCODE)" }

# --- .env ----------------------------------------------------------------------
$envFile = Join-Path $Root ".env"
if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path $Root ".env.example") $envFile
    Write-Host "Created .env from .env.example" -ForegroundColor Green
}

Write-Host ""
Write-Host "Setup done. Next (details in README.md):" -ForegroundColor Green
Write-Host "  1. Fill in .env (opening it in Notepad now)"
Write-Host "  2. Run windows\start.cmd"
Write-Host "  3. Point your tunnel at http://localhost:8080 and set the Discord URL mapping"
Write-Host "  4. Optional: windows\autostart.cmd to start it automatically with Windows"
Start-Process notepad.exe $envFile
