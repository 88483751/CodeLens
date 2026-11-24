# CodeLens release packer for a WINDOWS target server.
# Run on your own PC, from the repo root:
#   powershell -ExecutionPolicy Bypass -File deploy\windows\pack.ps1
# Output: %USERPROFILE%\Desktop\codelens-release.zip  (copy it to C:\ on the server)

param(
    [string]$OutZip = "$env:USERPROFILE\Desktop\codelens-release.zip",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

function Assert-LastExit([string]$what) {
    if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" }
}

Write-Host "[1/3] Building frontend ..." -ForegroundColor Cyan
if (-not $SkipBuild) {
    Push-Location (Join-Path $root "codelens-prototype")
    try {
        npm run build
        Assert-LastExit "npm run build"
    } finally {
        Pop-Location
    }
}
if (-not (Test-Path (Join-Path $root "codelens-prototype\dist\index.html"))) {
    throw "codelens-prototype\dist\index.html not found. Build the frontend first."
}

Write-Host "[2/3] Packing sources ..." -ForegroundColor Cyan
if (Test-Path $OutZip) { Remove-Item $OutZip -Force }
# tar.exe (bsdtar) creates a zip when -a is used and the name ends with .zip
& tar.exe -a -c -f $OutZip -C $root `
    --exclude=__pycache__ --exclude=*.pyc --exclude=.venv --exclude=node_modules `
    code "codelens-prototype/dist" requirements-backend.txt "deploy/windows"
Assert-LastExit "tar"

Write-Host "[3/3] Done." -ForegroundColor Green
$mb = [math]::Round((Get-Item $OutZip).Length / 1MB, 2)
Write-Host ""
Write-Host "Package : $OutZip  ($mb MB)"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Copy this zip to C:\ on the Windows server (RDP clipboard works)."
Write-Host "  2. On the server, open PowerShell as Administrator and run these two commands:"
Write-Host "       Expand-Archive C:\codelens-release.zip C:\codelens-pkg -Force"
Write-Host "       powershell -ExecutionPolicy Bypass -File C:\codelens-pkg\deploy\windows\setup.ps1"
Write-Host "  3. Open http://<public-ip>:8080/ in your browser."
