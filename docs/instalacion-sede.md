# Instalación del agente en una sede

Guía operativa: instalar el agente de BalanzaWeb en la PC de una sede, desde cero
hasta el servicio corriendo y enrolado. Última actualización: **2026-11-02**.

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

El paquete se descarga de la página de releases del repositorio o lo entrega quien
administra el sistema. Cómo se genera y publica una versión nueva está en
[`agent-release.md`](agent-release.md).

- Página de releases:
  <https://github.com/sebastian6253116/BalanzaWeb/releases>
- Release de la versión 1.0.2:
  <https://github.com/sebastian6253116/BalanzaWeb/releases/tag/agent-v1.0.2>
- Descarga directa del paquete:
  <https://github.com/sebastian6253116/BalanzaWeb/releases/download/agent-v1.0.2/balanza-agent-1.0.2-win-x64.zip>

Para 1.0.2 el paquete es un único archivo de 40,87 MB:

```
balanza-agent-1.0.2-win-x64.zip
```

Su SHA-256 de referencia es:

```
1c9f615e130cb30a528e8a7446388b0868993dedb59a900e4ef6e52ca8892465
```

**Verificación de integridad.** El zip se entrega junto con su SHA-256, que es el
valor que imprime `npm run agent:package` al generarlo (línea `sha256: ...`). En la
PC de la sede, en la carpeta donde está el zip:

```powershell
Get-FileHash .\balanza-agent-1.0.2-win-x64.zip -Algorithm SHA256
```

El campo `Hash` tiene que coincidir con el valor de referencia. El valor hexadecimal
es el mismo en mayúsculas o minúsculas. Si no coincide, el archivo llegó incompleto o
fue alterado: no lo instale y pida el paquete de nuevo.

> El hash de arriba es el del zip 1.0.2 publicado. Si se regenera el zip, aunque la
> versión sea la misma, el hash cambia: hay que usar el que imprimió
> `npm run agent:package` y quedó anotado en la release.

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
  Unblock-File .\balanza-agent-1.0.2-win-x64.zip
  ```

## 5. Paso 2 — instalar el servicio

1. Descomprima el zip en una carpeta local, por ejemplo `C:\Instaladores\`. Windows
   crea la carpeta `balanza-agent-1.0.2-win-x64` con todo el contenido plano:

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
   Set-Location "C:\Instaladores\balanza-agent-1.0.2-win-x64"
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
scales waiting: 0
```

`revision: 0` y `scales known: 0` son normales en una sede recién creada, sin
publicaciones todavía.

La línea `scales waiting` y el backoff por balanza (reintentos a 60 s, 120 s,
240 s… hasta 15 minutos) son comportamiento de la **1.0.3**. La última versión
publicada es la **1.0.2**; la 1.0.3 ya está en el repositorio pero todavía no está
empaquetada ni publicada. Una instalación 1.0.2 simplemente omite esa línea y
reintenta cada balanza en cada ciclo, sin espera entre intentos.

**5. Versión instalada:**

```powershell
& "C:\Program Files\BalanzaWeb\Agent\balanza-agent.exe" version
```

Esperado: `balanza-agent` seguido de la versión del paquete que se instaló:
`balanza-agent 1.0.2` si se instaló el zip 1.0.2. La última versión publicada es
la **1.0.2**; la 1.0.3 ya está en el repositorio pero todavía no está empaquetada
ni publicada. La versión que imprima el comando tiene que coincidir con el
paquete que se instaló en esa PC, no con otra. Si alguna vez hay que soportar esa
PC, este es el dato que hay que pedir: no hay otra forma de saber qué versión
corre una vez instalada.

**6. La PC llega a la API:**

```powershell
(Invoke-WebRequest https://balanza.farmavid.com.ve/healthz -UseBasicParsing).StatusCode
```

Esperado: `200`. El cuerpo de esa ruta es `{"ok":true,"uptimeSeconds":N}`.

**7. La web muestra la sede conectada:** en **Estado**, panel **Agentes de la
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
| Las etiquetas salen con una fecha equivocada | La balanza perdió el reloj (corte de energía) y no recibe un `hello` desde entonces. | Corregir el reloj de la sede con `once --force` (sección 11.2). |
| Aparece `El agente quedó enrolado, pero no se pudo reiniciar el servicio: ...` | La ventana se ejecutó sin permisos de administrador. | Abrir PowerShell como administrador y ejecutar `Restart-Service BalanzaWebAgent`. |

### 11.1 Diagnosticar una balanza que no responde (comando `probe`)

Cuando en **Estado** una balanza muestra `error: hello: no acknowledgement after 3
attempt(s)`, la transferencia no llegó a empezar: el agente manda el saludo del
protocolo y la balanza no contesta. En el historial esas filas tienen **Registros**
y **Tramas** en `—`, así que no se escribió nada en la balanza.

