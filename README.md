# Salón Suite — app de gestión (clean-room)

App de escritorio/salón desarrollada desde cero (clean-room) para uso interno, inspirada en la analizada en `analysis/ARCHITECTURE.md`. No contiene código, marcas ni licencias del sistema original.

## Estado de fases

- **0, 1 y 2: completadas.** Endurecimiento, runtime propio, instalador NSIS y lanzador verificados.
- **3: completada y desplegada.** Servidor de licencias con licencias pre-emitidas, admin autenticado, rate-limit, revocación, auditoría y backups. Producción: Vercel + Turso en `https://salon-license.vercel.app`.
- **4: completada en local.** Manifiesto firmado, banner/página admin, descarga con SHA-256, instalación silenciosa y rollback. Falta la prueba end-to-end en un Windows elevado con servicio/UAC.
- **5: CI verificada y servidor real.** El workflow compila en `windows-latest`, genera instalador/ZIP/checksums, ejecuta el smoke con activación real contra Vercel/Turso y publica artefactos. La pre-release `v0.2.0-rc.2` está publicada sin firma Authenticode.
- **6: pendiente.** QA final y publicación de la entrega estable firmada.

Detalle y pendientes: `docs/PLAN-EMPAQUETADO.md`.

## Tecnologías (decisión del usuario)

- Node.js + Express 5 + EJS + HTMX + SQLite (`better-sqlite3`)
- Auth con sesión (`express-session`) + scrypt para contraseñas
- Diseño propio (CSS sin frameworks)
- Servidor de licencias: Node/Express en Vercel + Turso (SQLite serverless)

## Arrancar

```
cd C:\salones\app
npm start        # => http://localhost:3000
```

- Credencial de admin: `admin@salon.local` / `admin123`
- El resto (`data/salon.db`) se genera al primer inicio con datos seed.
- Con licenciamiento activo, el primer arranque abre `/setup` (wizard de activación).

## Módulos (alineados al MVP)

| Ruta | Función |
|------|---------|
| `/login` | Auth (Forms-style), `/logout` |
| `/` | Dashboard: accesos, próximas citas, tickets en espera |
| `/clientes` | CRUD + búsqueda HTMX, historial de citas y tickets |
| `/servicios` | CRUD + familias; precio/duración/color/IVA |
| `/productos` | CRUD + movimientos de stock |
| `/personal` | CRUD staff, color de agenda |
| `/citas` | Agenda diaria (grid por personal, slots de 15 min), crear/editar, estado, check-in |
| `/ventas` | POS: tickets en espera, catálogo servicios/productos (HTMX), pagos múltiples, crédito/gift card |
| `/caja` | Apertura/cierre, gastos, tickets cobrados, resumen por método y personal |
| `/reportes` | Ventas diarias, rendimiento por personal, top servicios/productos/clientes, stats de citas |
| `/perfil` | Cambio de contraseña (obligatorio si `force_change=1`) |

## Datos

- Cliente de paso `id=1` "Público General" auto-aplicado al cobrar sin cliente.
- IVA 16% por defecto (configurable por servicio).

## Licenciamiento (por equipo)

- HWID = SHA-256 de `serial placa base | serial disco | UUID de máquina` (PowerShell/CIM). En otros SO se usa un ID local persistido en `.license/hwid_local`.
- Token firmado Ed25519: `base64url(payload).base64url(firma)`; payload `{ license_key, hwid, salon, cliente_email, plan, staff_max, exp, iat }`.
- TTL 30 días, gracia offline 14 días. La verificación exige la llave pública: se guarda en `.license/public_key.pem` al activar, o se toma de `app/public_key.pem` (embebida en el instalador) o de `LICENSE_PUBLIC_KEY`. Sin llave, el token se rechaza; para desarrollo existe `SALON_DEV_SKIP_LICENSE=1`.
- Estado local en `.license/token` (JSON) + tablas `config` y `license_tokens` en la BD.
- El servidor de producción no usa archivos locales: licencias, activaciones, eventos y manifiestos están en Turso.

### Variables de entorno

