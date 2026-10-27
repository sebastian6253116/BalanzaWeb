# Despliegue

La ruta principal es **Dokploy**. La guía completa, con la configuración exacta
de la aplicación, variables, backups y troubleshooting, está en
[`docs/deploy.md`](../docs/deploy.md).

Resumen:

- Build type: **Dockerfile** (el de la raíz del repositorio).
- Contexto de build: raíz del repositorio.
- Puerto del contenedor: `8080`.
- Volumen nombrado `balanza-data` montado en `/app/data`.
- Health check: `/healthz`.
- Dominio con HTTPS activado (Traefik + Let's Encrypt de Dokploy).

Las variables `BOOTSTRAP_ADMIN_*` solo hacen falta en el primer despliegue con
el volumen vacío. Después se pueden quitar.

## Alternativa secundaria: VPS sin Dokploy

Solo si **no** usas Dokploy. Este compose levanta el API y Caddy (TLS propio).
No lo ejecutes en el mismo servidor que Dokploy: ambos pelearían por los puertos
80/443.

```bash
cd BalanzaWeb/deploy
cp .env.example .env    # editar DOMAIN y las credenciales bootstrap
docker compose up -d --build
docker compose ps
docker compose logs -f api
```

Abrir `https://<DOMAIN>`, iniciar sesión con el usuario bootstrap y cambiar la
contraseña. Los datos quedan en `deploy/data/balanzaweb.db`; no versionar esa
carpeta. Para backups y operación, ver [`docs/deploy.md`](../docs/deploy.md).
