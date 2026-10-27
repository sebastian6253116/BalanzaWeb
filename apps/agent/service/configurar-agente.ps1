[CmdletBinding()]
param(
  [string]$InstallDir = 'C:\Program Files\BalanzaWeb\Agent',
  [string]$DataDir = (Join-Path $env:ProgramData 'BalanzaWeb\Agent'),
  [string]$ApiUrl,
  [string]$PairingCode,
  [switch]$AutoConnect
)

$ErrorActionPreference = 'Stop'

# Two layouts are supported, mirroring install.ps1:
#   packaged (flat): this script sits next to balanza-agent.exe, as extracted from
#                    the release zip;
#   repository:      apps\agent\service\configurar-agente.ps1 inside the repo,
#                    with the binary under apps\agent\dist.
$packagedAgent = Join-Path $PSScriptRoot 'balanza-agent.exe'
if (Test-Path -LiteralPath $packagedAgent) {
  $agentExe = $packagedAgent
} else {
  $agentRoot = Split-Path -Parent $PSScriptRoot
  $repoRoot = Split-Path -Parent (Split-Path -Parent $agentRoot)
  $agentExe = Join-Path $repoRoot 'apps\agent\dist\balanza-agent.exe'
}
if (-not (Test-Path -LiteralPath $agentExe)) {
  throw @"
No se encontró balanza-agent.exe. Layouts soportados:
  empaquetado: este script debe estar junto a balanza-agent.exe (extraiga el zip de la release).
  repositorio: apps\agent\service\configurar-agente.ps1 dentro del repo. Genere el binario con: npm run agent:build.
Falta:
  $agentExe
"@
}

$configPath = Join-Path $DataDir 'config\agent.config.json'
$serviceName = 'BalanzaWebAgent'

