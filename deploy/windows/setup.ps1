# CodeLens one-shot setup for Windows Server 2022.
# Run ON THE SERVER, in an elevated PowerShell window:
#   Expand-Archive C:\codelens-release.zip C:\codelens-pkg -Force
#   powershell -ExecutionPolicy Bypass -File C:\codelens-pkg\deploy\windows\setup.ps1
#
# What it does:
#   copy sources -> install Python 3.11 if missing -> venv + pip deps ->
#   install nginx for Windows -> write reverse-proxy config ->
#   register two auto-start scheduled tasks -> open firewall -> health check
#
# Requires at least 4 GiB RAM. Do not run this on a 2 GiB Windows instance.

param(
    [string]$SourceDir = "C:\codelens-pkg",
    [string]$Root      = "C:\codelens",
    [int]$ApiPort      = 18766,
    [int]$WebPort      = 8080,
    [switch]$SkipPythonInstall
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Log([string]$m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Die([string]$m) { Write-Host "`nFAILED: $m" -ForegroundColor Red; exit 1 }

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Die "Run PowerShell as Administrator."
}
if (-not (Test-Path "$SourceDir\code\backend\asgi.py")) {
    Die "Sources not found under $SourceDir. Extract the release zip first."
}

$memGb = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
Log "Memory: $memGb GB"
if ($memGb -lt 3.5) {
    Write-Host "WARNING: less than 4 GiB. Windows Server plus this backend will not fit." -ForegroundColor Yellow
}

New-Item -ItemType Directory -Force -Path $Root, "$Root\app", "$Root\logs", "$Root\tools" | Out-Null

# ------------------------------------------------------------------ sources
Log "Copying sources to $Root\app"
& robocopy $SourceDir "$Root\app" /E /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { Die "robocopy failed (code $LASTEXITCODE)" }

# ------------------------------------------------------------------ python
Log "Checking Python 3.11+"
$py = "C:\Program Files\Python311\python.exe"
if (-not (Test-Path $py)) {
    $cmd = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($cmd) {
        $ver = & $cmd.Source -c "import sys;print('%d.%d' % sys.version_info[:2])"
        if ($ver -in @('3.11','3.12','3.13')) { $py = $cmd.Source }
    }
}
if (-not (Test-Path $py)) {
    if ($SkipPythonInstall) { Die "Python 3.11+ not found and -SkipPythonInstall was given." }
    Log "Downloading Python 3.11.9 (huaweicloud mirror)"
    $installer = "$Root\tools\python-3.11.9-amd64.exe"
    Invoke-WebRequest -Uri "https://mirrors.huaweicloud.com/python/3.11.9/python-3.11.9-amd64.exe" `
        -OutFile $installer -UseBasicParsing
    Log "Installing Python 3.11.9 (silent, all users)"
    Start-Process $installer -ArgumentList '/quiet','InstallAllUsers=1','PrependPath=1','Include_test=0' -Wait
    $py = "C:\Program Files\Python311\python.exe"
    if (-not (Test-Path $py)) { Die "Python installation did not produce $py" }
}
& $py -c "import sys;print('Python', sys.version)"

# ------------------------------------------------------------------ venv
if (-not (Test-Path "$Root\venv\Scripts\python.exe")) {
    Log "Creating virtual environment"
    & $py -m venv "$Root\venv"
}
$vpy = "$Root\venv\Scripts\python.exe"
Log "Installing backend dependencies (aliyun PyPI mirror, 2-4 min)"
& "$Root\venv\Scripts\pip.exe" install --upgrade pip --quiet -i https://mirrors.aliyun.com/pypi/simple/
& "$Root\venv\Scripts\pip.exe" install -r "$Root\app\requirements-backend.txt" -i https://mirrors.aliyun.com/pypi/simple/
if ($LASTEXITCODE -ne 0) { Die "pip install failed" }
& $vpy -c "import fastapi, uvicorn, langgraph; print('deps OK')"

# ------------------------------------------------------------------ nginx
Log "Checking nginx for Windows"
$nginxExe = "$Root\nginx\nginx.exe"
if (-not (Test-Path $nginxExe)) {
    $zip = "$Root\tools\nginx.zip"
    Invoke-WebRequest -Uri "https://nginx.org/download/nginx-1.27.4.zip" -OutFile $zip -UseBasicParsing
    Expand-Archive $zip "$Root\tools" -Force
    $dir = Get-ChildItem "$Root\tools" -Directory -Filter "nginx-*" | Select-Object -First 1
    if (-not $dir) { Die "nginx archive did not contain an nginx-* folder" }
    Move-Item $dir.FullName "$Root\nginx" -Force
}

Log "Writing nginx.conf"
$conf = @'
worker_processes  1;
error_log  logs/error.log warn;
pid        logs/nginx.pid;

events { worker_connections 256; }

http {
    include       mime.types;
    default_type  application/octet-stream;
    sendfile      on;
    gzip          on;
    gzip_min_length 1k;
    gzip_types    text/plain text/css application/javascript application/json image/svg+xml;

    # backend accepts bodies up to 12 MiB
    client_max_body_size 16m;
    client_body_timeout  180s;

    server {
        listen      __WEBPORT__;
        server_name _;

        root  __ROOT__/app/codelens-prototype/dist;
        index index.html;

        location /assets/ { expires 30d; }

        location / {
            try_files $uri $uri/ /index.html;
        }

        # The backend only trusts Host/Origin = 127.0.0.1:<api port>.
        # Rewriting both headers here avoids touching any application code.
        location /api/ {
            proxy_pass http://127.0.0.1:__APIPORT__;
            proxy_http_version 1.1;
            proxy_set_header Connection "";
            proxy_set_header Host   127.0.0.1:__APIPORT__;
            proxy_set_header Origin http://127.0.0.1:__APIPORT__;

            # /api/review and /api/ai stream fragments; buffering must stay off
            proxy_buffering off;
            proxy_cache     off;
            proxy_read_timeout 900s;
            proxy_send_timeout 900s;
        }
    }
}
'@
$conf = $conf.Replace('__ROOT__', ($Root -replace '\\','/'))
$conf = $conf.Replace('__WEBPORT__', "$WebPort")
$conf = $conf.Replace('__APIPORT__', "$ApiPort")
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText("$Root\nginx\conf\nginx.conf", $conf, $utf8)

# ------------------------------------------------------------------ autostart
Log "Registering auto-start scheduled tasks"
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
$trigger  = New-ScheduledTaskTrigger -AtStartup

$apiArgs = "-B `"$Root\app\code\backend\asgi.py`" --port $ApiPort --log-file `"$Root\logs\codelens.log`""
$apiAction = New-ScheduledTaskAction -Execute $vpy -Argument $apiArgs -WorkingDirectory "$Root\app"
Register-ScheduledTask -TaskName "CodeLensAPI" -Action $apiAction -Trigger $trigger `
    -Settings $settings -User "SYSTEM" -RunLevel Highest -Force | Out-Null

$ngAction = New-ScheduledTaskAction -Execute $nginxExe -WorkingDirectory "$Root\nginx"
Register-ScheduledTask -TaskName "CodeLensWeb" -Action $ngAction -Trigger $trigger `
    -Settings $settings -User "SYSTEM" -RunLevel Highest -Force | Out-Null

# ------------------------------------------------------------------ start
Log "Starting services"
Stop-ScheduledTask -TaskName "CodeLensAPI" -ErrorAction SilentlyContinue
Get-Process nginx -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName "CodeLensAPI"
Start-ScheduledTask -TaskName "CodeLensWeb"

Log "Opening Windows firewall port $WebPort"
if (-not (Get-NetFirewallRule -DisplayName "CodeLens Web" -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName "CodeLens Web" -Direction Inbound -Protocol TCP `
        -LocalPort $WebPort -Action Allow | Out-Null
}

# ------------------------------------------------------------------ verify
Log "Health check (up to 40s)"
$apiOk = $false
$webOk = $false
for ($i = 0; $i -lt 40; $i++) {
    if (-not $apiOk) {
        $c = & curl.exe -s -o NUL -w "%{http_code}" --max-time 2 `
            -H "Host: 127.0.0.1:$ApiPort" "http://127.0.0.1:$ApiPort/api/status"
        if ($c -eq "200") { $apiOk = $true }
    }
    if (-not $webOk) {
        $c2 = & curl.exe -s -o NUL -w "%{http_code}" --max-time 2 "http://127.0.0.1:$WebPort/"
        if ($c2 -eq "200") { $webOk = $true }
    }
    if ($apiOk -and $webOk) { break }
    Start-Sleep -Seconds 1
}

Write-Host ""
Write-Host "============================================================"
Write-Host "  API  127.0.0.1:$ApiPort  healthy = $apiOk"
Write-Host "  WEB  127.0.0.1:$WebPort  healthy = $webOk"
Write-Host "  App  $Root\app"
Write-Host "  Log  $Root\logs\codelens.log"
Write-Host "------------------------------------------------------------"
Write-Host "  REMINDER: also allow TCP $WebPort in the Aliyun security group."
if (-not ($apiOk -and $webOk)) {
    Write-Host "  Debug commands:"
    Write-Host "    Get-ScheduledTask CodeLensAPI,CodeLensWeb | Format-List"
    Write-Host "    Get-Content $Root\logs\codelens.log -Tail 40"
    Write-Host "    Get-Content $Root\nginx\logs\error.log -Tail 40"
    Write-Host "    & '$vpy' -B '$Root\app\code\backend\asgi.py' --port $ApiPort"
}
Write-Host "============================================================"
