# Instalación del agente en una sede

Guía operativa: instalar el agente de BalanzaWeb en la PC de una sede, desde cero
hasta el servicio corriendo y enrolado. Última actualización: **2026-10-27**.

## 1. Qué es y qué instala

El agente es un servicio de Windows que corre en la PC de la sede y mantiene las
balanzas sincronizadas con la API de BalanzaWeb. Se instala una sola vez: después
arranca solo con Windows y no vuelve a pedir el código de autorización.

| Dato | Valor |
|---|---|
| Nombre del servicio | `BalanzaWebAgent` (nombre visible: `BalanzaWeb Agent`) |
| Binarios | `C:\Program Files\BalanzaWeb\Agent` |
| Datos (config, logs, estado) | `%ProgramData%\BalanzaWeb\Agent` |
| Configuración y token | `%ProgramData%\BalanzaWeb\Agent\config\agent.config.json` |
| Log del agente | `%ProgramData%\BalanzaWeb\Agent\logs\agent.log` |
| Log del envoltorio WinSW | `%ProgramData%\BalanzaWeb\Agent\logs\winsw\` |

`%ProgramData%` normalmente es `C:\ProgramData`.

## 2. Requisitos

- **Windows 10 versión 1903 o superior, o Windows 11, 64 bits.**
- **Permisos de administrador** en la PC (se registra un servicio del sistema).
- **.NET Framework 4.8**, incluido en Windows 10 y 11. Es lo que usa el envoltorio
  del servicio (WinSW); no hay que instalarlo aparte.
- **Red hacia la API**: salida por **HTTPS (443)** a `balanza.farmavid.com.ve`.
- **Red hacia las balanzas**: **UDP puerto 5001** contra la IP de cada balanza,
  dentro de la **red local de la sede**. Es tráfico LAN: no sale a Internet y no
  se publica en el router.
- **No se necesita Node.js** en la sede, ni el software del fabricante de balanzas.
  El agente es un único `.exe` autocontenido.

Si la PC no tiene salida a Internet por 443 o está en una red distinta de la de las
balanzas, la instalación va a terminar pero el agente no va a sincronizar.

## 3. Paso 0 — generar el código en la web

El código de autorización se genera en la web, **antes** de instalar. Necesita un
usuario con el permiso `agents.manage` (el botón queda deshabilitado sin él).

1. Entrar a `https://balanza.farmavid.com.ve` e iniciar sesión.
2. En el menú lateral, abrir **Sedes y balanzas**.
3. En la tabla, hacer clic sobre la fila de la sede que se está instalando. La fila
   queda resaltada y aparece el detalle de esa sede.
4. Bajar hasta el panel **Código de autorización del microservicio**, con el texto
   "Se usa una sola vez, al instalar el agente en la sede. Vence en 15 minutos."
5. Presionar **Generar código**.
6. El código aparece en el mismo panel, en un recuadro azul, con este formato:

   ```
   Código: 7KQ4M2XP
   Vence: 27/10/2026, 15:42:10
   En la PC de la sede: balanza-agent enroll --api <url> --code 7KQ4M2XP
   ```

   Son **8 caracteres** en mayúsculas, sin `0`, `O`, `1` ni `I` (para que no se
   confundan al tipearlos). No es una ventana modal: queda en el panel hasta que se
   genera otro código o se cambia de sede.

> **El código dura 15 minutos y sirve una sola vez.** Generelo inmediatamente antes
> de instalar, con la PC de la sede ya preparada. Si se vence o ya se usó, hay que
> generar uno nuevo: no se puede reutilizar.

## 4. Paso 1 — llevar el paquete a la PC

El paquete es un único archivo:

```
balanza-agent-1.0.0-win-x64.zip
```

**Verificación de integridad.** El zip se entrega junto con su SHA-256, que es el
valor que imprime `npm run agent:package` al generarlo (línea `sha256: ...`). En la
PC de la sede, en la carpeta donde está el zip:

```powershell
Get-FileHash .\balanza-agent-1.0.0-win-x64.zip -Algorithm SHA256
```

El campo `Hash` tiene que coincidir **exactamente** con el valor de referencia. Si
no coincide, el archivo llegó incompleto o fue alterado: no lo instale y pida el
paquete de nuevo.

