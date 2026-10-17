import type { CommitRecord } from "./history.js";
import type { CouplingEdge } from "../types.js";

export interface CouplingOptions {
  /** Minimum commits in which two files must appear together. */
  minCoChanges: number;
  /** Minimum directional confidence (0..1) for an edge to be stored. */
  minConfidence: number;
  /** Skip commits touching more than this many files. */
  maxMassCommitFiles: number;
  /** Hard cap on stored edges, highest-confidence first. */
  maxEdges: number;
  /** Hard cap on pairs tracked per file, to stop hub files blowing up memory. */
  maxPairsPerFile: number;
}

export const DEFAULT_COUPLING: CouplingOptions = {
  minCoChanges: 3,
  minConfidence: 0.25,
  maxMassCommitFiles: 80,
  maxEdges: 400_000,
  maxPairsPerFile: 400,
};

export interface CouplingResult {
  edges: CouplingEdge[];
  fileCounts: Map<string, number>;
  stats: {
    commits: number;
    commitsUsed: number;
    commitsSkippedAsMass: number;
    pairsConsidered: number;
    pairsAboveMin: number;
    edgesStored: number;
    filesTracked: number;
    ms: number;
    truncatedAtMaxEdges: boolean;
/**
 * Pairs that cleared `minCoChanges` but were dropped by the per-file partner
 * budget, so the stored graph is a strict subset of what history recorded.
 * Reported rather than hidden: a non-zero value means `edgesStored` is not the
 * whole truth about the repository.
 */
pairsFilteredByBudget: number;
pairsOverBudget: number;
  };
}

/**
 * Recount one pair straight from the commit log, with no budget and no caching.
 *
 * This is the authority for `coChanges`. It exists because a stored count that
 * disagrees with its own recount is a correctness failure, and the only way to
 * prove a stored count is right is to recompute it from the source. Deliberately
 * naive: a Set of Sets, no pair budget, no short-circuits.
 */
export function recountPair(commits: CommitRecord[], a: string, b: string, maxMassFiles = 80): number {
  let count = 0;
  for (const commit of commits) {
    if (commit.files.length < 2 || commit.files.length > maxMassFiles) continue;
    if (commit.files.includes(a) && commit.files.includes(b)) count++;
  }
  return count;
}

const NUL = "\u0000";
const key = (a: string, b: string) => `${a}${NUL}${b}`;
/** Canonical unordered pair so one coupling is stored once, not twice. */
const canonical = (a: string, b: string): [string, string] => (a <= b ? [a, b] : [b, a]);

/**
 * Change coupling, the classical measure, computed exactly and without sampling.
 *
 * For every commit with at least two in-scope files, each unordered pair is
 * counted. Then, for pair (a, b):
 *
 *   confidenceAB = |changes(a) n changes(b)| / |changes(a)|
 *   confidenceBA = |changes(a) n changes(b)| / |changes(b)|
 *   support      = |changes(a) n changes(b)| / |all commits|
 *   jaccard      = |. . .| / |changes(a) u changes(b)|
 *
 * Confidence is directional on purpose: if a config file always accompanies a
 * handler, then changes(handler) rarely implies changes(config), and an agent
 * that treats that as symmetric will drown the developer in noise.
 */
