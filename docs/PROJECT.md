# BalanzaWeb — estado del proyecto

Documento de traspaso. Última actualización: **2026-10-27**.

**Estado en una línea:** desplegado en producción con Dokploy, catálogo real de 832
artículos cargado, y pendiente la prueba de punta a punta con una balanza en la red
de la sede.

Resumen en una línea: web React en VPS + microservicio local que habla el
**protocolo nativo** de las balanzas Rongta RLS1000 por **UDP**, sin instalar
software del fabricante en la sede.

---

## 1. Cómo levantar todo (entorno de desarrollo)

```powershell
# 1. dependencias (una sola vez)
npm install

# 2. API (terminal 1)
$env:PORT="8080"
$env:DB_PATH="./data/dev.db"
$env:BOOTSTRAP_ADMIN_USERNAME="admin"
$env:BOOTSTRAP_ADMIN_PASSWORD="admin123"
node apps/api/src/index.js

# 3. Web (terminal 2)
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5173 --config apps/web/vite.config.js
#   (o, desde apps/web: npx vite)

# 4. Agente local (terminal 3, en la PC de la sede)
node apps/agent/src/index.js enroll --api http://127.0.0.1:8080 --code <CODIGO>
node apps/agent/src/index.js run
```

| Dato | Valor |
|---|---|
| Web | http://127.0.0.1:5173 |
| API | http://127.0.0.1:8080 |
| Usuario / clave (dev) | `admin` / `admin123` |
| Balanza de prueba | `192.168.0.201`, UDP **5001** |
| Base de datos (dev) | `data/dev.db` (SQLite) |

> El proxy de Vite manda `/api` y `/agent` al puerto 8080.
> En Windows, `Start-Process npx` falla: hay que lanzar `node …/vite/bin/vite.js`.

Comandos útiles del CLI de balanzas:

```powershell
node apps/cli/src/index.js validate <archivo.Txp>
node apps/cli/src/index.js build <archivo.Txp>
node apps/cli/src/index.js probe --ip 192.168.0.201
node apps/cli/src/index.js push <archivo.Txp> --ip 192.168.0.201 [--dry-run]
```

## 2. Estructura

```
packages/plu-format    .Txp → registros de 124 bytes → tramas UDP + validador
packages/scale-client  transporte UDP con ACK, timeout y reintentos
apps/api               API HTTP (node:http + node:sqlite), auth por sesión
apps/agent             servicio local: enrolamiento, polling, push, reporte
apps/agent/src/paths.js    rutas de datos (%ProgramData% vs binarios)
apps/agent/src/log.js      log rotativo propio del agente
apps/agent/scripts         build SEA (binario único) y descarga de WinSW
apps/agent/service         plantilla WinSW + install.ps1 / uninstall.ps1
apps/agent/dist/balanza-agent-<version>-win-x64.zip  paquete plano para la sede (npm run agent:package)
apps/cli               herramienta de operación (validate / build / probe / push)
apps/web               React 18 + Vite (sin librería de UI, CSS propio)
docs/protocol.md       contrato del protocolo (verificado contra hardware)
docs/service.md        empaquetado e instalación como servicio Windows
docs/deploy.md         despliegue del API + web en VPS (Docker, Caddy, backups)
deploy/                Dockerfile, docker-compose.yml y Caddyfile
docs/captures/         capturas .pcapng de referencia
```

Sin dependencias de runtime en API, agente y paquetes. La web usa solo React + Vite.

## 3. Protocolo RLS1000 (resumen)

Detalle completo en `docs/protocol.md`. Lo esencial:

- **UDP puerto 5001**. La balanza responde a cada datagrama con **un UDP vacío (ACK)**.
  No hay códigos de error ni confirmación de commit.
- Tramas de tamaño fijo: `0x0E` = 261 bytes, `0xD2` = 265 bytes.
- Checksum: **suma uint16 little-endian** de todos los bytes previos (no es CRC).
- Secuencia: `0E01` hello → `D201` start → `D202`×N datos → `D204`×3 tabla de
  teclado → `D207`×2 → `D205` → `D20C` → `0E02` goodbye.
