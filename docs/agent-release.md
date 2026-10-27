# Publicar una versión del agente

Guía para quien mantiene el repositorio y tiene que entregar una versión nueva del
agente a una sede. Cubre el build, el empaquetado, la verificación y la publicación
del artefacto. El procedimiento del lado de la sede está en
[`instalacion-sede.md`](instalacion-sede.md).

## 1. Por qué el binario no está en git

`apps/agent/dist/` está en `.gitignore`: ahí quedan el ejecutable del agente y el
zip que se entrega. Cada versión pesa alrededor de 40 MB; si se versionara, el
historial crecería para siempre y el repositorio es público. El binario es un
artefacto de release, no una parte del árbol de código.

El único archivo versionado que define la versión del agente es `apps/agent/package.json`.
El build lo embebe en el ejecutable, así que el binario publicado reporta por sí
mismo qué versión es.

## 2. Antes de empaquetar

1. Ejecutar los tests y confirmar que pasan los 76:

   ```powershell
   npm test
   ```

2. Subir `version` en `apps/agent/package.json`. Usar criterio semver: parche para
   correcciones, menor para cambios de comportamiento.

3. Ejecutar el smoke test del servicio en una consola **elevada**:

   ```powershell
   npm run agent:smoke
   ```

   Tiene que terminar con `RESULT: ALL CHECKS PASSED`. La transcripción queda en
   `%TEMP%\balanzaweb-service-smoke.log`.

## 3. Build y empaquetado

Requiere Node 22 y las dependencias instaladas (`npm install` en la raíz).

| Comando | Qué produce |
|---|---|
| `npm run agent:winsw` | Descarga WinSW v2.12.0 en `apps/agent/service/bin/balanza-agent-service.exe`. Es un binario de terceros y no se versiona; alcanza con ejecutarlo la primera vez. |
| `npm run agent:build` | Genera `apps/agent/dist/balanza-agent.exe` (~81.4 MB) con esbuild, Node SEA y postject. |
| `npm run agent:package` | Arma la carpeta plana y el zip en `apps/agent/dist/`; imprime ruta, tamaño y SHA-256. |

Orden completo:

```powershell
# Solo la primera vez, o con --force para volver a descargar WinSW
npm run agent:winsw

npm run agent:build
npm run agent:package
```

Para volver a descargar WinSW:

```powershell
npm run agent:winsw -- --force
```

`npm run agent:build` termina con estas líneas:

```
built ...\apps\agent\dist\balanza-agent.exe
size: 81.4 MB
note: injecting the blob invalidates the original Authenticode signature of node.exe
      (expected; sign the final executable before distributing it).
```

`npm run agent:package` deja dos resultados:

- `apps/agent/dist/package/balanza-agent-<version>-win-x64/` — la carpeta plana.
- `apps/agent/dist/balanza-agent-<version>-win-x64.zip` — el archivo que recibe la
  sede (~40 MB).

E imprime:

```
package: ...\apps\agent\dist\package\balanza-agent-<version>-win-x64
zip:     ...\apps\agent\dist\balanza-agent-<version>-win-x64.zip
size:    <tamaño> MB
sha256:  <hash del zip>
```

El zip contiene 8 archivos, todos dentro de la carpeta
`balanza-agent-<version>-win-x64/`: `balanza-agent.exe`,
`balanza-agent-service.exe`, `balanza-agent.xml.template`, `install.ps1`,
`uninstall.ps1`, `configurar-agente.ps1`, `smoke-test.ps1` y `README.txt`.

## 4. Verificar el binario antes de publicar

No alcanza con que el build termine: hay que ejecutar el binario extraído del
paquete en una carpeta temporal.

```powershell
Expand-Archive .\balanza-agent-1.0.0-win-x64.zip -DestinationPath .\prueba
Set-Location .\prueba\balanza-agent-1.0.0-win-x64

# Aislar la configuración para no leer la de una instalación real
$env:BALANZA_AGENT_HOME = Join-Path $env:TEMP 'balanza-release-check'

.\balanza-agent.exe version
.\balanza-agent.exe status

Remove-Item Env:BALANZA_AGENT_HOME
```

Resultados esperados:

- `version` imprime `balanza-agent <version>`. Para 1.0.0:
  `balanza-agent 1.0.0`.
