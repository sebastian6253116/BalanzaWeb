#Requires -RunAsAdministrator
[CmdletBinding()]
param(
  [string]$InstallDir = 'C:\Program Files\BalanzaWeb\Agent',
  [string]$DataDir = (Join-Path $env:ProgramData 'BalanzaWeb\Agent'),
  [string]$ApiUrl,
  [string]$PairingCode,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

# Two layouts are supported:
#   packaged (flat): this script sits next to balanza-agent.exe, the WinSW wrapper
#                    and the XML template, exactly as extracted from the release zip;
#   repository:      apps\agent\service\install.ps1 inside the repo, with the binary
#                    under apps\agent\dist and WinSW under apps\agent\service\bin.
$packagedAgent = Join-Path $PSScriptRoot 'balanza-agent.exe'
if (Test-Path -LiteralPath $packagedAgent) {
  $agentExe = $packagedAgent
  $winswExe = Join-Path $PSScriptRoot 'balanza-agent-service.exe'
} else {
  $agentRoot = Split-Path -Parent $PSScriptRoot
  $repoRoot = Split-Path -Parent (Split-Path -Parent $agentRoot)
  $agentExe = Join-Path $repoRoot 'apps\agent\dist\balanza-agent.exe'
  $winswExe = Join-Path $repoRoot 'apps\agent\service\bin\balanza-agent-service.exe'
}
$templatePath = Join-Path $PSScriptRoot 'balanza-agent.xml.template'

$missing = @()
foreach ($path in @($agentExe, $winswExe, $templatePath)) {
  if (-not (Test-Path -LiteralPath $path)) { $missing += $path }
}
if ($missing.Count -gt 0) {
  $list = ($missing | ForEach-Object { "  $_" }) -join "`n"
  throw @"
Cannot find the agent files. Supported layouts:
  packaged:   this script must sit next to balanza-agent.exe, balanza-agent-service.exe and balanza-agent.xml.template (extract the release zip).
  repository: apps\agent\service\install.ps1 inside the repo. Build the binaries with: npm run agent:build and npm run agent:winsw.
Missing:
$list
"@
}

if (Get-Service -Name 'BalanzaWebAgent' -ErrorAction SilentlyContinue) {
  throw 'The service BalanzaWebAgent already exists. Run uninstall.ps1 first.'
}

Write-Host "Creating directories..."
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
foreach ($sub in @('config', 'logs', 'run')) {
  New-Item -ItemType Directory -Force -Path (Join-Path $DataDir $sub) | Out-Null
}

Write-Host "Copying binaries..."
Copy-Item -LiteralPath $agentExe -Destination (Join-Path $InstallDir 'balanza-agent.exe') -Force
Copy-Item -LiteralPath $winswExe -Destination (Join-Path $InstallDir 'balanza-agent-service.exe') -Force

Write-Host "Rendering the service configuration..."
$template = [System.IO.File]::ReadAllText($templatePath)
$rendered = $template.Replace('__INSTALL_DIR__', $InstallDir).Replace('__DATA_DIR__', $DataDir)
$serviceXml = Join-Path $InstallDir 'balanza-agent-service.xml'
[System.IO.File]::WriteAllText($serviceXml, $rendered, (New-Object System.Text.UTF8Encoding($false)))

Write-Host "Installing the Windows service..."
& (Join-Path $InstallDir 'balanza-agent-service.exe') install
if ($LASTEXITCODE -ne 0) { throw 'The service install command failed.' }

# The ACL, the enrollment and the first start are the steps after registration that
# can fail, so a failure here removes the service instead of leaving a half-installed one.
try {
  Write-Host "Restricting access to the data directory..."
  # Well-known SIDs, not localized names: "BUILTIN\Administrators" is "Administradores"
  # on a Spanish Windows. They must be SecurityIdentifier objects: a string would be
  # interpreted as an account name and the translation would fail.
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @('S-1-5-18', 'S-1-5-32-544')) {
    $identity = New-Object System.Security.Principal.SecurityIdentifier($sid)
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
      $identity,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',
      [System.Security.AccessControl.PropagationFlags]::None,
      [System.Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule) | Out-Null
  }
  Set-Acl -LiteralPath $DataDir -AclObject $acl

  if ($ApiUrl -and $PairingCode) {
    # Enroll before the first start: the service then boots with a valid config
    # instead of logging "FATAL not enrolled yet" until someone enrolls it.
    Write-Host "Enrolling the agent..."
    $previousHome = $env:BALANZA_AGENT_HOME
    $env:BALANZA_AGENT_HOME = $DataDir
    try {
      & (Join-Path $InstallDir 'balanza-agent.exe') enroll --api $ApiUrl --code $PairingCode
      if ($LASTEXITCODE -ne 0) { throw 'Enrollment failed. Check the API URL and the pairing code.' }
    } finally {
      if ($null -eq $previousHome) {
        Remove-Item Env:BALANZA_AGENT_HOME -ErrorAction SilentlyContinue
      } else {
        $env:BALANZA_AGENT_HOME = $previousHome
      }
    }
  }

  Write-Host "Starting the service..."
  Start-Service -Name 'BalanzaWebAgent'
  Get-Service -Name 'BalanzaWebAgent' | Select-Object Name, Status, StartType | Format-Table -AutoSize
} catch {
  Write-Warning "Installation failed after the service was registered; removing it: $($_.Exception.Message)"
  & (Join-Path $InstallDir 'balanza-agent-service.exe') uninstall | Out-Null
  throw
}

if (-not $ApiUrl -and -not $PairingCode) {
  # An upgrade reuses the ProgramData config: enrolling again is not needed and the
  # connection window must not pop up for an agent that is already connected.
  $existingConfig = Join-Path $DataDir 'config\agent.config.json'
  if (Test-Path -LiteralPath $existingConfig) {
    Write-Host 'Existing configuration found: the agent stays enrolled, no window needed.'
  } elseif ($Quiet -or -not [Environment]::UserInteractive) {
    Write-Warning 'El agente quedó instalado pero NO está enrolado. Para conectarlo, ejecute configurar-agente.ps1 o enrolle a mano con el comando enroll.'
  } else {
    # An old package may not ship the window; the service is already installed,
    # so a missing helper must degrade to a warning instead of a failed install.
    $configureScript = Join-Path $PSScriptRoot 'configurar-agente.ps1'
    if (Test-Path -LiteralPath $configureScript) {
      Write-Host 'Opening the connection window...'
      & $configureScript -InstallDir $InstallDir -DataDir $DataDir
      if ($LASTEXITCODE -ne 0) {
        Write-Warning 'El agente quedó instalado pero NO está enrolado (se cerró o falló la ventana de conexión). Puede reintentar con configurar-agente.ps1.'
      }
    } else {
      Write-Warning 'No se encontró configurar-agente.ps1 en esta carpeta. El agente quedó instalado pero NO está enrolado; use el comando enroll para conectarlo.'
    }
  }
} elseif (-not ($ApiUrl -and $PairingCode)) {
  Write-Warning 'Both -ApiUrl and -PairingCode are required to enroll. Skipping enrollment.'
}

Write-Host ''
Write-Host 'Service installed.'
Write-Host "  binaries:  $InstallDir"
Write-Host "  data:      $DataDir"
Write-Host "  agent log: $(Join-Path $DataDir 'logs\agent.log')"
Write-Host "  WinSW log: $(Join-Path $DataDir 'logs\winsw')"
Write-Host ''
Write-Host 'Verify with:'
Write-Host '  Get-Service BalanzaWebAgent'
Write-Host "  Get-Content -Path '$(Join-Path $DataDir 'logs\agent.log')' -Tail 50"
