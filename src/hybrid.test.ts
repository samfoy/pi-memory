import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { reciprocalRankFusion, RRF_K } from "./hybrid.js";
import { cosine, toBlob, fromBlob } from "./vector.js";

type Item = { key: string };
const k = (key: string): Item => ({ key });
const id = (i: Item) => i.key;

describe("reciprocalRankFusion", () => {
  it("returns an empty list when both inputs are empty", () => {
    assert.deepEqual(reciprocalRankFusion<Item>([], [], id), []);
  });

  it("passes a single list through in order", () => {
    const out = reciprocalRankFusion([k("a"), k("b"), k("c")], [], id);
    assert.deepEqual(out.map((r) => r.item.key), ["a", "b", "c"]);
    assert.deepEqual(out.map((r) => r.sources), [["lexical"], ["lexical"], ["lexical"]]);
  });

  it("ranks an item found by both paths above one found by either alone", () => {
    // "b" is rank 1 in both lists; "a" is rank 0 in lexical only.
    const out = reciprocalRankFusion([k("a"), k("b")], [k("c"), k("b")], id);
    assert.equal(out[0]!.item.key, "b");
    assert.deepEqual(out[0]!.sources, ["lexical", "semantic"]);
  });

  it("scores by reciprocal rank with the documented k", () => {
    const out = reciprocalRankFusion([k("a")], [], id);
    assert.equal(out[0]!.score, 1 / (RRF_K + 0));
  });

  it("sums contributions from both paths", () => {
    const out = reciprocalRankFusion([k("a")], [k("a")], id);
    assert.equal(out[0]!.score, 2 / RRF_K);
  });

  it("keeps the best rank when one list repeats an item", () => {
    // A duplicate at a worse rank must not add a second contribution.
    const out = reciprocalRankFusion([k("a"), k("a")], [], id);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.score, 1 / RRF_K);
  });

  it("reports sources in a stable order regardless of discovery order", () => {
    const semanticFirst = reciprocalRankFusion([k("a")], [k("a")], id);
    assert.deepEqual(semanticFirst[0]!.sources, ["lexical", "semantic"]);
  });

  it("is not affected by which list is longer", () => {
    const out = reciprocalRankFusion([k("x")], [k("a"), k("b"), k("c"), k("x")], id);
    // x: 1/60 + 1/63 beats a: 1/60 alone.
    assert.equal(out[0]!.item.key, "x");
  });
});

describe("cosine", () => {
  const v = (...xs: number[]) => Float32Array.from(xs);

  it("is 1 for identical direction", () => {
    assert.ok(Math.abs(cosine(v(1, 0, 0), v(1, 0, 0)) - 1) < 1e-6);
  });

  it("is 0 for orthogonal vectors", () => {
    assert.ok(Math.abs(cosine(v(1, 0), v(0, 1))) < 1e-6);
  });

  it("is -1 for opposite direction", () => {
    assert.ok(Math.abs(cosine(v(1, 0), v(-1, 0)) + 1) < 1e-6);
  });

  it("ignores magnitude", () => {
    assert.ok(Math.abs(cosine(v(1, 1), v(5, 5)) - 1) < 1e-6);
  });

  it("returns 0 rather than NaN for a zero vector", () => {
    assert.equal(cosine(v(0, 0), v(1, 1)), 0);
  });

  it("returns 0 for mismatched lengths, so a stale-width vector is inert", () => {
    // This is what makes pre-#31 384-dim vectors harmless next to 512-dim ones.
    assert.equal(cosine(v(1, 2, 3), v(1, 2)), 0);
  });

  it("returns 0 for empty vectors", () => {
    assert.equal(cosine(v(), v()), 0);
  });
});

describe("blob round-trip", () => {
  it("preserves values", () => {
    const original = Float32Array.from([0.5, -0.25, 1, 0]);
    const back = fromBlob(toBlob(original));
    assert.ok(back);
    assert.deepEqual([...back!], [...original]);
  });

  it("returns null for absent or empty input", () => {
    assert.equal(fromBlob(null), null);
    assert.equal(fromBlob(undefined), null);
    assert.equal(fromBlob(Buffer.alloc(0)), null);
  });

  it("returns null for a truncated blob", () => {
    assert.equal(fromBlob(Buffer.alloc(7)), null);
  });

  it("handles a misaligned byteOffset", () => {
    // Buffer.from pools small allocations, so a sliced view is often offset by
    // a non-multiple of 4 and cannot back a Float32Array directly.
    const pool = Buffer.alloc(20);
    Float32Array.from([1, 2, 3, 4]).forEach((n, i) => pool.writeFloatLE(n, 4 + i * 4));
    const view = pool.subarray(4);
    const back = fromBlob(view);
    assert.ok(back);
    assert.deepEqual([...back!], [1, 2, 3, 4]);
  });
});
