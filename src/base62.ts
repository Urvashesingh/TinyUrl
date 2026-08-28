// Base62 codec over bigints.
//
// The alphabet order is part of the wire format: changing it invalidates every
// short code already handed out, so treat it as frozen.
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = BigInt(ALPHABET.length);

const VALUE_OF = new Map<string, bigint>(
  [...ALPHABET].map((character, index) => [character, BigInt(index)]),
);

export function base62Encode(value: bigint): string {
  if (value < 0n) {
    throw new RangeError("base62Encode expects a non-negative value");
  }

  if (value === 0n) {
    return ALPHABET[0];
  }

  let remaining = value;
  let encoded = "";

  while (remaining > 0n) {
    encoded = ALPHABET[Number(remaining % BASE)] + encoded;
    remaining /= BASE;
  }

  return encoded;
}

/** Returns null for anything that is not a well-formed base62 string. */
export function base62Decode(text: string): bigint | null {
  if (text.length === 0) {
    return null;
  }

  let decoded = 0n;

  for (const character of text) {
    const digit = VALUE_OF.get(character);
    if (digit === undefined) {
      return null;
    }

    decoded = decoded * BASE + digit;
  }

  return decoded;
}
