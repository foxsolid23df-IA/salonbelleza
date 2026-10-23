# Plan: convertir Salón Suite en software instalado para Windows

## Estado actual (22/10/2026)

| Fase | Estado | Pendiente |
|---|---|---|
| 0. Endurecimiento | Completada y verificada | — |
| 1. Runtime y paquete | Completada y verificada | — |
| 2. Instalador NSIS | Completada y verificada sin elevación | Probar registro/arranque del servicio con UAC real |
| 3. Licenciamiento productivo | Completada en local y despliegue preparado | Ejecutar en VPS real (DNS/TLS), custodiar `private.pem`, compilar el instalador contra el dominio |
| 4. Actualizaciones | Completada en local y empaquetada | Probar instalación/rollback en Windows real con servicio/UAC |
| 5. CI/CD y firma | Completada en código | Primera ejecución en GitHub con certificado y secretos SSH reales |
| 6. QA y entrega | Pendiente | Matriz de pruebas y validación end-to-end |

## 1. Punto de partida (lo que ya existe)

| Pieza | Estado |
|---|---|
| App Node/Express/EJS/SQLite | Funcional, módulos completos y probados |
| Licenciamiento (HWID + Ed25519 + gracia 14 días) | Funcional y verificado end-to-end |
| Wizard de activación `/setup` + cambio forzado de contraseña | Funcional |
| Servidor de licencias (`tools/license-server`) | Endurecido, con admin, rate-limit, backups y Docker/Caddy listos |
| Instalador NSIS (`build/salonsuite.nsi`) | Compilado y probado sin elevación; `dist\SalonSuite-0.2.0-setup.exe` |
| Servicio Windows (`salonsuite-service.exe` + XML) | Implementado; falta prueba con UAC (entorno sin elevación) |
| CI/CD GitHub Actions (`.github/workflows/build.yml`) | Implementado para Node 24/NSIS/WinSW, checksums, smoke, releases y despliegue opcional; pendiente primera ejecución |
| Firma de código | Implementada con `build/sign.ps1` y signtool; pendiente certificado real |

Objetivo: un `SalonSuite-X.Y.Z-setup.exe` que instale, registre el servicio, deje accesos directos, active la licencia y se actualice solo.

---

## 2. Decisión clave: cómo se empaqueta el runtime

La app usa `better-sqlite3`, que es un **módulo nativo** (`.node` compilado para una versión concreta de Node). Esto condiciona el empaquetado.

| Opción | Qué es | Pros | Contras | Veredicto |
|---|---|---|---|---|
| **A. Runtime embebido + WinSW** | `runtime\node.exe` + código + `node_modules` de producción; el servicio ejecuta node | Cero fricción con módulos nativos, build reproducible, fácil de depurar y actualizar | Carpeta con ~120 MB, no es "un solo binario" | **Recomendada** |
| **B. pkg** | `pkg server.js --targets node20-win-x64` | Un solo `.exe` | El `.node` de better-sqlite3 debe coincidir con el ABI del target (hoy compilado con Node 24, target node20 → falla); hay que forzar `npm_config_target` y declarar assets. Frágil en cada upgrade | Solo si se exige binario único |
| **C. Node SEA** | `--experimental-sea-config` + postject | Binario oficial de Node, sin hacks de terceros | El módulo nativo sigue en disco; más pasos manuales | Alternativa a B |
| **D. Electron** | Ventana de escritorio cargando `http://127.0.0.1:3000` | UX de app nativa, auto-update integrado | +150 MB, reescribir arranque, más superficie de fallo | Fase posterior, opcional |

**Recomendación:** A para la v1 (rápida y robusta), con posibilidad de migrar a D si se quiere ventana propia y bandeja del sistema.

> El `build.yml` actual usa pkg con target `node20`; si se mantiene, hay que compilar `better-sqlite3` contra ese ABI. El plan asume la opción A y deja pkg como variante documentada.

---

## 3. Arquitectura de despliegue