- Cuerpo de datos: 256 bytes = **2 registros de 124 bytes** + 8 de relleno; `seq` de 8 bits.
- Registro PLU: nombre 72 (ASCII), LF code BCD en `[73..74]`, barcode BCD 6 dígitos
  en `[77..79]`, precio BCD en `[83..84]`, unidad en `[85]`, departamento BCD en
  `[86]`, validez u16 LE en `[90..91]`, flag de empaque en `[92]` (`0x00` normal,
  `0x80` por unidad).

**Verificado en hardware:** transferencia de 832 PLUs (425 tramas, ~9,7 s) con los
datos confirmados en el equipo.

## 4. API

Autenticación en dos planos:

| Plano | Credencial | Uso |
|---|---|---|
| Personas | usuario + clave → token de sesión (12 h) | `/api/*` |
| Agentes | código de emparejamiento → token de agente | `/agent/*` |

- Contraseñas con **scrypt**; sesiones guardadas como **SHA-256**; cambiar la clave
  invalida las sesiones abiertas.
- Los permisos se resuelven **por request**, así que revocar un permiso es inmediato.

### Permisos por sección

| Sección | Permisos |
|---|---|
| Artículos | `articles.read`, `articles.write` |
| Sedes | `sedes.read`, `sedes.write` |
| Balanzas | `scales.read`, `scales.write` |
| Publicaciones | `deployments.create` |
| Estado | `status.read` |
| Agentes | `agents.manage` |
| Usuarios | `users.manage` |

Roles semilla: `admin` (todo), `operator` (maestro + publicar + lectura), `viewer` (lectura).

Además de los roles semilla, se pueden crear roles propios con `POST /api/roles` (la
clave se deriva del nombre si se omite), renombrarlos con `PATCH /api/roles/:key` y
borrarlos con `DELETE /api/roles/:key`. El rol `admin` no se puede borrar (`422`) y
debe conservar `users.manage`: `PUT /api/roles/:key/permissions` devuelve `422` si se
lo quita. Un rol asignado a usuarios no se puede borrar (`409`). Los seeds `admin`,
`operator` y `viewer` se recrean de forma idempotente y nunca tocan los roles propios.

### Endpoints principales

```
POST /api/auth/login | logout        GET /api/auth/me
GET/POST /api/articles               PATCH/DELETE /api/articles/:id
GET  /api/articles/suggest           PUT /api/articles        (carga masiva)
GET  /api/articles/export?format=txp|xlsx  (maestro .Txp o Excel; sin `format` usa `txp`)
GET  /api/catalog                    GET /api/units
GET/POST /api/sedes                  GET/POST /api/sedes/:id/scales
DELETE /api/sedes/:id                DELETE /api/sedes/:id/scales/:scaleId
POST /api/sedes/:id/pairing-code     POST /api/sedes/:id/deployments
GET  /api/sedes/:id/status           POST /api/agents/:id/revoke
GET/POST /api/users                  PATCH/DELETE /api/users/:id
PUT  /api/users/:id/roles            PUT /api/users/:id/password
GET/POST /api/roles                  PATCH/DELETE /api/roles/:key
PUT  /api/roles/:key/permissions
--- agentes ---
POST /agent/enroll                   GET /agent/sync?revision=N  (304 si no hay cambios)
POST /agent/report
```

## 5. Agente local

- `enroll` guarda la config en `%ProgramData%\BalanzaWeb\Agent\config\agent.config.json`
  (token + revisión + hashes). `BALANZA_AGENT_HOME` cambia la raíz; `./data/agent.config.json`
  es la ruta heredada de desarrollo fuera de Windows.
- `run` consulta cada N segundos. **Si la respuesta es 304 no hace nada.**
- Al recibir una revisión: arma los registros **localmente**, calcula el hash y
  **solo envía a las balanzas cuyo contenido cambió**.
- La revisión local **solo avanza si todas las balanzas ACKearon**; si una falla,
  se reintenta en el próximo ciclo sin reenviar a las que ya estaban bien.
- El intervalo remoto (desde la web) aplica salvo que exista override local.
- En producción corre como servicio Windows `BalanzaWebAgent`: binario único
  (Node SEA) + WinSW, datos en `%ProgramData%\BalanzaWeb\Agent`, log rotativo y
  parada ordenada con `request-stop`. Ver `docs/service.md`.
