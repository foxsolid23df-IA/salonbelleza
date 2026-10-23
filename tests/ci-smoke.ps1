param(
  [Parameter(Mandatory = $true)]
  [string]$Installer,
  [string]$InstallDir = "",
  [string]$ExpectedVersion = "",
  [string]$ActivationKey = "",
  [string]$ActivationSalon = "CI Salon Suite",
  [string]$ActivationEmail = "",
  [switch]$KeepInstall
)

$ErrorActionPreference = "Stop"
$installerPath = [IO.Path]::GetFullPath($Installer)
if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) {
  throw "No existe el instalador: $installerPath"
}

if (-not $InstallDir) {
  $tempRoot = $env:RUNNER_TEMP
  if (-not $tempRoot) { $tempRoot = [IO.Path]::GetTempPath() }
  $InstallDir = Join-Path $tempRoot ("SalonSuiteSmoke-" + [Guid]::NewGuid().ToString("N"))
}
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
if (Test-Path -LiteralPath $InstallDir) {
  $existing = @(Get-ChildItem -LiteralPath $InstallDir -Force -ErrorAction SilentlyContinue)
  if ($existing.Count -gt 0) { throw "La carpeta de prueba ya existe y no esta vacia: $InstallDir" }
}

$serviceName = "SalonSuite"
$installed = $false
$uninstalled = $false
$uninstaller = Join-Path $InstallDir "uninstall.exe"

function Get-AppBase {
  $port = 3000
  $portFile = Join-Path $InstallDir "app\data\port.txt"
  if (Test-Path -LiteralPath $portFile) {
    $raw = (Get-Content -LiteralPath $portFile -Raw -ErrorAction SilentlyContinue).Trim()
    if ($raw -match '^\d+$') { $port = [int]$raw }
  }
  return "http://127.0.0.1:$port"
}

function Wait-AppReady {
  param([int]$TimeoutSeconds = 90)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $base = Get-AppBase
    try {
      $health = Invoke-RestMethod -Uri "$base/health" -Method Get -TimeoutSec 5
      if ($health.ok) {
        return [pscustomobject]@{ BaseUrl = $base; Health = $health }
      }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  throw "La app no respondio /health en $TimeoutSeconds segundos"
}

function Wait-Service {
  param([string]$Name, [int]$TimeoutSeconds = 60)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if ($null -ne $service) {
      $service.Refresh()
      if ($service.Status -eq "Running") { return $service }
    }
    Start-Sleep -Milliseconds 500
  }
  throw "El servicio $Name no quedo en ejecucion"
}

function Wait-ServiceStopped {
  param([string]$Name, [int]$TimeoutSeconds = 30)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if ($null -eq $service) { return }
    $service.Refresh()
    if ($service.Status -eq "Stopped") { return }
    Start-Sleep -Milliseconds 500
  }
  throw "El servicio $Name no se detuvo"
}

function Wait-ServiceRemoved {
  param([string]$Name, [int]$TimeoutSeconds = 30)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (-not (Get-Service -Name $Name -ErrorAction SilentlyContinue)) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "El servicio $Name sigue registrado"
}

function Wait-PathGone {
  param([string]$Path, [int]$TimeoutSeconds = 15)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    Start-Sleep -Milliseconds 500
  }
  throw "El archivo sigue presente: $Path"
}

function Restart-App {
  $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if ($null -eq $service) { throw "No existe el servicio $serviceName" }
  if ($service.Status -ne "Stopped") {
    Stop-Service -Name $serviceName -Force -ErrorAction Stop
    Wait-ServiceStopped -Name $serviceName -TimeoutSeconds 30 | Out-Null
  }
  $portFile = Join-Path $InstallDir "app\data\port.txt"
  Remove-Item -LiteralPath $portFile -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
  Start-Service -Name $serviceName -ErrorAction Stop
  Wait-Service -Name $serviceName -TimeoutSeconds 60 | Out-Null
  return Wait-AppReady -TimeoutSeconds 90
}

