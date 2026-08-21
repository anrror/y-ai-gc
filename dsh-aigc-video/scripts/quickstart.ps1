#!/usr/bin/env pwsh
<#
.SYNOPSIS
    One-shot setup for dsh-aigc-video: installs deps, builds, installs ffmpeg,
    runs a dry-run to verify the pipeline.

.DESCRIPTION
    Designed for first-time users — gets from "git clone" to "I saw a final.mp4
    appear in <1 minute" with no manual steps.

    Re-runnable: each step is idempotent (npm install skips if up to date,
    winget install is a no-op if ffmpeg is already present, dry-run is safe).

.EXAMPLE
    pwsh -File scripts/quickstart.ps1
    # Or, if execution policy allows:
    .\scripts\quickstart.ps1
#>

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $root

Write-Host "`n[quickstart] Working directory: $root`n" -ForegroundColor Cyan

# ── Step 1: npm install ──────────────────────────────────────────────────
Write-Host "[1/4] npm install ..." -ForegroundColor Yellow
if (Test-Path node_modules) {
    Write-Host "  [skip] node_modules already present.`n"
} else {
    npm install 2>&1 | Select-Object -Last 5
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
}

# ── Step 2: build (tsc) ───────────────────────────────────────────────────
Write-Host "[2/4] npm run build ..." -ForegroundColor Yellow
npm run build 2>&1 | Select-Object -Last 3
if ($LASTEXITCODE -ne 0) { throw "build failed" }

# ── Step 3: ffmpeg (optional but recommended) ─────────────────────────────
Write-Host "[3/4] ffmpeg ..." -ForegroundColor Yellow
$ffmpeg = Get-Command ffmpeg -ErrorAction SilentlyContinue
if ($ffmpeg) {
    Write-Host "  [skip] ffmpeg already at: $($ffmpeg.Source)`n"
} else {
    Write-Host "  ffmpeg not found; installing via winget ..." -ForegroundColor DarkYellow
    $hasWinget = Get-Command winget -ErrorAction SilentlyContinue
    if (-not $hasWinget) {
        Write-Host "  [warn] winget not available. Install ffmpeg manually: choco install ffmpeg" -ForegroundColor DarkYellow
    } else {
        winget install -e --id Gyan.FFmpeg 2>&1 | Select-Object -Last 5
        if ($LASTEXITCODE -eq 0) {
            Write-Host "  ✅ ffmpeg installed (restart shell if PATH not refreshed)`n" -ForegroundColor Green
        } else {
            Write-Host "  [warn] winget install returned non-zero; you may need to install manually.`n" -ForegroundColor DarkYellow
        }
    }
}

# ── Step 4: dry-run to verify everything works ───────────────────────────
Write-Host "[4/4] dry-run validation ..." -ForegroundColor Yellow
if (-not (Test-Path code\result\jb.md)) {
    Write-Host "  [skip] code\result\jb.md missing (no script to dry-run). You can run manually:`n" -ForegroundColor DarkYellow
    Write-Host "    node bin\creative-to-video.mjs <your-script.md> --dry-run --max-shots 4`n" -ForegroundColor Gray
} else {
    node bin\creative-to-video.mjs code\result\jb.md --dry-run --max-shots 4 2>&1 | Select-Object -Last 15
    if ($LASTEXITCODE -ne 0) { throw "dry-run failed" }
}

Write-Host "`n[quickstart] ✅ all 4 steps completed." -ForegroundColor Green
Write-Host "  Next: set MINIMAX_API_KEY and run a real e2e (consumes Hailuo quota):`n"
Write-Host "    `$env:MINIMAX_API_KEY = '...'" -ForegroundColor Gray
Write-Host "    node bin\creative-to-video.mjs code\result\jb.md --max-shots 4 --reference C:\path\to\face.jpg`n" -ForegroundColor Gray
Write-Host "  See README.md and dsh-aigc-video/README.md for full docs.`n"