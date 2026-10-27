#Requires -RunAsAdministrator
<#
.SYNOPSIS
  End-to-end smoke test for the Windows service packaging of the BalanzaWeb agent.

.DESCRIPTION
  Installs the service into a sandbox directory (never into Program Files), verifies
  registration, start, file logging, ACLs, sync-failure survival, graceful stop,
  restart and uninstall. Leaves no service or directory behind unless -Keep is used.

  Run it from an elevated PowerShell:
    powershell -ExecutionPolicy Bypass -File .\apps\agent\service\smoke-test.ps1

.PARAMETER Root
  Sandbox directory. Defaults to %ProgramData%\BalanzaWebSmoke.

.PARAMETER InstallScript
  install.ps1 to exercise. Defaults to the repository copy; point it at the
  install.ps1 extracted from the release package to validate a package.

.PARAMETER UninstallScript
  uninstall.ps1 to exercise. Defaults to the repository copy.

.PARAMETER Keep
  Skip the uninstall step and leave the service running for manual inspection.
#>
[CmdletBinding()]
param(
  [string]$Root = (Join-Path $env:ProgramData 'BalanzaWebSmoke'),
  [string]$InstallScript,
  [string]$UninstallScript,
  [switch]$Keep
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
if (-not $InstallScript) { $InstallScript = Join-Path $repoRoot 'apps\agent\service\install.ps1' }
if (-not $UninstallScript) { $UninstallScript = Join-Path $repoRoot 'apps\agent\service\uninstall.ps1' }
$installDir = Join-Path $Root 'Agent'
$dataDir = Join-Path $Root 'Data'
$agentLog = Join-Path $dataDir 'logs\agent.log'
$serviceName = 'BalanzaWebAgent'
$transcript = Join-Path $env:TEMP 'balanzaweb-service-smoke.log'

Start-Transcript -Path $transcript -Force | Out-Null

$script:failures = 0
function Step([string]$name, [bool]$ok, [string]$detail) {
  $status = if ($ok) { 'PASS' } else { 'FAIL' }
  if (-not $ok) { $script:failures++ }
  Write-Host ("[{0}] {1} :: {2}" -f $status, $name, $detail)
}

function Read-AgentLog([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return '' }
  return (Get-Content -LiteralPath $path -Raw -Encoding UTF8)
}

function Invoke-Child([string]$script, [string[]]$arguments) {
  # The child writes errors to stderr; with ErrorActionPreference=Stop that would
  # terminate this script before we can report the exit code.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & powershell -NoProfile -ExecutionPolicy Bypass -File $script @arguments 2>&1
    return @{ exit = $LASTEXITCODE; output = $output }
  } finally {
    $ErrorActionPreference = $previous
  }
}

function Remove-Sandbox {
  if (-not (Test-Path -LiteralPath $Root)) { return }
  # A previous failed run may have left a directory whose ACL excludes Administrators.
  & takeown.exe /f $Root /r /d y | Out-Null
  & icacls.exe $Root /reset /t /c | Out-Null
  Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue
}

