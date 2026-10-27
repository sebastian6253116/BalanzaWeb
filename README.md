# BalanzaWeb

Aplicación web para administrar el catálogo PLU de balanzas **Rongta RLS1000** y
publicarlo por la red local usando el protocolo nativo de la balanza. No requiere
instalar el software del fabricante en la sede.

El sistema tiene tres partes:

- **Web** (React + Vite): artículos, sedes, balanzas, publicación, estado y usuarios.
- **API** (Node 22, sin dependencias de runtime): autenticación, catálogo y
  revisiones de publicación; sirve también la web compilada.
- **Agente local** (Node, se instala como servicio de Windows): descarga las
  revisiones y las envía a las balanzas por UDP en la red de la sede.

## Estructura

```
apps/api               API HTTP (node:http + node:sqlite)
apps/web               React 18 + Vite (CSS propio, sin librería de UI)
apps/agent             Agente local: enrolamiento, polling y push a balanzas
apps/cli               Herramienta de operación (validate / build / probe / push)
packages/plu-format    Formato .Txp: registros, tramas UDP y validador
packages/scale-client  Transporte UDP con ACK, timeout y reintentos
deploy/                Compose + Caddy para VPS sin Dokploy
docs/                  Protocolo, proyecto, servicio de Windows y despliegue
```

## Requisitos

- Node.js **22** o superior (probado con 22.17.1).
- npm (incluido con Node).
- Para desplegar: Dokploy con Docker, o un VPS con Docker y Caddy.

## Desarrollo

```powershell
# 1. Dependencias (una sola vez, desde la raíz)
npm install

# 2. API (terminal 1)
$env:PORT="8080"
$env:DB_PATH="./data/dev.db"
$env:BOOTSTRAP_ADMIN_USERNAME="admin"
$env:BOOTSTRAP_ADMIN_PASSWORD="admin123"
node apps/api/src/index.js

# 3. Web en modo desarrollo (terminal 2)
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --config apps/web/vite.config.js
```

- Web: http://127.0.0.1:5173
- API: http://127.0.0.1:8080
- Usuario de desarrollo: `admin` / `admin123` (cambiar antes de exponer la app).

El proxy de Vite manda `/api` y `/agent` al puerto 8080. La base de desarrollo
queda en `data/dev.db` y no se versiona.

## Tests

```powershell
npm test
```

Los tests cubren el formato PLU, el transporte UDP, la API y el agente. Los tests
golden que dependen del catálogo real (`BaseDatosBalanza/`) se omiten cuando esa
carpeta no está presente, para que el repositorio público se pueda probar sin
datos del negocio.

## Agente para Windows

El agente mantiene las balanzas de una sede sincronizadas con la API y corre como
el servicio de Windows `BalanzaWebAgent`. Se distribuye como
`balanza-agent-<version>-win-x64.zip` (1.0.0: `balanza-agent-1.0.0-win-x64.zip`), el
paso a paso está en [`docs/instalacion-sede.md`](docs/instalacion-sede.md) y los
binarios no se versionan en git: se publican como artefactos de release, según
[`docs/agent-release.md`](docs/agent-release.md).

## Documentación

- [`docs/PROJECT.md`](docs/PROJECT.md): estado del proyecto, decisiones y pendientes.
- [`docs/protocol.md`](docs/protocol.md): protocolo RLS1000 verificado contra hardware.
- [`docs/service.md`](docs/service.md): agente como servicio de Windows.
- [`docs/instalacion-sede.md`](docs/instalacion-sede.md): instalación del agente en la PC de una sede, paso a paso.
- [`docs/agent-release.md`](docs/agent-release.md): cómo generar, verificar y publicar una versión del agente.
- [`docs/deploy.md`](docs/deploy.md): despliegue con Dokploy, backups y operación.

## Datos que no forman parte del repositorio

Este repositorio no publica datos del negocio ni secretos: el catálogo real
(`BaseDatosBalanza/`), las bases SQLite (`data/`, `*.db`), los archivos `.env`,
los tokens de agentes y los artefactos de build quedan fuera por `.gitignore`.
Las capturas de referencia del protocolo están en `docs/captures/` y tampoco se
versionan.