> El hash cambia cada vez que se regenera el zip, aunque la versión sea la misma.
> El valor de referencia siempre es el que imprimió el empaquetado de ese archivo,
> no un valor fijo de esta guía.

**El ejecutable no está firmado.** Por eso:

- **Entregue el zip por USB o por la red interna.** Un archivo copiado así no lleva
  la marca de origen de Internet (*Mark-of-the-Web*) y SmartScreen no lo bloquea.
- Si el archivo se **descarga** (correo, navegador, almacenamiento en la nube),
  Windows le agrega esa marca. Al descomprimir y ejecutar `install.ps1`, el operador
  puede ver el aviso **"Windows protegió su PC"** con el botón **"Más información"**
  y después **"Ejecutar de todas formas"**. Antes de continuar, verifique el SHA-256:
  el aviso es esperado por falta de firma, no significa que el archivo esté dañado.
- Si el zip descargado quedó bloqueado y el script no arranca, desbloquéelo:

  ```powershell
  Unblock-File .\balanza-agent-1.0.0-win-x64.zip
  ```

## 5. Paso 2 — instalar el servicio

1. Descomprima el zip en una carpeta local, por ejemplo `C:\Instaladores\`. Windows
   crea la carpeta `balanza-agent-1.0.0-win-x64` con todo el contenido plano:

   ```
   balanza-agent.exe
   balanza-agent-service.exe
   balanza-agent.xml.template
   install.ps1
   uninstall.ps1
   configurar-agente.ps1
   smoke-test.ps1
   README.txt
   ```

2. Abra **PowerShell como administrador**:
   - Menú Inicio → escribir `PowerShell` → clic derecho sobre **Windows PowerShell**
     → **Ejecutar como administrador**.
   - En Windows 11 puede ser **Terminal** → **Ejecutar como administrador**.
   - Confirmar el control de cuentas de usuario.

3. Ubíquese en la carpeta extraída (ajuste la ruta a la suya):

   ```powershell
   Set-Location "C:\Instaladores\balanza-agent-1.0.0-win-x64"
   ```

4. Confirme que están los archivos antes de ejecutar:

   ```powershell
   Get-ChildItem
   ```

5. Ejecute el instalador **sin** `-ApiUrl` ni `-PairingCode`. Así, al terminar, abre
   la ventana para conectar el agente:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```

Salida esperada, en este orden:

```
Creating directories...
Copying binaries...
Rendering the service configuration...
Installing the Windows service...
Restricting access to the data directory...
Starting the service...

Name             Status  StartType
----             ------  ---------
BalanzaWebAgent  Running Automatic

Opening the connection window...

Service installed.
  binaries:  C:\Program Files\BalanzaWeb\Agent
  data:      C:\ProgramData\BalanzaWeb\Agent
  agent log: C:\ProgramData\BalanzaWeb\Agent\logs\agent.log
  WinSW log: C:\ProgramData\BalanzaWeb\Agent\logs\winsw

Verify with:
  Get-Service BalanzaWebAgent
  Get-Content -Path 'C:\ProgramData\BalanzaWeb\Agent\logs\agent.log' -Tail 50
```

Qué hace el script, en orden: crea los directorios, copia los binarios, genera
`balanza-agent-service.xml` desde la plantilla, registra el servicio, restringe el
ACL de la carpeta de datos (solo **SYSTEM** y **Administradores**), arranca el
servicio y, si no se pasaron URL y código, abre la ventana de conexión.

Si algo falla **después** de registrar el servicio (ACL, enrolamiento o arranque),
el script desinstala el servicio solo y corta con el error, para no dejar una
instalación a medias. En ese caso los binarios copiados quedan en su lugar y hay
que volver a ejecutar `install.ps1` después de corregir la causa.

> Si la consola **no** está elevada, el script corta de entrada porque declara
> `#Requires -RunAsAdministrator`. Si el servicio `BalanzaWebAgent` ya existe,
> corta con: `The service BalanzaWebAgent already exists. Run uninstall.ps1 first.`

## 6. Paso 3 — conectar el agente (ventana)

