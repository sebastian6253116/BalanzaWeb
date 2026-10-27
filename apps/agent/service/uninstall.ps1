#Requires -RunAsAdministrator
[CmdletBinding()]
param(
  [string]$InstallDir = 'C:\Program Files\BalanzaWeb\Agent',
  [string]$DataDir = (Join-Path $env:ProgramData 'BalanzaWeb\Agent'),
  [switch]$Purge
)

$ErrorActionPreference = 'Stop'

$serviceName = 'BalanzaWebAgent'
$serviceExe = Join-Path $InstallDir 'balanza-agent-service.exe'

$service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
if ($service) {
  Write-Host "Stopping $serviceName..."
  Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $serviceExe) {
  Write-Host 'Uninstalling the Windows service...'
  & $serviceExe uninstall
  if ($LASTEXITCODE -ne 0) { throw 'The service uninstall command failed.' }
} elseif (Get-Service -Name $serviceName -ErrorAction SilentlyContinue) {
  Write-Warning "Wrapper not found at $serviceExe; removing the service with sc.exe instead."
  & sc.exe delete $serviceName | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "sc.exe failed to delete $serviceName" }
}

Write-Host 'Removing installed files...'
foreach ($name in @('balanza-agent.exe', 'balanza-agent-service.exe', 'balanza-agent-service.xml')) {
  $path = Join-Path $InstallDir $name
  if (Test-Path -LiteralPath $path) {
    Remove-Item -LiteralPath $path -Force
  }
}

if (Test-Path -LiteralPath $InstallDir) {
  $remaining = Get-ChildItem -LiteralPath $InstallDir -Force
  if (-not $remaining) {
    Remove-Item -LiteralPath $InstallDir -Force
  }
}

if ($Purge) {
  if (Test-Path -LiteralPath $DataDir) {
    Write-Host "Removing data directory $DataDir..."
    Remove-Item -LiteralPath $DataDir -Recurse -Force
  }
  Write-Host 'Data directory removed.'
} else {
  Write-Host "Data directory kept at $DataDir (use -Purge to delete it)."
}

Write-Host 'Uninstall complete.'
