# Plan: convertir Salón Suite en software instalado para Windows

## Estado actual (octubre de 2026)

| Fase | Estado | Pendiente |
|---|---|---|
| 0. Endurecimiento | Completada y verificada | — |
| 1. Runtime y paquete | Completada y verificada | — |
| 2. Instalador NSIS | Completada y verificada sin elevación | Probar registro/arranque del servicio con UAC real |
| 3. Licenciamiento productivo | Completada y desplegada en Vercel + Turso | Custodia/rotación de la llave privada y backup programado |
| 4. Actualizaciones | Completada en local y empaquetada | Probar instalación/rollback en Windows instalado con servicio/UAC |
| 5. CI/CD y firma | CI verde, smoke con activación real y pre-release | Cargar PFX y `VERCEL_TOKEN`; publicar la entrega estable firmada |
| 6. QA y entrega | Pendiente | Matriz de pruebas y validación end-to-end |

El servidor de licencias ya no depende de un VPS. Producción usa una función de Vercel con Turso (SQLite serverless) en `https://salon-license.vercel.app`. No se requiere dominio propio.

## 1. Punto de partida

| Pieza | Estado |
|---|---|
| App Node/Express/EJS/SQLite | Funcional, módulos completos y probados |
| Licenciamiento (HWID + Ed25519 + gracia 14 días) | Funcional y verificado end-to-end |
| Wizard de activación `/setup` + cambio forzado de contraseña | Funcional |
| Servidor de licencias (`tools/license-server`) | Producción en Vercel + Turso, admin, rate-limit, auditoría, manifiestos y backups |
| Instalador NSIS (`build/salonsuite.nsi`) | Compilado y probado sin elevación; `dist\SalonSuite-0.2.0-setup.exe` |
| Servicio Windows (`salonsuite-service.exe` + XML) | Implementado; falta prueba con UAC |
| CI/CD GitHub Actions (`.github/workflows/build.yml`) | Build, tests, smoke real, artefactos, release y despliegue opcional a Vercel |
| Firma de código | Implementada con `build/sign.ps1` y signtool; pendiente certificado real |

Objetivo: un `SalonSuite-X.Y.Z-setup.exe` que instale, registre el servicio, cree accesos directos, active la licencia y se actualice solo.

## 2. Decisión de empaquetado

La app usa `better-sqlite3`, un módulo nativo que debe coincidir con el ABI del runtime. Por eso se empaqueta un runtime propio de Node en lugar de un binario único.

| Opción | Uso | Veredicto |
|---|---|---|
| Runtime embebido + WinSW | `runtime\node.exe` + app + `node_modules` de producción | **Recomendada y usada** |
| `pkg` | Un solo `.exe` | Frágil con módulos nativos; descartada |
| Node SEA | Binario oficial de Node + assets | Alternativa, más pasos manuales |
| Electron | Ventana nativa | Fase posterior opcional |

El servidor de licencias sí usa `@libsql/client`, que habla con Turso por HTTP y evita módulos nativos en Vercel.

## 3. Arquitectura de despliegue

### Cliente Windows

```text
C:\ProgramData\SalonSuite\          (admin; sin admin: %LOCALAPPDATA%\SalonSuite)
  runtime\node.exe
  app\server.js, src\, views\, public\, node_modules\
  app\data\salon.db                 BD del cliente (WAL)
  app\data\backups\                 copias diarias (retención 14)
  app\data\port.txt                 puerto real
  app\data\server.pid               PID para upgrades/desinstalación
  app\.license\token                activación + hwid_local + public_key.pem
  app\.env                          PORT, HOST, SALON_SECRET, LICENSE_SERVER_URL
  app.old\                          respaldo temporal durante una actualización
  launcher.exe                      espera /health y abre el navegador
  salonsuite-service.exe/.xml       servicio WinSW
  logs\                             salida del servicio y del updater
  uninstall.exe
```

Servicio `SalonSuite` (LocalSystem, automático, reinicio ante fallo) solo con admin. Escucha en `127.0.0.1`; sin reglas de firewall.

### Servidor de licencias

```text
Internet 443
  -> Vercel Function (Express 5)
       -> Turso (licencias, activaciones, eventos, manifiestos)
       -> GitHub Releases (instaladores; no pasan por la función)
```

