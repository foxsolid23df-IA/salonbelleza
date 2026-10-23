# Despliegue del servidor de licencias

Arquitectura elegida: Vercel para la API HTTPS y Turso para la base SQLite persistente. El servidor no usa el sistema de archivos de Vercel; las licencias, activaciones, eventos y manifiestos viven en Turso.

```
Internet 443 -> Vercel Function (Express) -> Turso (SQLite serverless)
                                      \-> GitHub Releases (instaladores)
```

No se necesita dominio propio: la URL de producción es `https://salon-license.vercel.app`.

## 1. Requisitos

- Cuenta de Vercel y CLI (`npm i -g vercel`).
- Proyecto `salon-license` en el equipo `gabinotrejos-projects`.
- Integración gratuita **Turso Cloud** desde Vercel Marketplace.
- Token de Vercel para que GitHub Actions pueda desplegar (`VERCEL_TOKEN`).

## 2. Crear el proyecto y la base

```powershell
vercel project add salon-license --scope gabinotrejos-projects
vercel link --yes --scope gabinotrejos-projects --project salon-license --cwd tools/license-server
vercel integration add tursocloud/database --plan starter --name salon-license-db --scope gabinotrejos-projects --cwd tools/license-server -e production -e preview -e development
```

La integración crea `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN` en el proyecto. Si Vercel pide aceptar los términos de Turso, hazlo en la URL que muestra el comando y vuelve a ejecutarlo.

## 3. Variables de entorno

Configura en Vercel (Production y Preview):

| Variable | Uso |
|---|---|
| `TURSO_DATABASE_URL` | URL de la base Turso; la crea la integración |
| `TURSO_AUTH_TOKEN` | Token de Turso; lo crea la integración |
| `LICENSE_ADMIN_TOKEN` | Token largo para `/admin/*` y publicación de manifiestos |
| `LICENSE_PRIVATE_KEY_PEM` | Llave privada Ed25519 en PEM |
| `LICENSE_PUBLIC_KEY_PEM` | Llave pública Ed25519 en PEM |
| `LICENSE_TRUST_PROXY` | `1` para confiar en el proxy de Vercel |
| `LICENSE_ALLOW_SELF_ACTIVATION` | `0` en producción |
| `LICENSE_SEED_DEMO` | `0` en producción |
| `LICENSE_TOKEN_DAYS` | Vigencia del token; por defecto `30` |
| `LICENSE_GRACE_DAYS` | Gracia offline; por defecto `14` |
| `LICENSE_RL_ACTIVATE` | Límite de activaciones por minuto |
| `LICENSE_RL_VERIFY` | Límite de verificaciones por minuto |
| `LICENSE_RL_ADMIN` | Límite de administración por minuto |
| `LICENSE_RL_UPDATES` | Límite de consultas de versión por minuto |
| `LICENSE_SERVER_VERSION` | Versión informativa que devuelve `/health` |

Genera las llaves una sola vez y guárdalas fuera del repositorio:

```powershell
node -e "const c=require('crypto'),f=require('fs');const p=c.generateKeyPairSync('ed25519');f.writeFileSync('private.pem',p.privateKey.export({type:'pkcs8',format:'pem'}));f.writeFileSync('public.pem',p.publicKey.export({type:'spki',format:'pem'}));"
```

Carga los PEM con `vercel env add NOMBRE production --sensitive` (y repite para `preview`). La llave privada no debe commitearse ni imprimirse.

## 4. Desplegar

```powershell
vercel --prod --yes --cwd tools/license-server
```

La primera vez Vercel asigna una URL del tipo `https://salon-license-<hash>-<equipo>.vercel.app` y el alias estable `https://salon-license.vercel.app`.

## 5. Verificar

```powershell
$base = "https://salon-license.vercel.app"
Invoke-RestMethod "$base/health"
Invoke-RestMethod "$base/public"
Invoke-RestMethod "$base/api/version?channel=stable"
```

`/health` debe devolver `ok: true`. `/public` debe devolver la llave pública. `/api/version` devuelve `404 NO_UPDATE_MANIFEST` hasta que se publique un manifiesto; eso es normal antes del primer release.

## 6. Administración

Todas las rutas `/admin/*` requieren `Authorization: Bearer <LICENSE_ADMIN_TOKEN>`.

```powershell
$h = @{ Authorization = "Bearer $env:LICENSE_ADMIN_TOKEN" }
$body = @{ plan = "pro"; cliente_email = "cliente@ejemplo.com" } | ConvertTo-Json
Invoke-RestMethod "https://salon-license.vercel.app/admin/licenses" -Method Post -Headers $h -ContentType "application/json" -Body $body
```

Comandos disponibles: crear licencia, listar, ver detalle, revocar/reactivar equipo, eventos y publicación de manifiestos. La CLI local `node admin.js` sigue funcionando contra un archivo SQLite si se define `LICENSE_DATA_DIR`; para producción usa la API.

## 7. Publicar una actualización

El workflow lo hace en cada tag. Manualmente:

```powershell
$body = @{
  channel = "stable"
  version = "0.2.1"
  url = "https://github.com/foxsolid23df-IA/salonbelleza/releases/download/v0.2.1/SalonSuite-0.2.1-setup.exe"
  sha256 = "<sha256 del setup>"
  notes = "Versión 0.2.1"
  published_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
} | ConvertTo-Json -Depth 4
Invoke-RestMethod "https://salon-license.vercel.app/admin/updates" -Method Post -Headers $h -ContentType "application/json" -Body $body
```

Los tags con sufijo `-rc`/`-beta` se publican en el canal `beta`; los tags `vX.Y.Z` en `stable`.

## 8. Respaldos

Turso conserva la base y permite restaurar desde su panel. Para una copia lógica:

```powershell
$env:TURSO_DATABASE_URL = "..."
$env:TURSO_AUTH_TOKEN = "..."
npm run backup
```

El backup genera un JSON con licencias, activaciones, eventos y manifiestos en `data/backups/`. Guarda la llave privada por separado; sin ella no se pueden firmar tokens ni manifiestos nuevos.

## 9. GitHub Actions

Variables del repositorio:

- `LICENSE_SERVER_URL=https://salon-license.vercel.app`
- `LICENSE_PUBLIC_KEY_PEM` (contenido del PEM público)
- `CI_SMOKE=true`
- `SIGNTOOL_TIMESTAMP_URL=http://timestamp.digicert.com`

Secretos:

- `LICENSE_ADMIN_TOKEN`
- `SMOKE_LICENSE_KEY`
- `SMOKE_LICENSE_EMAIL`
- `VERCEL_TOKEN` (para desplegar el servidor en cada push/tag)
- `WINDOWS_CERT_PFX_BASE64`
- `WINDOWS_CERT_PASSWORD`

El workflow revoca la activación anterior de la licencia de humo antes de instalar, para que cada runner pueda activar desde un HWID nuevo. Después del despliegue consulta `/health`, `/public` y el manifiesto firmado.

## 10. Limitaciones de Vercel

- El rate limit es por instancia de función; para volúmenes altos usa un almacén distribuido.
- La función tiene límite de tamaño de cuerpo y tiempo de ejecución; las descargas de instaladores van a GitHub Releases, no por la función.
- No se usa `better-sqlite3` en producción: Turso habla SQLite por HTTP y evita un sistema de archivos efímero.
