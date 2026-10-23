param(
  [Parameter(Mandatory = $true)]
  [string[]]$Files,
  [string]$PfxPath = "",
  [string]$Password = "",
  [string]$TimestampUrl = ""
)

$ErrorActionPreference = "Stop"

function Find-SignTool {
  $command = Get-Command signtool.exe -ErrorAction SilentlyContinue
  if ($null -ne $command) { return $command.Source }

  $roots = @()
  $x86 = [Environment]::GetFolderPath("ProgramFilesX86")
  $x64 = [Environment]::GetFolderPath("ProgramFiles")
  if ($x86) { $roots += (Join-Path $x86 "Windows Kits\10\bin") }
  if ($x64) { $roots += (Join-Path $x64 "Windows Kits\10\bin") }

  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    $found = Get-ChildItem -LiteralPath $root -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
      Sort-Object FullName -Descending |
      Select-Object -First 1
    if ($null -eq $found) {
      $found = Get-ChildItem -LiteralPath $root -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
        Sort-Object FullName -Descending |
        Select-Object -First 1
    }
    if ($null -ne $found) { return $found.FullName }
  }
  return $null
}

if (-not $TimestampUrl) {
  if ($env:SIGNTOOL_TIMESTAMP_URL) {
    $TimestampUrl = $env:SIGNTOOL_TIMESTAMP_URL
  } else {
    $TimestampUrl = "http://timestamp.digicert.com"
  }
}

if (-not $Password) {
  $Password = $env:WINDOWS_CERT_PASSWORD
}

$temporaryPfx = $null
if (-not $PfxPath) {
  $encoded = $env:WINDOWS_CERT_PFX_BASE64
  if (-not $encoded) {
    throw "No hay certificado: define -PfxPath o WINDOWS_CERT_PFX_BASE64"
  }
  $encoded = ($encoded -replace '\s', '')
  $temporaryPfx = Join-Path ([IO.Path]::GetTempPath()) ("salonsuite-" + [Guid]::NewGuid().ToString("N") + ".pfx")
  try {
    [IO.File]::WriteAllBytes($temporaryPfx, [Convert]::FromBase64String($encoded))
  } catch {
    throw "WINDOWS_CERT_PFX_BASE64 no contiene un PFX válido en base64"
  }
  $PfxPath = $temporaryPfx
}

$PfxPath = [IO.Path]::GetFullPath($PfxPath)
try {
  if (-not (Test-Path -LiteralPath $PfxPath -PathType Leaf)) {
    throw "No existe el certificado PFX: $PfxPath"
  }

  $signTool = Find-SignTool
  if (-not $signTool) {
    throw "No se encontró signtool.exe. Instala Windows SDK o ejecuta en windows-latest"
  }

  $resolvedFiles = @()
  foreach ($file in $Files) {
    if (-not $file) { continue }
    $full = [IO.Path]::GetFullPath($file)
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
      throw "No existe el archivo a firmar: $full"
    }
    $resolvedFiles += $full
  }
  if ($resolvedFiles.Count -eq 0) {
    throw "No se indicó ningún archivo para firmar"
  }

  foreach ($file in $resolvedFiles) {
    $arguments = @("sign", "/fd", "SHA256", "/f", $PfxPath)
    if ($Password) { $arguments += @("/p", $Password) }
    $arguments += @("/tr", $TimestampUrl, "/td", "SHA256", $file)

    & $signTool @arguments
    if ($LASTEXITCODE -ne 0) {
      throw "signtool sign falló para $file con código $LASTEXITCODE"
    }

    & $signTool verify /pa /v $file
    if ($LASTEXITCODE -ne 0) {
      throw "signtool verify falló para $file con código $LASTEXITCODE"
    }
    Write-Host "firma verificada: $file"
  }
} finally {
  if ($temporaryPfx -and (Test-Path -LiteralPath $temporaryPfx)) {
    Remove-Item -LiteralPath $temporaryPfx -Force -ErrorAction SilentlyContinue
  }
}
