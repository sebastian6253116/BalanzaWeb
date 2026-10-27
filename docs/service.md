# Agente como servicio de Windows

Documento operativo del empaquetado del agente. Última actualización: **2026-10-26**.

## 1. Qué es

El agente de BalanzaWeb corre en la PC de cada sede y mantiene las balanzas
sincronizadas con la API. En producción no se lanza a mano: se instala como el
servicio de Windows **`BalanzaWebAgent`**, con arranque automático (diferido),
log propio a archivo y parada ordenada.

La máquina de la sede **no necesita Node.js** ni ningún software del fabricante de
balanzas. El agente es un único `.exe` autocontenido.

## 2. Arquitectura

- **`balanza-agent.exe`**: binario único generado con **Node SEA** (Single
  Executable Application). Se arma con esbuild (CommonJS), se genera el blob de
  Node y se inyecta con `postject` dentro de una copia de `node.exe`.
- **`balanza-agent-service.exe`**: **WinSW v2.12.0 x64**, el envoltorio que
  registra el servicio. Es un único ejecutable que usa .NET Framework 4.8, ya
  incluido en Windows 10 y 11. Se distribuye junto al agente, nunca se instala a
  nivel de sistema.
- **Datos separados de binarios**: `C:\Program Files` contiene solo ejecutables;
  todo lo mutable vive en `%ProgramData%\BalanzaWeb\Agent`.
- **Log propio**: el agente escribe su propio log rotativo. La captura de
  WinSW queda como respaldo para errores de arranque.
- **Parada sin consola**: el comando `request-stop` escribe un archivo bandera y
  el bucle de `run` lo detecta entre ciclos. WinSW lo invoca como
  `stopexecutable` al detener el servicio.

## 3. Distribución de archivos en la sede

| Ruta | Contenido |
|---|---|
| `C:\Program Files\BalanzaWeb\Agent\balanza-agent.exe` | Agente (binario único) |
| `C:\Program Files\BalanzaWeb\Agent\balanza-agent-service.exe` | WinSW |
| `C:\Program Files\BalanzaWeb\Agent\balanza-agent-service.xml` | Configuración del servicio (generada por `install.ps1`) |
| `%ProgramData%\BalanzaWeb\Agent\config\agent.config.json` | Token, sede, revisión y hashes (solo SYSTEM y Administradores) |
| `%ProgramData%\BalanzaWeb\Agent\logs\agent.log` | Log principal del agente |
| `%ProgramData%\BalanzaWeb\Agent\logs\agent.N.log` | Logs rotados: hasta 4 archivos de 5 MB (5 en total con el activo) |
| `%ProgramData%\BalanzaWeb\Agent\logs\winsw\` | Captura de stdout/stderr del envoltorio |
| `%ProgramData%\BalanzaWeb\Agent\run\stop.flag` | Pedido de parada ordenada (transitorio) |
| `%ProgramData%\BalanzaWeb\Agent\run\agent.pid` | PID del proceso en ejecución (transitorio) |

## 4. Construcción

En una máquina de desarrollo con Node 22 y las dependencias instaladas:

```powershell
npm install

# WinSW vendeado (una sola vez; --force para volver a bajarlo)
npm run agent:winsw

# Binario único del agente
npm run agent:build
```

Resultado: `apps/agent/dist/balanza-agent.exe` (alrededor de 80 MB, porque
incluye el runtime de Node).

Para verificar el binario durante la construcción:

```powershell
node apps/agent/scripts/build-sea.mjs --smoke
```

El smoke test ejecuta `balanza-agent.exe status` con un directorio de datos
temporal y exige el mensaje `no configuration`.

> Al inyectar el blob se invalida la firma Authenticode original de `node.exe`.
> Eso es esperado y no es un error: el ejecutable final debe firmarse antes de
> distribuirlo (ver sección 10).

## 5. Instalación

Hay dos formas de instalar, según dónde esté el paquete.

### Desde el paquete de distribución (sede)

Es el camino recomendado en una sede. Extraiga el zip en una carpeta local y,
desde una consola de PowerShell **elevada** en esa carpeta:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 `
  -ApiUrl "https://balanza.ejemplo.com" `
  -PairingCode "ABCDEFGH"
```