Para saber si el problema es de red o del equipo, desde la PC de la sede:

```powershell
& "C:\Program Files\BalanzaWeb\Agent\balanza-agent.exe" probe --host 192.168.0.203
```

Parámetros opcionales: `--port` (por defecto `5001`), `--timeout` en milisegundos
(`1000`), `--retries` (`2`) y `--full` (diagnóstico completo, al final de esta
sección).

**Si contesta el saludo**, el equipo y la red están bien:

```
hello reply from 192.168.0.203:5001 in 34 ms
model: RONGTA_PV2.0
reply: 263 bytes
```

**Si no contesta**, imprime `error: hello: no acknowledgement after N attempt(s)` y
una pista. El orden de descarte es:

1. `ping 192.168.0.203` — si no responde, la balanza está apagada, desconectada o
   cambió de IP. Es la causa más frecuente.
2. Revisar en el menú de la balanza que su IP coincida con la que figura en **Sedes
   y balanzas**.
3. `arp -a | findstr 192.168.0.203` — si no aparece la MAC, no hay respuesta en la
   capa de red.
4. Cerrar cualquier software del fabricante que esté apuntando a esa balanza: algunas
   atienden una sola sesión y dejan de responder al saludo.
5. Reiniciar la balanza (apagar y encender) para liberar una sesión colgada.

No hace falta tocar la web: en la **1.0.3** el agente reintenta esa balanza con
backoff por balanza (60 s, después 120 s, 240 s… hasta un tope de 15 minutos); la
1.0.2 reintenta en cada ciclo, sin espera. Cuando la balanza vuelve a contestar, la
revisión avanza sola.

Para reintentar en el acto sin esperar, usar `once --force`. Un `once` normal
saltea por hash las balanzas que ya estaban al día, pero `--force` ignora ese hash
para **todas** las balanzas objetivo y reenvía el catálogo a todas. No ejecutar
`once --force` con el servicio `BalanzaWebAgent` activo: hay que detenerlo primero
(sección 11.2).

**Diagnóstico completo con `--full`.** Sin `--full`, `probe` solo prueba el saludo:
distingue una balanza que no está en la red de una que contesta. Con `--full` abre
además una sesión de transferencia completa, `hello` → `start` → `goodbye`, e imprime
cada paso con su latencia:

```powershell
& "C:\Program Files\BalanzaWeb\Agent\balanza-agent.exe" probe --host 192.168.0.203 --full
```

```
  hello: 34 ms
  start: 12 ms
  goodbye: 8 ms
session opened on 192.168.0.203:5001 in 61 ms
```

Eso separa dos fallas que el saludo solo no distingue:

- **Falla en `hello`** con `hello: no acknowledgement after N attempt(s)`: la balanza
  no contesta nada. Es un problema de red, de IP o de equipo apagado.
- **`hello` responde y falla en `start`** con `start: no acknowledgement after N
  attempt(s)` y la pista `the scale answered hello but refused to start a transfer
  session. Close any vendor software holding the session and power-cycle the scale.`
  El equipo y la red están bien, pero la balanza no abre la sesión de descarga: hay
  software del fabricante con la sesión tomada o una sesión colgada. Cerrar ese
  software y apagar/encender la balanza.

El `hello` lleva la fecha y la hora de la PC, y la balanza las adopta como propias. Por
eso `probe --full` también corrige el reloj de esa balanza: no manda el catálogo ni
cambia ningún PLU. Para corregir todas las balanzas de la sede de una vez, ver 11.2.

### 11.2 Corregir la fecha de las balanzas (etiquetas con fecha equivocada)

La fecha que imprime la etiqueta sale del reloj de la balanza, y la balanza toma ese
reloj del `hello` que manda el agente: el frame lleva la fecha de la PC. Una balanza
que quedó sin energía puede volver con una fecha incorrecta y mantenerla hasta que
reciba un `hello` nuevo.

Un `once` normal no alcanza para corregirla. El agente saltea las balanzas cuyo
contenido no cambió y, cuando la API responde 304, no envía nada: sin `hello`, el
reloj no se actualiza. La forma de forzar el envío a todas las balanzas de la sede es
`once --force`, que pide la revisión 0 e ignora el hash guardado de todas las
balanzas objetivo.

Detenga primero el servicio: dos procesos no deben estar empujando a las mismas
balanzas al mismo tiempo. Todo se ejecuta en PowerShell **elevado**.

1. Detener el servicio y confirmar que quedó parado:

   ```powershell
   Stop-Service BalanzaWebAgent
   Get-Service BalanzaWebAgent
   ```

   `Status` tiene que decir `Stopped`.

2. Ejecutar el envío forzado con el binario instalado:

   ```powershell
   & "C:\Program Files\BalanzaWeb\Agent\balanza-agent.exe" once --force
   ```

