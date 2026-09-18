/**
 * Reciprocal Rank Fusion of a lexical result list and a semantic one.
 *
 * RRF is used rather than score blending because BM25 scores and cosine
 * similarities are not on a comparable scale, and BM25 magnitudes shift with
 * corpus size. Fusing *ranks* sidesteps normalisation entirely.
 *
 * Pure: no database, no embedding provider, no I/O.
 */

/** Matches pi-knowledge-search, which in turn follows the original RRF paper. */
export const RRF_K = 60;

export interface Ranked<T> {
  item: T;
  /** Fused score. Higher is better. Not comparable across queries. */
  score: number;
  /** Which retrieval paths contributed, for debugging and for tests. */
  sources: ReadonlyArray<"lexical" | "semantic">;
}

/**
 * Fuse two ranked lists by reciprocal rank.
 *
 * Each list contributes `1 / (k + rank)` per item, rank being 0-based. An item
 * found by both paths therefore outranks one found by either alone, which is
 * the property we want: agreement between lexical and semantic retrieval is
 * the strongest available relevance signal.
 *
 * `identity` maps an item to its dedup key. Items are assumed unique within
 * each input list; a duplicate inside one list keeps its best (first) rank.
 */
export function reciprocalRankFusion<T>(
  lexical: readonly T[],
  semantic: readonly T[],
  identity: (item: T) => string,
  k: number = RRF_K,
): Ranked<T>[] {
  const merged = new Map<string, { item: T; score: number; sources: Set<"lexical" | "semantic"> }>();

  const contribute = (list: readonly T[], source: "lexical" | "semantic") => {
    const seen = new Set<string>();
    list.forEach((item, rank) => {
      const id = identity(item);
      if (seen.has(id)) return; // keep best rank only
      seen.add(id);

      const weight = 1 / (k + rank);
      const existing = merged.get(id);
      if (existing) {
        existing.score += weight;
        existing.sources.add(source);
      } else {
        merged.set(id, { item, score: weight, sources: new Set([source]) });
      }
    });
  };

  contribute(lexical, "lexical");
  contribute(semantic, "semantic");

  return [...merged.values()]
    .map(({ item, score, sources }) => ({
      item,
      score,
      // Stable order so assertions and output do not depend on Set iteration.
      sources: (["lexical", "semantic"] as const).filter((s) => sources.has(s)),
    }))
    .sort((a, b) => b.score - a.score);
}