- `version` imprime `balanza-agent <version>`. La versión sale de
  `apps/agent/package.json` y queda embebida en el SEA, así que el ejecutable la
  reporta sin necesitar Node.
- `probe --host <ip>` manda el `hello` del protocolo y reporta modelo, tamaño de la
  respuesta y latencia. Sirve para separar "la balanza no está en la red" de "el
  protocolo falla", sin Node en la sede. `--port`, `--timeout` y `--retries` son
  opcionales.
- En una instalación nueva sin `-ApiUrl` ni `-PairingCode`, `install.ps1` abre la
  ventana **BalanzaWeb - Conectar agente** (`configurar-agente.ps1`), salvo con
  `-Quiet` o sin sesión interactiva, donde deja el aviso en consola. Si ya existe
  configuración, no la abre: imprime `Existing configuration found: the agent stays
  enrolled, no window needed.`
- Un agente revocado recibe `403 agent token revoked` en cada request; el servicio
  sigue registrando `sync error: sync failed: HTTP 403` hasta que se vuelve a
  enrolar con un código nuevo.

## 6. Web

| Pantalla | Permiso | Qué hace |
|---|---|---|
| Artículos | `articles.read` | Maestro con **paginado 10/30/50/100**, búsqueda progresiva con spinner, alta/edición con sugerencia de código libre y selector de las 13 unidades, y dos botones, **Exportar Excel** y **Exportar .Txp**, para descargar el catálogo activo como planilla editable o en el formato del software del fabricante |
| Código de barras | `articles.read` | Genera el EAN-13 de una referencia: base de 12 dígitos con relleno a la derecha y dígito de control módulo 10. Dibuja el código como SVG (EAN-13 o CODE128) y lo descarga en PNG |
| Sedes y balanzas | `sedes.read` | Alta y **baja** de sedes y balanzas (con confirmación), y código de autorización |
| Publicar | `deployments.create` | Elige sede y destino (todas o balanzas puntuales) y crea la revisión |
| Estado | `status.read` | Revisión publicada, resultado real por balanza, historial de envíos y **agentes de la sede**, que se pueden **revocar** con `agents.manage`; un agente revocado queda con la etiqueta `revocado` |
| Usuarios | `users.manage` | Dos pestañas (**Usuarios** / **Roles**), búsqueda en el cliente por nombre o usuario, alta detrás de un botón y edición de nombre/usuario/estado, cambio de clave y roles con guardado explícito. En **Roles** se crean, renombran y eliminan roles y se editan sus permisos; el rol `admin` no se puede borrar ni perder `users.manage`, y un rol asignado no se borra. El rol de la cuenta `admin` está bloqueado |

Además, las sedes y balanzas se pueden eliminar, y los usuarios se pueden editar, cambiar de clave o eliminar; toda acción destructiva pide confirmación y se valida también en la API.

Limitación de la exportación `.Txp`: `pack_weight` y las columnas 11-25 no se almacenan, así que el archivo exportado las normaliza a cero; los nombres se exportan sin espacios sobrantes.

Responsive: menú lateral deslizable bajo 900 px, columnas secundarias ocultas bajo
720 px, modales a pantalla completa y menú "Acción ▾" por fila en móvil. En esa
misma medida, la tabla de usuarios usa `.table-cards` y se convierte en tarjetas con
etiquetas, y sus botones de acción dejan de ocultarse; el resto de las tablas todavía
usa desplazamiento horizontal.

Flujo de datos: **crear/editar deja la sede "con cambios sin publicar"** → publicar
genera una revisión inmutable → el agente la baja en su próximo ciclo.

## 7. Base de datos

SQLite en desarrollo (`node:sqlite`). Tablas: `sedes`, `scales`, `agents`,
`pairing_codes`, `articles`, `deployments` (con `catalog_json`, snapshot inmutable),
`deployment_results`, `users`, `roles`, `role_permissions`, `user_roles`, `sessions`.

Para pasar a MySQL en el VPS alcanza con reimplementar los cuatro métodos de
`apps/api/src/db.js` (`run`, `get`, `all`, `exec`). El resto del código no cambia.

