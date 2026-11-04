import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCatalogPayload, catalogueSignature } from '../../../scripts/set-validity.mjs';

const articles = [
  {
    id: 1,
    name: 'LOMO DE AGUJA',
    lfCode: 1,
    pluNumber: 1,
    barcode: 11001,
    barcodeType: 7,
    priceCents: 1450,
    unitCode: 4,
    department: 21,
    validityDays: 364,
    packageType: 0,
  },
  {
    id: 2,
    name: 'PAN CANILLA',
    lfCode: 2,
    pluNumber: 2,
    barcode: 11002,
    barcodeType: 7,
    priceCents: 0,
    unitCode: 4,
    department: 21,
    validityDays: 366,
    packageType: 0,
  },
];

test('buildCatalogPayload sets validityDays and preserves every other field', () => {
  const payload = buildCatalogPayload(articles, 365);

  assert.equal(payload.length, 2);
  assert.deepEqual(payload[0], {
    name: 'LOMO DE AGUJA',
    lfCode: 1,
    pluNumber: 1,
    barcode: 11001,
    barcodeType: 7,
    priceCents: 1450,
    unitCode: 4,
    department: 21,
    validityDays: 365,
    packageType: 0,
  });
  assert.equal(payload[1].validityDays, 365);
  assert.equal(payload[1].priceCents, 0, 'zero-priced articles must stay at 0');
});

test('buildCatalogPayload does not mutate the input articles', () => {
  const snapshot = structuredClone(articles);

  buildCatalogPayload(articles, 365);

  assert.deepEqual(articles, snapshot);
});

test('buildCatalogPayload honours a different target', () => {
  const payload = buildCatalogPayload(articles, 30);

  assert.deepEqual(payload.map((article) => article.validityDays), [30, 30]);
});

test('catalogueSignature is stable for the same catalogue in another order', () => {
  assert.equal(catalogueSignature(articles), catalogueSignature([...articles].reverse()));
});

test('catalogueSignature changes when a barcode is added or removed', () => {
  const base = catalogueSignature(articles);

  assert.notEqual(catalogueSignature([...articles, { ...articles[0], barcode: 11003 }]), base);
  assert.notEqual(catalogueSignature(articles.slice(1)), base);
});

test('catalogueSignature changes when a price changes', () => {
  const repriced = articles.map((article, index) => (index === 0 ? { ...article, priceCents: 1500 } : article));

  assert.notEqual(catalogueSignature(repriced), catalogueSignature(articles));
});
