# Servidor de licencias Salón Suite

Servicio Node + SQLite para emitir y verificar licencias Ed25519 ligadas al HWID. En producción va detrás de Caddy con HTTPS; ver `DEPLOY.md`.

## Desarrollo local

```bash
npm install
cp .env.example .env
# Edita .env: token de administración y LICENSE_SEED_DEMO=1 si quieres la licencia demo
node index.js
```

Sin `LICENSE_DATA_DIR`, los datos quedan en `data/` (ignorado por git). El par de llaves se genera en `data/keys/` al primer arranque.

Variables principales:

| Variable | Default | Uso |
|---|---|---|
| `PORT` | `4000` | Puerto HTTP |
| `HOST` | `127.0.0.1` | Interfaz; en Docker `0.0.0.0` |
| `LICENSE_DATA_DIR` | `./data` | BD, llaves, backups |
| `LICENSE_ADMIN_TOKEN` | vacío | Obligatorio para `/admin/*` y `/revoke`; vacío = deshabilitado |
| `LICENSE_ALLOW_SELF_ACTIVATION` | `0` | `1` solo desarrollo: crea licencias al vuelo |
| `LICENSE_SEED_DEMO` | `0` | `1` solo desarrollo: licencia demo `550e8400-...` |
| `LICENSE_TOKEN_DAYS` | `30` | Vigencia del token |
| `LICENSE_GRACE_DAYS` | `14` | Gracia tras vencer el token |
| `LICENSE_RL_ACTIVATE` | `10` | Límite/min/IP de activaciones |
| `LICENSE_RL_VERIFY` | `60` | Límite/min/IP de verificaciones |
| `LICENSE_RL_ADMIN` | `30` | Límite/min/IP de administración |
| `LICENSE_RL_UPDATES` | `120` | Límite/min/IP de consulta de versión |
| `LICENSE_UPDATES_DIR` | `./updates` | Manifiestos y binarios de actualización |
| `LICENSE_TRUST_PROXY` | `0` | `1` detrás de Caddy para usar la IP real |

## Endpoints

Públicos:

- `GET /health` — estado.
- `GET /public` — llave pública PEM.
- `POST /activate` — `{ license_key, hwid, salon?, cliente_email? }` → `{ token, plan, staff_max, expires_at, public_key }`.
- `POST /verify` — `{ token, hwid }` → `{ ok, token, expires_at }`; renueva el token y la app lo persiste.
- `GET /api/version?channel=stable` — manifiesto firmado con Ed25519 (`version`, `url`, `sha256`, `notes`, `min_version`, `signature`).
- `GET /api/download/:file` — instalador/zip publicado en `updates/files` (solo `.exe`, `.zip`, `.msi`).

Con `Authorization: Bearer <LICENSE_ADMIN_TOKEN>` o `X-Admin-Token`:

- `GET /admin/licenses?limit=100`
- `POST /admin/licenses` — `{ plan, cliente_email? }`
- `GET /admin/licenses/:key`
- `POST /admin/revoke` — `{ hwid }`
- `POST /admin/reactivate` — `{ hwid }`
- `POST /admin/licenses/:key/revoke`
- `GET /admin/events?limit=100`
- `POST /revoke` — alias de administración.

Errores: `404 LICENSE_NOT_FOUND`, `409 ACTIVATION_LIMIT`, `403 REVOKED`, `403 HWID_MISMATCH`, `429 RATE_LIMIT`, `401 UNAUTHORIZED`, `503 ADMIN_DISABLED`.

Cada licencia admite una activación activa. Para mover un cliente se revoca el HWID anterior y se activa en el equipo nuevo.

## Administración

```bash
node admin.js create pro cliente@dominio.com
node admin.js list
node admin.js show <key>
node admin.js revoke <hwid>
node admin.js reactivate <hwid>
node admin.js events 50
```

Añade `--json` para salida legible por máquina. `seed-license.js` se conserva como alias de `admin.js`.

## Backups

```bash
node backup.js
```

Copia consistente de SQLite en `data/backups/`, retención `LICENSE_BACKUP_KEEP` (14 por defecto). Respalda también `data/keys/private.pem` cifrado y fuera del servidor.

## Pruebas

```bash
npm test
```

`test-phase3.js` levanta un servidor temporal y comprueba 30 casos: licencias pre-emitidas, autenticación admin, límite de activación, renovación de token, revocación/reactivación, rate limit, auditoría, CLI y backup.

Para actualizaciones:

```bash
npm run test:phase4
```

Comprueba el manifiesto firmado, canales, descarga y la verificación del cliente.

## Despliegue

Ver `DEPLOY.md` (Docker Compose + Caddy + TLS + backups + custodia de llaves).