3. Confirmar la salida. Primero aparece `forced push: ignoring cached scale hashes`,
   después la revisión y una línea `pushed` por balanza con la cantidad de registros y
   la duración. No debe aparecer ninguna línea `skipped scale`. Si una balanza muestra
   `FAILED`, esa balanza no recibió el catálogo: diagnosticarla con 11.1.

4. Volver a arrancar el servicio y confirmar que quedó corriendo:

   ```powershell
   Start-Service BalanzaWebAgent
   Get-Service BalanzaWebAgent
   ```

5. Imprimir una etiqueta de prueba y verificar la fecha. Si la balanza sigue con la
   fecha vieja, revisar que su IP sea la correcta en **Sedes y balanzas**, detener el
   servicio de nuevo y repetir el paso 2.

> `probe --full` (sección 11.1) también manda el `hello`, así que corrige el reloj de
> una sola balanza sin tocar el catálogo. `once --force` es el que garantiza que toda
> la sede quede corregida.

**La fecha de vencimiento es otro dato.** El catálogo no lleva una fecha de
vencimiento: lleva los **días de validez** de cada artículo, y la balanza calcula
vencimiento = su fecha + esos días. Todos los artículos deben tener **365 días**. Un
maestro importado del fabricante suele traer 364–366, y entonces la etiqueta muestra
un vencimiento a un año aunque el reloj esté bien. Eso es dato maestro: se corrige en
la web artículo por artículo o de una vez con el script de 11.3, y no es un defecto
del agente.

### 11.3 Llevar los días de validez de todo el catálogo a 365

El maestro del fabricante trae 364–366 días en casi todos los artículos. Después de
importar un maestro así, hay que dejarlos todos en 365. El script lee el catálogo,
cambia **solo** `validityDays` y vuelve a enviarlo completo; el resto de los campos
—precios incluidos— queda igual, también los artículos que tienen precio 0 a
propósito.

Se ejecuta desde una máquina con Node 22 o superior y acceso al API, no desde la PC
de la sede. El usuario tiene que tener los permisos `articles.read` (para leer el
catálogo) y `articles.write` (para reemplazarlo), por ejemplo un administrador.

1. Definir la clave en la sesión de PowerShell. Así no queda en el historial:

   ```powershell
   $env:BALANZA_PASSWORD = "..."
   ```

   También se acepta `--password "..."` por compatibilidad, pero queda visible en la
   lista de procesos y en el historial del shell; conviene `$env:BALANZA_PASSWORD`.

2. Probar primero en seco. No envía nada: muestra cuántos artículos cambiarían y
   algunos ejemplos con su valor actual.

   ```powershell
   node scripts/set-validity.mjs --api https://balanza.farmavid.com.ve --user admin --dry-run
   ```

3. Aplicar el cambio quitando `--dry-run`:

   ```powershell
   node scripts/set-validity.mjs --api https://balanza.farmavid.com.ve --user admin
   ```

   Al terminar imprime los artículos leídos, los que ya estaban en 365, los que
   cambiaron y el estado HTTP. Si el API rechaza el catálogo, imprime el mensaje de
   error y termina con código distinto de cero.

4. Publicar el catálogo a la sede desde la web para que las balanzas reciban los días
   nuevos. El script solo cambia el dato maestro: no publica ni empuja a las balanzas.

Antes de enviar, el script vuelve a leer el catálogo y compara la firma (cantidad de
artículos, códigos de barra y precios) con la del inicio. Si alguien lo modificó
mientras corría, aborta sin enviar nada y hay que ejecutarlo de nuevo.

El destino se puede cambiar con `--days <n>`; el valor por defecto es 365 y solo se
aceptan enteros positivos. Cada pedido tiene un tiempo de espera de 30 s, ajustable
con `--timeout <ms>`.

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
  sede. Para anularlo, quien tenga el permiso `agents.manage` puede revocarlo
  desde la web en **Estado → Agentes de la sede → Revocar**. La revocación surte
  efecto de inmediato porque los permisos y el token se resuelven en cada
  request; el agente de esa PC queda listado como `revocado` y seguirá
  registrando `sync error: sync failed: HTTP 403` hasta que se vuelva a enrolar
  con un código nuevo.
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

Todo esto se ejecuta en una máquina de desarrollo con Node 24 y `npm install` hecho,
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
package: ...\apps\agent\dist\package\balanza-agent-1.0.2-win-x64
zip:     ...\apps\agent\dist\balanza-agent-1.0.2-win-x64.zip
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

Documentos relacionados: [`agent-release.md`](agent-release.md) (cómo se genera y
publica una versión nueva), [`service.md`](service.md) (empaquetado, arquitectura y
diagnóstico del servicio), [`PROJECT.md`](PROJECT.md) (estado del proyecto),
[`protocol.md`](protocol.md) (protocolo RLS1000).
