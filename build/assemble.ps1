param(
  [string]$Version = "0.2.0",
  [string]$LicenseServer = "https://salon-license.vercel.app",
  [string]$PublicKey = "",
  [switch]$NoZip,
  [string]$UpdateChannel = "stable"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$pkg = Join-Path $root "pkg"
$app = Join-Path $pkg "app"
$dist = Join-Path $root "dist"
$installerDir = Join-Path $root "build\installer"
$seedDir = Join-Path $root "build\seed"

$nodeExe = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { throw "Node no está en PATH; se necesita para ensamblar." }

$csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe" }
if (-not (Test-Path $csc)) { throw "No se encontró csc.exe (.NET Framework 4)." }

if (Test-Path $pkg) { Remove-Item $pkg -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $pkg "runtime") | Out-Null
New-Item -ItemType Directory -Force $app | Out-Null
New-Item -ItemType Directory -Force $dist | Out-Null
New-Item -ItemType Directory -Force $installerDir | Out-Null
New-Item -ItemType Directory -Force $seedDir | Out-Null

Copy-Item $nodeExe (Join-Path $pkg "runtime\node.exe")

Copy-Item (Join-Path $root "server.js") $app
Copy-Item (Join-Path $root "package.json") $app
Copy-Item (Join-Path $root "package-lock.json") $app
foreach ($dir in @("src", "views", "public")) {
  Copy-Item (Join-Path $root $dir) (Join-Path $app $dir) -Recurse
}

Push-Location $app
try {
  npm ci --omit=dev --no-audit --no-fund --silent
  if ($LASTEXITCODE -ne 0) { throw "npm ci falló con código $LASTEXITCODE" }
} finally {
  Pop-Location
}

$envLines = @(
  "APP_VERSION=$Version",
  "NODE_ENV=production",
  "PORT=3000",
  "HOST=127.0.0.1",
  "LICENSE_SERVER_URL=$LicenseServer",
  "SALON_GRACE_DAYS=14",
  "SALON_UPDATE_CHANNEL=$UpdateChannel"
)
Set-Content -Path (Join-Path $app ".env") -Value $envLines -Encoding ASCII

if ($PublicKey) {
  if (-not (Test-Path $PublicKey)) { throw "No se encontro la llave publica: $PublicKey" }
  Copy-Item $PublicKey (Join-Path $app "public_key.pem") -Force
}

$seedDb = Join-Path $seedDir "salon.db"
if (Test-Path $seedDb) { Remove-Item "$seedDb*" -Force }
$previousDb = $env:SALON_DB
$env:SALON_DB = $seedDb
Push-Location $app
try {
  & (Join-Path $pkg "runtime\node.exe") -e "const m=require('./src/db'); m.db.pragma('wal_checkpoint(TRUNCATE)'); m.db.close();"
  if ($LASTEXITCODE -ne 0) { throw "No se pudo generar la BD de ejemplo" }
} finally {
  Pop-Location
  if ($null -eq $previousDb) { Remove-Item Env:SALON_DB -ErrorAction SilentlyContinue } else { $env:SALON_DB = $previousDb }
}
Remove-Item "$seedDb-wal", "$seedDb-shm" -Force -ErrorAction SilentlyContinue
if ((Get-Item $seedDb).Length -lt 8192) { throw "La BD de ejemplo quedo vacia (WAL no consolidado)" }

& $csc /nologo /target:winexe /optimize+ /codepage:65001 /out:"$pkg\launcher.exe" "$root\build\launcher.cs" /r:System.Windows.Forms.dll
if ($LASTEXITCODE -ne 0) { throw "No se pudo compilar launcher.exe" }

$winswExe = Join-Path $root "build\winsw\winsw.exe"
if (-not (Test-Path $winswExe)) {
  Write-Host "descargando WinSW 2.12.0..."
  Invoke-WebRequest -Uri "https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW-x64.exe" -OutFile $winswExe -UseBasicParsing -TimeoutSec 120
}
Copy-Item $winswExe (Join-Path $installerDir "salonsuite-service.exe") -Force
Copy-Item (Join-Path $root "build\winsw\winsw-salonsuite.xml") (Join-Path $installerDir "salonsuite-service.xml") -Force

$dbCheck = & (Join-Path $pkg "runtime\node.exe") -e "const db=require('better-sqlite3'); process.stdout.write('ok ' + db(':memory:').prepare('select 1 as x').get().x)" 2>&1
if ($dbCheck -notmatch "ok 1") { throw "better-sqlite3 no carga en el paquete: $dbCheck" }

$seedCheck = & (Join-Path $pkg "runtime\node.exe") -e "const db=require('better-sqlite3')(process.argv[1],{readonly:true}); const n=(t)=>db.prepare('SELECT COUNT(*) AS n FROM '+t).get().n; process.stdout.write('staff='+n('staff')+' services='+n('services')+' products='+n('products'));" $seedDb 2>&1
if ($seedCheck -notmatch "staff=") { throw "BD de ejemplo inválida: $seedCheck" }

$zipPath = Join-Path $dist "SalonSuite-$Version-portable.zip"
if (-not $NoZip) {
  if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
  Compress-Archive -Path (Join-Path $pkg "*") -DestinationPath $zipPath
}

$size = [math]::Round(((Get-ChildItem $pkg -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Host "runtime: $nodeExe"
Write-Host "paquete: $pkg ($size MB)"
Write-Host "ejemplo: $seedCheck"
if (-not $NoZip) { Write-Host "portable: $zipPath" }