## 8. Tests

```powershell
node --test packages/plu-format/test/plu-format.test.js `
               packages/scale-client/test/scale-client.test.js `
               packages/xlsx/test/xlsx.test.js `
               apps/api/test/api.test.js apps/api/test/server.test.js `
               apps/api/test/users-sedes.test.js `
               apps/agent/test/agent.test.js apps/agent/test/service.test.js `
               apps/web/test/barcode.test.js
```

**99 tests, todos verdes.** Incluyen:

- Golden byte-a-byte de los **832 registros** y de **todas las tramas de control**
  contra las capturas reales (fixture inmutable `test/fixtures/plu-832-original.txp`).
- Transporte UDP contra una balanza falsa (ACK, reintento, timeout).
- API: flujo completo, permisos, roles editables, sesiones, validación de catálogo.
- Excel: escritor OOXML propio sin dependencias, ZIP determinista, las seis partes del
  paquete, celdas de texto en línea, formato de moneda y validación del nombre de hoja.
- Agente: push, 304, skip por hash, fallo no avanza revisión, envío selectivo, comando `version`.
- Código de barras: dígito de control EAN-13 contra vectores conocidos, geometría de 95 módulos y checksum de CODE128 subset B.
- Servicio: rutas, log rotativo y tolerante a fallos, guardado atómico de la
  config y parada ordenada de `run` mediante `request-stop`.

## 9. Decisiones tomadas (y por qué)

1. **Snapshot completo por revisión**, no deltas: 832 PLUs son ~100 KB y elimina
   bugs de sincronización incremental. El "diff" ocurre por balanza con el hash.
2. **Validar contra el catálogo completo** en cada alta/edición: los duplicados solo
   se detectan comparando con el resto.
3. **No borrar filas al corregir duplicados**: se reasignó código para no dejar
   teclas apuntando a la nada.
4. **Commit sin confirmación de la balanza**: no existe; el éxito se define por ACK
   de todas las tramas. La app del fabricante reporta "listo" sin verificar y falla
   en silencio.
5. **El agente no avanza la revisión si una balanza falla**, para que el error sea
   visible y reintentable.
6. **Permisos resueltos por request**, no dentro del token, para que revocar sea inmediato.
7. **Ventana de primer arranque y enrolamiento antes del primer inicio**: el
   instalador permite pegar la URL y el código en una ventana, y cuando recibe
   `-ApiUrl` y `-PairingCode` enrola **antes** de arrancar el servicio. Así el
   operador no depende de la consola y el agente no queda repitiendo
   `FATAL not enrolled yet`.
8. **Revocar el agente en lugar de borrar la fila**: conserva el historial de la
   máquina, invalida el token de inmediato y obliga a un enrolamiento nuevo, que
   crea un agente distinto. Borrar la fila perdería la trazabilidad.
9. **No firmar el binario por ahora**: no hay certificado ni `signtool`; el zip se
   entrega por USB o red interna para evitar el *Mark-of-the-Web*. Un certificado
   autofirmado no es de confianza en otras PC y agrava la operación. La decisión de
   comprar un certificado real queda pendiente.
10. **La versión del agente es independiente de la web y del API**: la fuente es
    `apps/agent/package.json` (hoy `1.0.1`) y el tag de release es
    `agent-v<version>`. La web y el API pueden avanzar sin volver a publicar el
    agente, y viceversa.

## 10. Pendientes (en orden sugerido)

