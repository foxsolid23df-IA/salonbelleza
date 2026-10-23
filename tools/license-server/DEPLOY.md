# Despliegue del servidor de licencias

Arquitectura: un VPS con Docker Compose. El servicio Node escucha solo en la red interna; Caddy publica HTTPS con certificado automático de Let's Encrypt.

```
Internet 443 -> Caddy (TLS) -> license:4000 (Node + SQLite)
                                 |
                                 +-> volumen license-data (/data)
```

## 1. Requisitos

- VPS Linux con Docker Engine 24+ y el plugin `docker compose`.
- Dominio o subdominio con registro DNS `A` apuntando a la IP del VPS.
- Puertos 80 y 443 abiertos (Caddy necesita el 80 para validar el certificado).
- Acceso SSH con llave.

## 2. DNS y firewall

Crea el registro:

```
get.salonsuite.com.  A  <IP_DEL_VPS>
```

En el VPS:

```bash
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

No publiques el puerto 4000: en `docker-compose.yml` el servicio usa `expose`, no `ports`.

## 3. Configuración

Copia la carpeta `tools/license-server` al VPS (por ejemplo `/opt/salonsuite-license`) y entra en ella:

```bash
cd /opt/salonsuite-license
cp .env.example .env
```

Genera un token de administración largo y pégalo en `LICENSE_ADMIN_TOKEN`:

```bash
openssl rand -hex 32
```

Valores recomendados en producción:

```
DOMAIN=get.salonsuite.com
LICENSE_ADMIN_TOKEN=<token-de-64-hex>
LICENSE_SEED_DEMO=0
LICENSE_ALLOW_SELF_ACTIVATION=0
LICENSE_TOKEN_DAYS=30
LICENSE_GRACE_DAYS=14
LICENSE_RL_ACTIVATE=10
LICENSE_RL_VERIFY=60
LICENSE_RL_ADMIN=30
LICENSE_BACKUP_KEEP=14
```

`LICENSE_SEED_DEMO=1` solo se usa en desarrollo: crea la licencia demo conocida. `LICENSE_ALLOW_SELF_ACTIVATION=1` permite que cualquier UUID se active; nunca en producción.

## 4. Arranque

```bash
docker compose config
docker compose up -d --build
docker compose ps
docker compose logs -f license caddy
```

Comprobaciones:

```bash
curl -fsS https://get.salonsuite.com/health
curl -fsS https://get.salonsuite.com/public
```

`/health` debe devolver `{"ok":true,...}` y `/public` la llave pública Ed25519.

## 5. Emitir licencias

Las licencias son pre-emitidas: la app no puede crearlas por sí sola. El servidor crea el par de llaves Ed25519 en `/data/keys` en el primer arranque.

CLI dentro del contenedor:

```bash
docker compose exec license node admin.js create pro cliente@dominio.com
docker compose exec license node admin.js list
docker compose exec license node admin.js show <key>
docker compose exec license node admin.js events 50
```

API de administración (requiere el token):

```bash
TOKEN=<LICENSE_ADMIN_TOKEN>

curl -fsS -X POST https://get.salonsuite.com/admin/licenses \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"plan":"pro","cliente_email":"cliente@dominio.com"}'

curl -fsS https://get.salonsuite.com/admin/licenses \
  -H "Authorization: Bearer $TOKEN"
```

Planes: `starter` (4 estilistas), `pro` (10), `enterprise` (ilimitado, `staff_max=0`).

Una licencia admite una activación activa. Para mover un cliente a otro equipo:

```bash
# 1. localizar el HWID en el detalle de la licencia
docker compose exec license node admin.js show <key>

# 2. revocar el equipo anterior
docker compose exec license node admin.js revoke <hwid>

# 3. el cliente activa en el equipo nuevo con la misma licencia
```

También existe `POST /admin/revoke`, `POST /admin/reactivate`, `POST /admin/licenses/:key/revoke`, `GET /admin/events` y `POST /revoke` (todos con token).

## 6. Conectar el instalador

El instalador usa `https://get.salonsuite.com` por defecto. Para compilar apuntando a tu dominio:

```powershell
build\build-installer.ps1 -Version 0.2.0 -LicenseServer https://get.salonsuite.com
```

Opcionalmente embebe la llave pública. Así el cliente confía en las licencias incluso antes de la primera activación:

```bash
docker compose exec license cat /data/keys/public.pem > public.pem
```

```powershell
build\build-installer.ps1 -Version 0.2.0 -LicenseServer https://get.salonsuite.com -PublicKey C:\ruta\public.pem
```

Sin `-PublicKey`, la app guarda la llave que recibe por HTTPS en `app\.license\public_key.pem` durante la activación. Con `-PublicKey`, también existe `app\public_key.pem` como respaldo.

## 7. Backups y custodia de llaves

El backup de SQLite debe ser consistente; usa el script incluido (API `backup()` de SQLite, retención configurable):

```bash
docker compose exec -T license node backup.js
```

Cron diario en el VPS:

```cron
0 3 * * * cd /opt/salonsuite-license && docker compose exec -T license node backup.js >> /var/log/salonsuite-backup.log 2>&1
```

Los archivos quedan en el volumen `license-data`, bajo `/data/backups`. Cópialos fuera del VPS y cífralos:

```bash
docker run --rm -v salonsuite-license_license-data:/data -v "$PWD/offsite:/out" alpine \
  tar czf /out/salonsuite-licenses-$(date +%F).tgz -C /data backups keys
gpg --symmetric --cipher-algo AES256 offsite/salonsuite-licenses-$(date +%F).tgz
```

Guarda `keys/private.pem` cifrado y separado del servidor. Es la llave que firma todas las licencias y los manifiestos de actualización:

