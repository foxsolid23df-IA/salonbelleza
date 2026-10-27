# Estado de entrega de Salón Suite

Actualizado: 26 de octubre de 2026. Este documento no contiene secretos: solo inventario, evidencia y pendientes.

## 1. Resumen ejecutivo

La aplicación, el instalador, el servidor de licencias y el flujo de CI/CD están implementados y verificados. El servidor de producción está desplegado en Vercel con Turso y el smoke de CI ya activa licencias reales.

La entrega **estable** todavía no está publicada. Faltan dos cosas externas al código:

1. Cargar el certificado Authenticode (PFX y contraseña) en los secretos del repositorio.
2. Cargar un token de Vercel para que GitHub Actions despliegue el servidor durante la compuerta estable.

Además, el API de GitHub no muestra esos secretos todavía: solo están visibles `LICENSE_ADMIN_TOKEN`, `SMOKE_LICENSE_KEY` y `SMOKE_LICENSE_EMAIL`. Hay que revisar que se hayan guardado en **Repository secrets** de `foxsolid23df-IA/salonbelleza`, no en Vercel ni en un environment.

## 2. Lo que ya está hecho

### Aplicación e instalador

| Pieza | Estado |
|---|---|
| App Node/Express/EJS/SQLite | Funcional; módulos de clientes, servicios, productos, personal, citas, ventas, caja, reportes y perfil |
| Licenciamiento por HWID + Ed25519 | Funcional; TTL 30 días, gracia offline 14 días, revalidación cada 24 h y revocación |
| Wizard `/setup` y cambio forzado de contraseña | Funcional |
| Runtime embebido | `runtime\node.exe`; no requiere Node en el equipo destino |
| Instalador NSIS | Instalación con/sin UAC, servicio WinSW, atajos, upgrade y desinstalación |
| ZIP portable | Generado y verificado |
| Actualizaciones in-app | Manifiesto firmado, SHA-256, descarga, instalación silenciosa y rollback |
| Firma Authenticode | Implementada en `build/sign.ps1`; **pendiente de certificado real** |

### Servidor de licencias

| Pieza | Estado |
|---|---|
| Producción | `https://salon-license.vercel.app` (Vercel + Turso, sin dominio propio) |
| Persistencia | Turso; no usa el sistema de archivos efímero de Vercel |
| Licencias | Crear, listar, detallar, revocar y reactivar; una activación activa por licencia |
| Seguridad | `LICENSE_ADMIN_TOKEN`, rate limit, validación de body/UUID/HWID y auditoría |
| Llaves | Ed25519 en variables de Vercel; `/public` publica la llave correcta |
| Actualizaciones | Manifiestos `stable`/`beta` firmados; publicación con `POST /admin/updates` |
| Health | `/health` responde 200 con versión `2.1.0` |
| Manifiesto beta | `0.2.0-rc.2` publicado; firma Ed25519 verificada |
| Manifiesto stable | Aún no existe; `/api/version?channel=stable` devuelve `404 NO_UPDATE_MANIFEST` (esperado) |

### CI/CD y releases

| Pieza | Estado |
|---|---|
| Workflow `.github/workflows/build.yml` | Build en `windows-latest`, tests, NSIS, smoke, artefactos, release y despliegue opcional |
| Smoke real | Activa la licencia de humo contra Vercel/Turso; antes revoca la activación anterior |
| Run de `main` | `40442697124` en verde sobre `baaf0f8` |
| Run con smoke real | `39899601490` en verde sobre `1a9ac85`; artefacto `0.0.0-ci.8` |
| Run de tag | `39899893300` en verde sobre `1a9ac85`; release `v0.2.0-rc.2` |
| Pre-release | `v0.2.0-rc.2`, marcada como pre-release |
| Activos del release | Setup, ZIP, `SHA256SUMS.txt` y `BUILD-INFO.json` |
| SHA-256 del setup rc.2 | `f8f1b96b7f95f7a22378e64788f6c1d2f1738b4a5d6696f8b9bd0fd32284bacb` |
| SHA-256 del ZIP rc.2 | `284a6b7892f5df0125bd4fbffd58723d878cd27f4453cfec368edec7a14d139e` |
| Estado de firma rc.2 | `signed=false`; no se presenta como firmado |
| Artefacto `0.0.0-ci.8` | Descargado; sus dos SHA-256 coinciden con `SHA256SUMS.txt` |