```
C:\ProgramData\SalonSuite\          (admin; sin admin: %LOCALAPPDATA%\SalonSuite)
├─ runtime\node.exe          # runtime propio, no requiere Node instalado
├─ app\                      # server.js, src\, views\, public\, node_modules (prod)
│  ├─ data\salon.db          # BD del cliente (WAL) — nunca se sobrescribe en updates
│  ├─ data\backups\          # copias diarias (retención 14)
│  ├─ data\port.txt          # puerto real (fallback 3000→3010)
│  ├─ data\server.pid        # PID para upgrades/desinstalación
│  ├─ .license\token         # activación + hwid_local + public_key.pem
│  └─ .env                   # PORT, HOST, SALON_SECRET, LICENSE_SERVER_URL
├─ launcher.exe              # espera /health y abre el navegador
├─ salonsuite-service.exe    # WinSW
├─ salonsuite-service.xml
├─ logs\                     # salida del servicio (WinSW roll-by-size)
└─ uninstall.exe

Servicio "SalonSuite" (LocalSystem, automático, reinicio ante fallo) — solo con admin
        └─ escucha en 127.0.0.1:3000
Usuario → navegador (acceso directo "Salón Suite")
```

Sin reglas de firewall: solo loopback.

---

## 4. Fases

### Fase 0 — Endurecimiento previo (1–2 días)
Requisitos para que "instalado" no rompa cosas:

> **Estado: completada y verificada** (20/20 pruebas de humo, más fallback de puerto).

1. **Escuchar solo en localhost**: `app.listen(PORT, "127.0.0.1")`. Hoy escucha en todas las interfaces y expone el salón a la red.
2. **`SALON_SECRET` persistente**: generarlo en la instalación y guardarlo en `.env`; si cambia, se invalidan las sesiones (y con ellas el wizard).
3. **Rutas escribibles**: confirmar que `SALON_DB` y `.license` apuntan a `%PROGRAMDATA%\SalonSuite` (el `.env` lo define; `src/db.js` ya respeta `SALON_DB`).
4. **Migraciones idempotentes al arranque**: ya existen; añadir un `config.schema_version` para upgrades ordenados.
5. **Revalidación periódica**: job cada 24 h que llame a `POST /verify` con el token; si el servidor revoca o expira, marcar `license_tokens.revoked=1` y bloquear con mensaje de contacto (la gracia offline sigue vigente si no hay red).
6. **Backup automático**: `db.backup()` diario a `data\backups\salon-YYYYMMDD.db`, retención 14, al arrancar y cada 24 h.
7. **Puerto ocupado**: si `:3000` está tomado, reintentar 3001–3010 y escribir el puerto real en `.env` (el lanzador lo lee).

**Resultado implementado:**
- `HOST` por defecto `127.0.0.1`; fallback de puerto 3000→3010 y `data/port.txt` con el puerto real.
- `src/env.js`: carga `.env`, genera y persiste `SALON_SECRET` (32 bytes) si falta.
- `src/backup.js`: `db.backup()` diario a `data/backups/salon-AAAAMMDD.db`, retención 14, sin duplicar el mismo día.
- `src/license.js`: `revalidate()` cada 24 h contra `/verify`; distingue `revoked`, `token_superseded`, `not_activated`, `expired` y `offline`; la revocación bloquea con aviso y permite reactivar sin bucle.
- `src/db.js`: `schema_version=3` y corrección de `nowISO(date)`.
- `tests/smoke-phase0.js`: 20 comprobaciones automatizadas (`npm run test:smoke`, con BD y `.license` limpios).