| Variable | Default | Uso |
|----------|---------|-----|
| `APP_VERSION` | `0.2.0` | Versión mostrada en UI |
| `PORT` | `3000` | Puerto HTTP |
| `SALON_DB` | `data/salon.db` | Ruta de la BD |
| `SALON_SECRET` | dev | Firma de sesión (cambiar en producción) |
| `LICENSE_SERVER_URL` | `https://salon-license.vercel.app` | Servidor de activación/verificación |
| `LICENSE_PUBLIC_KEY` | — | PEM de la llave pública (alternativa al archivo) |
| `SALON_GRACE_DAYS` | `14` | Días de gracia sin conexión |
| `HOST` | `127.0.0.1` | Interfaz de escucha (usar `0.0.0.0` solo para LAN explícita) |
| `SALON_BACKUP_KEEP` | `14` | Copias diarias conservadas |
| `SALON_DEV_SKIP_LICENSE` | — | `1` = sin licencia (solo desarrollo) |
| `SALON_UPDATE_CHANNEL` | `stable` | Canal de actualizaciones (`stable` o `beta`) |
| `SALON_ALLOW_UNSIGNED_UPDATES` | — | `1` = aceptar manifiesto sin firma (solo desarrollo) |
| `SALON_UPDATE_ALLOW_HTTP` | — | `1` = permitir descarga por HTTP (solo desarrollo) |

### Operación instalada (Fase 0)

- Escucha solo en `127.0.0.1`; el puerto real se escribe en `data/port.txt` y, si el preferido está ocupado, prueba hasta 10 puertos más.
- `SALON_SECRET` se genera y persiste en `.env` en el primer arranque (las sesiones sobreviven reinicios).
- Revalidación de licencia cada 24 h contra `LICENSE_SERVER_URL`; revocación bloquea el acceso y ofrece reactivar; sin red se conserva la gracia local.
- Backup diario con la API de SQLite en `data/backups/salon-AAAAMMDD.db` (retención 14).
- Prueba de humo: `npm run test:smoke` (requiere app y servidor de licencias corriendo, con `data/` y `.license/` recién borrados; el servidor debe usar `LICENSE_ADMIN_TOKEN=dev-admin-token` o el mismo valor exportado).

### Servidor de licencias

Producción: `https://salon-license.vercel.app` (Vercel + Turso, sin dominio propio).

```
cd tools/license-server
npm install
copy .env.example .env
node index.js    # :4000, datos locales en tools/license-server/data
```

- En producción las llaves se cargan desde `LICENSE_PRIVATE_KEY_PEM` y `LICENSE_PUBLIC_KEY_PEM`; en local se generan en `data/keys/` al primer arranque.
- Licencias pre-emitidas: `node admin.js create pro cliente@dominio.com`. La licencia demo `550e8400-e29b-41d4-a716-446655440000` solo se crea con `LICENSE_SEED_DEMO=1`.
- `/admin/*` y `/revoke` requieren `LICENSE_ADMIN_TOKEN`; sin token quedan deshabilitados. Rate limit y auditoría incluidos.
- Endpoints públicos: `GET /health`, `GET /public`, `POST /activate`, `POST /verify` (renueva el token).
- Manifiestos: `GET /api/version?channel=stable|beta`; publicación con `POST /admin/updates`.
- Despliegue y variables: `tools/license-server/DEPLOY.md`.
- Backup lógico: `npm run backup` con `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN`.

Prueba del servidor (levanta un servidor temporal, 30 comprobaciones):

```
cd tools/license-server
npm test
```

Prueba local de la app:

```
set LICENSE_SERVER_URL=http://localhost:4000
npm start
```

## Paquete ejecutable (Fase 1)

```
build\assemble.ps1 -Version 0.2.0
```

Genera:

