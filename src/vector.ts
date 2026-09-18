/**
 * Vector helpers: cosine similarity and BLOB (de)serialization.
 *
 * Pure and dependency-free so the fusion path can be unit tested without an
 * embedding provider or a database.
 */

/**
 * Cosine similarity of two equal-length vectors, in [-1, 1].
 *
 * Returns 0 for mismatched lengths or a zero-magnitude vector rather than
 * NaN, so a malformed stored embedding degrades to "no signal" instead of
 * poisoning the ranking.
 */
export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/** Serialize a vector for storage in the `semantic.embedding` BLOB column. */
export function toBlob(v: Float32Array): Buffer {
  return Buffer.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
}

/**
 * Deserialize a stored BLOB. Returns null for absent or truncated data.
 *
 * A Float32Array needs a byte length divisible by 4 and an offset aligned to
 * 4; `Buffer.from` pools small allocations, so the underlying ArrayBuffer is
 * usually shared and misaligned. Copy when alignment does not hold.
 */
export function fromBlob(b: Buffer | Uint8Array | null | undefined): Float32Array | null {
  if (!b || b.byteLength === 0 || b.byteLength % 4 !== 0) return null;
  if (b.byteOffset % 4 === 0) {
    return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  }
  const copy = Uint8Array.prototype.slice.call(b);
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}
