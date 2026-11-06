import { test } from 'node:test';
import assert from 'node:assert/strict';

import { articlesNeedingUpdate, catalogueSignature } from '../../../scripts/set-validity.mjs';

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

test('articlesNeedingUpdate selects only the articles whose validity differs', () => {
  const selected = articlesNeedingUpdate(articles, 365);

  assert.deepEqual(selected.map((article) => article.id), [1, 2]);
  assert.equal(selected[0], articles[0], 'the original objects are preserved, not copies');
  assert.equal(selected[1].priceCents, 0, 'zero-priced articles are still selected');
});

test('articlesNeedingUpdate does not mutate the input articles', () => {
  const snapshot = structuredClone(articles);

  articlesNeedingUpdate(articles, 365);

  assert.deepEqual(articles, snapshot);
});

test('articlesNeedingUpdate honours a different target', () => {
  assert.deepEqual(articlesNeedingUpdate(articles, 364).map((article) => article.id), [2]);
});

test('articlesNeedingUpdate returns nothing when every article already matches', () => {
  const alreadyAt365 = articles.map((article) => ({ ...article, validityDays: 365 }));

  assert.deepEqual(articlesNeedingUpdate(alreadyAt365, 365), []);
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

test('catalogueSignature changes when a name, a unit code or a validity changes', () => {
  const base = catalogueSignature(articles);
  const withName = articles.map((article, index) => (index === 0 ? { ...article, name: 'LOMO DE AGUJA PREMIUM' } : article));
  const withUnit = articles.map((article, index) => (index === 0 ? { ...article, unitCode: 1 } : article));
  const withValidity = articles.map((article, index) => (index === 0 ? { ...article, validityDays: 30 } : article));

  assert.notEqual(catalogueSignature(withName), base);
  assert.notEqual(catalogueSignature(withUnit), base);
  assert.notEqual(catalogueSignature(withValidity), base);
});