- `pkg\runtime\node.exe`: runtime propio; el equipo destino no necesita Node instalado.
- `pkg\app\`: `server.js`, `src`, `views`, `public` y `node_modules` de producción.
- `pkg\app\.env`: configuración sin secretos (`SALON_SECRET` se genera al primer arranque).
- `pkg\launcher.exe`: lanzador que arranca la app si no está corriendo y abre el navegador.
- `dist\SalonSuite-X.Y.Z-portable.zip`: ~38 MB comprimido (105 MB expandido).

Arranque: `pkg\launcher.exe` (recomendado) o `pkg\runtime\node.exe server.js` con directorio de trabajo `pkg\app`, o descomprimir el zip.

Rutas en el paquete: datos en `app\data\salon.db`, licencia en `app\.license\`, backups en `app\data\backups\` y puerto real en `app\data\port.txt`.

Verificado con un `PATH` sin Node: arranca, activa la licencia y sirve el dashboard usando `pkg\runtime\node.exe`.

## Instalador Windows (Fase 2)

Compilar (descarga NSIS 3.13 y WinSW 2.12 la primera vez si faltan):

```
build\build-installer.ps1 -Version 0.2.0 -LicenseServer https://salon-license.vercel.app -PublicKey C:\ruta\public.pem
```

`-PublicKey` es opcional: embebe `app\public_key.pem` para que el cliente confíe en la firma desde el primer arranque. Sin ella, la llave se guarda al activar por HTTPS.
`-UpdateChannel beta` embebe el canal beta; por defecto es `stable`.
Genera `dist\SalonSuite-0.2.0-setup.exe` (~31 MB), `dist\SalonSuite-0.2.0-portable.zip`, `dist\SHA256SUMS.txt` y `dist\BUILD-INFO.json` (estado de firma + hashes). Los hashes vigentes están en `dist\SHA256SUMS.txt`.

### Firma Authenticode (Fase 5)

El build firma `pkg\launcher.exe` y `salonsuite-service.exe` antes de comprimirlos con NSIS, y después firma el setup final. El ZIP portable se recrea **después** de firmar el launcher, así que contiene el mismo binario firmado que el instalador.

```
$env:WINDOWS_CERT_PFX_BASE64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("C:\ruta\certificado.pfx"))
$env:WINDOWS_CERT_PASSWORD = "clave-del-pfx"
$env:SIGNTOOL_TIMESTAMP_URL = "http://timestamp.digicert.com"
build\build-installer.ps1 -Version 0.2.0 -LicenseServer https://salon-license.vercel.app
```

- `build\sign.ps1` busca `signtool.exe` en Windows SDK, firma con SHA-256 y verificador `/pa`, y falla si la firma o la verificación no son correctas.
- También acepta `-PfxPath C:\ruta\certificado.pfx` para no usar base64.
- Sin certificado el build sigue siendo válido: `BUILD-INFO.json` queda con `"signed": false` y se publican los SHA-256.
- Mientras no haya certificado, Windows SmartScreen puede mostrar "editor desconocido"; publica siempre los hashes y explica a los clientes cómo verificarlos.
- Para entrega comercial se recomienda un certificado OV/EV de code signing; EV reduce la fricción inicial de SmartScreen. El certificado y su contraseña viven solo en secretos de GitHub.

### Modos de instalación

- **Administrador (UAC)**: instala en `%ProgramData%\SalonSuite`, registra el servicio `SalonSuite` (WinSW, arranque automático y reinicio ante fallo), escribe en HKLM y crea atajos para todos los usuarios.
- **Usuario estándar (sin elevación)**: instala en `%LOCALAPPDATA%\SalonSuite`, escribe en HKCU y no registra servicio; el lanzador arranca `runtime\node.exe app\server.js` cuando hace falta.
- Silenciosa: `SalonSuite-0.2.0-setup.exe /S` (admite `/D=<ruta>` como último parámetro).

### Layout instalado

```
%ProgramData%\SalonSuite\
  runtime\node.exe
  app\server.js, src\, views\, public\, node_modules\
  app\data\salon.db          BD del cliente (demo si no existe)
  app\data\backups\          copias diarias (retención 14)
  app\data\port.txt          puerto real
  app\data\server.pid        PID para upgrades/desinstalación
  app\.license\              token + HWID
  app\public_key.pem         llave embebida opcional (-PublicKey)
  app\.env                   PORT, HOST, SALON_SECRET, LICENSE_SERVER_URL
  app.old\                   respaldo temporal durante una actualización
  logs\update.log            registro del helper de actualización
  logs\update-status.json    último estado del intento
  launcher.exe               abre el navegador (arranca la app si no hay servicio)
  salonsuite-service.exe/.xml  servicio WinSW
  logs\                      salida del servicio
  uninstall.exe
