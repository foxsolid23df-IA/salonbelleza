# Publicación de actualizaciones

El servidor firma cada manifiesto con la misma llave Ed25519 del licenciamiento. La app verifica la firma y el SHA-256 antes de instalar.

## Estructura

```
updates/
  stable.json          manifiesto del canal estable
  beta.json            manifiesto del canal beta
  files/
    SalonSuite-0.2.1-setup.exe
```

Los binarios no se versionan en git. `stable.example.json` y `beta.example.json` muestran el formato.

## Publicar una versión

1. Compila el instalador con la versión nueva:

   ```powershell
   build\build-installer.ps1 -Version 0.2.1 -LicenseServer https://get.salonsuite.com
   ```

2. Copia el instalador a `updates/files/` en el VPS y calcula su hash:

   ```bash
   cd /opt/salonsuite-license/updates/files
   sha256sum SalonSuite-0.2.1-setup.exe
   ```

3. Crea `updates/stable.json` a partir de `stable.example.json` con la versión, URL relativa, hash y notas. El servidor lo lee en cada solicitud; no hace falta reiniciar.

4. Comprueba:

   ```bash
   curl -fsS "https://get.salonsuite.com/api/version?channel=stable"
   ```

   La respuesta incluye `signature`; la app la valida con la llave pública.

5. Opcional: publica `beta.json` para pilotos. El cliente usa `stable` por defecto; para beta, define `SALON_UPDATE_CHANNEL=beta` en la instalación.

Desde Fase 5, el workflow de GitHub Actions puede hacer los pasos 1–3 automáticamente en cada tag `vX.Y.Z`: publica el setup y el manifiesto del canal en `get.salonsuite.com` cuando están configurados `DEPLOY_HOST`, `DEPLOY_USER` y `DEPLOY_SSH_KEY`. El SHA-256 del setup y el estado de firma quedan en el release (`SHA256SUMS.txt` y `BUILD-INFO.json`).

## Reglas

- `version` debe ser mayor que `APP_VERSION` de la instalación.
- `url` puede ser relativa al servidor (`/api/download/...`) o absoluta con HTTPS.
- `sha256` debe corresponder exactamente al archivo descargado.
- `min_version` fuerza la actualización si la instalación es anterior.
- Conserva las versiones anteriores para soporte; la app también guarda `app.old` durante el intento y lo restaura si la nueva versión no responde en 90 segundos.
- El endpoint `/api/download/:file` solo sirve `.exe`, `.zip` y `.msi` desde `updates/files`; no expone manifiestos ni llaves.
