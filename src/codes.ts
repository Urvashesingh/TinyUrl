import { base62Decode, base62Encode } from "./base62.js";

// A short code is a pure, reversible function of the row's primary key.
//
// Encoding the id directly would work, but it would also publish our row count
// and let anyone walk the whole table by counting. So we first map the id
// through a multiplicative permutation of the code space. Multiplying by a
// value coprime with the modulus is a bijection, so distinct ids still produce
// distinct codes with no collision checks and no retry loop -- we just no
// longer hand out consecutive ones.
//
// This is obfuscation, not encryption. It stops casual enumeration; it is not
// a substitute for authorization on anything private.

export const CODE_LENGTH = 7;

/** Size of the code space: 62^7 ~= 3.5e12 links. */
export const CODE_SPACE = 62n ** BigInt(CODE_LENGTH);

// CODE_SPACE factors as 2^7 * 31^7, so any odd multiplier that is not a
// multiple of 31 is coprime with it and therefore invertible.
const MULTIPLIER = 1_500_450_271n;
const INVERSE = modularInverse(MULTIPLIER, CODE_SPACE);

/** Extended Euclid, used once at module load to invert the multiplier. */
function modularInverse(value: bigint, modulus: bigint): bigint {
  let [oldRemainder, remainder] = [value % modulus, modulus];
  let [oldCoefficient, coefficient] = [1n, 0n];

  while (remainder !== 0n) {
    const quotient = oldRemainder / remainder;
    [oldRemainder, remainder] = [remainder, oldRemainder - quotient * remainder];
    [oldCoefficient, coefficient] = [coefficient, oldCoefficient - quotient * coefficient];
  }

  if (oldRemainder !== 1n) {
    throw new Error("Multiplier is not coprime with the code space");
  }

  return ((oldCoefficient % modulus) + modulus) % modulus;
}

export function encodeId(id: bigint): string {
  if (id < 0n || id >= CODE_SPACE) {
    throw new RangeError(`Id ${id} is outside the code space`);
  }

  return base62Encode((id * MULTIPLIER) % CODE_SPACE).padStart(CODE_LENGTH, "0");
}

/**
 * Inverse of encodeId. Returns null when the code cannot possibly have been
 * issued by us, which lets the redirect path reject junk without a database
 * round trip.
 */
export function decodeCode(code: string): bigint | null {
  if (code.length !== CODE_LENGTH) {
    return null;
  }

  const scrambled = base62Decode(code);
  if (scrambled === null || scrambled >= CODE_SPACE) {
    return null;
  }

  return (scrambled * INVERSE) % CODE_SPACE;
}
