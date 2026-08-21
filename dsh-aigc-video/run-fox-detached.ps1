$ErrorActionPreference = 'Stop'
$key = $env:MINIMAX_API_KEY
if (-not $key -or $key.Length -lt 50) {
  Write-Error "MINIMAX_API_KEY not set"
  exit 1
}
$td = 'E:\code\ai\y-ai-gc\aigc-director\dsh-aigc-video'
Set-Location $td

# Kill any prior fox-real-run or fox-run2 processes.
Get-Process node -EA SilentlyContinue | Where-Object { $_.CommandLine -match 'creative-to-video' } | ForEach-Object {
  Stop-Process -Id $_.Id -Force -EA SilentlyContinue
}
Start-Sleep -Milliseconds 500

# Build the args (cmd-style, no PowerShell quoting headaches).
$mdPath = 'D:/down/自作聪明的傻狐狸.md'
$project = "fox-run2"
$maxShots = 2  # 2 remaining Hailuo tokens today
$logFile = "$td\fox-run2.log"
if (Test-Path $logFile) { Remove-Item $logFile -Force }

# Launch detached.
$proc = Start-Process -FilePath 'node' `
  -ArgumentList 'bin/creative-to-video.mjs', $mdPath, '--max-shots', "$maxShots", '--project', $project `
  -WorkingDirectory $td `
  -RedirectStandardOutput $logFile `
  -RedirectStandardError "$logFile.err" `
  -WindowStyle Hidden -PassThru

Write-Output "started pid=$($proc.Id) project=$project max_shots=$maxShots log=$logFile"
$proc.Id | Out-File "$td\fox-run2.pid" -Encoding ascii