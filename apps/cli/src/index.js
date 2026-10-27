#!/usr/bin/env node
/**
 * balanza — inspect, validate and push a PLU catalog to an RLS1000 scale.
 *
 * No vendor software involved: the frames are built here and sent over UDP.
 *
 *   balanza validate <file.txp>
 *   balanza build    <file.txp>
 *   balanza probe    --ip 192.168.0.201 [--port 5001]
 *   balanza push     <file.txp> --ip 192.168.0.201 [--dry-run] [--no-index-table]
 */
import { parseTxpFile, buildRecords, indexTableNumbers, validateRows, formatReport, buildDataFrames, buildHello, buildStart, buildIndexTableFrame, buildCommitFrames, buildGoodbye, INDEX_FRAME_COUNT, unitByCode } from '../../../packages/plu-format/src/index.js';
import { DEFAULT_PORT, probeScale, pushPlu } from '../../../packages/scale-client/src/index.js';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function loadCatalog(path) {
  try {
    return parseTxpFile(path);
  } catch (err) {
    fail(`cannot read ${path}: ${err.message}`);
  }
}

function preflight(path, { allowInvalid = false } = {}) {
  const rows = loadCatalog(path);
  const report = validateRows(rows);
  if (!report.ok) {
    console.error(formatReport(report));
    if (!allowInvalid) {
      fail(`catalog has ${report.errors.length} blocking error(s); fix them before pushing`);
    }
  } else if (report.warnings.length) {
    console.error(formatReport(report));
  }
  return { rows, report };
}

async function cmdValidate(path) {
  const { report } = preflight(path, { allowInvalid: true });
  console.log(formatReport(report));
  console.log(report.ok ? '\nresult: OK' : '\nresult: BLOCKED');
  process.exitCode = report.ok ? 0 : 2;
}

function unitSummary(rows) {
  const counts = new Map();
  for (const row of rows) counts.set(row.unitCode, (counts.get(row.unitCode) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([code, count]) => `${unitByCode(code)?.label ?? `code ${code}`}×${count}`)
    .join(', ');
}

async function cmdBuild(path) {
  const { rows, report } = preflight(path, { allowInvalid: true });
  const records = buildRecords(rows);
  const frames = buildDataFrames(records);
  const indexTable = indexTableNumbers(rows);

  console.log(`file:          ${path}`);
  console.log(`rows:          ${rows.length}`);
  console.log(`records:       ${records.length} x 124 bytes`);
  console.log(`data frames:   ${frames.length} (256-byte bodies, 2 records each)`);
  console.log(`index frames:  ${INDEX_FRAME_COUNT}`);
  console.log(`commit frames: ${buildCommitFrames().length}`);
  console.log(`weight units:  ${unitSummary(rows)}`);
  console.log(`validation:    ${report.ok ? 'OK' : `${report.errors.length} error(s)`}`);
  console.log(`first frame:   ${frames[0].toString('hex').slice(0, 64)}…`);
  process.exitCode = report.ok ? 0 : 2;
}

async function cmdProbe(flags) {
  const ip = flags.ip;
  if (!ip) fail('--ip is required');
  const port = Number(flags.port ?? DEFAULT_PORT);
  const result = await probeScale({ host: ip, port, timeoutMs: Number(flags.timeout ?? 1000) });
  console.log(`scale ${ip}:${port} answered in ${result.ms} ms`);
  console.log(`model: ${result.model} (${result.replyLength} byte reply)`);
}

async function cmdPush(path, flags) {
  const ip = flags.ip;
  if (!ip) fail('--ip is required');
  const port = Number(flags.port ?? DEFAULT_PORT);
  const { rows, report } = preflight(path, { allowInvalid: Boolean(flags['allow-invalid']) });
  if (report.warnings.length) console.error(`proceeding with ${report.warnings.length} warning(s)`);

  const records = buildRecords(rows);
  const frameCount = buildDataFrames(records).length;
  const indexTable = flags['no-index-table'] ? null : indexTableNumbers(rows);

  console.log(`target:      ${ip}:${port}`);
  console.log(`catalog:     ${rows.length} PLUs -> ${records.length} records -> ${frameCount} data frames`);
  console.log(`weight units: ${unitSummary(rows)}`);
  console.log(`index table: ${indexTable ? `${indexTable.length} slot number(s)` : 'disabled'}`);

  if (flags['dry-run']) {
    console.log('\ndry run: nothing was sent');
    console.log(`hello frame: ${buildHello().toString('hex').slice(0, 48)}…`);
    console.log(`start frame: ${buildStart().toString('hex').slice(0, 48)}…`);
    console.log(`index #1:    ${indexTable ? buildIndexTableFrame(0, indexTable).toString('hex').slice(0, 48) + '…' : 'skipped'}`);
    console.log(`goodbye:     ${buildGoodbye().toString('hex').slice(0, 48)}…`);
    return;
  }

  let lastShown = 0;
  const result = await pushPlu({
    host: ip,
    port,
    records,
    indexTable,
    timeoutMs: Number(flags.timeout ?? 800),
    retries: Number(flags.retries ?? 3),
    onProgress: (step) => {
      const now = Date.now();
      if (now - lastShown > 250 || step.attempt > 1) {
        lastShown = now;
        const suffix = step.attempt > 1 ? ` (retry ${step.attempt})` : '';
        console.log(`  ${step.label} — ${step.ms} ms${suffix}`);
      }
    },
  });

  console.log('\ntransfer completed');
  console.log(`  records:   ${result.records}`);
  console.log(`  frames:    ${result.framesSent}`);
  console.log(`  retries:   ${result.retriesUsed}`);
  console.log(`  duration:  ${result.durationMs} ms`);
  console.log('\nnote: the scale never reports a commit status. Success here means every frame was acknowledged.');
}

const USAGE = `balanza — RLS1000 PLU tool

usage:
  balanza validate <file.txp>
  balanza build    <file.txp>
  balanza probe    --ip <scale-ip> [--port 5001]
  balanza push     <file.txp> --ip <scale-ip> [options]

push options:
  --port <n>            UDP port (default ${DEFAULT_PORT})
  --timeout <ms>        acknowledgement timeout per frame (default 800)
  --retries <n>         attempts per frame (default 3)
  --no-index-table      skip the D2 04 keyboard-slot table
  --allow-invalid       push even when validation reports errors
  --dry-run             build and print the plan without sending
`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  try {
    switch (command) {
      case 'validate':
        if (!positional[0]) fail('missing <file.txp>');
        await cmdValidate(positional[0]);
        break;
      case 'build':
        if (!positional[0]) fail('missing <file.txp>');
        await cmdBuild(positional[0]);
        break;
      case 'probe':
        await cmdProbe(flags);
        break;
      case 'push':
        if (!positional[0]) fail('missing <file.txp>');
        await cmdPush(positional[0], flags);
        break;
      case 'help':
      case undefined:
        console.log(USAGE);
        break;
      default:
        fail(`unknown command "${command}"\n\n${USAGE}`);
    }
  } catch (err) {
    fail(err.message);
  }
}

main();
