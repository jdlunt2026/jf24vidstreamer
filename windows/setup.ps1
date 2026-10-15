# One-time setup on Windows: installs Node.js and FFmpeg (via winget) if they're
# missing, installs npm packages, and creates .env.
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

# --- FFmpeg --------------------------------------------------------------------
# Gyan's "full" build includes libx264, libopus, NVENC, Quick Sync and AMF.
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Install-WithWinget "Gyan.FFmpeg" "FFmpeg"
}
$ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
if (-not $ffmpeg) {
    throw "FFmpeg was installed but isn't on PATH yet. Open a new terminal and re-run this script."
}
Write-Host "FFmpeg: $ffmpeg" -ForegroundColor Green

# --- npm packages --------------------------------------------------------------
Write-Host "Installing npm packages..." -ForegroundColor Cyan
& npm ci --omit=dev
if ($LASTEXITCODE -ne 0) { throw "npm ci failed (exit $LASTEXITCODE)" }

# --- .env ----------------------------------------------------------------------
$envFile = Join-Path $Root ".env"
if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path $Root ".env.example") $envFile
    Write-Host "Created .env from .env.example" -ForegroundColor Green
}
# Record ffmpeg's full path so the bot finds it even when started by Task
# Scheduler, which doesn't always see PATH changes made by winget.
$content = Get-Content $envFile -Raw
if ($content -match "(?m)^FFMPEG_PATH=[^\r\n]*") {
    $content = $content -replace "(?m)^FFMPEG_PATH=[^\r\n]*", "FFMPEG_PATH=$ffmpeg"
} else {
    $content = $content.TrimEnd() + "`r`nFFMPEG_PATH=$ffmpeg`r`n"
}
[IO.File]::WriteAllText($envFile, $content)  # UTF-8 without BOM

# --- Hardware encoders ---------------------------------------------------------
$encoders = & $ffmpeg -hide_banner -encoders 2>$null | Out-String
$found = @()
if ($encoders -match "h264_nvenc") { $found += "nvenc (NVIDIA)" }
if ($encoders -match "h264_qsv")   { $found += "qsv (Intel)" }
if ($encoders -match "h264_amf")   { $found += "amf (AMD)" }
if ($found) {
    Write-Host "Your FFmpeg supports these GPU encoders (STREAM_ENCODER): $($found -join ', ')"
    Write-Host "They only work if you actually have that GPU."
}

Write-Host ""
Write-Host "Setup done. Next:" -ForegroundColor Green
Write-Host "  1. Fill in .env (opening it in Notepad now)"
Write-Host "  2. Run windows\start.cmd to start streaming"
Write-Host "  3. Optional: windows\autostart.cmd to start it automatically with Windows"
Start-Process notepad.exe $envFile
