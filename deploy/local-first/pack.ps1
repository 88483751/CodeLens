param(
    [string]$OutDir
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
if (-not $OutDir) { $OutDir = Join-Path $root 'tmp/codelens-cloud' }
$output = (New-Item -ItemType Directory -Force -Path $OutDir).FullName

Push-Location (Join-Path $root 'codelens-prototype')
try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Frontend build failed ($LASTEXITCODE)" }
} finally {
    Pop-Location
}

$sources = @(git -C $root ls-files -- code | Where-Object { $_ -like '*.py' })
if ($LASTEXITCODE -ne 0 -or $sources.Count -eq 0) { throw 'Cannot list backend source files' }
$sources = @($sources + @('code/ai/source_policy.py', 'code/backend/local_database.py', 'code/backend/migrate_local_sqlite.py') |
    Select-Object -Unique)
$stage = Join-Path $root 'tmp/codelens-local-package'
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'start-local.py') -Destination $stage -Force

$zip = Join-Path $output 'codelens-local.zip'
& tar.exe -a -c -f $zip -C $root @sources 'code/ai/review_prompts.json' 'code/ai/source_policy.json' 'requirements-backend.txt' 'codelens-prototype/dist' `
    -C $stage 'start-local.py'
if ($LASTEXITCODE -ne 0) { throw "Cannot create the local release package ($LASTEXITCODE)" }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'index.html') -Destination (Join-Path $output 'index.html') -Force
Write-Host "Static site: $output"