No hace falta el repositorio: `install.ps1` resuelve el agente, WinSW y la
plantilla desde su propia carpeta.

### Desde el repositorio (desarrollo)

Desde una consola de PowerShell **elevada**, en la raíz del repositorio:

```powershell
powershell -ExecutionPolicy Bypass -File .\apps\agent\service\install.ps1 `
  -ApiUrl "https://balanza.ejemplo.com" `
  -PairingCode "ABCDEFGH"
```

Requiere haber generado antes el binario (`npm run agent:build`) y WinSW
(`npm run agent:winsw`).

Parámetros:

| Parámetro | Valor por defecto |
|---|---|
| `-InstallDir` | `C:\Program Files\BalanzaWeb\Agent` |
| `-DataDir` | `%ProgramData%\BalanzaWeb\Agent` |
| `-ApiUrl` | (opcional) URL de la API |
| `-PairingCode` | (opcional) código de emparejamiento |
| `-Quiet` | (opcional) no abre la ventana de conexión; deja el aviso en consola |

El script:

1. Detecta el layout: si está junto a los ejecutables, usa el paquete plano;
   si no, usa las rutas del repositorio. Si falta algún archivo, indica qué
   layout espera y qué comando genera cada binario.
2. Crea los directorios de binarios y de datos.
3. Copia los ejecutables y genera `balanza-agent-service.xml` a partir de la
   plantilla (WinSW busca un XML con el mismo nombre que su ejecutable).
4. Registra el servicio `BalanzaWebAgent` con WinSW.
5. Restringe el ACL de `$DataDir`: quita la herencia y deja solo **SYSTEM** y
   **Administradores** con control total. Se aplica por **SID** (`S-1-5-18` y
   `S-1-5-32-544`), no por nombre, porque `BUILTIN\Administrators` se llama
   `Administradores` en un Windows en español y `icacls` falla al resolverlo.
   Si este paso o el arranque fallan, el script desinstala el servicio solo, para
   no dejar una instalación a medias.
6. Si se pasaron `-ApiUrl` y `-PairingCode`, ejecuta `enroll` con
   `BALANZA_AGENT_HOME=$DataDir` **antes** del primer arranque. Así el servicio
   arranca ya enrolado y no queda repitiendo `FATAL not enrolled yet`.
7. Arranca el servicio y muestra su estado.

Si se instala sin código de emparejamiento, se puede enrolar después:

```powershell
$env:BALANZA_AGENT_HOME = "$env:ProgramData\BalanzaWeb\Agent"
& "C:\Program Files\BalanzaWeb\Agent\balanza-agent.exe" enroll `
  --api "https://balanza.ejemplo.com" --code "ABCDEFGH"