Al terminar la instalación se abre la ventana **BalanzaWeb - Conectar agente**.

- Texto de ayuda: "El código se genera en la web, en la sección Sedes. Dura 15
  minutos y se puede usar una sola vez."
- Campo **Dirección del servidor**: escriba exactamente

  ```
  https://balanza.farmavid.com.ve
  ```

  **Sin `/api`.** El agente arma solo las rutas `/agent/enroll`, `/agent/sync` y
  `/agent/report` sobre esa base; si se agrega `/api`, el servidor responde 404. Una
  barra final se descarta sola, así que no rompe nada, pero conviene no escribirla.

- Campo **Código de autorización**: pegue el código de 8 caracteres del Paso 0. El
  campo convierte todo a mayúsculas automáticamente.
- Presione **Conectar**.

Mensajes posibles:

| Mensaje en la ventana | Significado |
|---|---|
| `Conectando...` | Está llamando al servidor. |
| `Conectado a la sede "NOMBRE"` (verde) | Listo. El botón pasa a **Listo** y el servicio se reinicia solo para tomar el token nuevo. |
| `Ingresá una dirección válida que empiece con http:// o https://.` | La URL está vacía, no empieza con `http://`/`https://` o no tiene host. |
| `Ingresá el código de autorización.` | El campo del código está vacío. |
| `Ese código ya fue usado. Generá uno nuevo en la web.` | El código ya se canjeó (por ejemplo, en un intento anterior). |
| `El código venció. Generá uno nuevo en la web (dura 15 minutos).` | Pasaron más de 15 minutos desde que se generó. |
| `El código no existe. Verificá que sea el de esta sede.` | El código no está en la base: error de tipeo o de sede. |
| `No se pudo conectar con el servidor. Revisá la dirección y que esta PC tenga acceso a la red.` | No hay ruta, DNS o el servidor no responde. |
| `No se pudo conectar: <detalle>` | Cualquier otro error del servidor, con el texto crudo de la API. |

Después del mensaje verde, cierre la ventana con **Cerrar** (o con **Listo**). La
ventana no se cierra sola.

> La ventana necesita una sesión de escritorio interactiva. Si se ejecuta desde una
> tarea programada o una sesión sin escritorio, el script no la abre y muestra en
> consola las instrucciones para enrolar a mano. El camino equivalente es instalar
> con `-ApiUrl` y `-PairingCode` (sección 9).

## 7. Paso 4 — verificar

Todo desde PowerShell **elevado**.

**1. El servicio existe y está corriendo:**

```powershell
Get-Service BalanzaWebAgent | Select-Object Name, Status, StartType
```

Esperado: `Status : Running` y `StartType : Automatic`.

**2. El arranque es automático y diferido:**

```powershell
Get-Content "C:\Program Files\BalanzaWeb\Agent\balanza-agent-service.xml"
```

Esperado, entre otras líneas: `<startmode>Automatic</startmode>` y
`<delayedAutoStart>true</delayedAutoStart>`.

**3. El log del agente:**

```powershell
Get-Content -Encoding UTF8 "$env:ProgramData\BalanzaWeb\Agent\logs\agent.log" -Tail 50
```

Esperado: una línea `agent starting` y después, según si ya hay una publicación
para esa sede:

- `revision N has X articles and Y scales - nothing to push`, o
- `no changes (304) - nothing to do` seguido de `idle; next poll in Ns`, o
- líneas `scale NOMBRE (IP:PUERTO): X records in N ms`.

No debe aparecer `FATAL not enrolled yet`.

**4. Estado desde el propio binario:**

```powershell
& "C:\Program Files\BalanzaWeb\Agent\balanza-agent.exe" status
```

Esperado:

```
config:        C:\ProgramData\BalanzaWeb\Agent\config\agent.config.json
log dir:       C:\ProgramData\BalanzaWeb\Agent\logs
api:           https://balanza.farmavid.com.ve
sede:          NOMBRE (id N)
agent:         N
poll interval: 60s
revision:      0
last sync:     2026-10-27T15:40:12.000Z
scales known:  0
```

`revision: 0` y `scales known: 0` son normales en una sede recién creada, sin
publicaciones todavía.