- `status` imprime la ruta de configuración, la carpeta de logs y, sin
  configuración previa, `no configuration at ...`. Si esa PC ya tiene un agente
  instalado, la variable `BALANZA_AGENT_HOME` evita leer su token.

El ejecutable es un Node SEA: incluye el runtime de Node y no necesita que la
máquina tenga Node instalado.

## 5. Publicar

El tag de release sigue la forma `agent-v<version>`, por ejemplo `agent-v1.0.0`.
El zip se adjunta como asset de esa release.

### 5.1 Desde la interfaz web de GitHub

1. Abrir el repositorio y entrar en **Releases**.
2. Presionar **Draft a new release**.
3. En **Choose a tag**, escribir `agent-v<version>` y crear el tag sobre `main`.
4. Completar el título, por ejemplo `Agente 1.0.0`.
5. Adjuntar `apps/agent/dist/balanza-agent-1.0.0-win-x64.zip`.
6. Pegar el SHA-256 en la descripción, junto con un resumen de los cambios.
7. Publicar la release.

### 5.2 Con `gh` instalado

```powershell
gh release create agent-v1.0.0 `
  "apps\agent\dist\balanza-agent-1.0.0-win-x64.zip" `
  --title "Agente 1.0.0" `
  --notes "SHA-256: 3DA2B5FD7B49366A971D70CE2F8E6514A706F2AB1A6D46B41FFE73EA68397483"
```

`gh` **no está instalado en la máquina actual**, así que hoy el camino disponible
es el de la interfaz web. El comando queda documentado para cuando se instale y
autentique la herramienta.

## 6. Anotar el SHA-256

El hash vive en tres lugares:

- la salida de `npm run agent:package`, línea `sha256:`;
- la descripción de la release;
- el mensaje con el que se entrega el zip a la sede.

Es la única forma de comprobar que el archivo que llegó es el que se publicó. La
versión del ejecutable no prueba integridad: un zip distinto puede contener la
misma versión. En la PC de la sede, antes de descomprimir:

```powershell
Get-FileHash .\balanza-agent-1.0.0-win-x64.zip -Algorithm SHA256
```

El campo `Hash` tiene que coincidir exactamente con el publicado. El SHA-256 de
1.0.0 es:

```
3DA2B5FD7B49366A971D70CE2F8E6514A706F2AB1A6D46B41FFE73EA68397483
```

Si se vuelve a empaquetar la misma versión, el zip cambia y el hash también:
hay que recalcularlo y actualizar la referencia antes de entregarlo.

## 7. Firma

Los dos ejecutables del paquete están **sin firmar**. Además, al inyectar el blob
del SEA se invalida la firma Authenticode original de `node.exe`. No hay
certificado de firma de código y `signtool` no está instalado en la máquina de
build.

Consecuencia: si el zip llega con la marca de origen de Internet
(*Mark-of-the-Web*), SmartScreen puede mostrar **"Windows protegió su PC"**. El
operador puede continuar con **"Más información"** y **"Ejecutar de todas
formas"**, pero antes debe verificar el SHA-256. Si el zip se entrega por USB o
por una red interna, no lleva esa marca y el aviso no aparece.

Firmar con un certificado autofirmado **empeora** la situación: el certificado no
es de confianza en otras PC, SmartScreen sigue advirtiendo y habría que instalar
la raíz en cada sede. La decisión de comprar o gestionar un certificado real
sigue pendiente.

## 8. Checklist de publicación

- [ ] `npm test` pasa completo (76 tests).
- [ ] `version` está subida en `apps/agent/package.json`.
- [ ] `npm run agent:smoke` terminó con `RESULT: ALL CHECKS PASSED` en consola elevada.
- [ ] `npm run agent:build` y `npm run agent:package` generaron el zip.
- [ ] El zip extraído responde `version` con la versión nueva y ejecuta `status`.
- [ ] El SHA-256 quedó anotado en la release y en el mensaje de entrega.
- [ ] La release se publicó con el tag `agent-v<version>` y el zip adjunto.
- [ ] El zip se entrega por USB/red interna o se verifica con `Get-FileHash` en la sede.

---

Documentos relacionados: [`instalacion-sede.md`](instalacion-sede.md) (instalación
paso a paso), [`service.md`](service.md) (arquitectura y diagnóstico del servicio),
[`PROJECT.md`](PROJECT.md) (estado del proyecto).