| Prioridad | Tarea | Por qué |
|---|---|---|
| Hecho | **Empaquetar el agente como servicio Windows y distribuirlo** (binario único, arranque automático, log a archivo, zip plano para la sede) | Implementado con Node SEA + WinSW; `npm run agent:package` genera `balanza-agent-<version>-win-x64.zip`; ver `docs/service.md` |
| Hecho | **API lista para desplegar** (un solo proceso sirve API y web compilada, `/healthz`, headers de seguridad, rate limit de login, logs por request, archivos estáticos con fallback SPA, Dockerfile + compose + Caddy) | Implementado en `apps/api/src/app.js` e `apps/api/src/index.js`; artefactos en `deploy/` y guía en `docs/deploy.md` |
| Hecho | **Despliegue en VPS + HTTPS** | Corriendo en Dokploy (Docker + Traefik + Let's Encrypt) desde `main`, con auto-deploy. Ver sección 15 |
| Hecho | **Maestro de artículos en producción** | 832 artículos cargados con `PUT /api/articles` y persistidos en el volumen. 23 tienen precio 0 en el archivo original |
| Hecho | **Administración completa de sedes, balanzas y usuarios** | Alta, baja y edición; ver sección 15 |
| Alta | **Probar el flujo completo con hardware**: sede + balanza + publicación + agente real | Es lo único que falta para cerrar el circuito. Requiere la PC en la red `192.168.0.x` |
| Alta | Revisar los **23 artículos con precio 0** antes de publicar | Pueden llegar a la balanza con precio cero |
| Media | **MySQL** | SQLite alcanza para una sede; varias sedes simultáneas necesitan servidor. La API es síncrona, migrar exige volver async los handlers |
| Media | **Decidir la firma del `.exe` del agente** | Sin firma, SmartScreen puede advertir en la sede; un certificado autofirmado no lo resuelve |
| Media | **Cerrar las incógnitas abiertas del protocolo** (sección 11): `D204`, bytes `[93..123]`, obligatoriedad de `D207` y las **10 unidades sin confirmar** | Son datos inferidos; requieren capturas o pruebas en hardware |
| Baja | Aislar cuál de los tres defectos del catálogo original disparaba el aborto | Se puede hacer con el CLI, sin GUI |
| Baja | Actualizar el texto de `Sedes.jsx` que todavía muestra `balanza-agent enroll ...` | La instalación ya usa la ventana de conexión; el texto quedó viejo |
| Baja | Reutilizar `.table-cards` en las demás tablas | Solo la tabla de usuarios se vuelve tarjetas; el resto sigue con scroll horizontal en móvil |
| Baja | Unificar `camelCase`/`snake_case` en las respuestas de la API | Hoy artículos es camelCase y sedes/balanzas snake_case |
| Baja | Importar/exportar `.Txp` desde la web | Hoy la carga masiva es por API |
| Baja | Paginado del lado del servidor | Con 832 artículos no hace falta; importa al crecer |

## 11. Incógnitas abiertas del protocolo

1. Semántica de la tercera trama `D204` (contiene bytes que no son BCD).
2. Bytes `[93..123]` del registro PLU.
3. Si `D204` es obligatoria y si las dos `D207` son necesarias.
4. Las 10 unidades de peso no verificadas.

## 12. Trampas encontradas (para no repetirlas)

- **PowerShell + UTF-8**: `Get-Content -Raw` lee UTF-8 sin BOM como Latin-1 y
  `Set-Content -Encoding UTF8` agrega **BOM**. Resultado: acentos rotos ("Ã³") y
  esbuild fallando con `Unexpected "�"`. Editar fuentes con la herramienta de
  escritura, no con `Set-Content`.
- **`node --test <carpeta>`** no acepta directorios en Node 22: hay que pasar los
  archivos `.test.js`.
- **`Start-Process npx`** falla en Windows (es un shim `.cmd`): usar `node` con la
  ruta al binario de Vite.
- **`npm install`** en la raíz es necesario para los workspaces (una sola vez).
- **Captura de red**: `pktmon` (nativo) + `tshark` sirve y no requiere Npcap; Npcap
  free **no** acepta instalación silenciosa. `pktmon` duplica paquetes por
  componente: deduplicar por payload.
- **El archivo `.Txp` real** tenía 4 códigos de barra duplicados que hacían que la
  balanza descartara todo sin avisar. El validador ahora lo bloquea.

## 13. Historial de verificación en hardware

| Fecha | Prueba | Resultado |
|---|---|---|
| 2026-10-26 | Descarga de 10 PLUs limpios | PLUs confirmados en la balanza |
| 2026-10-26 | Push de precios distintivos desde el CLI | Precios confirmados en la balanza |
| 2026-10-26 | Push del catálogo completo (832 PLUs) | 425 tramas, 0 reintentos, 9,7 s |
| 2026-10-26 | Agente completo (API → agente → balanza) | `last_result=ok`, y 304 en el ciclo siguiente |

## 14. Credenciales y datos sensibles

- Credenciales de desarrollo: `admin` / `admin123`. **No usar en producción.**
- En producción la clave del usuario `admin` ya se cambió. Los accesos al VPS, a la
  base y al panel de Dokploy **no se guardan en este repositorio** (es público):
  viven en el gestor de credenciales del cliente.
- El token del agente vive en `%ProgramData%\BalanzaWeb\Agent\config\agent.config.json`
  en producción (en desarrollo, `data/agent.config.json`): restringir ACL y, más
  adelante, guardarlo con DPAPI o Credential Manager.
- `data/` no debe versionarse (contiene la base y los tokens).

## 15. Producción (estado al 2026-10-27)

Desplegado en el VPS del cliente, administrado con **Dokploy** (Docker + Traefik +
Let's Encrypt). Repositorio `sebastian6253116/BalanzaWeb`, rama `main`, auto-deploy
al hacer push. La guía de configuración está en `docs/deploy.md`.

### Topología

- **Un solo contenedor** con la API y la web compilada servida por la misma
  (`WEB_DIR=/app/apps/web/dist`). Traefik termina TLS; el contenedor escucha en 8080.
- **SQLite** en el volumen `balanza-data` montado en `/app/data`.
- El contenedor corre como **uid 1000**: el volumen debe ser *named volume*, nunca
  bind mount, o la API no puede escribir.
- **Una sola réplica**: SQLite no soporta varias instancias.
- Variables: `PORT`, `DB_PATH`, `WEB_DIR`, `TRUST_PROXY=1`, `LOG_REQUESTS=1` y las
  `BOOTSTRAP_ADMIN_*` (solo sirven para crear el primer usuario con la base vacía).
- El servidor es **compartido** con otras aplicaciones del cliente y tiene ~7.8 GB de
  RAM. Se agregó **4 GB de swap** (`/swapfile`) porque el build de Node lo tumbaba.

### Base de datos de producción

- 832 artículos cargados desde `BaseDatosBalanza/PLU BALANZA FARMAVID.Txp` con
  `PUT /api/articles` (validación completa; 0 errores, 25 advertencias).
- **23 artículos tienen precio 0** en el archivo original (PAN CANILLA, INACTIVO,
  ASADO DE TIRAS X KG…): revisar antes de publicar a una balanza.
- Todavía **no hay sedes, balanzas ni agentes** creados en producción.
- La instancia MySQL que provisionó Dokploy está **sin usar** (la app es SQLite).
  Borrarla libera ~460 MB de RAM.

### Verificar que la API responde a los agentes

| Prueba | Respuesta esperada | Qué demuestra |
|---|---|---|
| `GET /healthz` | `200 {"ok":true}` | contenedor vivo |
| `GET /agent/sync` sin token | `401 agent token required` | ruta y autenticación activas |
| `POST /agent/enroll` con código falso | `404 unknown pairing code` | el enrolamiento llega a la base |
| `/agent/*` → `404 no route` | | el deploy quedó con código viejo |
| `502` / `504` | | Traefik no llega al contenedor |

La señal real de un agente sano está en la web (Sedes y balanzas → `Último resultado`
y `Última conexión`) y en el log del servicio en la sede (`docs/service.md`).

### Runbook: restaurar el rol del usuario `admin`

Si alguien lo degrada por error, dentro del contenedor:

```js
// docker exec <contenedor> node /tmp/fix-admin.mjs
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync('/app/data/balanzaweb.db');
db.prepare('DELETE FROM user_roles WHERE user_id = 1').run();
db.prepare("INSERT INTO user_roles (user_id, role_id) SELECT 1, id FROM roles WHERE key = 'admin'").run();
db.close();
```

Los permisos se resuelven por request, así que aplica sin reiniciar el servicio.

### Protecciones de administración

- El rol de la cuenta `admin` **no se puede editar** desde la web.
- Los cambios de rol de otros usuarios requieren **Guardar cambios** explícito.
- La API rechaza (`422`) quitarle el rol `admin` al último administrador, borrar tu
  propia cuenta y borrar al último administrador.
- Borrar una sede arrastra sus balanzas, agentes, publicaciones y resultados.
