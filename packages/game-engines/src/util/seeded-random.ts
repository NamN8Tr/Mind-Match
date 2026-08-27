/**
 * Deterministic PRNG derived from a string seed (xmur3 hash -> mulberry32 generator).
 * Used so both players in a ranked match receive the identical board/puzzle: given
 * the same seed string, `pickIndex` always returns the same index into an array of
 * a given length, on any machine, forever.
 */

function xmur3(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function mulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSeededRandom(seed: string): () => number {
  const seedFn = xmur3(seed);
  return mulberry32(seedFn());
}

export function pickIndex(seed: string, length: number): number {
  if (length <= 0) {
    throw new Error("Cannot pick an index from an empty list");
  }
  const random = createSeededRandom(seed);
  return Math.floor(random() * length);
}
