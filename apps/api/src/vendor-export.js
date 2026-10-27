/**
 * Vendor-layout workbook export.
 *
 * The manufacturer's PLU manager imports the same 26 columns as the .Txp file
 * but from a spreadsheet. Every cell is written as text so Excel cannot turn
 * "0.000" into 0 or reformat long barcodes, and the price stays in cents,
 * exactly like the vendor file.
 */
import { buildXlsx } from '../../../packages/xlsx/src/index.js';

const EXTRA_COLUMNS = 15;
const PACK_WEIGHT = '0.000';

const VENDOR_HEADERS = [
  'Teclado',
  'Nombre',
  'LF',
  'Código',
  'Tipo de código de barras',
  'Precio (centavos)',
  'Unidad',
  'Departamento',
  'Peso PT',
  'Fecha de validez',
  'Tipo de empaque',
  ...Array.from({ length: EXTRA_COLUMNS }, (_, index) => `Reservado ${index + 11}`),
];

export const VENDOR_COLUMNS = VENDOR_HEADERS.map((header, index) => ({
  header,
  key: `c${index}`,
  type: 'text',
}));

function vendorRow(article) {
  const values = [
    article.pluNumber,
    article.name,
    article.lfCode,
    article.barcode,
    article.barcodeType,
    article.priceCents,
    article.unitCode,
    article.department,
    PACK_WEIGHT,
    article.validityDays,
    article.packageType,
    ...Array(EXTRA_COLUMNS).fill('0'),
  ];

  return Object.fromEntries(values.map((value, index) => [`c${index}`, String(value)]));
}

/** Build the vendor-layout workbook for the active catalogue. */
export function buildVendorWorkbook(articles) {
  return buildXlsx({
    sheetName: 'PLU',
    header: false,
    columns: VENDOR_COLUMNS,
    rows: articles.map(vendorRow),
  });
}