# WinForms needs an interactive desktop: never hang a scheduled or service run.
if (-not [Environment]::UserInteractive) {
  Write-Host 'No hay una sesión interactiva: no se puede abrir la ventana de conexión.'
  Write-Host 'Enrole el agente a mano con:'
  Write-Host "  `$env:BALANZA_AGENT_HOME = '$DataDir'"
  Write-Host "  & '$agentExe' enroll --api <url> --code <codigo>"
  Write-Host '  Restart-Service BalanzaWebAgent'
  exit 1
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$script:exitCode = 1
$script:connected = $false

function Get-ConnectedInfo {
  if (-not (Test-Path -LiteralPath $configPath)) { return $null }
  try {
    $config = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($config.sede.name) { return $config }
  } catch {
    # A malformed config must not prevent the window from opening.
  }
  return $null
}

function Set-Status([string]$text, [System.Drawing.Color]$color) {
  $statusLabel.Text = $text
  $statusLabel.ForeColor = $color
  $statusLabel.Refresh()
  [System.Windows.Forms.Application]::DoEvents()
}

function Invoke-Connect {
  if ($script:connected) {
    $form.Close()
    return
  }

  $url = $urlBox.Text.Trim()
  $code = $codeBox.Text.Trim().ToUpperInvariant()

  $uri = $null
  $validUri = [Uri]::TryCreate($url, [UriKind]::Absolute, [ref]$uri)
  if (-not $validUri -or
      ($uri.Scheme -ne 'http' -and $uri.Scheme -ne 'https') -or
      [string]::IsNullOrWhiteSpace($uri.Host)) {
    Set-Status 'Ingresá una dirección válida que empiece con http:// o https://.' ([System.Drawing.Color]::Firebrick)
    $urlBox.Focus()
    return
  }
  if ([string]::IsNullOrWhiteSpace($code)) {
    Set-Status 'Ingresá el código de autorización.' ([System.Drawing.Color]::Firebrick)
    $codeBox.Focus()
    return
  }

  $apiUrl = $url.TrimEnd('/')

  $connectButton.Enabled = $false
  $closeButton.Enabled = $false
  Set-Status 'Conectando...' ([System.Drawing.Color]::DimGray)

  try {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $agentExe
    $startInfo.Arguments = "enroll --api `"$apiUrl`" --code `"$code`""
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.EnvironmentVariables['BALANZA_AGENT_HOME'] = $DataDir

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    $process.Start() | Out-Null
    # Read both streams to the end before waiting: a full pipe would deadlock.
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    $process.WaitForExit()
    $exit = $process.ExitCode
    $process.Dispose()
  } catch {
    $connectButton.Enabled = $true
    $closeButton.Enabled = $true
    Set-Status "No se pudo conectar: $($_.Exception.Message)" ([System.Drawing.Color]::Firebrick)
    return
  }

  if ($exit -ne 0) {
    $message = (($stderr, $stdout) -join "`n").Trim()
    if ($message -match 'already used') {
      $friendly = 'Ese código ya fue usado. Generá uno nuevo en la web.'
    } elseif ($message -match 'expired') {
      $friendly = 'El código venció. Generá uno nuevo en la web (dura 15 minutos).'
    } elseif ($message -match 'unknown pairing code') {
      $friendly = 'El código no existe. Verificá que sea el de esta sede.'
    } elseif ($message -match 'fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|getaddrinfo') {
      # The most common failure at a sede: wrong address, no DNS or no route out.
      $friendly = 'No se pudo conectar con el servidor. Revisá la dirección y que esta PC tenga acceso a la red.'
    } else {
      $friendly = "No se pudo conectar: $message"
    }
    $connectButton.Enabled = $true
    $closeButton.Enabled = $true
    Set-Status $friendly ([System.Drawing.Color]::Firebrick)
    return
  }

  # The config is written; restart the service so the new token applies right away.
  $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if ($service) {
    try {
      if ($service.Status -eq 'Stopped') {
        Start-Service -Name $serviceName
      } else {
        Restart-Service -Name $serviceName
      }
    } catch {
      Write-Warning "El agente quedó enrolado, pero no se pudo reiniciar el servicio: $($_.Exception.Message)"
    }
  }

  $connected = Get-ConnectedInfo
  $sedeName = if ($connected -and $connected.sede.name) { $connected.sede.name } else { 'la sede' }

  $script:connected = $true
  $script:exitCode = 0
  $connectButton.Text = 'Listo'
  $connectButton.Enabled = $true
  $closeButton.Enabled = $true
  Set-Status "Conectado a la sede `"$sedeName`"" ([System.Drawing.Color]::ForestGreen)
  $connectButton.Focus()
}

$connectedInfo = Get-ConnectedInfo

$form = New-Object System.Windows.Forms.Form
$form.Text = 'BalanzaWeb - Conectar agente'
$form.ClientSize = New-Object System.Drawing.Size(470, 320)
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$form.Font = New-Object System.Drawing.Font('Segoe UI', 9)

$headerLabel = New-Object System.Windows.Forms.Label
$headerLabel.Location = New-Object System.Drawing.Point(16, 12)
$headerLabel.Size = New-Object System.Drawing.Size(438, 20)
$headerLabel.AutoEllipsis = $true
$headerLabel.Font = New-Object System.Drawing.Font('Segoe UI', 9, [System.Drawing.FontStyle]::Bold)
if ($connectedInfo) {
  $headerLabel.Text = "Ya conectado a la sede `"$($connectedInfo.sede.name)`" (agente $($connectedInfo.agentId))"
} else {
  $headerLabel.Visible = $false
}

$explanationLabel = New-Object System.Windows.Forms.Label
$explanationLabel.Location = New-Object System.Drawing.Point(16, 44)
$explanationLabel.Size = New-Object System.Drawing.Size(438, 44)
$explanationLabel.Text = 'El código se genera en la web, en la sección Sedes. Dura 15 minutos y se puede usar una sola vez.'

$urlLabel = New-Object System.Windows.Forms.Label
$urlLabel.Location = New-Object System.Drawing.Point(16, 100)
$urlLabel.Size = New-Object System.Drawing.Size(438, 18)
$urlLabel.Text = 'Dirección del servidor'

$urlBox = New-Object System.Windows.Forms.TextBox
$urlBox.Location = New-Object System.Drawing.Point(16, 120)
$urlBox.Size = New-Object System.Drawing.Size(438, 24)
if ($ApiUrl) {
  $urlBox.Text = $ApiUrl
} else {
  $urlBox.Text = 'https://'
}

$codeLabel = New-Object System.Windows.Forms.Label
$codeLabel.Location = New-Object System.Drawing.Point(16, 154)
$codeLabel.Size = New-Object System.Drawing.Size(438, 18)
$codeLabel.Text = 'Código de autorización'

$codeBox = New-Object System.Windows.Forms.TextBox
$codeBox.Location = New-Object System.Drawing.Point(16, 174)
$codeBox.Size = New-Object System.Drawing.Size(438, 24)
$codeBox.CharacterCasing = [System.Windows.Forms.CharacterCasing]::Upper
$codeBox.MaxLength = 32
if ($PairingCode) { $codeBox.Text = $PairingCode }

$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Location = New-Object System.Drawing.Point(16, 206)
$statusLabel.Size = New-Object System.Drawing.Size(438, 44)
$statusLabel.ForeColor = [System.Drawing.Color]::DimGray

$connectButton = New-Object System.Windows.Forms.Button
$connectButton.Location = New-Object System.Drawing.Point(250, 262)
$connectButton.Size = New-Object System.Drawing.Size(110, 30)
if ($connectedInfo) {
  $connectButton.Text = 'Reconectar'
} else {
  $connectButton.Text = 'Conectar'
}
$connectButton.Add_Click({ Invoke-Connect })

$closeButton = New-Object System.Windows.Forms.Button
$closeButton.Location = New-Object System.Drawing.Point(370, 262)
$closeButton.Size = New-Object System.Drawing.Size(84, 30)
$closeButton.Text = 'Cerrar'
$closeButton.Add_Click({ $form.Close() })

$form.AcceptButton = $connectButton
$form.Controls.AddRange(@(
  $headerLabel,
  $explanationLabel,
  $urlLabel,
  $urlBox,
  $codeLabel,
  $codeBox,
  $statusLabel,
  $connectButton,
  $closeButton
))

if ($AutoConnect) {
  $form.Add_Shown({
    if (-not [string]::IsNullOrWhiteSpace($urlBox.Text) -and
        $urlBox.Text -ne 'https://' -and
        -not [string]::IsNullOrWhiteSpace($codeBox.Text)) {
      Invoke-Connect
    }
  })
}

[void]$form.ShowDialog()
$form.Dispose()
exit $script:exitCode