### Configuración de GitHub

Variables presentes:

- `LICENSE_SERVER_URL=https://salon-license.vercel.app`
- `LICENSE_PUBLIC_KEY_PEM` (llave pública Ed25519)
- `CI_SMOKE=true`
- `SIGNTOOL_TIMESTAMP_URL=http://timestamp.digicert.com`

Secretos presentes:

- `LICENSE_ADMIN_TOKEN`
- `SMOKE_LICENSE_KEY`
- `SMOKE_LICENSE_EMAIL`

### Documentación

- `README.md`: estado de fases, operación, build, firma, CI/CD y compuerta estable.
- `tools/license-server/DEPLOY.md`: Vercel + Turso, variables, llaves, administración, manifiestos, backups y carga de secretos.
- `tools/license-server/updates/README.md`: publicación de actualizaciones por canal.
- `docs/PLAN-EMPAQUETADO.md`: plan por fases y criterios de terminado.
- Este documento: inventario y pendientes.

## 3. Lo que falta

### P0 — Para publicar `v0.2.0` estable

| Pendiente | Detalle |
|---|---|
| `VERCEL_TOKEN` | Crear en `https://vercel.com/account/tokens` con scope `gabinotrejos-projects` y guardarlo como **Repository secret** |
| `WINDOWS_CERT_PFX_BASE64` | PFX del certificado de code signing convertido a base64 |
| `WINDOWS_CERT_PASSWORD` | Contraseña del PFX |
| Verificar secretos | `gh secret list --repo foxsolid23df-IA/salonbelleza` debe mostrar los seis secretos |
| Build firmado | Ejecutar un build con el PFX y confirmar `BUILD-INFO.json` con `"signed": true` |
| Despliegue desde CI | Confirmar que el paso de Vercel deja de omitirse y publica el servidor |
| Tag estable | Crear `v0.2.0` solo después de que el build firmado y el despliegue pasen |
| Verificación posterior | Confirmar release, `/health`, `/public`, `/api/version?channel=stable` y manifiesto firmado |

La compuerta del workflow exige exactamente:

- `BUILD-INFO.json` con `signed=true`.
- `LICENSE_SERVER_URL` explícita.
- `LICENSE_PUBLIC_KEY_PEM`.
- `SMOKE_LICENSE_KEY`.
- `LICENSE_ADMIN_TOKEN`.
- `VERCEL_TOKEN`.
- `CI_SMOKE` distinto de `false`.

Si falta cualquiera, el tag `vX.Y.Z` no se publica como estable.

### P1 — QA antes de entregar a clientes

| Pendiente | Detalle |
|---|---|
| Instalación con UAC real | Probar servicio WinSW, reglas de `%ProgramData%` y reinicio automático en Windows 10/11 |
| Actualización real | Descargar, instalar, reiniciar y verificar que datos/licencia se conservan |
| Rollback real | Forzar una versión que no responde y confirmar restauración de `app.old` |
| Desinstalación | Probar conservar y borrar datos/licencia |
| Backup/restauración | Restaurar una copia de Turso y una copia local `salon-*.db` |
| Antivirus/SmartScreen | Probar Defender y un antivirus de terceros; documentar el aviso si no hay firma EV |

### P2 — Operación y mantenimiento

| Pendiente | Detalle |
|---|---|
| Custodia de llave privada | Mover `private.pem` a una bóveda cifrada; no debe quedar en el directorio temporal de la sesión |
| Rotación de llaves | Documentar y probar el procedimiento si se compromete la llave |
| Backup programado de Turso | Definir frecuencia, retención y responsable |
| Integración Git de Vercel | Opcional: conectar el repositorio y configurar Root Directory `tools/license-server` para auto-deploy sin token |
| Panel de soporte | Opcional; hoy la API y `admin.js` cubren la operación |

## 4. Cómo cerrar la entrega estable

### Paso 1: cargar los secretos

Ir a:

`https://github.com/foxsolid23df-IA/salonbelleza/settings/secrets/actions`

Crear **Repository secrets** con estos nombres exactos:

- `VERCEL_TOKEN`
- `WINDOWS_CERT_PFX_BASE64`
- `WINDOWS_CERT_PASSWORD`

Para el token:

```powershell
$token = Read-Host -AsSecureString "Token de Vercel"
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($token))
gh secret set VERCEL_TOKEN --repo foxsolid23df-IA/salonbelleza --body $plain
```

