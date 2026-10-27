/**
 * Minimal OOXML spreadsheet writer (no third-party dependencies).
 *
 * Produces a single-sheet .xlsx workbook with an optional header style and a
 * currency number format. Text cells are inline strings, so the file does not
 * need a shared-strings table; numbers are written as numeric cells.
 */
import { createZip } from './zip.js';

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';
const CONTENT_TYPES = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const WORKSHEET = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
const STYLES = 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml';
const RELATIONSHIP_PACKAGE = 'application/vnd.openxmlformats-package.relationships+xml';
const RELATIONSHIP_OFFICE_DOCUMENT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const RELATIONSHIP_WORKSHEET = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
const RELATIONSHIP_STYLES = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles';

export const XLSX_CONTENT_TYPE = CONTENT_TYPES;

const INVALID_SHEET_NAME = /[[\]:*?/\\]/;
const MAX_SHEET_NAME_LENGTH = 31;

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Column index (1-based) to Excel letters: 1 -> A, 27 -> AA. */
function columnName(index) {
  let name = '';
  let value = index;
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function validateSheetName(sheetName) {
  if (typeof sheetName !== 'string' || sheetName.trim() === '') {
    throw new Error('sheet name must be a non-empty string');
  }
  if (sheetName.length > MAX_SHEET_NAME_LENGTH) {
    throw new Error(`sheet name must be at most ${MAX_SHEET_NAME_LENGTH} characters: ${JSON.stringify(sheetName)}`);
  }
  if (INVALID_SHEET_NAME.test(sheetName)) {
    throw new Error(`sheet name contains invalid characters ([]:*?/\\): ${JSON.stringify(sheetName)}`);
  }
  if (sheetName.startsWith("'") || sheetName.endsWith("'")) {
    throw new Error(`sheet name cannot start or end with an apostrophe: ${JSON.stringify(sheetName)}`);
  }
  if (sheetName.toLowerCase() === 'history') {
    throw new Error('sheet name "History" is reserved by Excel');
  }
}

function validateColumns(columns) {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new TypeError('buildXlsx expects at least one column');
  }
  for (const column of columns) {
    if (!column || typeof column.header !== 'string' || typeof column.key !== 'string') {
      throw new TypeError('each column needs a string header and key');
    }
    if (column.type !== undefined && !['text', 'number', 'money', 'integer'].includes(column.type)) {
      throw new TypeError(`unknown column type: ${JSON.stringify(column.type)}`);
    }
    if (column.width !== undefined && (!Number.isFinite(column.width) || column.width <= 0)) {
      throw new RangeError(`column width must be a positive number: ${JSON.stringify(column.width)}`);
    }
  }
}

function numberValue(value, column, rowIndex) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new RangeError(
      `row ${rowIndex + 1}, column ${JSON.stringify(column.key)}: value is not a number (${JSON.stringify(value)})`,
    );
  }
  return number;
}

function cellXml(column, row, rowIndex, columnIndex) {
  const value = row?.[column.key];
  const reference = `${columnName(columnIndex)}${rowIndex + 1}`;
  const type = column.type ?? 'text';

  if (value === undefined || value === null || value === '') return '';

  if (type === 'text') {
    return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(value)}</t></is></c>`;
  }

  const number = numberValue(value, column, rowIndex);
  if (type === 'money') {
    const rounded = Math.round(number * 100) / 100;
    return `<c r="${reference}" s="2" t="n"><v>${rounded}</v></c>`;
  }
  return `<c r="${reference}" t="n"><v>${type === 'integer' ? Math.trunc(number) : number}</v></c>`;
}

function worksheetXml({ sheetName, columns, rows }) {
  const lastColumn = columnName(columns.length);
  const lastRow = rows.length + 1;

  const widths = columns
    .map((column, index) =>
      column.width === undefined
        ? ''
        : `<col min="${index + 1}" max="${index + 1}" width="${column.width}" customWidth="1"/>`,
    )
    .join('');

  const header = columns
    .map(
      (column, index) =>
        `<c r="${columnName(index + 1)}1" s="1" t="inlineStr"><is><t xml:space="preserve">${escapeXml(column.header)}</t></is></c>`,
    )
    .join('');

  const body = rows
    .map((row, rowIndex) => {
      const cells = columns
        .map((column, columnIndex) => cellXml(column, row, rowIndex + 1, columnIndex + 1))
        .join('');
      return `<row r="${rowIndex + 2}">${cells}</row>`;
    })
    .join('');

  return (
    `${XML_DECLARATION}` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<dimension ref="A1:${lastColumn}${lastRow}"/>` +
    `<sheetViews><sheetView workbookViewId="0" tabSelected="1">` +
    `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` +
    `<selection pane="bottomLeft" activeCell="A2" sqref="A2"/>` +
    `</sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    (widths ? `<cols>${widths}</cols>` : '') +
    `<sheetData><row r="1">${header}</row>${body}</sheetData>` +
    `</worksheet>`
  );
}

function workbookXml(sheetName) {
  return (
    `${XML_DECLARATION}` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<bookViews><workbookView/></bookViews>` +
    `<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
    `</workbook>`
  );
}

function stylesXml() {
  return (
    `${XML_DECLARATION}` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>` +
    `<fonts count="2">` +
    `<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>` +
    `<font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font>` +
    `</fonts>` +
    `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="3">` +
    `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
    `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
    `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` +
    `</cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `<dxfs count="0"/>` +
    `<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>` +
    `</styleSheet>`
  );
}

function contentTypesXml() {
  return (
    `${XML_DECLARATION}` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="${RELATIONSHIP_PACKAGE}"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="${CONTENT_TYPES}"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="${WORKSHEET}"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="${STYLES}"/>` +
    `</Types>`
  );
}

function packageRelationshipsXml() {
  return (
    `${XML_DECLARATION}` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${RELATIONSHIP_OFFICE_DOCUMENT}" Target="xl/workbook.xml"/>` +
    `</Relationships>`
  );
}

function workbookRelationshipsXml() {
  return (
    `${XML_DECLARATION}` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${RELATIONSHIP_WORKSHEET}" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="${RELATIONSHIP_STYLES}" Target="styles.xml"/>` +
    `</Relationships>`
  );
}

function xmlEntry(name, xml) {
  return { name, data: Buffer.from(xml, 'utf8') };
}

/**
 * Build a complete .xlsx workbook.
 *
 * @param {object} options
 * @param {string} [options.sheetName]
 * @param {{ header: string, key: string, width?: number, type?: 'text' | 'number' | 'money' | 'integer' }[]} options.columns
 * @param {object[]} options.rows
 * @returns {Buffer}
 */
export function buildXlsx({ sheetName = 'Hoja1', columns, rows }) {
  validateSheetName(sheetName);
  validateColumns(columns);
  if (!Array.isArray(rows)) throw new TypeError('buildXlsx expects rows to be an array');

  return createZip([
    xmlEntry('[Content_Types].xml', contentTypesXml()),
    xmlEntry('_rels/.rels', packageRelationshipsXml()),
    xmlEntry('xl/workbook.xml', workbookXml(sheetName)),
    xmlEntry('xl/_rels/workbook.xml.rels', workbookRelationshipsXml()),
    xmlEntry('xl/styles.xml', stylesXml()),
    xmlEntry('xl/worksheets/sheet1.xml', worksheetXml({ sheetName, columns, rows })),
  ]);
}
