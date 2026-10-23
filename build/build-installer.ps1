param(
  [string]$Version = "0.2.0",
  [string]$LicenseServer = "https://get.salonsuite.com",
  [string]$PublicKey = "",
  [string]$NsisDir = "",
  [switch]$TestNoAdmin,
  [string]$PfxPath = "",
  [string]$PfxPassword = "",
  [string]$TimestampUrl = "",
  [string]$UpdateChannel = "stable"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$pkg = Join-Path $root "pkg"
$dist = Join-Path $root "dist"
$installerDir = Join-Path $root "build\installer"

if ($NsisDir -eq "") {
  $candidates = @(
    (Join-Path $root "..\tools\nsis\nsis-3.13"),
    (Join-Path $env:ProgramFiles "NSIS"),
    (Join-Path ${env:ProgramFiles(x86)} "NSIS")
  )
  foreach ($c in $candidates) {
    if (Test-Path (Join-Path $c "makensis.exe")) { $NsisDir = $c; break }
  }
}

if ($NsisDir -eq "") {
  $toolsDir = Join-Path $root "..\tools"
  New-Item -ItemType Directory -Force $toolsDir | Out-Null
  $zipPath = Join-Path $toolsDir "nsis.zip"
  $extractDir = Join-Path $toolsDir "nsis"
  Write-Host "descargando NSIS 3.13..."
  Invoke-WebRequest -Uri "https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.13/nsis-3.13.zip" -OutFile $zipPath -UseBasicParsing -TimeoutSec 120
  Remove-Item $extractDir -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
  $found = Get-ChildItem $extractDir -Recurse -Filter makensis.exe | Select-Object -First 1
  if ($null -eq $found) { throw "No se encontro makensis.exe en el paquete descargado" }
  $NsisDir = $found.DirectoryName
}

$makensis = Join-Path $NsisDir "makensis.exe"
if (-not (Test-Path $makensis)) { throw "makensis.exe no existe en $NsisDir" }

if (-not $PfxPassword) { $PfxPassword = $env:WINDOWS_CERT_PASSWORD }
if (-not $TimestampUrl) { $TimestampUrl = $env:SIGNTOOL_TIMESTAMP_URL }
$signing = $false
if ($PfxPath) {
  if (-not (Test-Path -LiteralPath $PfxPath -PathType Leaf)) {
    throw "No existe el certificado PFX: $PfxPath"
  }
  $signing = $true
} elseif ($env:WINDOWS_CERT_PFX_BASE64 -and ($env:WINDOWS_CERT_PFX_BASE64).Trim()) {
  $signing = $true
}

$nsiPath = Join-Path $PSScriptRoot "salonsuite.nsi"
$nsiText = [IO.File]::ReadAllText($nsiPath, [Text.Encoding]::UTF8)
[IO.File]::WriteAllText($nsiPath, $nsiText, (New-Object Text.UTF8Encoding($true)))

& (Join-Path $PSScriptRoot "assemble.ps1") -Version $Version -LicenseServer $LicenseServer -PublicKey $PublicKey -NoZip -UpdateChannel $UpdateChannel

if ($signing) {
  Write-Host "firmando launcher y servicio antes de NSIS..."
  $signArgs = @{
    Files = @(
      (Join-Path $pkg "launcher.exe"),
      (Join-Path $installerDir "salonsuite-service.exe")
    )
    PfxPath = $PfxPath
    Password = $PfxPassword
    TimestampUrl = $TimestampUrl
  }
  & (Join-Path $PSScriptRoot "sign.ps1") @signArgs
} else {
  Write-Host "sin certificado Authenticode: se publicaran SHA-256"
}

Push-Location $PSScriptRoot
try {
  $makensisArgs = @("/V2", "/DAPP_VERSION=$Version", "salonsuite.nsi")
  if ($TestNoAdmin) { $makensisArgs = @("/V2", "/DAPP_VERSION=$Version", "/DTEST_NO_ADMIN", "salonsuite.nsi") }
  & $makensis $makensisArgs
  if ($LASTEXITCODE -ne 0) { throw "makensis fallo con codigo $LASTEXITCODE" }
} finally {
  Pop-Location
}

$setup = Join-Path $dist "SalonSuite-$Version-setup.exe"
if (-not (Test-Path $setup)) { throw "No se genero el instalador" }

if ($signing) {
  Write-Host "firmando el instalador final..."
  & (Join-Path $PSScriptRoot "sign.ps1") -Files @($setup) -PfxPath $PfxPath -Password $PfxPassword -TimestampUrl $TimestampUrl
}

$portable = Join-Path $dist "SalonSuite-$Version-portable.zip"
if (Test-Path $portable) { Remove-Item -LiteralPath $portable -Force }
Compress-Archive -Path (Join-Path $pkg "*") -DestinationPath $portable

$files = @()
$sums = @()
foreach ($file in @($setup, $portable)) {
  $item = Get-Item -LiteralPath $file
  $hash = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLower()
  $files += [ordered]@{
    name = $item.Name
    sha256 = $hash
    bytes = $item.Length
  }
  $sums += "$hash  $($item.Name)"
  Write-Host "sha256: $($item.Name) $hash"
}
Set-Content -Path (Join-Path $dist "SHA256SUMS.txt") -Value $sums -Encoding ASCII

$buildInfo = [ordered]@{
  version = $Version
  signed = [bool]$signing
  signature = $(if ($signing) { "Authenticode" } else { "none" })
  generated_at = [DateTime]::UtcNow.ToString("o")
  files = $files
}
$buildInfo | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $dist "BUILD-INFO.json") -Encoding UTF8

$size = [math]::Round((Get-Item $setup).Length / 1MB, 1)
Write-Host "instalador: $setup ($size MB)"
Write-Host "portable: $portable"
Write-Host "firma: $(if ($signing) { 'Authenticode verificada' } else { 'no configurada' })"

$bytes = [IO.File]::ReadAllBytes($setup)
$ascii = [Text.Encoding]::ASCII.GetString($bytes)
$idx = $ascii.IndexOf("requestedExecutionLevel")
if ($idx -ge 0) {
  $level = $ascii.Substring($idx, [Math]::Min(80, $ascii.Length - $idx))
  Write-Host "nivel de ejecucion: $level"
}