export function computeCouplings(commits: CommitRecord[], options: Partial<CouplingOptions> = {}): CouplingResult {
  const started = Date.now();
  const opts = { ...DEFAULT_COUPLING, ...options };

  const fileCounts = new Map<string, number>();
  /** Every pair ever seen together. Never pruned: these counts are the answer. */
  const pairCounts = new Map<string, number>();
  /** Pairs still eligible to be stored, after the per-file partner budget. */
  const storeable = new Set<string>();
  const perFilePairs = new Map<string, number>();

  let commitsUsed = 0;
  let commitsSkippedAsMass = 0;
  let pairsConsidered = 0;
  let pairsOverBudget = 0;

  for (const commit of commits) {
    if (commit.files.length < 2) {
      if (commit.files.length === 1) bump(fileCounts, commit.files[0]!, 1);
      continue;
    }

    if (commit.files.length > opts.maxMassCommitFiles) {
      commitsSkippedAsMass++;
      for (const f of commit.files) bump(fileCounts, f, 1);
      continue;
    }

    commitsUsed++;
    for (const f of commit.files) bump(fileCounts, f, 1);

    const unique = Array.from(new Set(commit.files));
    for (let i = 0; i < unique.length; i++) {
      const a = unique[i]!;
      for (let j = i + 1; j < unique.length; j++) {
        const b = unique[j]!;
        pairsConsidered++;

        const [ca, cb] = canonical(a, b);
        const k = key(ca, cb);

        // Count unconditionally. `coChanges` is the ranking signal for every
        // downstream feature and `verify` recounts it from the commit log with no
        // cap, so a count that depends on how many other pairs happened to be seen
        // first is simply wrong.
        pairCounts.set(k, (pairCounts.get(k) ?? 0) + 1);

        // Budget which pairs get *stored*, not which get counted. Skipping the
        // increment here is what previously made 18 of 25 stored counts disagree
        // with their own recount on vercel/next.js: `package.json` has 5,912
        // distinct partners there and the cap was 400, so the files that most
        // needed a correct count had the least accurate one.
        if (!storeable.has(k)) {
          const pa = perFilePairs.get(a) ?? 0;
          const pb = perFilePairs.get(b) ?? 0;
          if (pa >= opts.maxPairsPerFile || pb >= opts.maxPairsPerFile) {
            pairsOverBudget++;
            continue;
          }
          storeable.add(k);
          perFilePairs.set(a, pa + 1);
          perFilePairs.set(b, pb + 1);
        }
      }
    }
  }

  let pairsAboveMin = 0;
  let pairsFilteredByBudget = 0;
  const candidates: CouplingEdge[] = [];

  for (const [k, coChanges] of pairCounts) {
    if (coChanges < opts.minCoChanges) continue;
    pairsAboveMin++;

    // Over budget but strong enough to matter: recorded so the ingest report can
    // state that the stored graph is a subset rather than implying completeness.
    if (!storeable.has(k)) {
      pairsFilteredByBudget++;
      continue;
    }

    const sep = k.indexOf(NUL);
    const a = k.slice(0, sep);
    const b = k.slice(sep + 1);

    const changesA = fileCounts.get(a) ?? 0;
    const changesB = fileCounts.get(b) ?? 0;
    if (changesA === 0 || changesB === 0) continue;

    const confidenceAB = coChanges / changesA;
    const confidenceBA = coChanges / changesB;
    const maxConfidence = Math.max(confidenceAB, confidenceBA);
    if (maxConfidence < opts.minConfidence) continue;

    candidates.push({
      a,
      b,
      coChanges,
      changesA,
      changesB,
      confidenceAB: round(confidenceAB),
      confidenceBA: round(confidenceBA),
      maxConfidence: round(maxConfidence),
      support: round(coChanges / commitsUsed),
      jaccard: round(coChanges / (changesA + changesB - coChanges)),
      hasImport: false,
    });
  }

  candidates.sort((x, y) => y.coChanges - x.coChanges || y.maxConfidence - x.maxConfidence);
  const truncatedAtMaxEdges = candidates.length > opts.maxEdges;
  const edges = truncatedAtMaxEdges ? candidates.slice(0, opts.maxEdges) : candidates;

  return {
    edges,
    fileCounts,
    stats: {
      commits: commits.length,
      commitsUsed,
      commitsSkippedAsMass,
      pairsConsidered,
      pairsAboveMin,
      edgesStored: edges.length,
      filesTracked: fileCounts.size,
      ms: Date.now() - started,
      truncatedAtMaxEdges,
      /** Strong pairs excluded from the graph by the per-file partner budget. */
      pairsFilteredByBudget,
      /** Times the budget bound while counting. Diagnostics only. */
      pairsOverBudget,
    },
  };
}

/**
 * Independent recomputation used by `verify` and by the certificate's
 * reproducibility claim. Deliberately naive: a Map of Maps, no canonical keys,
 * no caching. If this agrees with FalkorDB, the graph traversal is honest.
 */
export function oracleCouplings(
  commits: CommitRecord[],
  opts: { minCoChanges: number; minConfidence: number; maxMassCommitFiles: number },
): { a: string; b: string; coChanges: number; maxConfidence: number }[] {
  const counts = new Map<string, number>();
  const eligible = commits.filter((c) => c.files.length >= 2 && c.files.length <= opts.maxMassCommitFiles);
  const changeSets: Set<string>[] = eligible.map((c) => new Set(c.files));

  for (const set of changeSets) {
    for (const f of set) counts.set(f, (counts.get(f) ?? 0) + 1);
  }

  const names = Array.from(counts.keys()).sort();
  const out: { a: string; b: string; coChanges: number; maxConfidence: number }[] = [];

  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i]!;
      const b = names[j]!;
      let co = 0;
      for (const set of changeSets) {
        if (set.has(a) && set.has(b)) co++;
      }
      if (co < opts.minCoChanges) continue;
      const maxConfidence = Math.max(co / counts.get(a)!, co / counts.get(b)!);
      if (maxConfidence < opts.minConfidence) continue;
      out.push({ a, b, coChanges: co, maxConfidence: round(maxConfidence) });
    }
  }
  return out;
}

/** Bounded BFS over an adjacency map. Used to precompute hasImport. */
export function reachable(
  adjacency: Map<string, string[]>,
  start: string,
  maxDepth: number,
  cap = 3000,
): Set<string> {
  const seen = new Set<string>();
  let frontier = [start];
  for (let depth = 0; depth < maxDepth && frontier.length > 0 && seen.size < cap; depth++) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const neighbour of adjacency.get(node) ?? []) {
        if (neighbour === start || seen.has(neighbour)) continue;
        seen.add(neighbour);
        if (seen.size >= cap) break;
        next.push(neighbour);
      }
    }
    frontier = next;
  }
  return seen;
}

function bump(map: Map<string, number>, key: string, by: number): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}