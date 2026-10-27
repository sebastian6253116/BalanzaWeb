/**
 * Weight/price unit vocabulary.
 *
 * The vendor "PLU manager" exposes exactly these 13 options in the "Unidad de
 * peso" dropdown, in this order. The record stores the **0-based index** of the
 * option in byte 85 (verified: every kg article in the production file carries
 * 4, and the two by-unit articles carry 9 and 10 = PCS(g) / PCS(kg)).
 *
 * Only codes 4, 9 and 10 have been observed on the wire. The rest are inferred
 * from the dropdown order and are accepted with a warning until a capture
 * confirms them.
 */

export const WEIGHT_UNITS = [
  { code: 0, id: '50g', label: '50g' },
  { code: 1, id: 'g', label: 'g' },
  { code: 2, id: '10g', label: '10g' },
  { code: 3, id: '100g', label: '100g' },
  { code: 4, id: 'kg', label: 'kg' },
  { code: 5, id: 'oz', label: 'oz' },
  { code: 6, id: 'lb', label: 'lb' },
  { code: 7, id: '500g', label: '500g' },
  { code: 8, id: '600g', label: '600g' },
  { code: 9, id: 'pcs_g', label: 'PCS(g)' },
  { code: 10, id: 'pcs_kg', label: 'PCS(kg)' },
  { code: 11, id: 'pcs_oz', label: 'PCS(oz)' },
  { code: 12, id: 'pcs_lb', label: 'PCS(lb)' },
];

/** Unit codes actually observed in a captured download. */
export const VERIFIED_UNIT_CODES = new Set([4, 9, 10]);

const BY_CODE = new Map(WEIGHT_UNITS.map((unit) => [unit.code, unit]));
const BY_ID = new Map(WEIGHT_UNITS.map((unit) => [unit.id, unit]));

export function unitByCode(code) {
  return BY_CODE.get(code) ?? null;
}

export function unitById(id) {
  return BY_ID.get(id) ?? null;
}

export function isKnownUnitCode(code) {
  return BY_CODE.has(code);
}

/**
 * Resolve whatever the cloud sends (numeric code or string id) to a unit code.
 * Accepts 4, '4', 'kg', 'pcs_kg'. Returns null when it cannot be resolved.
 */
export function resolveUnitCode(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return isKnownUnitCode(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      const code = Number(trimmed);
      return isKnownUnitCode(code) ? code : null;
    }
    const unit = BY_ID.get(trimmed.toLowerCase());
    return unit ? unit.code : null;
  }
  return null;
}
