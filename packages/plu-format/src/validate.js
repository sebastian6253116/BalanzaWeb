/**
 * Pre-publish validation.
 *
 * Motivation: the vendor application aborts the commit when the master data is
 * invalid, but the scale ACKs every datagram anyway, so a bad file fails
 * silently with no diagnostic. See docs/protocol.md section 9.
 *
 * ERROR blocks a publish. WARNING is surfaced but does not block.
 */
import { NAME_FIELD_SIZE, PACKAGE_FLAG_BY_TYPE } from './record.js';
import { VERIFIED_UNIT_CODES, isKnownUnitCode, unitByCode } from './units.js';

export const SEVERITY = { ERROR: 'error', WARNING: 'warning' };

const LIMITS = {
  lfCodeMax: 9999, // 2 bytes BCD
  barcodeMax: 999999, // 3 bytes BCD (6 digits)
  priceCentsMax: 9999, // 2 bytes BCD
  departmentMax: 99, // 1 byte BCD
  validityDaysMax: 65535, // uint16 little-endian
  practicalNameLength: 40, // vendor grid width; longer names are unproven
};

export function validateRows(rows) {
  const errors = [];
  const warnings = [];
  const seenBarcode = new Map();
  const seenLf = new Map();

  const push = (list, row, field, message) =>
    list.push({ row: row.line, field, message, name: row.name });

  rows.forEach((row) => {
    if (!row.name || row.name.trim() === '') {
      push(errors, row, 'name', 'name is empty');
    } else if (row.name.length > NAME_FIELD_SIZE) {
      push(errors, row, 'name', `name has ${row.name.length} chars, field holds ${NAME_FIELD_SIZE}`);
    } else if (/[^\x20-\x7e]/.test(row.name)) {
      push(errors, row, 'name', 'name contains non-ASCII or control characters');
    } else if (row.name.length > LIMITS.practicalNameLength) {
      push(warnings, row, 'name', `name has ${row.name.length} chars (vendor grid shows ${LIMITS.practicalNameLength})`);
    }

    if (!Number.isInteger(row.lfCode) || row.lfCode < 1 || row.lfCode > LIMITS.lfCodeMax) {
      push(errors, row, 'lfCode', `LF code must be 1..${LIMITS.lfCodeMax}, got ${row.lfCode}`);
    }

    if (!Number.isInteger(row.barcode) || row.barcode < 1 || row.barcode > LIMITS.barcodeMax) {
      push(errors, row, 'barcode', `barcode must be 1..${LIMITS.barcodeMax}, got ${row.barcode}`);
    }

    if (!Number.isInteger(row.barcodeType) || row.barcodeType < 0 || row.barcodeType > 255) {
      push(errors, row, 'barcodeType', `barcode type must be 0..255, got ${row.barcodeType}`);
    } else if (row.barcodeType !== 7) {
      push(warnings, row, 'barcodeType', `barcode type is ${row.barcodeType}, every verified record used 7`);
    }

    if (!Number.isInteger(row.priceCents) || row.priceCents < 0 || row.priceCents > LIMITS.priceCentsMax) {
      push(errors, row, 'priceCents', `price must be 0..${LIMITS.priceCentsMax} cents, got ${row.priceCents}`);
    } else if (row.priceCents === 0) {
      push(warnings, row, 'priceCents', 'price is 0 — confirm this is an intentional placeholder');
    }

    if (!isKnownUnitCode(row.unitCode)) {
      push(errors, row, 'unitCode', `unknown weight unit code ${row.unitCode} (the scale offers codes 0..12)`);
    } else if (!VERIFIED_UNIT_CODES.has(row.unitCode)) {
      push(
        warnings,
        row,
        'unitCode',
        `weight unit "${unitByCode(row.unitCode).label}" (code ${row.unitCode}) is inferred from the vendor dropdown, not yet verified on hardware`,
      );
    }

    if (!Number.isInteger(row.department) || row.department < 0 || row.department > LIMITS.departmentMax) {
      push(errors, row, 'department', `department must be 0..${LIMITS.departmentMax}, got ${row.department}`);
    }

    if (!Number.isInteger(row.validityDays) || row.validityDays < 0 || row.validityDays > LIMITS.validityDaysMax) {
      push(errors, row, 'validityDays', `validity must be 0..${LIMITS.validityDaysMax}, got ${row.validityDays}`);
    }

    if (!PACKAGE_FLAG_BY_TYPE.has(row.packageType)) {
      push(
        errors,
        row,
        'packageType',
        `package type ${row.packageType} was never observed on the wire (verified values: ${[...PACKAGE_FLAG_BY_TYPE.keys()].join(', ')})`,
      );
    }

    if (Number.isInteger(row.barcode)) {
      const previous = seenBarcode.get(row.barcode);
      if (previous) {
        push(errors, row, 'barcode', `duplicate barcode ${row.barcode}, already used on line ${previous.line}`);
      } else {
        seenBarcode.set(row.barcode, row);
      }
    }

    if (Number.isInteger(row.lfCode)) {
      const previous = seenLf.get(row.lfCode);
      if (previous) {
        push(errors, row, 'lfCode', `duplicate LF code ${row.lfCode}, already used on line ${previous.line}`);
      } else {
        seenLf.set(row.lfCode, row);
      }
    }
  });

  return { ok: errors.length === 0, errors, warnings };
}

export function formatReport(report) {
  const lines = [];
  lines.push(`rows with errors: ${new Set(report.errors.map((e) => e.row)).size}`);
  lines.push(`errors: ${report.errors.length}, warnings: ${report.warnings.length}`);
  for (const issue of report.errors) {
    lines.push(`  ERROR  line ${issue.row}: [${issue.field}] ${issue.message}`);
  }
  for (const issue of report.warnings) {
    lines.push(`  WARN   line ${issue.row}: [${issue.field}] ${issue.message}`);
  }
  return lines.join('\n');
}