```

- La BD demo y `.env` solo se copian si faltan: los upgrades conservan datos, licencia y `SALON_SECRET`.
- Con la app en marcha, el instalador lee `app\data\server.pid`, detiene el servicio o mata el proceso y reemplaza binarios; después reinicia el servicio (admin) o deja que el lanzador arranque la nueva versión.
- El lanzador espera `http://127.0.0.1:<puerto>/health` antes de abrir el navegador; `launcher.exe --check` valida sin abrir ventana.
- Desinstalar: menú Inicio → "Desinstalar Salón Suite" o `uninstall.exe` (`/S` silencioso). Detiene el servicio, borra binarios, atajos y registro, y pregunta si conservar `app\data` y `app\.license`; en modo silencioso los conserva.
- Sin certificado de firma: SmartScreen puede mostrar un aviso; con el certificado configurado, el build firma y verifica launcher, servicio y setup.

### Verificación realizada

- Instalación silenciosa sin elevación: 1318 archivos, BD demo (`staff=3`, `services=8`, `products=5`), atajos correctos y `/health` 200.
- Upgrade con la app corriendo: cierra el proceso, conserva datos/licencia/secreto y actualiza el código.
- Desinstalación con la app corriendo: elimina runtime, código, atajos, registro y proceso; conserva datos y licencia.
- La ruta de servicio (admin) requiere UAC y no se pudo ejecutar en este entorno; el XML de WinSW y el flujo quedan listos para probar en un equipo elevado.
- `.github/workflows/build.yml` usa Node 24, `build\build-installer.ps1`, NSIS, WinSW, checksums, prueba de humo, firma opcional y publicación; ver **CI/CD y firma** más abajo.
- Fase 5 verificada en GitHub Actions (run `39899601490`, versión `0.0.0-ci.8`): el smoke instaló con NSIS, arrancó el servicio, validó `/health`, login, `/updates`, activó la licencia real contra Vercel/Turso y desinstaló con código 0. El artefacto se descargó y sus SHA-256 coinciden con `SHA256SUMS.txt`.

## Actualizaciones (Fase 4)

- La app consulta `GET /api/version` al arrancar y cada 24 h; si hay una versión nueva muestra un banner y la página **Actualizaciones** (solo admin).
- El manifiesto se firma con Ed25519 usando la misma llave del licenciamiento; la app verifica firma y SHA-256 antes de instalar.
- La descarga va a `%TEMP%`, se ejecuta el setup en modo silencioso y se conservan datos/licencia/.env.
- Un helper independiente crea `app.old`, espera la nueva versión en `/health` hasta 90 s y, si no responde, restaura la versión anterior.
- Publicación: el workflow hace `POST /admin/updates`; el instalador se descarga desde el GitHub Release. No se copian binarios al servidor.
- Pruebas: `npm run test:update` (manifiesto/descarga), `npm run test:update-ui` (banner y página) y `npm run test:update-helper` (respaldo, rollback y hash inválido).
- Pendiente: probar la instalación/rollback en un Windows instalado (servicio/UAC) y validar la firma con un certificado real.

## CI/CD y firma (Fase 5)

El workflow `.github/workflows/build.yml` se ejecuta en `windows-latest` con Node 24 en pushes a `main`/`master`, pull requests, tags `v*` y ejecuciones manuales:

1. Normaliza la versión desde el tag `vX.Y.Z` o desde la entrada manual.
2. Instala dependencias de la app y del servidor de licencias.
3. Ejecuta las pruebas de Fase 3 y Fase 4.
4. Compila con `build\build-installer.ps1` (runtime + NSIS + ZIP + checksums).
5. Firma launcher, servicio y setup si existe certificado; si no, deja constancia en `BUILD-INFO.json`.
6. Revoca la activación anterior de la licencia de humo y ejecuta el instalador en modo silencioso; comprueba servicio, `/health`, login, página de actualizaciones, activación real contra Vercel y desinstalación.
7. Publica setup, ZIP, `SHA256SUMS.txt` y `BUILD-INFO.json` como artefacto.
8. Despliega `tools/license-server` en Vercel si `VERCEL_TOKEN` está configurado.
9. En tags, crea el GitHub Release (pre-release si el tag contiene `-`) y publica el manifiesto con `POST /admin/updates`.
10. En tags estables, verifica `/health`, `/public`, la coincidencia de la llave pública y el manifiesto firmado.

