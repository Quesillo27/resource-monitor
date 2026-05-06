param(
  [Parameter(Mandatory=$true)][string]$ServerUrl,
  [Parameter(Mandatory=$true)][string]$EnrollmentToken,
  [string]$Name = "",
  [int]$Interval = 60,
  [string]$Version = "latest"
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this installer from an elevated PowerShell session."
}

$repo = "Quesillo27/resource-monitor"
if ($Version -eq "latest") {
  $baseUrl = "https://github.com/$repo/releases/latest/download"
} else {
  $baseUrl = "https://github.com/$repo/releases/download/$Version"
}

$installDir = Join-Path $env:ProgramFiles "ResourceMonitorAgent"
$installPath = Join-Path $installDir "resource-monitor-agent.exe"
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

if (Get-Service resource-monitor-agent -ErrorAction SilentlyContinue) {
  Stop-Service resource-monitor-agent -ErrorAction SilentlyContinue
}

$assetUrl = "$baseUrl/resource-monitor-agent-windows-amd64.exe"
Write-Host "Downloading $assetUrl..."
try {
  Invoke-WebRequest -Uri $assetUrl -OutFile $installPath -UseBasicParsing
} catch {
  throw "Could not download the Windows agent binary from $assetUrl. Wait for the GitHub Release assets to finish publishing, or verify internet/TLS access from this host. Original error: $($_.Exception.Message)"
}

Write-Host "Registering and installing resource-monitor-agent..."
& $installPath install --server-url $ServerUrl --enrollment-token $EnrollmentToken --name $Name --interval $Interval

Start-Service resource-monitor-agent
Write-Host "Running agent doctor..."
& $installPath doctor --config "C:\ProgramData\ResourceMonitorAgent\config.json"
Get-Service resource-monitor-agent
Write-Host "Resource Monitor agent installation complete."
