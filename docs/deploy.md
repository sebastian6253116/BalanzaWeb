# Despliegue y operación

Ruta principal: **Dokploy** (Docker + Traefik + Let's Encrypt). La alternativa
para un VPS sin Dokploy (compose + Caddy) está en el apéndice.

## 1. Arquitectura en producción

```
Internet
   │  HTTPS (443)
   ▼
Traefik (Dokploy) ── TLS con Let's Encrypt + proxy inverso
   │  HTTP plano por la red interna Docker
   ▼
Contenedor Node (uid 1000, usuario `node`)
   ├─ /api/*     API JSON
   ├─ /agent/*   protocolo de agentes
   ├─ /healthz   healthcheck sin auth
   └─ /*         web compilada (apps/web/dist) + fallback SPA
   │
   ▼
Volumen `balanza-data` → /app/data/balanzaweb.db (SQLite)
```

Es **un solo contenedor**: el proceso Node sirve la API y la web compilada. No
hay CORS porque la web llama a `/api` con ruta relativa y comparte origen con el
API. Los headers de seguridad (CSP, `nosniff`, `x-frame-options`,
`referrer-policy`) los pone el API en todas las respuestas.

El contenedor corre como `node` (uid 1000). El SQLite y cualquier archivo local
viven en `/app/data`, que debe ser un **volumen nombrado**. No uses un bind mount
sin corregir el dueño: el proceso no podrá escribir la base.

## 2. Configuración exacta de la aplicación en Dokploy

Los nombres de los campos pueden variar levemente entre versiones de Dokploy.
La tabla describe el valor que debe quedar configurado.

| Campo | Valor |
|---|---|
| Proveedor (Provider) | GitHub |
| Repositorio | `sebastian6253116/BalanzaWeb` |
| Rama | `main` |
| Tipo de build (Build type) | **Dockerfile** |
| Ruta del Dockerfile (Dockerfile path) | `Dockerfile` |
| Contexto de build (Build context) | raíz del repositorio (`.` / `/`) |
| Puerto del contenedor (Container port) | `8080` |
| Dominio (Domain) | el host real que se va a servir, con **HTTPS activado** (Let's Encrypt vía Traefik) |
| Volumen (Volume / Mount) | volumen nombrado `balanza-data` → `/app/data` |
| Health check (Path) | `/healthz` |

El Dockerfile de la raíz es el objetivo de build de Dokploy. Construye la web en
una etapa `build` y en la etapa de runtime copia solo el resultado; la API no
tiene dependencias de runtime, por eso el runtime **no ejecuta `npm install`**.

### Variables de entorno

| Variable | Valor | Uso |
|---|---|---|
| `PORT` | `8080` | Puerto de escucha del API (debe coincidir con el puerto del contenedor) |
| `DB_PATH` | `/app/data/balanzaweb.db` | Archivo SQLite dentro del volumen |
| `WEB_DIR` | `/app/apps/web/dist` | Web compilada que sirve el API |
| `TRUST_PROXY` | `1` | Usa `X-Forwarded-For`; detrás de Traefik es obligatorio |
| `LOG_REQUESTS` | `1` | Una línea de log por request |
| `BOOTSTRAP_ADMIN_USERNAME` | usuario del primer administrador | Solo en el primer despliegue |
| `BOOTSTRAP_ADMIN_PASSWORD` | clave del primer administrador | Solo en el primer despliegue |
| `BOOTSTRAP_ADMIN_NAME` | nombre visible del administrador | Opcional |

Las variables `BOOTSTRAP_ADMIN_*` solo se usan cuando la tabla de usuarios está
vacía. Puedes quitarlas después del primer arranque; dejarlas también es
inofensivo porque el usuario se crea únicamente cuando no hay ninguno.

### Auto-deploy

Conecta el repositorio para que un push a `main` dispare un nuevo despliegue.
Dokploy ofrece webhook y GitHub App; usa el que corresponda a tu instalación y
verifica que el evento llegue (pestaña de deployments de la aplicación).

## 3. Checklist del primer despliegue

1. Desplegar la aplicación y esperar a que el build termine.
2. Abrir `https://<dominio>` y verificar que carga la web (no una página en blanco).
3. Iniciar sesión con el usuario bootstrap.
4. Cambiar la contraseña del administrador desde la pantalla de Usuarios.
5. Verificar `https://<dominio>/healthz` devuelve `200` con `{"ok":true,...}`.

## 4. Copia de seguridad y restauración

La base completa vive en el volumen, en `/app/data/balanzaweb.db`. Incluye
usuarios, sedes, catálogo, publicaciones y tokens de agentes.

**En frío (recomendada):** detener la aplicación en Dokploy, copiar el archivo y
volver a arrancar.

```bash
# Localizar el contenedor y el volumen reales (Dokploy puede prefijar el nombre)
docker ps --format '{{.Names}}'
docker volume ls
```

**En caliente (sin detener el servicio):** usar `VACUUM INTO` dentro del
contenedor y copiar el resultado afuera.

```bash
docker exec <contenedor> node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/app/data/balanzaweb.db');db.exec(\"VACUUM INTO '/app/data/balanzaweb-backup.db'\");db.close()"
docker cp <contenedor>:/app/data/balanzaweb-backup.db "./balanzaweb-$(date +%F-%H%M).db"
```

Guardar la copia fuera del VPS y **probar la restauración** alguna vez.

Para restaurar:

1. Detener la aplicación en Dokploy.
2. Reemplazar `/app/data/balanzaweb.db` dentro del volumen por la copia y
   asegurar el dueño `1000:1000` (`node`).

```bash
docker run --rm -v <volumen>:/app/data -v "$PWD":/backup alpine \
  sh -c 'cp /backup/balanzaweb-AAAA-MM-DD-HHMM.db /app/data/balanzaweb.db && chown 1000:1000 /app/data/balanzaweb.db'
```

3. Volver a arrancar la aplicación y comprobar `/healthz` y el login.

## 5. Logs y monitoreo

- Logs del contenedor: `docker logs -f <contenedor>` (o la vista de logs de Dokploy).
- Con `LOG_REQUESTS=1` se escribe una línea por request al terminar la respuesta:
  `GET /api/articles 200 12ms 203.0.113.10`. Nunca se registran headers, cuerpos,
  tokens ni contraseñas; `/healthz` se omite.
- Monitoreo de uptime: apuntar el monitor a `https://<dominio>/healthz`. Alarmar
  si deja de responder `200` o si `uptimeSeconds` baja (reinicio inesperado).

## 6. Una sola réplica

SQLite y el estado local viven en el volumen del contenedor. **No escales a más
de una réplica**: dos procesos escribiendo el mismo archivo o con volúmenes
distintos rompen los datos y las sesiones. Esta aplicación se despliega con una
réplica y se escala verticalmente.

## 7. Troubleshooting

| Síntoma | Causa probable | Solución |
|---|---|---|
| El contenedor arranca y se reinicia en bucle | Volumen vacío sin `BOOTSTRAP_ADMIN_USERNAME` / `BOOTSTRAP_ADMIN_PASSWORD` | Definir las variables bootstrap y redeployar una vez; después se pueden quitar |
| Traefik devuelve 502 | El puerto del contenedor no coincide con `PORT` | Poner puerto `8080` y `PORT=8080` |
| `permission denied` sobre `/app/data` | Bind mount del host sin permisos para uid 1000 | Usar volumen nombrado o hacer `chown 1000:1000` del directorio montado |
| Página en blanco | La imagen no contiene `apps/web/dist` | Verificar que el build ejecutó `npm --workspace @balanza/web run build` y que se copió el `dist` |

## 8. Apéndice: VPS sin Dokploy (compose + Caddy)

Alternativa secundaria para un VPS con Docker y sin Dokploy. Usa
`deploy/docker-compose.yml` y `deploy/Caddyfile`; Caddy termina TLS y publica los
puertos 80/443.

```bash
cd BalanzaWeb/deploy
cp .env.example .env    # editar DOMAIN y las credenciales bootstrap
docker compose up -d --build
docker compose logs -f api
```

No ejecutes este compose en el mismo servidor que Dokploy: Caddy y Traefik
competirían por los puertos 80/443 y por la emisión del certificado. El paso a
paso completo está en `deploy/README.md`.

## 9. Pendientes

| Tema | Estado |
|---|---|
| **Adaptador MySQL** | Pendiente. Hoy `db.js` usa `node:sqlite`; para varias sedes simultáneas hay que implementar `run`/`get`/`all`/`exec` sobre `mysql2` y agregar el servicio a Compose |
| **Firma de código del agente** | Pendiente. El binario SEA y el instalador WinSW no están firmados; SmartScreen puede advertir |
| **Auto-actualización del agente** | Pendiente. Hoy actualizar el agente es manual (reemplazar el servicio) |
