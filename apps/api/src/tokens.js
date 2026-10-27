/**
 * Agent credentials.
 *
 * Enrolment hands the agent a random token. Only its SHA-256 is stored, so a
 * database leak does not hand out access, and revocation is a single column.
 * The token travels in `Authorization: Bearer <token>` over HTTPS.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function generateToken() {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison of two hex digests. */
export function sameHash(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

export function generatePairingCode() {
  // Human-typable: no 0/O/1/I to avoid support calls.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) code += alphabet[bytes[i] % alphabet.length];
  return code;
}
