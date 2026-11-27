$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$output = Join-Path $root 'tmp'
New-Item -ItemType Directory $output -Force | Out-Null
$stage = Join-Path $output ('sync-package-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $stage | Out-Null
try {
    npm --prefix (Join-Path $root 'codelens-prototype') run build:sync
    if ($LASTEXITCODE -ne 0) { throw 'Sync build failed' }
    Copy-Item -LiteralPath (Join-Path $root 'codelens-prototype/dist-sync') -Destination (Join-Path $stage 'site') -Recurse
    $server = Join-Path $stage 'server'
    New-Item -ItemType Directory $server | Out-Null
    foreach ($name in 'Dockerfile', 'requirements.txt', 'service.py', 'codelens-history.service', 'nginx-tls.conf', 'prepare-postgres.sh', 'README.md') {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $server
    }
    $artifact = Join-Path $output 'codelens-sync.tar.gz'
    tar.exe -czf $artifact -C $stage site server
    if ($LASTEXITCODE -ne 0) { throw 'Release archive failed' }
    Get-Item -LiteralPath $artifact
} finally {
    $resolvedStage = (Resolve-Path -LiteralPath $stage).Path
    if ((Split-Path -Parent $resolvedStage) -eq (Resolve-Path -LiteralPath $output).Path) {
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}