**5. La PC llega a la API:**

```powershell
(Invoke-WebRequest https://balanza.farmavid.com.ve/healthz -UseBasicParsing).StatusCode
```

Esperado: `200`. El cuerpo de esa ruta es `{"ok":true,"uptimeSeconds":N}`.

**6. La web muestra la sede conectada:** en **Estado**, panel **Agentes de la
sede**, aparece una línea con el identificador de la máquina y la etiqueta verde
**activo**, con un **último contacto** de hace segundos o minutos. En **Sedes y
balanzas**, el **Último resultado** de cada balanza pasa a `ok` cuando hay una
publicación y el push funciona.

## 8. Qué pasa después

- El token queda guardado en `agent.config.json`. Solo **SYSTEM** y
  **Administradores** pueden leer esa carpeta; el agente nunca escribe el token en
  el log.
- El servicio arranca solo con Windows, en modo **automático diferido**
  (`delayedAutoStart`), para no competir con el arranque del sistema.
- **Nunca vuelve a pedir el código.** El código de 8 caracteres sirve una sola vez,
  al enrolar; de ahí en adelante se usa el token.
- Sobrevive a reinicios de la PC y a redespliegues del servidor: el token está en la
  base del servidor (guardado como hash), que vive en el volumen persistente.
- Si el agente no puede sincronizar, no se cae: registra `sync error: ... - retrying
  in Ns` y reintenta en el ciclo siguiente. WinSW además lo reinicia a los 10
  segundos si el proceso muere.

## 9. Instalación desatendida

Si ya se tiene la URL y el código a mano (por ejemplo, un técnico que prepara la PC
antes de ir a la sede), se pasa todo por parámetro y el instalador no abre ninguna
ventana. El enrolamiento se hace **antes** del primer arranque, así el servicio
nunca llega a registrar `FATAL not enrolled yet`.

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 `
  -ApiUrl "https://balanza.farmavid.com.ve" `
  -PairingCode "7KQ4M2XP" `
  -Quiet
```

Salida esperada: las mismas líneas del Paso 2 más `Enrolling the agent...`, y **sin**
`Opening the connection window...`.

Parámetros del instalador:

| Parámetro | Valor por defecto | Para qué |
|---|---|---|
| `-InstallDir` | `C:\Program Files\BalanzaWeb\Agent` | Dónde copiar los binarios. |
| `-DataDir` | `%ProgramData%\BalanzaWeb\Agent` | Dónde viven config, logs y estado. |
| `-ApiUrl` | (vacío) | URL de la API. Se usa junto con `-PairingCode`. |
| `-PairingCode` | (vacío) | Código de 8 caracteres. Se usa junto con `-ApiUrl`. |
| `-Quiet` | (apagado) | No abre la ventana de conexión. |

`-ApiUrl` y `-PairingCode` van juntos: si se pasa solo uno, el script avisa
`Both -ApiUrl and -PairingCode are required to enroll. Skipping enrollment.` y deja
el agente sin enrolar.

## 10. Reconectar / cambiar de servidor

Para volver a enrolar la misma PC (código vencido antes de terminar, token revocado,
o cambio de servidor), no hace falta desinstalar. Desde la carpeta del paquete, en
PowerShell **elevado** (lo necesita para reiniciar el servicio):

```powershell
powershell -ExecutionPolicy Bypass -File .\configurar-agente.ps1
```

- Si ya hay configuración, la ventana muestra arriba
  `Ya conectado a la sede "NOMBRE" (agente N)` y el botón principal dice
  **Reconectar** en lugar de **Conectar**.
- Se ingresan la URL y el código nuevos y se presiona **Reconectar**. Al confirmar,
  `agent.config.json` se **sobrescribe completo** con la configuración nueva.
- El servicio se reinicia solo. Si la consola no está elevada, el agente queda
  enrolado pero aparece el aviso `El agente quedó enrolado, pero no se pudo
  reiniciar el servicio: ...`; en ese caso reinicie a mano:

  ```powershell
  Restart-Service BalanzaWebAgent
  ```

Consecuencias de reconectar:

