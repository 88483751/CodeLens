# CodeLens one-click release: build UI, pack sources, upload and deploy to ECS.
# Run from Windows PowerShell:
#   powershell -ExecutionPolicy Bypass -File deploy\pack.ps1
#   powershell -ExecutionPolicy Bypass -File deploy\pack.ps1 -ServerIp 121.41.29.215
#   powershell -ExecutionPolicy Bypass -File deploy\pack.ps1 -SkipBuild   # reuse existing dist

param(
    [string]$ServerIp = "121.41.29.215",
    [string]$SshUser  = "root",
    [int]$WebPort     = 8080,
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$root      = Split-Path -Parent $PSScriptRoot
$remoteTgz = "/tmp/codelens-src.tar.gz"
$localTgz  = Join-Path $env:TEMP "codelens-src.tar.gz"
$tmpScript = Join-Path $env:TEMP "codelens-bootstrap.sh"
$target    = "$SshUser@$ServerIp"

function Assert-LastExit([string]$what) {
    if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" }
}

# ---------------------------------------------------------------- 1. build UI
Write-Host "[1/5] Building frontend ..." -ForegroundColor Cyan
if (-not $SkipBuild) {
    Push-Location (Join-Path $root "codelens-prototype")
    try {
        npm run build
        Assert-LastExit "npm run build"
    } finally {
        Pop-Location
    }
} else {
    Write-Host "      skipped (-SkipBuild)"
}
$distIndex = Join-Path $root "codelens-prototype\dist\index.html"
if (-not (Test-Path $distIndex)) {
    throw "codelens-prototype\dist\index.html not found. Run 'npm run build' in codelens-prototype first."
}

# ---------------------------------------------------------------- 2. pack
Write-Host "[2/5] Packing sources ..." -ForegroundColor Cyan
if (Test-Path $localTgz) { Remove-Item $localTgz -Force }
& tar.exe -czf $localTgz -C $root `
    --exclude=__pycache__ --exclude=*.pyc --exclude=.venv --exclude=node_modules `
    code "codelens-prototype/dist" deploy requirements-backend.txt
Assert-LastExit "tar"
$sizeMb = [math]::Round((Get-Item $localTgz).Length / 1MB, 1)
Write-Host "      package: $localTgz ($sizeMb MB)"

# Normalize the bootstrap script to LF so bash on Linux can execute it.
$scriptText = (Get-Content -Raw (Join-Path $PSScriptRoot "bootstrap.sh")) -replace "`r`n", "`n"
$utf8NoBom  = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($tmpScript, $scriptText, $utf8NoBom)

# ---------------------------------------------------------------- 3. upload
Write-Host "[3/5] Uploading bootstrap script ..." -ForegroundColor Cyan
& scp -o StrictHostKeyChecking=accept-new $tmpScript "${target}:/tmp/bootstrap.sh"
Assert-LastExit "scp bootstrap.sh"

Write-Host "[4/5] Uploading package ..." -ForegroundColor Cyan
& scp -o StrictHostKeyChecking=accept-new $localTgz "${target}:$remoteTgz"
Assert-LastExit "scp package"

# ---------------------------------------------------------------- 4. deploy
Write-Host "[5/5] Running remote bootstrap (2-4 min on first run) ..." -ForegroundColor Cyan
& ssh -o StrictHostKeyChecking=accept-new $target "bash /tmp/bootstrap.sh $remoteTgz"
Assert-LastExit "remote bootstrap"

Write-Host ""
Write-Host "Done.  Open:  http://${ServerIp}:${WebPort}/" -ForegroundColor Green
Write-Host "Logs:  ssh ${target} 'journalctl -u codelens -n 50 --no-pager'"
