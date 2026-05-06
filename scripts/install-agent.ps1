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
  throw "Run this installer from an elevated PowerShell session."
}

$configPath = "C:\ProgramData\ResourceMonitorAgent\config.json"
if ($EnrollmentToken -eq "" -and -not (Test-Path $configPath)) {
  throw "EnrollmentToken is required for first install. Existing installs can update without a token."
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
New-Item -ItemType Directory -Force -Path $installDir | Out-Null

if (Get-Service resource-monitor-agent -ErrorAction SilentlyContinue) {
  Stop-Service resource-monitor-agent -ErrorAction SilentlyContinue
}

$assetUrl = "$baseUrl/resource-monitor-agent-windows-amd64.exe"
if ($AgentUrl -ne "") {
  $assetUrl = $AgentUrl
}
Write-Host "Downloading $assetUrl..."
try {
  Invoke-WebRequest -Uri $assetUrl -OutFile $installPath -UseBasicParsing
} catch {
  throw "Could not download the Windows agent binary from $assetUrl. Original error: $($_.Exception.Message)"
}

Write-Host "Installing or updating resource-monitor-agent..."
$args = @("install", "--server-url", $ServerUrl, "--interval", $Interval, "--profile", $Profile)
if ($EnrollmentToken -ne "") { $args += @("--enrollment-token", $EnrollmentToken) }
if ($Name -ne "") { $args += @("--name", $Name) }
if ($Services -ne "") { $args += @("--services", $Services) }
& $installPath @args

Start-Service resource-monitor-agent -ErrorAction SilentlyContinue
Write-Host "Running agent doctor..."
& $installPath doctor --config $configPath
Get-Service resource-monitor-agent
Write-Host "Resource Monitor agent installation/update complete."