- La revisión local vuelve a **0** y se borran los hashes por balanza, así que en el
  ciclo siguiente el agente **reenvía el catálogo completo** a todas las balanzas,
  aunque el contenido no haya cambiado.
- En el servidor se crea un **agente nuevo**; el anterior queda en la base con su
  último contacto viejo. La web puede mostrar dos entradas en **Agentes de la sede**;
  la activa es la de último contacto reciente.

## 11. Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| El log repite `FATAL not enrolled yet - run "balanza-agent enroll ..."; waiting` | El servicio corre sin `agent.config.json`: se instaló sin código y la ventana no se completó. | Ejecutar `configurar-agente.ps1` (sección 10) o enrolar a mano (sección 9). |
| La ventana dice `El código venció. Generá uno nuevo en la web (dura 15 minutos).` | Pasaron más de 15 minutos desde que se generó. | Generar un código nuevo en **Sedes y balanzas** y reintentar. |
| La ventana dice `Ese código ya fue usado. Generá uno nuevo en la web.` | El código ya se canjeó una vez. | Generar un código nuevo. |
| La ventana dice `El código no existe. Verificá que sea el de esta sede.` | Código mal tipeado o de otra instalación. | Revisar los 8 caracteres y volver a generarlo. |
| La ventana dice `No se pudo conectar: no route for POST /api/agent/enroll` | Se escribió la URL con `/api` al final. | Usar `https://balanza.farmavid.com.ve`, sin `/api` ni barra final. |
| La ventana dice `No se pudo conectar con el servidor. Revisá la dirección y que esta PC tenga acceso a la red.` | Sin DNS, sin ruta a Internet, firewall o proxy bloqueando 443. | Probar `(Invoke-WebRequest https://balanza.farmavid.com.ve/healthz -UseBasicParsing).StatusCode`; si no da 200, resolver la red antes de reinstalar. |
| El log repite `sync error: sync failed: HTTP 401` | El servidor no reconoce el token: base restaurada desde un backup anterior, sede recreada, u otro servidor. | Reconectar con un código nuevo (sección 10). |
| El log repite `sync error: sync failed: HTTP 403` | El token del agente fue revocado en el servidor. | Reconectar con un código nuevo (sección 10). |
| El log repite `sync error: sync failed: HTTP 404` | URL apuntando a una ruta inexistente (por ejemplo con `/api`) o sede borrada. | Corregir la URL reconectando; si la sede se borró, recrearla y generar un código. |
| `configurar-agente.ps1` muestra `No hay una sesión interactiva: no se puede abrir la ventana de conexión.` | Se ejecutó desde una tarea programada o una sesión sin escritorio. | Enrolar a mano con `enroll` (sección 9) o ejecutarlo con una sesión abierta. |
| `install.ps1` corta con `The service BalanzaWebAgent already exists. Run uninstall.ps1 first.` | Se instaló dos veces sin desinstalar. | Ejecutar `uninstall.ps1` **sin** `-Purge` y volver a instalar. |
| El servicio no arranca (error 1053 o `Stopped` apenas se inicia) | Falta .NET Framework 4.8, rutas del XML inválidas, o el ejecutable está bloqueado/dañado. | Revisar `%ProgramData%\BalanzaWeb\Agent\logs\winsw\`, el XML, y probar `balanza-agent.exe status` a mano. |
| El servicio corre pero el log muestra `FAILED - hello: no acknowledgement after 3 attempt(s)` | La balanza no responde: IP o puerto mal cargados, firewall, o la PC no está en la red local de la balanza. | Verificar `IP:PUERTO` en **Sedes y balanzas** (UDP **5001**), que la PC esté en la misma LAN y que nada bloquee el UDP saliente hacia la balanza. |
| Aparece `El agente quedó enrolado, pero no se pudo reiniciar el servicio: ...` | La ventana se ejecutó sin permisos de administrador. | Abrir PowerShell como administrador y ejecutar `Restart-Service BalanzaWebAgent`. |

## 12. Actualizar el agente a una versión nueva

El token vive en `%ProgramData%`, no en la carpeta de binarios. Por eso una
actualización **no vuelve a pedir código**: se desinstala conservando los datos y se
instala la versión nueva.

Orden correcto:

1. Desinstalar **sin** `-Purge` (desde la carpeta del paquete viejo, PowerShell
   elevado):

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
   ```

   Esto detiene y elimina el servicio y borra los binarios, pero **conserva**
   `%ProgramData%\BalanzaWeb\Agent` (config con el token, logs y estado). La consola
   lo confirma con `Data directory kept at ... (use -Purge to delete it).`