- Si se pierde, los tokens emitidos dejan de ser verificables y hay que generar llaves nuevas y reactivar a todos los clientes.
- Si se filtra, cualquiera puede firmar licencias: rota el par y reemite licencias.
- Nunca la subas al repositorio ni la envíes por correo/chat.

Restauración: detén el stack, restaura el volumen `license-data` (base de datos y `keys/`), y arranca de nuevo. El dominio debe ser el mismo.

## 8. Actualizar el servidor

```bash
cd /opt/salonsuite-license
docker compose build --pull
docker compose up -d
docker compose ps
```

El volumen `license-data` se conserva. Los endpoints y el esquema son compatibles con versiones anteriores (el servidor agrega columnas faltantes al arrancar).

## 9. Seguridad operativa

- `LICENSE_ADMIN_TOKEN` vacío deshabilita `/admin/*` y `/revoke` (responden 503/401). No lo dejes vacío.
- Rate limit: 10 activaciones/min, 60 verificaciones/min, 30 operaciones admin/min y 120 consultas de versión/min por IP. Ajustable con `LICENSE_RL_*`; `LICENSE_TRUST_PROXY=1` (ya configurado en Compose) hace que Caddy informe la IP real.
- Caddy fuerza HTTPS y HSTS. El certificado se renueva solo.
- El contenedor corre como usuario `node`, no como root.
- Revisa `docker compose logs license` y `docker compose logs caddy` ante errores 401/403/429.
- La auditoría queda en la tabla `events`: activaciones, intentos denegados, revocaciones y reactivaciones.
- Si quieres limitar la administración a una IP fija, añade una regla en el firewall del VPS o un `@admin` matcher en `Caddyfile`; el token sigue siendo obligatorio.

## 10. Diagnóstico

| Síntoma | Causa probable | Acción |
|---|---|---|
| Caddy no obtiene certificado | DNS incorrecto o puertos 80/443 cerrados | Verifica `dig` y `ufw status`; `docker compose logs caddy` |
| 502 Bad Gateway | Contenedor `license` caído | `docker compose ps`, `docker compose logs license` |
| 401 en admin | Token ausente o distinto | Revisa `Authorization: Bearer ...` y `.env` |
| 503 en admin | `LICENSE_ADMIN_TOKEN` vacío | Configúralo y reinicia |
| 404 al activar | Licencia no emitida | `node admin.js create ...` |
| 409 al activar | Licencia ya usada en otro equipo | Revoca el HWID anterior |
| 429 | Rate limit | Espera la ventana de un minuto o ajusta `LICENSE_RL_*` |
| Error al compilar `better-sqlite3` | Sin toolchain en la etapa de build | Usa la imagen completa `node:24-bookworm` (ya configurada) |

Pruebas locales del servidor (no requieren Docker):

```bash
cd tools/license-server
npm test
npm run test:phase4
```

## 11. Publicar actualizaciones de la app

El servidor sirve el manifiesto firmado y los instaladores desde `updates/`, montado en el contenedor como `/updates` (solo lectura).

1. Compila la versión nueva:

   ```powershell
   build\build-installer.ps1 -Version 0.2.1 -LicenseServer https://get.salonsuite.com
   ```

2. Copia el instalador a `updates/files/` en el VPS:

   ```bash
   cp SalonSuite-0.2.1-setup.exe /opt/salonsuite-license/updates/files/
   chmod -R a+rX /opt/salonsuite-license/updates
   sha256sum /opt/salonsuite-license/updates/files/SalonSuite-0.2.1-setup.exe
   ```

3. Crea `/opt/salonsuite-license/updates/stable.json`:

   ```json
   {
     "version": "0.2.1",
     "url": "/api/download/SalonSuite-0.2.1-setup.exe",
     "sha256": "<hash>",
     "notes": "Correcciones y mejoras de estabilidad.",
     "min_version": "0.2.0",
     "published_at": "2026-10-21T00:00:00Z"
   }
   ```

4. Verifica el manifiesto firmado:

   ```bash
   curl -fsS "https://get.salonsuite.com/api/version?channel=stable"
   ```

   No es necesario reiniciar el contenedor: el archivo se lee en cada solicitud. La firma se genera con `private.pem` y la app la valida antes de descargar.

5. Publica `beta.json` para pilotos. El cliente usa `stable` por defecto; en la instalación beta define `SALON_UPDATE_CHANNEL=beta` en `app\.env`.

### Publicación automática desde GitHub Actions

El workflow de Fase 5 compila el mismo artefacto que se publica en GitHub Releases y, cuando existen los secretos SSH, lo copia a `updates/files/` y escribe `stable.json` o `beta.json` sin intervención manual. Configura `DEPLOY_HOST`, `DEPLOY_USER` y `DEPLOY_SSH_KEY`; opcionalmente `DEPLOY_PORT` y `DEPLOY_UPDATES_DIR` (por defecto `/opt/salonsuite-license/updates`). Si `DEPLOY_HOST` no está configurado, el workflow omite el despliegue y deja el release de GitHub como artefacto principal.

El manifiesto se firma en el servidor con `private.pem`; no copies una firma precalculada. Después de cada publicación, verifica:

```bash
curl -fsS "https://get.salonsuite.com/api/version?channel=stable"
```

La app descarga el setup, comprueba el SHA-256 y la firma Ed25519 antes de instalar.

La app revisa cada 24 h y también al abrir **Actualizaciones** (solo administradores). Descarga a `%TEMP%`, verifica SHA-256 y firma, ejecuta el setup en modo silencioso y conserva datos/licencia. Si la versión nueva no responde en 90 s, el helper restaura `app.old` automáticamente. Los detalles de formato están en `updates/README.md`.