- `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN` los crea la integración de Turso en Vercel.
- Las llaves Ed25519 se cargan desde variables de entorno (`LICENSE_PRIVATE_KEY_PEM`, `LICENSE_PUBLIC_KEY_PEM`).
- El sistema de archivos de Vercel es efímero; no se usa para datos.
- La URL estable es `https://salon-license.vercel.app`.

## 4. Fases

### Fase 0 — Endurecimiento previo

Estado: completada y verificada.

- Escucha solo en `127.0.0.1`; puerto real en `data/port.txt` con fallback 3000→3010.
- `SALON_SECRET` generado y persistido en `.env` al primer arranque.
- Revalidación de licencia cada 24 h contra `/verify`; distingue `revoked`, `token_superseded`, `not_activated`, `expired` y `offline`.
- Backup diario con la API de SQLite en `data/backups/salon-AAAAMMDD.db`, retención 14.
- Prueba de humo `tests/smoke-phase0.js` (20 comprobaciones) y fallback de puerto.

### Fase 1 — Runtime y paquete

Estado: completada.

- `build/assemble.ps1` copia un runtime Node oficial, instala dependencias de producción y genera el layout.
- El equipo destino no necesita Node instalado.
- Verificado con `PATH` sin Node: activación, login y dashboard desde `pkg\runtime\node.exe`.
- Datos y licencia viven dentro de `app\` (`app\data`, `app\.license`).

### Fase 2 — Instalador NSIS

Estado: completada y verificada en modo sin elevación.

- `build/build-installer.ps1` descarga NSIS 3.13 y WinSW 2.12 si faltan; fuerza UTF-8 en el `.nsi`.
- Instala en `%ProgramData%` con UAC (servicio) o en `%LOCALAPPDATA%` sin elevación.
- Conserva BD, licencia y `SALON_SECRET` en upgrades.
- Servicio WinSW automático, reinicio ante fallo y atajos de Inicio/escritorio.
- Desinstalador detiene el servicio/proceso y permite conservar datos y licencia.
- Verificación: instalación silenciosa (1318 archivos), seed `staff=3/services=8/products=5`, `/health` 200, upgrade con app corriendo y desinstalación.
- Pendiente: probar la ruta de servicio con UAC real.

### Fase 3 — Licenciamiento productivo

Estado: completada y desplegada.

Implementado:

1. Licencias pre-emitidas; `/activate` no crea licencias. Auto-activación y demo solo con variables de desarrollo.
2. `/admin/*` y `/revoke` exigen `LICENSE_ADMIN_TOKEN` (Bearer o `X-Admin-Token`).
3. API para crear/listar/detallar licencias, revocar/reactivar equipos y consultar eventos.
4. Tokens renovables: `/verify` revalida firma, HWID, revocación y vigencia; emite token nuevo de 30 días. Gracia offline 14 días.
5. Rate limit por IP, límite de body, validación de UUID/HWID/textos y `trust proxy`.
6. Auditoría en `events`; CLI `admin.js` con `--json`.
7. Revocación por HWID o licencia; el siguiente `/verify` bloquea con `reason=revoked`.
8. Una sola activación activa por licencia, reforzada con un índice único parcial en Turso.
9. Backups lógicos en JSON (`backup.js`) y panel de Turso para restauración.
10. Despliegue: Vercel Function (`api/index.js` + `app.js`), Turso y `vercel.json` con rewrite a la función.
11. Llave pública embebida opcional (`public_key.pem`) y verificación que falla cerrada si falta.

Verificación ejecutada:

- `cd tools/license-server && npm test` → `PASS Fase 3: 30 comprobaciones`.
- `npm run test:phase4` → manifiesto firmado, canales, descarga y verificación del cliente.
- Producción: `/health` 200, `/public` con llave correcta, activación/verificación/revocación contra Turso y rechazo de segunda activación con `409 ACTIVATION_LIMIT`.
- Manifiesto beta de `0.2.0-rc.1` publicado y firma Ed25519 verificada.

Pendiente:

- Custodiar la llave privada cifrada fuera de Vercel y documentar su rotación.
- Programar backups de Turso y probar una restauración.
- Opcional: panel web de soporte; hoy la API y la CLI cubren la operación.

### Fase 4 — Actualizaciones

Estado: completada en local y empaquetada.

Implementado:

1. `GET /api/version?channel=stable|beta` lee el manifiesto desde Turso, lo valida y lo firma con Ed25519.
2. `POST /admin/updates` publica/actualiza el manifiesto; el instalador se descarga desde GitHub Releases.
3. El cliente consulta al arrancar y cada 24 h, compara semver, exige HTTPS, verifica firma y SHA-256.
4. Banner y página `/updates` para administradores; instalación silenciosa y polling a `/health`.
5. Helper independiente que crea `app.old`, espera la nueva versión hasta 90 s y restaura si no responde.
6. Canales `stable` y `beta`; los tags con `-rc`/`-beta` se publican en beta.

Verificación:

- `npm run test:update`, `npm run test:update-ui` y `npm run test:update-helper` → OK.
- Manifiesto beta real firmado y verificado contra la llave pública de producción.

Pendiente:

- Ciclo completo en Windows instalado: descarga, setup silencioso, reinicio y rollback forzado.
- Validar el helper cuando la app corre como servicio WinSW/LocalSystem y con UAC.
- Firmar el instalador y los ejecutables con el certificado real.

### Fase 5 — CI/CD y firma

Estado: CI verde, smoke real y pre-release; falta firma y token de Vercel.

El workflow `.github/workflows/build.yml` se ejecuta en `windows-latest` con Node 24:

1. Normaliza la versión desde el tag `vX.Y.Z` o la entrada manual.
2. Instala dependencias de la app y del servidor.
3. Ejecuta pruebas de Fase 3 y Fase 4.
4. Compila runtime, NSIS, ZIP y checksums.
5. Firma launcher, servicio y setup si hay PFX; si no, deja `signed=false`.
6. Revoca la activación anterior de la licencia de humo y ejecuta el instalador en modo silencioso.
7. Comprueba servicio, `/health`, login, `/updates`, activación real contra Vercel/Turso y desinstalación.
8. Publica setup, ZIP, `SHA256SUMS.txt` y `BUILD-INFO.json` como artefacto.
9. Despliega `tools/license-server` en Vercel si `VERCEL_TOKEN` está configurado.
10. En tags crea el GitHub Release y publica el manifiesto con `POST /admin/updates`.
11. En tags estables verifica `/health`, `/public`, la coincidencia de la llave pública y el manifiesto firmado.

Estado verificado: runs `39893564306`, `39894211283`, `39894666551`, `39895590459` y `39896021054` en verde. Pre-release de validación: [v0.2.0-rc.1](https://github.com/foxsolid23df-IA/salonbelleza/releases/tag/v0.2.0-rc.1), sin firma Authenticode y con SHA-256 publicados.

Configuración de GitHub:

- Variables: `LICENSE_SERVER_URL`, `LICENSE_PUBLIC_KEY_PEM`, `CI_SMOKE`, `SIGNTOOL_TIMESTAMP_URL`.
- Secretos: `LICENSE_ADMIN_TOKEN`, `SMOKE_LICENSE_KEY`, `SMOKE_LICENSE_EMAIL`, `WINDOWS_CERT_PFX_BASE64`, `WINDOWS_CERT_PASSWORD`, `VERCEL_TOKEN`.

La compuerta estable exige `BUILD-INFO.json` con `signed=true`, URL explícita, llave pública, licencia de humo, token de administración, `VERCEL_TOKEN` y `CI_SMOKE` distinto de `false`. Los tags `-rc`/`-beta` son pre-release y no pasan por ella.

Bloqueos actuales:

- No hay PFX ni contraseña en GitHub: no se puede publicar un build firmado.
- No hay `VERCEL_TOKEN`: el despliegue desde GitHub se omite y la compuerta estable falla.
- Sin certificado, SmartScreen puede mostrar "editor desconocido"; se publican los SHA-256, pero el build no se presenta como firmado.

### Fase 6 — QA y entrega

Matriz mínima:

| Caso | Esperado |
|---|---|
| Windows 10/11 limpio, sin Node | Instala, servicio arriba, wizard abre |
| Instalación sin conexión | Wizard avisa y permite reintentar; gracia no aplica hasta activar |
| Upgrade 0.2.0 → 0.2.1 | Datos y licencia intactos, servicio reinicia |
| Actualización in-app fallida | Rollback a `app.old`, datos/licencia intactos |
| Desinstalar conservando datos | Reinstala y encuentra todo |
| Desinstalar borrando datos | Estado limpio |
| HWID distinto / licencia revocada | Bloqueo con mensaje de soporte |
| Puerto 3000 ocupado | Usa 3001 y el lanzador abre el puerto correcto |
| Usuario sin permisos de admin | El instalador pide elevación |
| Antivirus corporativo | Sin cuarentena (Defender y uno de terceros) |

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

## 6. Riesgos y mitigaciones

| Riesgo | Impacto | Mitigación |
|---|---|---|
| `better-sqlite3` y ABI de Node | El ejecutable arranca y muere | Runtime embebido de versión fija |
| SmartScreen / antivirus | El cliente no instala | Firma de código, hashes publicados y editor coherente |
| Upgrade pisa `salon.db` | Pérdida de datos | `IfFileExists` en NSIS + backups diarios |
| WAL y copias | Backup corrupto | `db.backup()` de SQLite, no copiar archivos a mano |
| Servicio sin permisos sobre `%PROGRAMDATA%` | BD no escribible | Servicio LocalSystem; probar usuario estándar |
| Puerto ocupado | La app no abre | Fallback de puerto + lanzador que lee el puerto real |
| Revocación sin red | El cliente sigue operando | Gracia 14 días + expiración de token a 30 días |
| Pérdida de `private.pem` | No se pueden emitir licencias | Respaldo offline cifrado + rotación documentada |
| Cold start/límites de Vercel | Latencia o rate limit por instancia | Turso remoto, límites holgados y migración a almacén distribuido si crece |
| Función sin base | 500 en producción | `TURSO_DATABASE_URL` obligatoria cuando `VERCEL_ENV=production` |

## 7. Checklist de "terminado"

- [ ] `SalonSuite-1.0.0-setup.exe` instala en Windows 10 y 11 sin Node ni dependencias.
- [ ] Servicio automático que sobrevive reinicios y se recupera de fallos.
- [ ] Wizard de activación en el primer arranque y cambio de contraseña forzado.
- [ ] Datos y licencia intactos tras actualizar.
- [ ] Desinstalación limpia con opción de conservar datos.
- [ ] Verificación periódica y revocación contra el servidor real.
- [ ] Actualización in-app detecta, descarga, verifica e instala.
- [ ] Backups diarios y restauración probada.
- [ ] Instalador firmado y `BUILD-INFO.json` con `signed=true`.
- [ ] Release estable con manifiesto firmado y smoke con activación real.
- [ ] README de soporte: reiniciar servicio, ubicación de logs y backups.

## 8. Comandos de referencia

```powershell
# Build completo con runtime, NSIS, ZIP, hashes y firma opcional
build\build-installer.ps1 -Version 1.0.0 -LicenseServer https://salon-license.vercel.app -PublicKey C:\ruta\public.pem

# Canal beta
build\build-installer.ps1 -Version 1.0.0-beta.1 -LicenseServer https://salon-license.vercel.app -UpdateChannel beta

# Firma manual de un artefacto
build\sign.ps1 -Files dist\SalonSuite-1.0.0-setup.exe -PfxPath C:\ruta\certificado.pfx -Password "clave"

# Prueba de humo de una instalación
tests\ci-smoke.ps1 -Installer dist\SalonSuite-1.0.0-setup.exe -ExpectedVersion 1.0.0

# Servidor local
cd tools\license-server
npm install
npm test
npm run test:phase4

# Despliegue del servidor
vercel --prod --yes --cwd tools\license-server
```

## 9. Próximos pasos para cerrar la entrega estable

1. Cargar `WINDOWS_CERT_PFX_BASE64` y `WINDOWS_CERT_PASSWORD` en GitHub.
2. Crear `VERCEL_TOKEN` y guardarlo como secreto del repositorio.
3. Ejecutar un build firmado y confirmar `BUILD-INFO.json` con `signed=true`.
4. Verificar el despliegue de Vercel desde el workflow y el manifiesto firmado.
5. Crear el tag `v0.2.0`, esperar la compuerta estable y comprobar el release.
6. Ejecutar la matriz de Fase 6 en Windows 10/11 con y sin UAC.