Remove-Item Env:BALANZA_AGENT_HOME
Restart-Service BalanzaWebAgent
```

### Ventana de primer arranque

Si `install.ps1` se ejecuta sin `-ApiUrl` y sin `-PairingCode`, al terminar abre
la ventana **BalanzaWeb - Conectar agente**. Ahí el operador pega la dirección
del servidor y el código de autorización que genera la web en **Sedes**.

- El código dura **15 minutos** y sirve **una sola vez**.
- Al conectar, el agente guarda la configuración y reinicia el servicio; después
  **no vuelve a pedir el código**.
- Si la ventana no se abre (por ejemplo, una instalación desatendida con
  `-Quiet` o una sesión sin escritorio), el servicio queda instalado pero sin
  enrolar y el log repite `FATAL not enrolled yet` cada 60 segundos.
- Para volver a abrirla (código vencido, reconectar la máquina o cambiar de
  servidor), ejecute desde la carpeta del paquete:

```powershell
powershell -ExecutionPolicy Bypass -File .\configurar-agente.ps1
```

La ventana detecta una configuración existente, muestra la sede y el agente
actuales y ofrece **Reconectar** para sobrescribirla.

### Paquete de distribución

`npm run agent:package` arma el zip que se lleva a la sede. Requiere el binario
(`npm run agent:build`) y WinSW (`npm run agent:winsw`) ya generados.

- Salida: `apps/agent/dist/balanza-agent-<version>-win-x64.zip`.
- Contenido plano (todo en la raíz del zip): `balanza-agent.exe`,
  `balanza-agent-service.exe`, `balanza-agent.xml.template`, `install.ps1`,
  `uninstall.ps1`, `smoke-test.ps1`, `configurar-agente.ps1` y `README.txt`.
- El script imprime la ruta absoluta, el tamaño en MB y el SHA-256 del zip.

Para verificar un paquete extraído sin tocar una instalación real, corra el smoke
test con los scripts de la carpeta extraída:

```powershell
powershell -ExecutionPolicy Bypass -File .\smoke-test.ps1 -InstallScript .\install.ps1
```

Instala en el sandbox `%ProgramData%\BalanzaWebSmoke`, corre los 27 checks y
limpia al terminar.

## 6. Desinstalación

Desde PowerShell elevada, en la carpeta del paquete extraído (sede) o en la raíz
del repositorio (desarrollo):

```powershell
# Sede: los scripts están junto a los ejecutables
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1

# Desarrollo: desde la raíz del repositorio
powershell -ExecutionPolicy Bypass -File .\apps\agent\service\uninstall.ps1

# Además borra %ProgramData%\BalanzaWeb\Agent (agregar -Purge al comando elegido)
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -Purge
```

Sin `-Purge`, el token y los logs se conservan para poder reinstalar sin volver a
enrolar.

## 7. Verificación

```powershell
Get-Service BalanzaWebAgent

# Log del agente (UTF-8; PowerShell 5.1 necesita -Encoding UTF8)
Get-Content -Encoding UTF8 "$env:ProgramData\BalanzaWeb\Agent\logs\agent.log" -Tail 50

# Estado desde el propio binario
& "C:\Program Files\BalanzaWeb\Agent\balanza-agent.exe" status
```

El servicio debe figurar `Running`. El log debe mostrar `agent starting` y,
cuando hay configuración, los ciclos de sincronización o `idle; next poll in Ns`.

### Smoke test automático

Hay una prueba end-to-end que instala en un sandbox (`%ProgramData%\BalanzaWebSmoke`),
verifica registro, arranque, log, ACL, supervivencia a fallos de red, parada
ordenada, reinicio y desinstalación, y **no toca una instalación real** (aborta si
encuentra un servicio cuyo binario no esté dentro del sandbox).

```powershell
# Desde PowerShell elevada
npm run agent:smoke