Para el PFX:

```powershell
$pfx = "C:\ruta\certificado.pfx"
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($pfx))
gh secret set WINDOWS_CERT_PFX_BASE64 --repo foxsolid23df-IA/salonbelleza --body $b64
$password = Read-Host -AsSecureString "Contraseña del PFX"
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($password))
gh secret set WINDOWS_CERT_PASSWORD --repo foxsolid23df-IA/salonbelleza --body $plain
```

### Paso 2: verificar

```powershell
gh secret list --repo foxsolid23df-IA/salonbelleza
```

Deben aparecer los seis secretos. Si `VERCEL_TOKEN` o los del PFX no aparecen, revisar que se guardaron en el repositorio correcto y como Repository secrets.

### Paso 3: build firmado de prueba

Lanzar el workflow manualmente con una versión con sufijo, por ejemplo `0.2.0-rc.3` y canal `beta`. No crea un release estable. Comprobar:

- El paso de Vercel ya no se omite.
- `BUILD-INFO.json` tiene `"signed": true`.
- `signtool verify /pa` pasa.
- El smoke activa la licencia real.

### Paso 4: publicar `v0.2.0`

Solo si el paso anterior está en verde:

```powershell
git tag v0.2.0
git push origin v0.2.0
```

La compuerta estable debe:

1. Compilar y firmar setup/ZIP.
2. Ejecutar el smoke con activación real.
3. Desplegar el servidor en Vercel.
4. Crear el GitHub Release.
5. Publicar el manifiesto `stable` firmado.
6. Verificar `/health`, `/public` y la coincidencia de la llave pública.

### Paso 5: verificación final

```powershell
$base = "https://salon-license.vercel.app"
Invoke-RestMethod "$base/health"
Invoke-RestMethod "$base/public"
Invoke-RestMethod "$base/api/version?channel=stable"
```

Comprobar que el manifiesto stable apunta al setup `0.2.0`, que el SHA-256 coincide con el activo del release y que la firma verifica con la llave pública.

## 5. Evidencia y enlaces

- Producción: `https://salon-license.vercel.app`
- Repositorio: `https://github.com/foxsolid23df-IA/salonbelleza`
- Release rc.2: `https://github.com/foxsolid23df-IA/salonbelleza/releases/tag/v0.2.0-rc.2`
- Run main más reciente: `https://github.com/foxsolid23df-IA/salonbelleza/actions/runs/40442697124`
- Run smoke real: `https://github.com/foxsolid23df-IA/salonbelleza/actions/runs/39899601490`
- Run del tag rc.2: `https://github.com/foxsolid23df-IA/salonbelleza/actions/runs/39899893300`

Estado actual de la API de producción:

- `/health`: `ok=true`, versión `2.1.0`.
- `/public`: `ok=true`, algoritmo `Ed25519`.
- `/api/version?channel=beta`: `0.2.0-rc.2`, firma presente.
- `/api/version?channel=stable`: `404 NO_UPDATE_MANIFEST` (todavía no hay estable).

## 6. Seguridad

- La llave privada Ed25519 y el token de administración están fuera del repositorio; no se versionan.
- La copia temporal de la llave privada debe moverse a una bóveda cifrada y borrarse del equipo de trabajo.
- El PFX y su contraseña deben vivir solo en los secretos de GitHub y en la bóveda del responsable.
- No se debe publicar un build sin certificado como “firmado”: en ese caso `BUILD-INFO.json` queda con `signed=false`.
- El ZIP portable no se puede firmar como archivo; se firma su launcher y el setup.

## 7. Criterio de terminado

La entrega estable se considera cerrada cuando:

- [ ] Los seis secretos están en GitHub.
- [ ] Un build produce `signed=true` y `signtool verify /pa` pasa.
- [ ] El despliegue de Vercel se ejecuta desde GitHub Actions.
- [ ] El smoke activa una licencia real y revoca la anterior.
- [ ] `v0.2.0` se publica como release estable.
- [ ] El manifiesto `stable` está firmado y apunta al setup correcto.
- [ ] `/health`, `/public` y `/api/version?channel=stable` responden correctamente.
- [ ] La matriz de Fase 6 se ejecutó en Windows 10/11 con y sin UAC.
- [ ] La llave privada y el PFX están en una bóveda cifrada.