### Fase 1 — Runtime y armado del paquete (1 día)
1. `npm ci --omit=dev` en un staging limpio.
2. Copiar `runtime\node.exe` (Node 20/22 LTS oficial) — evita depender de Node instalado y fija el ABI.
3. Layout destino: `pkg\` con `runtime\`, `app\`, `.env`, `winsw.exe`, XML, `salon.db` demo.
4. Generar `.env` con: `PORT`, `SALON_SECRET` aleatorio, `SALON_DB`, `LICENSE_SERVER_URL`, `APP_VERSION`.
5. Verificar `node.exe app\server.js` desde `pkg\` sin Node global (PATH vacío).

> **Estado: completada.** `build/assemble.ps1` genera `pkg\` y el ZIP portable.
> Runtime usado: Node 24.16.0 (el mismo del equipo de build, así el `.node` de better-sqlite3 carga sin recompilar).
> Verificado con `PATH` sin Node: activación, login y dashboard OK; proceso corriendo desde `pkg\runtime\node.exe`.
> Ajuste para Fase 2: la app guarda datos y licencia dentro de `app\` (`app\data`, `app\.license`), no en la raíz; el NSIS debe apuntar ahí.

### Fase 2 — Instalador NSIS (2–3 días)

> **Estado: completada y verificada en modo sin elevación.** El artefacto de producción se compila con `highestAvailable`: pide UAC a administradores (servicio) y, para usuarios estándar, instala por usuario sin servicio. La ruta de servicio no se pudo ejecutar en este entorno porque el shell no está elevado; el XML de WinSW y el flujo están listos para validar en un equipo con admin.

Implementado:

1. **Build reproducible**: `build\build-installer.ps1` ejecuta `assemble.ps1` y compila con makensis; descarga NSIS 3.13 (Tauri) y WinSW 2.12 si faltan. El `.nsi` se fuerza a UTF-8 con BOM.
2. **Paquete**: `assemble.ps1` copia `runtime\node.exe`, hace `npm ci --omit=dev`, genera `.env`, crea la BD demo consolidando el WAL (`wal_checkpoint(TRUNCATE)`), compila `launcher.exe` con csc (`/codepage:65001`) y prepara WinSW.
3. **Instalador** (`build\salonsuite.nsi`): MUI2 en español, respeta `/D`, detecta elevación real con `shell32::IsUserAnAdmin`, instala en `%ProgramData%` (admin) o `%LOCALAPPDATA%` (usuario), y escribe HKLM/HKCU según el caso.
4. **Datos**: `app\data\salon.db`, `.env` y `.license` solo se copian si faltan; upgrades conservan BD, licencia y `SALON_SECRET`.
5. **Servicio**: solo con admin; `salonsuite-service.exe install` + `start` (WinSW, automático, reinicio ante fallo). Las llamadas a WinSW se omiten si el servicio no existe o no hay elevación, evitando cuelgues.
6. **Atajos**: menú Inicio con "Salón Suite" y "Desinstalar Salón Suite"; escritorio opcional.
7. **Lanzador** (`build\launcher.cs`): lee `app\data\port.txt` o `.env`, comprueba/arranca `runtime\node.exe app\server.js`, espera el puerto y abre el navegador; `--check` para pruebas sin UI.
8. **Upgrade**: si existe `app\data\server.pid`, detiene el servicio y/o mata el PID antes de reemplazar binarios; conserva datos/licencia y reinicia el servicio (admin).
9. **Desinstalador**: detiene y quita el servicio (si existe), mata el PID, borra binarios/logs/atajos/registro y pregunta si conservar `app\data` + `app\.license`; `/S` conserva por defecto.
10. **`/health`**: endpoint público con `{ ok, version }` usado por el lanzador antes de la puerta de licencia.

Verificación: instalación silenciosa (1318 archivos), seed `staff=3/services=8/products=5`, `/health` 200, upgrade con app corriendo (datos/licencia/secreto intactos) y desinstalación sin residuos salvo datos/licencia conservados.

### Fase 3 — Licenciamiento en producción (1–2 días)

> **Estado: completada en local y despliegue preparado.** `npm test` ejecuta 30 comprobaciones del servidor (licencias pre-emitidas, admin, límite de activación, renovación de token, revocación/reactivación, rate limit, auditoría, CLI y backup). Falta ejecutarla en infraestructura real: DNS, VPS, certificado TLS y custodia de la llave privada.

Implementado:

1. **Licencias pre-emitidas**: `/activate` ya no crea licencias. Una clave inexistente devuelve `404 LICENSE_NOT_FOUND`. La demo y la auto-activación solo se habilitan con `LICENSE_SEED_DEMO=1` y `LICENSE_ALLOW_SELF_ACTIVATION=1` (desarrollo).
2. **Administración autenticada**: `/admin/*` y `/revoke` exigen `LICENSE_ADMIN_TOKEN` (Bearer o `X-Admin-Token`); sin token responden 503/401. API para crear/listar/detallar licencias, revocar/reactivar equipos y consultar eventos.
3. **Tokens renovables**: `/verify` revalida firma, HWID, revocación y vigencia, y emite un token nuevo de 30 días; la app lo persiste. Gracia offline de 14 días.
4. **Resistencia a abuso**: rate limit por IP (10 activaciones/min, 60 verificaciones/min, 30 admin/min), límite de body, validación de UUID/HWID/textos y `trust proxy` para Caddy.
5. **Auditoría y soporte**: tabla `events` (activaciones, intentos denegados, revocaciones, reactivaciones) y CLI `admin.js` con salida `--json`.
6. **Revocación**: por HWID o por licencia; el siguiente `/verify` bloquea con `reason=revoked` y la app muestra el aviso de soporte.
7. **Backups**: `backup.js` usa la API de SQLite, guarda en `data/backups` y aplica retención (`LICENSE_BACKUP_KEEP`).
8. **Despliegue preparado**: `Dockerfile` multi-stage con usuario no root, `docker-compose.yml` con volumen persistente, `Caddyfile` con TLS automático/HSTS y `DEPLOY.md` con DNS, firewall, emisión, backups, restauración y diagnóstico.
9. **Llave pública**: `build\assemble.ps1`/`build-installer.ps1` aceptan `-PublicKey` y la copian a `app\public_key.pem`; la app la usa si no hay clave en `.license` o en `LICENSE_PUBLIC_KEY`. La verificación de firma ahora falla cerrada si no hay llave. Una instalación anterior sin `.license/public_key.pem` debe reactivarse una vez.
10. **Prueba local**: `cd tools/license-server && npm test`.

Pendiente para producción:

- Crear el VPS y el registro DNS de `get.salonsuite.com`; abrir 80/443.
- Ejecutar `docker compose up -d --build` y verificar `/health` y `/public` por HTTPS.
- Respaldar `private.pem` cifrado fuera del servidor y definir el procedimiento de rotación.
- Compilar el instalador con `-LicenseServer https://get.salonsuite.com` y, opcionalmente, `-PublicKey public.pem`.
- Probar de extremo a extremo con una instalación real: activar, revocar y confirmar el bloqueo en menos de 24 h (Fase 6).
- Panel web de soporte (opcional): hoy la CLI y la API cubren alta, listado, detalle y revocación.

Verificación ejecutada (21/10/2026):

- `npm run test:license` → `PASS Fase 3: 30 comprobaciones` (servidor, admin, revocación, rate-limit, CLI y backup).
- `docker compose config --quiet` → configuración válida.
- `node --check` en servidor, CLI, backup, pruebas y cliente → sin errores de sintaxis.
- Firma Ed25519 del cliente: válida con llave pública y rechazada sin llave (falla cerrada).
- Limitación del entorno: el daemon de Docker no estaba activo, así que no se construyó ni arrancó el contenedor aquí; el despliegue queda listo para ejecutar en el VPS.

### Fase 4 — Actualizaciones (2–3 días)

> **Estado: completada en local.** Manifiesto firmado, consulta cada 24 h, banner, página de administración, descarga con SHA-256, instalación silenciosa y rollback implementados y probados sin una instalación Windows real.

Implementado:

1. **Servidor**: `GET /api/version?channel=stable|beta` lee `updates/stable.json` o `beta.json`, valida el formato y firma el manifiesto con la llave Ed25519 del licenciamiento. `GET /api/download/:file` sirve instaladores/zip desde `updates/files` (solo `.exe`, `.zip`, `.msi`).
2. **Cliente**: `src/updates.js` consulta al arrancar y cada 24 h, compara semver, exige HTTPS, verifica firma y SHA-256, y guarda el estado en `config`. Sin llave pública falla cerrada; `SALON_ALLOW_UNSIGNED_UPDATES=1` queda solo para desarrollo.
3. **UI**: banner para administradores y página `/updates` con versión actual, canal, notas, SHA-256, botón de búsqueda e instalación. La página de instalación hace polling a `/health` y detecta éxito o rollback.
4. **Descarga**: `%TEMP%\salonsuite-updates\SalonSuite-<versión>-setup.exe`, límite de 250 MB y hash obligatorio.
5. **Instalación**: helper separado (`src/update-helper.js`) que sobrevive al reinicio de la app, copia el código a `app.old`, ejecuta el setup `/S /D=<instalación>` y espera la versión nueva en `/health`.
6. **Rollback**: si la versión nueva no responde en 90 s, restaura `app.old`, arranca el servicio o el lanzador y registra el resultado en `logs/update-status.json`.
7. **Canales**: `stable` por defecto; `beta` con `SALON_UPDATE_CHANNEL=beta`.
8. **Publicación**: `updates/README.md` y `DEPLOY.md` explican cómo copiar el instalador, calcular el hash, crear el manifiesto y verificar el endpoint.

Verificación ejecutada (21/10/2026):

- `npm run test:update` → manifiesto firmado, canales, descarga y verificación del cliente OK.
- `npm run test:update-ui` → banner y página `/updates` OK con la app real.
- `npm run test:update-helper` → respaldo `app.old`, actualización simulada, rollback y rechazo por hash inválido OK.
- `npm run test:license` y pruebas de sintaxis → OK.
- Instalador `dist\SalonSuite-0.2.0-setup.exe` recompilado con `src\updates.js`, `src\update-helper.js`, ruta `/updates` y vistas; los hashes quedan en `dist\SHA256SUMS.txt`.

Pendiente:

- Probar el ciclo completo sobre una instalación Windows real: descarga, setup silencioso, reinicio y rollback forzado.
- Validar el helper cuando la app corre como servicio WinSW/LocalSystem y con UAC.
- Firmar el instalador y los ejecutables: implementado en Fase 5, pendiente probar con certificado real.

### Fase 5 — CI/CD y firma (completada en código)
Implementado:

1. Workflow en `windows-latest` con Node 24, runtime embebido, NSIS, ZIP portable y `SHA256SUMS.txt`; se ejecuta en `main`/`master`, pull requests, tags y manualmente.
2. Prueba de humo `tests/ci-smoke.ps1`: instalación silenciosa, servicio, `/health`, login, página de actualizaciones y desinstalación. Usa `SALON_DEV_SKIP_LICENSE=1` en la instalación temporal si no hay licencia de staging.
3. Firma Authenticode con `build/sign.ps1` y `signtool`: launcher y servicio antes de NSIS, setup al final. El ZIP se recrea después de firmar.
4. Publicación automática de artefactos y GitHub Release en tags; despliegue opcional del setup y manifiesto `stable.json`/`beta.json` a `get.salonsuite.com` por SSH.

Configuración:
- Secretos: `WINDOWS_CERT_PFX_BASE64`, `WINDOWS_CERT_PASSWORD`, `SMOKE_LICENSE_KEY`/`SMOKE_LICENSE_EMAIL` (opcional), `DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`.
- Variables: `SIGNTOOL_TIMESTAMP_URL`, `LICENSE_SERVER_URL`, `LICENSE_PUBLIC_KEY_PEM`, `DEPLOY_PORT`, `DEPLOY_UPDATES_DIR`; `CI_SMOKE=false` desactiva el smoke.

Sin certificado el workflow sigue siendo válido: publica los SHA-256 y el aviso de SmartScreen. La firma se certifica cuando se ejecute con un PFX real y `signtool verify /pa` pase.

### Fase 6 — QA y entrega (2 días)
Matriz mínima:

| Caso | Esperado |
|---|---|
| Windows 10/11 limpio, sin Node | Instala, servicio arriba, wizard abre |
| Instalación sin conexión | Wizard avisa, permite reintentar; gracia no aplica hasta activar |
| Upgrade 0.2.0 → 0.2.1 | Datos y licencia intactos, servicio reinicia |
| Actualización in-app fallida | Rollback a app.old, datos/licencia intactos |
| Desinstalar conservando datos | Reinstala y encuentra todo |
| Desinstalar borrando datos | Estado limpio |
| HWID distinto / licencia revocada | Bloqueo con mensaje de soporte |
| Puerto 3000 ocupado | Usa 3001 y el lanzador abre el puerto correcto |
| Usuario sin permisos de admin | El instalador pide elevación |
| Antivirus corporativo | Sin cuarentena (probar con Defender y uno de terceros) |

---

## 5. Cronograma estimado

| Fase | Días |
|---|---|
| 0. Endurecimiento | 1–2 |
| 1. Runtime y paquete | 1 |
| 2. Instalador NSIS + lanzador | 2–3 |
| 3. Licenciamiento productivo | 1–2 |
| 4. Actualizaciones | 2–3 |
| 5. CI/CD + firma | 1–2 |
| 6. QA | 2 |
| **Total** | **10–15 días hábiles** |

Se puede lanzar un **MVP instalable en 4–5 días** (fases 0–3, updates manuales) y completar actualizaciones/firma después.

---

## 6. Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| `better-sqlite3` y ABI de Node | El `.exe` arranca y muere | Runtime embebido de versión fija (opción A); evitar pkg |
| SmartScreen / antivirus | El cliente no instala | Firma de código; hashes publicados; instalador con nombre y editor coherentes |
| Upgrade pisa `salon.db` | Pérdida de datos | `IfFileExists` en NSIS + backups diarios |
| WAL y copias | Backup corrupto | `db.backup()` (API de SQLite), no copiar archivos a mano |
| Servicio sin permisos sobre `%PROGRAMDATA%` | BD no escribible | Servicio como LocalSystem; probar con usuario estándar |
| Puerto ocupado | App "no abre" | Fallback de puerto + lanzador que lee `.env` |
| Revocación sin red | Cliente sigue operando | Gracia 14 días + expiración del token a 30 días |
| Pérdida de `private.pem` | No se pueden emitir licencias | Respaldo offline + rotación documentada |

---

## 7. Checklist de "terminado"

- [ ] `SalonSuite-1.0.0-setup.exe` instala en Windows 10 y 11 sin Node ni dependencias.
- [ ] Servicio automático que sobrevive reinicios y se recupera de fallos.
- [ ] Wizard de activación en el primer arranque y cambio de contraseña forzado.
- [ ] Datos y licencia intactos tras actualizar.
- [ ] Desinstalación limpia con opción de conservar datos.
- [ ] Verificación periódica y revocación funcionando contra el servidor real.
- [ ] Actualización in-app detecta, descarga, verifica e instala.
- [ ] Backups diarios y restauración probada.
- [ ] Instalador firmado (implementado; pendiente certificado) o hashes publicados mientras no haya certificado.
- [ ] README de soporte: cómo reiniciar el servicio, dónde están logs y backups.

---

## 8. Comandos de build (referencia)

```powershell
# Build completo con runtime, NSIS, ZIP, hashes y firma opcional
build\build-installer.ps1 -Version 1.0.0 -LicenseServer https://get.salonsuite.com -PublicKey C:\ruta\public.pem
# Canal beta
build\build-installer.ps1 -Version 1.0.0-beta.1 -LicenseServer https://get.salonsuite.com -UpdateChannel beta

# Firma manual de un artefacto
build\sign.ps1 -Files dist\SalonSuite-1.0.0-setup.exe -PfxPath C:\ruta\certificado.pfx -Password "clave"

# Prueba de humo de una instalación (requiere administrador)
tests\ci-smoke.ps1 -Installer dist\SalonSuite-1.0.0-setup.exe -ExpectedVersion 1.0.0
```
