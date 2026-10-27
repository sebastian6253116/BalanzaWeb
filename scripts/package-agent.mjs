#!/usr/bin/env node
/**
 * Build the distributable Windows package for the BalanzaWeb agent.
 *
 *   node scripts/package-agent.mjs
 *
 * Stages a flat layout (binaries, service wrapper, template, scripts and README)
 * under apps/agent/dist/package, zips it and prints the path, size and SHA-256.
 * The zip is the artifact a sede receives: the installer next to the exe resolves
 * everything from its own folder, with no reference to the repository.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const agentRoot = join(repoRoot, 'apps', 'agent');
const distDir = join(agentRoot, 'dist');
const serviceDir = join(agentRoot, 'service');

const version = JSON.parse(readFileSync(join(agentRoot, 'package.json'), 'utf8')).version;
const packageName = `balanza-agent-${version}-win-x64`;
const stagingDir = join(distDir, 'package', packageName);
const zipPath = join(distDir, `${packageName}.zip`);

const agentExe = join(distDir, 'balanza-agent.exe');
const winswExe = join(serviceDir, 'bin', 'balanza-agent-service.exe');
const template = join(serviceDir, 'balanza-agent.xml.template');
const installScript = join(serviceDir, 'install.ps1');
const uninstallScript = join(serviceDir, 'uninstall.ps1');
const smokeTest = join(serviceDir, 'smoke-test.ps1');

const required = [
  [agentExe, 'run "npm run agent:build" to produce it'],
  [winswExe, 'run "npm run agent:winsw" to download it'],
  [template, 'the service template is part of the repository'],
  [installScript, 'the installer is part of the repository'],
  [uninstallScript, 'the uninstaller is part of the repository'],
  [smokeTest, 'the smoke test is part of the repository'],
];

const missing = required.filter(([path]) => !existsSync(path));
if (missing.length > 0) {
  for (const [path, hint] of missing) {
    console.error(`error: missing ${path}`);
    console.error(`       ${hint}`);
  }
  process.exit(1);
}

const readme = `BalanzaWeb - Agente para Windows
================================

Qué es
------
Este paquete instala el agente de BalanzaWeb como servicio de Windows
(BalanzaWebAgent). El agente mantiene las balanzas de la sede sincronizadas con
la API. La máquina no necesita Node.js ni software del fabricante de balanzas.

Requisitos
----------
- Windows 10 versión 1903 o superior, o Windows 11 (64 bits).
- .NET Framework 4.8 (incluido en Windows 10 y 11).
- Permisos de administrador para instalar el servicio.
- Acceso de red a las balanzas (UDP) y a la API de BalanzaWeb (HTTP/HTTPS).

Instalación
-----------
1. Extraiga el contenido del zip en una carpeta de la sede.
2. Abra una consola de PowerShell como administrador en esa carpeta.
3. Ejecute:

   powershell -ExecutionPolicy Bypass -File .\\install.ps1 -ApiUrl "https://balanza.ejemplo.com" -PairingCode "ABCDEFGH"

   -ApiUrl y -PairingCode son opcionales. Si los omite, puede enrolar el agente
   más tarde con el comando enroll.

Datos y logs
------------
- Binarios:  C:\\Program Files\\BalanzaWeb\\Agent
- Datos:     %ProgramData%\\BalanzaWeb\\Agent\\config\\agent.config.json
- Log:       %ProgramData%\\BalanzaWeb\\Agent\\logs\\agent.log
- Log WinSW: %ProgramData%\\BalanzaWeb\\Agent\\logs\\winsw

Estado
------
Get-Service BalanzaWebAgent

Desinstalación
--------------
powershell -ExecutionPolicy Bypass -File .\\uninstall.ps1

Agregue -Purge para borrar también los datos (token y logs).

Aviso
-----
El ejecutable no está firmado. Windows SmartScreen puede mostrar una advertencia
al ejecutarlo; verifique el origen del archivo antes de continuar.
`;

if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });

const files = [
  [agentExe, 'balanza-agent.exe'],
  [winswExe, 'balanza-agent-service.exe'],
  [template, 'balanza-agent.xml.template'],
  [installScript, 'install.ps1'],
  [uninstallScript, 'uninstall.ps1'],
  [smokeTest, 'smoke-test.ps1'],
];
for (const [source, name] of files) {
  const target = join(stagingDir, name);
  writeFileSync(target, readFileSync(source));
}
writeFileSync(join(stagingDir, 'README.txt'), readme, 'utf8');

rmSync(zipPath, { force: true });
const quote = (path) => `'${path.replace(/'/g, "''")}'`;
execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `Compress-Archive -LiteralPath ${quote(stagingDir)} -DestinationPath ${quote(zipPath)}`,
  ],
  { stdio: 'inherit' },
);

if (!existsSync(zipPath)) {
  console.error(`error: Compress-Archive did not produce ${zipPath}`);
  process.exit(1);
}

const zipBytes = readFileSync(zipPath);
const sha256 = createHash('sha256').update(zipBytes).digest('hex');
const sizeMb = (statSync(zipPath).size / (1024 * 1024)).toFixed(2);
console.log('');
console.log(`package: ${stagingDir}`);
console.log(`zip:     ${zipPath}`);
console.log(`size:    ${sizeMb} MB`);
console.log(`sha256:  ${sha256}`);