2. Descomprimir el zip nuevo y ejecutar el instalador desde esa carpeta:

   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```

3. Verificar con los pasos de la sección 7. El log debe mostrar `agent starting` y
   los ciclos de sincronización, **sin** pasar por la ventana de conexión.

> El instalador detecta la configuración existente e imprime
> `Existing configuration found: the agent stays enrolled, no window needed.` No abre
> la ventana y **no** hay que volver a generar un código: el token sigue en
> `%ProgramData%`. Si por algún motivo ese archivo no existe, el instalador sí abre la
> ventana (o avisa que quedó sin enrolar, con `-Quiet`).

Para cambiar de servidor además de actualizar, después del paso 2 ejecutar
`configurar-agente.ps1` (sección 10).

## 13. Desinstalar

Desde la carpeta del paquete descomprimido, en PowerShell **elevado**. No hace
falta el código de emparejamiento ni conexión a la API: la desinstalación es
local.

### 13.1 Conservando los datos (reinstalar sin volver a enrolar)

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
```

Qué hace:

- Detiene el servicio `BalanzaWebAgent` y lo elimina del registro de servicios.
- Borra de `C:\Program Files\BalanzaWeb\Agent` los archivos
  `balanza-agent.exe`, `balanza-agent-service.exe` y
  `balanza-agent-service.xml`, y la carpeta si queda vacía.
- **Conserva** `%ProgramData%\BalanzaWeb\Agent` completo: configuración con el
  token, logs y estado de sincronización.

Verificar que quedó limpio:

```powershell
Get-Service BalanzaWebAgent -ErrorAction SilentlyContinue
Test-Path 'C:\Program Files\BalanzaWeb\Agent'
Test-Path (Join-Path $env:ProgramData 'BalanzaWeb\Agent\config\agent.config.json')
```

Los dos primeros deben devolver `False`. El tercero debe devolver `True`: el
token sigue ahí, y por eso al reinstalar el agente arranca ya conectado, sin
pedir código.

### 13.2 Borrando todo (la PC queda como si nunca se hubiera instalado)

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -Purge
```

Hace lo mismo que 13.1 y además elimina `%ProgramData%\BalanzaWeb\Agent`
completo. Se pierde el token, así que para volver a instalar hay que generar un
código nuevo en la web (sección 3).

```powershell
Test-Path (Join-Path $env:ProgramData 'BalanzaWeb\Agent')
```

Debe devolver `False`.

### 13.3 Instalación en rutas no estándar

Si en la instalación se usaron `-InstallDir` o `-DataDir` distintos de los
predeterminados, hay que repetirlos en la desinstalación, o el script no
encontrará nada:

```powershell
powershell -ExecutionPolicy Bypass -File .\uninstall.ps1 -InstallDir 'D:\Apps\BalanzaWeb\Agent' -DataDir 'D:\Datos\BalanzaWeb\Agent' -Purge
```

### 13.4 Qué queda del lado del servidor

La desinstalación es **local**: no avisa a la API. Consecuencias, en orden de
importancia:

- La sede sigue existiendo en la web, con el agente que estuvo instalado en esa
  PC en su historial. Su `last_seen_at` deja de actualizarse y el agente se ve
  como inactivo, pero **no se borra solo**.
- El token del agente **sigue siendo válido en la base** aunque la PC ya no lo
  tenga. Si alguien conserva una copia del `agent.config.json` (por ejemplo, un
  respaldo anterior a `-Purge`), ese token todavía puede leer y reportar para esa
  sede. Hoy no hay botón en la web para revocar un agente: si se desinstala una
  PC que va a salir de circulación, lo correcto es borrar la sede (si ya no se
  usa) o ponerse en contacto con quien administra la base.
- Volver a enrolar la misma PC genera un **agente nuevo** en la web; el anterior
  queda en el historial. Es esperado: no hay reutilización de tokens.

### 13.5 Si el servicio queda huérfano

Si el registro del servicio está corrupto o `uninstall.ps1` no encuentra el
wrapper, el script lo intenta borrar con `sc.exe delete BalanzaWebAgent`
automáticamente. Si ni eso funciona, verificar el estado real antes de
reinstalar:

```powershell
sc.exe query BalanzaWebAgent
Get-Process balanza-agent -ErrorAction SilentlyContinue
```

`install.ps1` **se niega a instalar si el servicio ya existe** (`The service BalanzaWebAgent already exists. Run uninstall.ps1 first.`). Por eso, ante cualquier reinstalación, el orden es siempre: desinstalar primero, instalar después.

## 14. Checklist final

Marcar en la PC de la sede, con la consola elevada abierta:

- [ ] El zip se verificó con `Get-FileHash` y el SHA-256 coincide.
- [ ] El paquete se descomprimió y los 8 archivos están en la carpeta.
- [ ] `install.ps1` terminó con `Service installed.`
- [ ] La ventana **BalanzaWeb - Conectar agente** mostró `Conectado a la sede "..."` en verde.
- [ ] `Get-Service BalanzaWebAgent` devuelve `Running` y `Automatic`.
- [ ] El XML del servicio tiene `<delayedAutoStart>true</delayedAutoStart>`.
- [ ] El log no tiene `FATAL not enrolled yet`.
- [ ] `balanza-agent.exe status` muestra la API y el nombre de la sede.
- [ ] `https://balanza.farmavid.com.ve/healthz` devuelve `200` desde esa PC.
- [ ] En la web, **Estado → Agentes de la sede** muestra el agente **activo** con contacto reciente.

