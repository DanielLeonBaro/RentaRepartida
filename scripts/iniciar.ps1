$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path -Parent $PSScriptRoot
$appUrl = 'http://127.0.0.1:3210'
try {
    $nodeCommand = Get-Command node.exe -ErrorAction Stop
    $running = $false
    try {
        $health = Invoke-RestMethod -Uri "$appUrl/api/health" -TimeoutSec 2
        if ($health.app -ne 'renta-repartida') { throw 'El puerto 3210 pertenece a otra aplicación.' }
        $running = $true
    } catch {
        if ($_.Exception.Message -eq 'El puerto 3210 pertenece a otra aplicación.') { throw }
    }
    if (-not $running) {
        $serverPath = Join-Path $projectDirectory 'server.mjs'
        $logDirectory = Join-Path $projectDirectory 'data'
        New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
        $process = Start-Process -FilePath $nodeCommand.Source -ArgumentList @('"' + $serverPath + '"') -WorkingDirectory $projectDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDirectory 'servidor.log') -RedirectStandardError (Join-Path $logDirectory 'errores.log')
        $ready = $false
        for ($attempt = 0; $attempt -lt 30; $attempt++) {
            Start-Sleep -Milliseconds 200
            if ($process.HasExited) { throw 'La aplicación no pudo iniciar. Revisa data\errores.log.' }
            try {
                $health = Invoke-RestMethod -Uri "$appUrl/api/health" -TimeoutSec 1
                if ($health.app -eq 'renta-repartida') { $ready = $true; break }
            } catch {}
        }
        if (-not $ready) { throw 'La aplicación tardó demasiado en iniciar. Revisa data\errores.log.' }
    }
} catch {
    Write-Host "No se pudo abrir Renta Repartida: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
try {
    Start-Process $appUrl
} catch {
    Write-Host "Renta Repartida ya está lista. Abre esta dirección en tu navegador: $appUrl" -ForegroundColor Green
}