try {
  Step 'elevation' $true ([Security.Principal.WindowsIdentity]::GetCurrent().Name)

  # Never touch a real installation: the service must either be absent or ours.
  $existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if ($existing) {
    $wmi = Get-CimInstance Win32_Service -Filter "Name='$serviceName'" -ErrorAction SilentlyContinue
    if (-not $wmi -or $wmi.PathName -notlike "*$Root*") {
      throw "A real $serviceName service exists at '$($wmi.PathName)'. Run the smoke test on a machine without a production install, or change -Root."
    }
    Write-Host 'Removing a leftover sandbox service from a previous run...'
    Invoke-Child $uninstallScript @('-InstallDir', $installDir, '-DataDir', $dataDir, '-Purge') | Out-Null
  }
  Remove-Sandbox
  Step 'clean slate' (-not (Get-Service -Name $serviceName -ErrorAction SilentlyContinue)) "sandbox $Root"

  # --- install -----------------------------------------------------------
  # -Quiet keeps the sandbox unattended: the installer must never open the GUI here.
  $install = Invoke-Child $installScript @('-InstallDir', $installDir, '-DataDir', $dataDir, '-Quiet')
  Step 'install.ps1 exit code' ($install.exit -eq 0) "exit=$($install.exit)"
  if ($install.exit -ne 0) { throw ("install.ps1 failed:`n" + ($install.output -join "`n")) }

  $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  Step 'service registered' ([bool]$service) 'Get-Service finds BalanzaWebAgent'
  if (-not $service) { throw 'Service was not registered.' }
  Step 'start type is Automatic' ($service.StartType -eq 'Automatic') "StartType=$($service.StartType)"
  Step 'service is Running' ($service.Status -eq 'Running') "Status=$($service.Status)"

  Step 'binaries copied' ((Test-Path (Join-Path $installDir 'balanza-agent.exe')) -and (Test-Path (Join-Path $installDir 'balanza-agent-service.exe'))) $installDir
  $xml = Get-Content -LiteralPath (Join-Path $installDir 'balanza-agent-service.xml') -Raw
  Step 'rendered xml has no placeholders' (-not ($xml -match '__[A-Z_]+__')) 'balanza-agent-service.xml'

  Start-Sleep -Seconds 4
  $text = Read-AgentLog $agentLog
  Step 'agent log exists' (Test-Path -LiteralPath $agentLog) $agentLog
  Step 'agent logged startup' ($text -match 'agent starting') 'contains "agent starting"'
  Step 'agent waits when not enrolled' ($text -match 'not enrolled yet') 'contains "not enrolled yet"'

  # --- ACL ---------------------------------------------------------------
  $acl = Get-Acl -LiteralPath $dataDir
  $sids = @()
  foreach ($rule in $acl.Access) {
    try { $sids += $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { }
  }
  $hasUsers = ($sids -contains 'S-1-5-32-545') -or ($sids -contains 'S-1-1-0')
  Step 'data dir ACL excludes Users' (-not $hasUsers) ("identities: " + ($sids -join ', '))
  Step 'data dir ACL includes SYSTEM' ($sids -contains 'S-1-5-18') 'S-1-5-18 present'
  Step 'data dir ACL includes Administrators' ($sids -contains 'S-1-5-32-544') 'S-1-5-32-544 present'
  Step 'data dir inheritance is disabled' ($acl.AreAccessRulesProtected) 'AreAccessRulesProtected=True'

  # --- enrolled behaviour ------------------------------------------------
  $configDir = Join-Path $dataDir 'config'
  New-Item -ItemType Directory -Force -Path $configDir | Out-Null
  $config = @{
    apiUrl = 'http://127.0.0.1:1'
    agentId = 'smoke-agent'
    sede = @{ id = 1; name = 'Smoke Sede' }
    token = 'smoke-token'
    machineId = 'smoke-machine'
    pollIntervalSeconds = 2
    allowLocalOverride = $true
    state = @{ revision = 0; scaleHashes = @{}; lastSyncAt = $null }
  } | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText((Join-Path $configDir 'agent.config.json'), $config, (New-Object System.Text.UTF8Encoding($false)))
  Step 'config written' (Test-Path (Join-Path $configDir 'agent.config.json')) 'agent.config.json'

  Restart-Service -Name $serviceName
  Start-Sleep -Seconds 6
  $text = Read-AgentLog $agentLog
  Step 'agent reloads config and polls' ($text -match 'sync error') 'contains "sync error"'
  Step 'agent survives sync failures' ((Get-Service -Name $serviceName).Status -eq 'Running') 'still Running after failed sync'

  # --- graceful stop -----------------------------------------------------
  $watch = [Diagnostics.Stopwatch]::StartNew()
  Stop-Service -Name $serviceName -Force
  $watch.Stop()
  $status = (Get-Service -Name $serviceName).Status
  Step 'service stopped' ($status -eq 'Stopped') "Status=$status in $([int]$watch.Elapsed.TotalSeconds)s"
  Step 'stop respected the 30s timeout' ($watch.Elapsed.TotalSeconds -lt 30) "$([int]$watch.Elapsed.TotalSeconds)s"
  $text = Read-AgentLog $agentLog
  Step 'graceful stop logged' ($text -match 'agent stopped') 'contains "agent stopped"'

  # --- restart -----------------------------------------------------------
  Start-Service -Name $serviceName
  Start-Sleep -Seconds 3
  Step 'service restarts cleanly' ((Get-Service -Name $serviceName).Status -eq 'Running') 'Status=Running'

  # --- uninstall ---------------------------------------------------------
  if ($Keep) {
    Write-Host ''
    Write-Host "Keeping the sandbox service running at $installDir (data in $dataDir)."
    Write-Host 'Remove it later with:'
    Write-Host ("  powershell -ExecutionPolicy Bypass -File `"{0}`" -InstallDir `"{1}`" -DataDir `"{2}`" -Purge" -f $uninstallScript, $installDir, $dataDir)
  } else {
    $uninstall = Invoke-Child $uninstallScript @('-InstallDir', $installDir, '-DataDir', $dataDir, '-Purge')
    Step 'uninstall.ps1 exit code' ($uninstall.exit -eq 0) "exit=$($uninstall.exit)"
    if ($uninstall.exit -ne 0) { Write-Host ($uninstall.output -join "`n") }
    Step 'service removed' (-not [bool](Get-Service -Name $serviceName -ErrorAction SilentlyContinue)) 'Get-Service returns nothing'
    Step 'install dir removed' (-not (Test-Path -LiteralPath $installDir)) $installDir
    Step 'data dir purged' (-not (Test-Path -LiteralPath $dataDir)) $dataDir
    if (Test-Path -LiteralPath $Root) {
      $remaining = Get-ChildItem -LiteralPath $Root -Force
      if (-not $remaining) { Remove-Item -LiteralPath $Root -Force -ErrorAction SilentlyContinue }
    }
    Step 'sandbox root removed' (-not (Test-Path -LiteralPath $Root)) $Root
  }
}
catch {
  Step 'UNEXPECTED ERROR' $false $_.Exception.Message
  Write-Host $_.ScriptStackTrace
}
finally {
  Write-Host ''
  if ($script:failures -eq 0) {
    Write-Host 'RESULT: ALL CHECKS PASSED'
  } else {
    Write-Host ("RESULT: {0} CHECK(S) FAILED" -f $script:failures)
  }
  Write-Host "Transcript: $transcript"
  Stop-Transcript | Out-Null
}

if ($script:failures -eq 0) { exit 0 } else { exit 1 }
