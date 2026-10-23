# Publicación de actualizaciones

El servidor firma cada manifiesto con la misma llave Ed25519 del licenciamiento. La app verifica la firma y el SHA-256 antes de instalar.

## Canales

- `stable`: tags `vX.Y.Z` sin sufijo.
- `beta`: tags `vX.Y.Z-rc.N` o `vX.Y.Z-beta.N`.

El manifiesto se guarda en Turso y se consulta en `GET /api/version?channel=stable|beta`. La respuesta incluye `signature`; la app la valida con la llave pública.

## Publicar con el workflow

En cada tag `v*`, GitHub Actions:

1. Compila el instalador y calcula su SHA-256.
2. Crea el GitHub Release con el setup y el ZIP.
3. Hace `POST /admin/updates` al servidor de Vercel con la URL pública del setup, el hash, la versión y el canal.
4. Verifica `/health`, `/public` y el manifiesto firmado en una entrega estable.

No se copian binarios al servidor de licencias. El instalador se descarga desde el GitHub Release; la función solo firma el manifiesto.

## Publicar manualmente

```powershell
$base = "https://salon-license.vercel.app"
$headers = @{ Authorization = "Bearer $env:LICENSE_ADMIN_TOKEN" }
$body = @{
  channel = "stable"
  version = "0.2.1"
  url = "https://github.com/foxsolid23df-IA/salonbelleza/releases/download/v0.2.1/SalonSuite-0.2.1-setup.exe"
  sha256 = "<sha256>"
  notes = "Versión 0.2.1"
  published_at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
} | ConvertTo-Json -Depth 4
Invoke-RestMethod "$base/admin/updates" -Method Post -Headers $headers -ContentType "application/json" -Body $body
```

## Formato

```json
{
  "version": "0.2.1",
  "url": "https://github.com/.../SalonSuite-0.2.1-setup.exe",
  "sha256": "64 caracteres hexadecimales",
  "notes": "Notas de la versión",
  "min_version": "0.2.0",
  "published_at": "2026-10-22T12:00:00Z"
}
```

`min_version` es opcional. `url` debe usar HTTPS. El SHA-256 debe corresponder exactamente al archivo descargado.

## Reglas

- `version` debe ser mayor que `APP_VERSION` de la instalación.
- Conserva las versiones anteriores para soporte; la app guarda `app.old` durante el intento y lo restaura si la nueva versión no responde en 90 segundos.
- El endpoint `/api/download/:file` solo sirve archivos locales `.exe`, `.zip` y `.msi` cuando se usa el modo local; en Vercel las descargas van a GitHub Releases.
- Los manifiestos de ejemplo `stable.example.json` y `beta.example.json` son solo para desarrollo local.