## 15. Para el administrador

Todo esto se ejecuta en una máquina de desarrollo con Node 22 y `npm install` hecho,
no en la sede.

```powershell
# 1. WinSW vendeado (una sola vez; --force para volver a bajarlo)
npm run agent:winsw

# 2. Binario único del agente -> apps/agent/dist/balanza-agent.exe
npm run agent:build

# 3. Zip para la sede + ruta, tamaño y SHA-256
npm run agent:package
```

`npm run agent:package` imprime al final:

```
package: ...\apps\agent\dist\package\balanza-agent-1.0.0-win-x64
zip:     ...\apps\agent\dist\balanza-agent-1.0.0-win-x64.zip
size:    N MB
sha256:  <hash que se entrega con el zip>
```

Ese `sha256` es el valor de referencia del Paso 1.

**Prueba de punta a punta del servicio.** Requiere una consola **elevada** (declara
`#Requires -RunAsAdministrator`), instala en el sandbox `%ProgramData%\BalanzaWebSmoke`
—nunca en `Program Files`— y valida: registro del servicio, tipo de arranque
automático, arranque, copia de binarios, XML sin placeholders, log del agente,
`agent starting`, espera con `not enrolled yet` cuando falta config, ACL de la
carpeta de datos (sin `Users`, con `SYSTEM` y `Administradores`, herencia
deshabilitada), recarga de config y polling, supervivencia a fallos de sincronización,
parada ordenada dentro de los 30 s, reinicio limpio y desinstalación con `-Purge`.

```powershell
npm run agent:smoke
```

Termina con `RESULT: ALL CHECKS PASSED` o el detalle de los checks fallidos, y deja
la transcripción en `%TEMP%\balanzaweb-service-smoke.log`. Aborta si encuentra un
servicio real fuera del sandbox, así que no toca una instalación de producción.

Para validar un paquete ya extraído, en lugar del código del repositorio:

```powershell
powershell -ExecutionPolicy Bypass -File .\smoke-test.ps1 -InstallScript .\install.ps1
```

La prueba de emparejamiento completo (código web → agente empaquetado → balanza
simulada por UDP) está disponible con:

```powershell
npm run e2e:pairing
```

---

Documentos relacionados: [`service.md`](service.md) (empaquetado, arquitectura y
diagnóstico del servicio), [`PROJECT.md`](PROJECT.md) (estado del proyecto),
[`protocol.md`](protocol.md) (protocolo RLS1000).