Estado verificado: el [run 39899601490](https://github.com/foxsolid23df-IA/salonbelleza/actions/runs/39899601490) sobre `1a9ac85` completó build, pruebas, smoke con activación real y carga de artefactos. El [run 39899893300](https://github.com/foxsolid23df-IA/salonbelleza/actions/runs/39899893300) del tag `v0.2.0-rc.2` publicó el release y el manifiesto beta firmado.

Pre-release de validación: [v0.2.0-rc.2](https://github.com/foxsolid23df-IA/salonbelleza/releases/tag/v0.2.0-rc.2), publicada sin firma Authenticode y con los SHA-256 en la página del release. El servidor de licencias de producción ya está desplegado y probado con activación real.

### Disparar una versión

```
git tag v0.2.0-rc.2
git push origin v0.2.0-rc.2
```

Usa un sufijo `-rc.N` o `-beta.N` para pre-release. Un tag `vX.Y.Z` sin sufijo pasa por la compuerta de entrega estable. También se puede lanzar manualmente con **Actions → Build & Release Salón Suite → Run workflow**, indicando versión, canal y servidor de licencias.

### Configuración del repositorio

| Nombre | Tipo | Uso |
|---|---|---|
| `WINDOWS_CERT_PFX_BASE64` | secret | PFX en base64 para Authenticode |
| `WINDOWS_CERT_PASSWORD` | secret | Contraseña del PFX |
| `SIGNTOOL_TIMESTAMP_URL` | variable | Servidor de timestamp; por defecto `http://timestamp.digicert.com` |
| `LICENSE_SERVER_URL` | variable | URL embebida en el cliente; producción `https://salon-license.vercel.app` |
| `LICENSE_PUBLIC_KEY_PEM` | variable | Llave pública Ed25519 para embeber en el paquete |
| `LICENSE_ADMIN_TOKEN` | secret | Token para publicar manifiestos y administrar licencias |
| `SMOKE_LICENSE_KEY` | secret | Licencia de producción para la prueba de humo |
| `SMOKE_LICENSE_EMAIL` | secret | Correo admin asociado a esa licencia |
| `VERCEL_TOKEN` | secret | Token de Vercel para desplegar el servidor |
| `CI_SMOKE` | variable | `false` desactiva la prueba de humo (no permitido en estable) |

La prueba de humo usa `SALON_DEV_SKIP_LICENSE=1` si no se configura una licencia. Con `SMOKE_LICENSE_KEY`, activa realmente contra el servidor de producción. Antes de cada smoke se revoca la activación anterior de esa licencia para permitir un HWID nuevo.

### Firma y SmartScreen

- Con `WINDOWS_CERT_PFX_BASE64` y `WINDOWS_CERT_PASSWORD`, el build firma y verifica; si la firma falla, el workflow falla y no publica artefactos.
- Sin certificado, el workflow publica el aviso de SmartScreen y los SHA-256. No se debe presentar ese build como firmado.
- El ZIP portable incluye el launcher firmado; no se puede firmar el ZIP en sí, solo su contenido ejecutable.

### Entrega estable

Un tag `vX.Y.Z` sin sufijo no se publica como estable si falta cualquiera de estos requisitos:

- `BUILD-INFO.json` con `signed=true` y firma Authenticode verificada.
- `LICENSE_SERVER_URL` explícita, apuntando al servidor real.
- `LICENSE_PUBLIC_KEY_PEM` para embeber la llave pública.
- `SMOKE_LICENSE_KEY` para probar la activación real durante el smoke.
- `LICENSE_ADMIN_TOKEN` para publicar el manifiesto.
- `VERCEL_TOKEN` para desplegar el servidor.
- `CI_SMOKE` distinto de `false`.

Después del despliegue, el workflow consulta `/health`, `/public` y `/api/version?channel=stable`; falla si el servidor no responde, si la llave pública no coincide con la variable o si el manifiesto no corresponde a la versión y no está firmado. Los tags `-rc`/`-beta` quedan como pre-release y no pasan por esta compuerta.

El servidor usa la URL `https://salon-license.vercel.app`; no se requiere dominio propio. La entrega estable sigue bloqueada hasta cargar el PFX y el `VERCEL_TOKEN` en GitHub. Las pre-releases `-rc`/`-beta` ya validan build, smoke, release y manifiesto firmado sin pasar por esa compuerta.

## Notas de limpieza

- `analysis/` contiene el proceso REA full clean-room (no se copió código del original).
- DB reseteable borrando `app/data/salon.db*` y `.license/`.