# Dejar el sandbox instalado para inspeccionarlo a mano
powershell -ExecutionPolicy Bypass -File .\apps\agent\service\smoke-test.ps1 -Keep
```

Termina con `RESULT: ALL CHECKS PASSED` o el detalle de los checks fallidos, y deja
la transcripción completa en `%TEMP%\balanzaweb-service-smoke.log`.

### Prueba de emparejamiento (código web → agente → retroalimentación)

`npm run e2e:pairing` levanta la API sobre una copia descartable de la base, genera un
código de emparejamiento como lo hace la web, enrola el **binario empaquetado** con ese
código y verifica el ciclo completo contra una balanza simulada (UDP que ACKea como la
RLS1000):

- el código es de un solo uso (el segundo intento devuelve 409);
- el push de 832 artículos se reporta a la API y queda en `deployment_results` como
  `ok=1` con la cantidad de registros;
- el agente aparece enrolado en el estado de la sede y la balanza queda en `ok`;
- el segundo ciclo responde 304 y **no envía ni un datagrama**;
- si se agrega una balanza inalcanzable, el fallo se reporta (`ok=0` con el error) y la
  revisión **no avanza**; al quitarla, el reintento converge.

La balanza simulada es un socket UDP local: esta prueba no reemplaza la verificación
contra hardware real, que sigue pendiente de una máquina en la red `192.168.0.x`.

## 8. Parada ordenada

WinSW detiene el servicio ejecutando:

```
balanza-agent.exe request-stop
```

Ese comando escribe `run\stop.flag` y termina con código 0. El proceso `run`:

- revisa la bandera cada segundo, **entre ciclos**, nunca en medio de un push;
- al verla, registra `stop requested — finishing current cycle`, termina el ciclo
  actual, borra la bandera y el PID, y registra `agent stopped`;
- WinSW espera hasta **30 segundos** (`stoptimeout`). Si el agente no termina, lo
  fuerza.

Ante una caída inesperada, WinSW reinicia el servicio a los 10 segundos
(`onfailure`) y resetea el contador de fallas luego de una hora (`resetfailure`).
Si falta la configuración, el agente **no entra en crash-loop**: registra una
línea `FATAL not enrolled yet`, sigue vivo y reintenta.

## 9. ACL y token

`agent.config.json` contiene el token del agente. Por eso:

- el directorio de datos se crea con herencia deshabilitada;
- solo **SYSTEM** y **Administradores** tienen acceso;
- un usuario normal de la sede no puede leer el token;
- el agente nunca escribe el token en el log.

No se usa DPAPI ni Credential Manager todavía; el archivo restringido por ACL es
la protección actual. Si se necesita un nivel más alto, el siguiente paso es
cifrar el token con DPAPI en modo máquina.

## 10. Diagnóstico

**El servicio no arranca.**

- Revisar `%ProgramData%\BalanzaWeb\Agent\logs\winsw\` y `logs\agent.log`.
- Confirmar que `balanza-agent-service.xml` apunte a rutas existentes.
- Confirmar que .NET Framework 4.8 esté presente (`Get-ItemProperty
  'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full'`).
- Probar el binario a mano:
  `& "C:\Program Files\BalanzaWeb\Agent\balanza-agent.exe" status`.

**Error 1053: "El servicio no respondió a la solicitud de inicio o control de
manera oportuna".**

Windows canceló el arranque o la parada porque el servicio no respondió dentro
del tiempo. Causas habituales:

- rutas incorrectas en el XML (ejecutable o directorio de trabajo);
- el ejecutable está bloqueado o dañado;
- falta .NET Framework 4.8;
- el ACL impide que la cuenta del servicio lea sus archivos;
- un `request-stop` viejo que no se pudo escribir.

**El agente arranca pero no sincroniza.**

- `status` debe mostrar la API, la sede y la revisión.
- Si dice `no configuration`, falta enrolar.
- Si el log repite `sync error`, revisar conectividad con la API y el token.

**Hay que volver a enrolar.**

```powershell
$env:BALANZA_AGENT_HOME = "$env:ProgramData\BalanzaWeb\Agent"
& "C:\Program Files\BalanzaWeb\Agent\balanza-agent.exe" enroll --api <url> --code <codigo>
Remove-Item Env:BALANZA_AGENT_HOME
Restart-Service BalanzaWebAgent
```

**Los acentos del log se ven mal en PowerShell.**

El log está en UTF-8 sin BOM. En PowerShell 5.1 hay que leerlo con
`Get-Content -Encoding UTF8`; de lo contrario interpreta los bytes como ANSI.

## 11. Fuera de alcance (por ahora)

- **Firma de código (Authenticode)** del ejecutable final: el build avisa que la
  firma de `node.exe` queda inválida, pero no firma el resultado.
- **Auto-actualización** del agente en la sede. Hoy se reinstala con
  `install.ps1`.
- **Cuenta de servicio dedicada**: el servicio corre como `LocalSystem` (valor
  por defecto de WinSW).
- **Rotación centralizada de logs** o envío de logs a un colector remoto.
