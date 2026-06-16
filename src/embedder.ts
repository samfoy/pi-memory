/**
 * Lazy embedding pipeline using @xenova/transformers (optional dependency).
 * Gracefully degrades to FTS-only when the package is unavailable or the
 * model fails to load.
 *
 * Model: Xenova/all-MiniLM-L6-v2 (quantized int8, ~6 MB download, 384 dims).
 * Cached in ~/.cache/huggingface/hub/ after first download.
 */

const MODEL = "Xenova/all-MiniLM-L6-v2";
const LOAD_TIMEOUT_MS = 30_000;
const INFER_TIMEOUT_MS = 5_000;
const TEXT_CHAR_LIMIT = 512;

let _pipe: unknown = null;
let _failed = false;

async function getPipe(): Promise<unknown> {
  if (_failed) return null;
  if (_pipe) return _pipe;
  try {
    // Dynamic import — @xenova/transformers is optional; catch if absent.
    // String variable prevents TypeScript from resolving the type (it's optional).
    const pkg = "@xenova/transformers";
    const mod = await import(pkg).catch(() => null) as any;
    if (!mod) {
      console.error("pi-memory: @xenova/transformers not installed, semantic search disabled");
      _failed = true;
      return null;
    }
    const { pipeline, env } = mod;
    env.allowRemoteModels = true;
    env.useBrowserCache = false;
    _pipe = await withTimeout(
      pipeline("feature-extraction", MODEL, { quantized: true }),
      LOAD_TIMEOUT_MS,
      "model load",
    );
    return _pipe;
  } catch (err: unknown) {
    console.error(`pi-memory: embedder unavailable (${(err as any)?.message ?? err}), using FTS-only`);
    _failed = true;
    return null;
  }
}

/** Compute a normalized embedding for text. Returns null on any failure. */
export async function embed(text: string): Promise<Float32Array | null> {
  const pipe = await getPipe();
  if (!pipe) return null;
  try {
    const out = await withTimeout(
      (pipe as any)(text.slice(0, TEXT_CHAR_LIMIT), { pooling: "mean", normalize: true }),
      INFER_TIMEOUT_MS,
      "inference",
    );
    return new Float32Array((out as any).data);
  } catch {
    return null;
  }
}

/**
 * Cosine similarity of two normalized unit vectors (dot product).
 * Both vectors must have been produced with normalize:true.
 */
export function similarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}

/**
 * Serialize a Float32Array to a Buffer for SQLite BLOB storage.
 * Creates a copy to avoid shared-buffer aliasing issues.
 */
export function toBlob(v: Float32Array): Buffer {
  return Buffer.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
}

/**
 * Deserialize a SQLite BLOB back to Float32Array.
 * Returns null for null/undefined input.
 * Uses Uint8Array.from to produce a fresh, owned ArrayBuffer — safe when
 * node:sqlite returns a Buffer whose .buffer is a shared backing store.
 */
export function fromBlob(b: Buffer | null | undefined): Float32Array | null {
  if (!b) return null;
  const raw = Uint8Array.from(b); // copy — handles non-zero byteOffset
  return new Float32Array(raw.buffer);
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms),
    ),
  ]);
}