try {
  Write-Host "instalando en $InstallDir..."
  & $installerPath /S "/D=$InstallDir"
  if ($LASTEXITCODE -ne 0) {
    throw "El instalador termino con codigo $LASTEXITCODE"
  }
  $installed = $true

  Wait-Service -Name $serviceName -TimeoutSeconds 60 | Out-Null
  $ready = Wait-AppReady -TimeoutSeconds 90
  $base = $ready.BaseUrl
  $health = $ready.Health
  Write-Host "salud inicial: version=$($health.version) url=$base"

  if ($ExpectedVersion -and [string]$health.version -ne $ExpectedVersion) {
    throw "Version inesperada: $($health.version), se esperaba $ExpectedVersion"
  }

  $loginEmail = "admin@salon.local"
  $activated = $false
  if ($ActivationKey) {
    Write-Host "activando licencia contra el servidor configurado..."
    $body = @{
      license_key = $ActivationKey
      salon = $ActivationSalon
    }
    if ($ActivationEmail) { $body.cliente_email = $ActivationEmail }
    $activation = Invoke-WebRequest -Uri "$base/setup/activar" -Method Post -Body $body -TimeoutSec 30
    if ($activation.StatusCode -ge 400 -or $activation.Content -notmatch "Listo") {
      throw "La activacion no llego a /setup/inicio"
    }
    $activated = $true
    if ($ActivationEmail) { $loginEmail = $ActivationEmail }
    $ready = Wait-AppReady -TimeoutSeconds 60
    $base = $ready.BaseUrl
  } else {
    Write-Host "sin licencia de staging: se usa SALON_DEV_SKIP_LICENSE=1 en la instalacion temporal..."
    $envFile = Join-Path $InstallDir "app\.env"
    if (-not (Test-Path -LiteralPath $envFile)) {
      throw "No existe app\.env tras la instalacion"
    }
    $envText = Get-Content -LiteralPath $envFile -Raw
    if ($envText -notmatch "(?m)^SALON_DEV_SKIP_LICENSE=1\s*$") {
      Add-Content -LiteralPath $envFile -Value "SALON_DEV_SKIP_LICENSE=1" -Encoding ASCII
    }
    $ready = Restart-App
    $base = $ready.BaseUrl
  }

  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $login = Invoke-WebRequest -Uri "$base/login" -Method Post -Body @{ email = $loginEmail; password = "admin123" } -WebSession $session -MaximumRedirection 10 -TimeoutSec 20
  if ($login.StatusCode -ne 200) {
    throw "El login devolvio HTTP $($login.StatusCode)"
  }

  $target = if ($activated) { "$base/perfil" } else { "$base/" }
  $page = Invoke-WebRequest -Uri $target -WebSession $session -TimeoutSec 20
  if ($page.StatusCode -ne 200) {
    throw "La pagina autenticada devolvio HTTP $($page.StatusCode)"
  }
  if (-not $activated -and $page.Content -notmatch "Hola,") {
    throw "El dashboard no muestra la sesion autenticada"
  }

  $updates = Invoke-WebRequest -Uri "$base/updates" -WebSession $session -TimeoutSec 20
  if ($updates.StatusCode -ne 200 -or $updates.Content -notmatch "Actualizaciones") {
    throw "La pagina de actualizaciones no esta disponible"
  }

  Write-Host "login y paginas autenticadas: OK"

  if (Test-Path -LiteralPath $uninstaller) {
    & $uninstaller /S
    if ($LASTEXITCODE -ne 0) {
      throw "El desinstalador termino con codigo $LASTEXITCODE"
    }
  } else {
    throw "No se encontro uninstall.exe"
  }
  $uninstalled = $true
  Wait-ServiceRemoved -Name $serviceName -TimeoutSeconds 30 | Out-Null
  Wait-PathGone -Path (Join-Path $InstallDir "launcher.exe") -TimeoutSeconds 15 | Out-Null
  Wait-PathGone -Path $uninstaller -TimeoutSeconds 15 | Out-Null

  Write-Host "PASS smoke: instalacion, servicio, login, actualizaciones y desinstalacion"
} finally {
  if (-not $KeepInstall) {
    if ($installed -and -not $uninstalled -and (Test-Path -LiteralPath $uninstaller)) {
      try { & $uninstaller /S | Out-Null } catch {}
    }
    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($null -ne $service) {
      try { Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue } catch {}
    }
    Start-Sleep -Milliseconds 500
    Remove-Item -LiteralPath $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    Write-Host "instalacion conservada en $InstallDir"
  }
}
