param(
  [Parameter(Mandatory=$true)][string]$ServerUrl,
  [string]$EnrollmentToken = "",
  [string]$Name = "",
  [int]$Interval = 60,
  [string]$Version = "latest",
  [string]$AgentUrl = "",
  [string]$DownloadUrl = "",
  [string]$Profile = "balanced",
  [string]$Services = ""
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Ejecuta este instalador desde una sesion elevada de PowerShell (Ejecutar como administrador)."
}

$configPath = "C:\ProgramData\ResourceMonitorAgent\config.json"
if ($EnrollmentToken -eq "" -and -not (Test-Path $configPath)) {
  throw "EnrollmentToken es requerido para la primera instalacion. Las reinstalaciones pueden omitirlo."
}

$repo = "Quesillo27/resource-monitor"
if ($DownloadUrl -ne "") {
  $baseUrl = $DownloadUrl.TrimEnd("/")
} elseif ($Version -eq "latest") {
  $baseUrl = "https://github.com/$repo/releases/latest/download"
} else {
  $baseUrl = "https://github.com/$repo/releases/download/$Version"
}

$installDir = Join-Path $env:ProgramFiles "ResourceMonitorAgent"
$installPath = Join-Path $installDir "resource-monitor-agent.exe"
$tmpPath = Join-Path $env:TEMP "resource-monitor-agent-new.exe"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

$assetUrl = "$baseUrl/resource-monitor-agent-windows-amd64.exe"
if ($AgentUrl -ne "") { $assetUrl = $AgentUrl }

# Descargar a archivo temporal ANTES de detener el servicio
Write-Host "Descargando agente desde $assetUrl..."
try {
  Invoke-WebRequest -Uri $assetUrl -OutFile $tmpPath -UseBasicParsing -TimeoutSec 60
} catch {
  $msg = $_.Exception.Message
  Write-Host ""
  Write-Host "ERROR: No se pudo descargar el agente." -ForegroundColor Red
  Write-Host "  URL: $assetUrl" -ForegroundColor Yellow
  Write-Host "  Causa: $msg" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Verifica que:" -ForegroundColor Cyan
  Write-Host "  - El servidor esta accesible desde esta maquina"
  Write-Host "  - La URL de descargas es correcta (incluye el puerto si aplica)"
  Write-Host "  - No hay firewall bloqueando la conexion"
  throw "Descarga fallida: $msg"
}

# Verificar checksum ANTES de detener el servicio
$checksumUrl = "$baseUrl/checksums.txt"
try {
  $checksumContent = (Invoke-WebRequest -Uri $checksumUrl -UseBasicParsing -TimeoutSec 10).Content
  $expectedLine = ($checksumContent -split "`n") | Where-Object { $_ -match "resource-monitor-agent-windows-amd64\.exe$" }
  if ($expectedLine) {
    $expected = ($expectedLine -split "\s+")[0].Trim()
    $actual = (Get-FileHash -Path $tmpPath -Algorithm SHA256).Hash.ToLower()
    if ($expected -ne $actual) {
      Remove-Item $tmpPath -Force -ErrorAction SilentlyContinue
      throw "Checksum incorrecto. Esperado: $expected  Obtenido: $actual"
    }
    Write-Host "Checksum OK."
  }
} catch [System.Net.WebException] {
  # checksums.txt no disponible — continuar sin verificar
}

# Detener servicio solo si descarga y checksum pasaron
$svc = Get-Service resource-monitor-agent -ErrorAction SilentlyContinue
if ($svc) {
  Write-Host "Deteniendo servicio existente..."
  Stop-Service resource-monitor-agent -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
}
Copy-Item -Path $tmpPath -Destination $installPath -Force
Remove-Item $tmpPath -Force -ErrorAction SilentlyContinue

Write-Host "Instalando/actualizando resource-monitor-agent..."
$installArgs = @("install", "--server-url", $ServerUrl, "--interval", $Interval, "--profile", $Profile)
if ($EnrollmentToken -ne "") { $installArgs += @("--enrollment-token", $EnrollmentToken) }
if ($Name -ne "") { $installArgs += @("--name", $Name) }
if ($Services -ne "") { $installArgs += @("--services", $Services) }
& $installPath @installArgs
if ($LASTEXITCODE -ne 0) {
  throw "Fallo al instalar el agente (exit code $LASTEXITCODE). Revisa los permisos de administrador."
}

Write-Host "Iniciando servicio..."
Start-Service resource-monitor-agent -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

Write-Host "Verificando agente..."
& $installPath doctor --config $configPath
Get-Service resource-monitor-agent
Write-Host ""
Write-Host "Instalacion completada." -ForegroundColor Green
