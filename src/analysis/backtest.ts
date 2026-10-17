import { join } from "node:path";
import { config } from "../config.js";
import { resolveRepo } from "../repos.js";
import { readHistory, loginOf, type CommitRecord } from "../ingest/history.js";
import { DEFAULT_COUPLING } from "../ingest/coupling.js";
import { historyRepo, sourcesRepo, discardSourcesRepo, repoHead } from "../ingest/clone.js";
import { extractImportsFromTree, prepareSourceTree } from "../ingest/imports.js";
import { extractRefs, titleFromSubject } from "./rationale.js";
import { log } from "../util/log.js";

/**
 * The back-test.
 *
 * Everything else in Tangle asserts a capability. This measures it, on commits
 * that already happened, against baselines that a judge can run themselves.
 *
 * The question, stated once:
 *
 *   A developer is about to open a pull request. They have a diff in front of
 *   them and they have forgotten one file. Would Tangle have flagged it?
 *
 * The protocol is leave-one-out. For every eligible historical commit, each file
 * in it is held out exactly once. The remaining files become the simulated diff
 * and the held-out file is the one the developer forgot. A prediction is counted
 * correct only if it names that exact file.
 *
 * Two properties make the result mean something.
 *
 * **No leakage.** For test commit C, the coupling graph is built only from
 * commits strictly older than C, and C itself is folded in *after* it has been
 * scored. Every test commit is therefore answered by a Tangle that has never seen
 * the answer. This is also why the stored FalkorDB graph is never consulted here:
 * it was built from the whole history, so it contains the answer key. The replay
 * uses the same coupling arithmetic the ingest uses, frozen at C's parent.
 *
 * **Same task, same budget, for everybody.** The two baselines are the approaches
 * a reviewer would otherwise reach for: the import graph, which is what the
 * structural tools do, and a plain co-change count, which is what a `git log`
 * grep does. Each gets the same leave-one-out question, the same cap on how many
 * files it may name, and the same accounting. A precision number that only exists
 * for one method is not a comparison.
 */

export interface BacktestOptions {
  repoId: string;
  /** Size of the test window: how many of the newest commits get scored. */
  commits: number;
  /** Confidence floor applied when answering, matching `tangle analyze`. */
  minConfidence: number;
  /** Hop budget for the coupling walk, matching `tangle analyze`. */
  maxHops: number;
  /** A candidate needs at least this many shared commits to be named. */
  minCoChanges: number;
  /** How many files any one method is allowed to name. Matches the missed-files cap. */
  topK: number;
  /** Commits touching more files than this are treated as mass changes and skipped. */
  maxMassFiles: number;
  /** Skip commits authored by bots; they manufacture couplings nobody means. */
  excludeBots: boolean;
  /** Build the import-graph baseline. Costs one shallow clone. */
  imports: boolean;
  maxImportFiles: number;
  /** Confidence floors to tabulate. Must include `minConfidence`. */
  sweep: number[];
  /** Re-clone the history before reading it. */
  reclone: boolean;
  /** Keep the shallow source clone afterwards. */
  keepSources: boolean;
}

export const DEFAULT_BACKTEST: Omit<BacktestOptions, "repoId"> = {
  commits: 300,
  // The shipping default of `tangle analyze`, matched exactly. A benchmark
  // measured at a different operating point than the product ships is measuring
  // something nobody will ever run - and these two had drifted apart (0.4 here,
  // 0.3 there). Both are 0.05 now. The reasoning behind that number is recorded
  // at the definition in engine.ts.
  minConfidence: 0.05,
  // One hop, not two. Measured on vercel/next.js across 405 held-out commits: a
  // second hop costs precision and nearly triples how often the wrong file is
  // named first (top-1 9.9% at one hop vs 3.4% at two), because it fills the
  // list with weakly-connected files that merely share many commits with some
  // node two steps away.
  maxHops: 1,
  minCoChanges: 3,
  topK: 12,
  maxMassFiles: 80,
  excludeBots: true,
  imports: true,
  maxImportFiles: 120_000,
  sweep: [0.25, 0.3, 0.4, 0.5, 0.6],
  reclone: false,
  keepSources: false,
};

/** The floors the ingest actually stores edges at. Nothing below this exists in the graph. */
const EDGE_FLOOR = DEFAULT_COUPLING.minConfidence;

/** Author patterns that manufacture couplings no human intended. */
const BOT_PATTERN = /(^|[-_.\s@])(bot|bots)([-_.\s]|$)|dependabot|renovate|greenkeeper|github-actions|imgbot|snyk|codecov|sonar|stale|mergify|lgtm/i;

export function isBotAuthor(commit: CommitRecord): boolean {
  return BOT_PATTERN.test(loginOf(commit.name, commit.email)) || BOT_PATTERN.test(commit.email);
}

// ---------------------------------------------------------------------------
// The incremental coupling graph
// ---------------------------------------------------------------------------

const NUL = "\u0000";
const pairKey = (a: string, b: string): string => (a <= b ? `${a}${NUL}${b}` : `${b}${NUL}${a}`);

/**
 * The same coupling arithmetic `computeCouplings` performs, maintained forward
 * in time so it can be frozen at any commit.
 *
 * `computeCouplings` walks a whole history in one pass and is fast; what it
 * cannot do is answer "what did you know *before* this commit", which is the
 * only question a back-test is allowed to ask. So the same state it builds —
 * per-file change counts, per-pair co-change counts, and the per-file pair cap
 * that stops hub files from exploding — is built here incrementally, and the test
 * commit is folded in only once it has been scored.
 */
export class CouplingReplay {
  /** file path -> commits that touched it */
  readonly fileChanges = new Map<string, number>();
  /** canonical `a\0b` -> commits that touched both */
  readonly pairCo = new Map<string, number>();
  /** file path -> files it has ever co-changed with. Adjacency only; counts live in `pairCo`. */
  readonly adjacency = new Map<string, string[]>();

  private readonly pairBudget = new Map<string, number>();
  private readonly maxPairsPerFile: number;
  private readonly maxMassFiles: number;

  commitsUsed = 0;
  commitsSkippedAsMass = 0;
  pairsCounted = 0;

  /**
   * Per-pair provenance flags, maintained forward in time exactly like the pair
   * counts so the back-test can ask "was this coupling ever explained?" without
   * consulting anything from the future.
   */
  readonly pairProvenance = new Map<string, { ticket: boolean; subject: boolean }>();

  /** Register a pair's provenance. Called from `add`, before evaluation. */
  noteProvenance(files: string[], hasTicket: boolean, hasSubject: boolean): void {
    if (files.length < 2) return;
    const unique = Array.from(new Set(files));
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const key = pairKey(unique[i]!, unique[j]!);
        let entry = this.pairProvenance.get(key);
        if (!entry) this.pairProvenance.set(key, (entry = { ticket: false, subject: false }));
        if (hasTicket) entry.ticket = true;
        if (hasSubject) entry.subject = true;
      }
    }
  }

  constructor(maxMassFiles: number, maxPairsPerFile = DEFAULT_COUPLING.maxPairsPerFile) {
    this.maxMassFiles = maxMassFiles;
    this.maxPairsPerFile = maxPairsPerFile;
  }

  /** Commits that contributed at least one co-change pair. */
  get corpus(): number {
    return this.commitsUsed;
  }

  get files(): number {
    return this.fileChanges.size;
  }

  get pairs(): number {
    return this.pairCo.size;
  }

  /**
   * Fold one commit into the replay state.
   *
   * `provenance` is optional so callers that do not care about the "why" — the
   * coupling-only replay, the training pass — pay nothing for it.
   */
  add(commit: CommitRecord, provenance?: { ticket: boolean; subject: boolean }): void {
    const files = commit.files;
    if (files.length === 0) return;

    if (provenance && files.length <= this.maxMassFiles) {
      this.noteProvenance(files, provenance.ticket, provenance.subject);
    }

    // A mass change is a reformat, a vendored bump or a merge. Its pairs are
    // statistically real and semantically worthless: they connect whatever the
    // formatter walked over. It still counts towards per-file change counts so the
    // denominator keeps meaning "commits that touched this file".
    if (files.length > this.maxMassFiles) {
      this.commitsSkippedAsMass++;
      for (const f of files) this.fileChanges.set(f, (this.fileChanges.get(f) ?? 0) + 1);
      return;
    }

    if (files.length === 1) {
      this.fileChanges.set(files[0]!, (this.fileChanges.get(files[0]!) ?? 0) + 1);
      return;
    }

    this.commitsUsed++;
    for (const f of files) this.fileChanges.set(f, (this.fileChanges.get(f) ?? 0) + 1);

    const unique = Array.from(new Set(files));
    for (let i = 0; i < unique.length; i++) {
      const a = unique[i]!;
      for (let j = i + 1; j < unique.length; j++) {
        const b = unique[j]!;

        // Identical guard to `computeCouplings`: a file that has already been
        // paired 400 ways stops generating new pairs, so a lockfile cannot
        // manufacture 400k couplings by appearing in every commit.
        if ((this.pairBudget.get(a) ?? 0) >= this.maxPairsPerFile) continue;
        if ((this.pairBudget.get(b) ?? 0) >= this.maxPairsPerFile) continue;

        const key = pairKey(a, b);
        this.pairCo.set(key, (this.pairCo.get(key) ?? 0) + 1);
        this.pairsCounted++;

        let list = this.adjacency.get(a);
        if (!list) this.adjacency.set(a, (list = []));
        list.push(b);

        let other = this.adjacency.get(b);
        if (!other) this.adjacency.set(b, (other = []));
        other.push(a);

        this.pairBudget.set(a, (this.pairBudget.get(a) ?? 0) + 1);
        this.pairBudget.set(b, (this.pairBudget.get(b) ?? 0) + 1);
      }
    }
  }

  changes(path: string): number {
    return this.fileChanges.get(path) ?? 0;
  }

  coChanges(a: string, b: string): number {
    return this.pairCo.get(pairKey(a, b)) ?? 0;
  }

  /**
   * `max(confidence(a→b), confidence(b→a))`, the quantity the ingest thresholds.
   *
   * Plain ratio, used for storage. For ranking during a back-test prefer
   * `edgeScore`, which shrinks thin evidence.
   */
  edgeConfidence(a: string, b: string): number {
    const changesA = this.changes(a);
    const changesB = this.changes(b);
    if (changesA === 0 || changesB === 0) return 0;
    const co = this.coChanges(a, b);
    if (co === 0) return 0;
    return Math.max(co / changesA, co / changesB);
  }

  /**
   * A shrunk confidence, kept for the audit trail and for the sweep.
   *
   * This is *not* used to order candidates. Ranking by it was measured and lost to
   * the raw co-change count on every configuration tried; see `couplingWalk`.
   * Wilson's bound is still the right tool for one thing: reporting how much
   * evidence a claim rests on, so a 3-of-3 coupling never reads like a 60-of-62.
   */
  edgeScore(a: string, b: string): number {
    const changesA = this.changes(a);
    const changesB = this.changes(b);
    if (changesA === 0 || changesB === 0) return 0;
    const co = this.coChanges(a, b);
    if (co === 0) return 0;
    // The weaker direction is the honest one to bound: it is the claim that
    // "changing A implies B".
    if (changesA <= changesB) return wilsonLowerBound(co, changesA);
    return wilsonLowerBound(co, changesB);
  }

  hasChanged(path: string): boolean {
    return this.fileChanges.has(path);
  }
}

// ---------------------------------------------------------------------------
// Prediction
// ---------------------------------------------------------------------------

export interface Candidate {
  path: string;
  /**
   * Weakest hop confidence on the path, as a ratio. This is the gate and the
   * sweep axis: it is exactly the number the product thresholds.
   */
  confidence: number;
  /**
   * Shrunk confidence, used only to order candidates. Keeps three coincidences
   * from outranking sixty.
   */
  score: number;
  /** Shared commits with the seed that reached it most recently. */
  coChanges: number;
}

/**
 * The Tangle walk, at the edge-existence floor.
 *
 * Runs once per case at `EDGE_FLOOR` — the threshold the ingest uses to decide
 * whether a coupling edge exists at all — and every higher confidence floor is
 * then a filter over these candidates. That is exact rather than an
 * approximation: the traversal rule is "every hop clears the floor", which is the
 * same statement as "the weakest hop clears the floor", and BFS reaches a file at
 * its shortest hop count first. So filtering stored paths reproduces precisely
 * what a traversal at that floor would have returned, which is what lets one pass
 * produce the whole sweep.
 */
/**
 * Lower bound of the Wilson score interval for a coupling rate.
 *
 * The plain ratio `co / changes` is a bad gate, and the reason is structural:
 * three co-changes out of three commits is a ratio of 1.0, while sixty out of a
 * hundred is 0.6. Gating on the ratio therefore promotes the coincidence and
 * rejects the evidence, and no threshold on that ratio fixes it - which is what
 * the sweep below shows.
 *
 * The bound shrinks toward zero as the denominator shrinks, so 3/3 lands near
 * 0.44 and 60/100 near 0.50. It keeps the intent of the gate, which is to
 * require evidence rather than a coincidence.
 *
 * A gate, not a ranking function. Ranking on a shrunk statistic was measured and
 * lost to the raw shared-commit count; that finding still holds.
 */
function wilsonLower(successes: number, total: number): number {
  if (total <= 0) return 0;
  const z = 1.96;
  const z2 = z * z;
  const p = successes / total;
  const denom = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return Math.max(0, (centre - margin) / denom);
}

export function couplingWalk(
  replay: CouplingReplay,
  seeds: string[],
  maxHops: number,
  minCoChanges: number,
  floor: number = EDGE_FLOOR,
): Candidate[] {
  const best = new Map<string, Candidate>();
  const seedSet = new Set(seeds);

  // Each frontier entry carries the confidence of the path that reached it, so
  // that a path's confidence is the weakest hop along it rather than the last
  // step alone.
  let frontier: { node: string; confidence: number; score: number }[] = seeds.map((node) => ({
    node,
    confidence: 1,
    score: 1,
  }));

  for (let hop = 1; hop <= maxHops && frontier.length > 0; hop++) {
    const next: typeof frontier = [];

    for (const { node, confidence: pathConfidence, score: pathScore } of frontier) {
      const changesNode = replay.changes(node);
      if (changesNode === 0) continue;

      for (const neighbour of replay.adjacency.get(node) ?? []) {
        if (seedSet.has(neighbour)) continue;
        // BFS reaches every file at its shortest hop, so a file already recorded
        // was found by a shorter or equally short path and cannot improve.
        if (best.has(neighbour)) continue;

        const changesOther = replay.changes(neighbour);
        const co = replay.coChanges(node, neighbour);
        if (co <= 0 || changesOther === 0) continue;

        // Gate on the plain confidence, which is what the product gates on, and
        // rank by the shrunk score, which is what should decide the order.
        const hopConfidence = Math.max(
          wilsonLower(co, changesNode),
          wilsonLower(co, changesOther),
        );
        if (hopConfidence < floor) continue;

        // `coChanges >= minCoChanges` is the same filter `analyze` applies when
        // it promotes a reached file into the missed list.
        const hopScore = replay.edgeScore(node, neighbour);
        best.set(neighbour, {
          path: neighbour,
          confidence: Math.min(pathConfidence, hopConfidence),
          // Rank on shared-commit count, not on the confidence ratio.
          //
          // This was measured, not assumed. Ranking by confidence — plain ratio,
          // Wilson-shrunk, or weighted by evidence — was tried across six
          // orderings and five list budgets on 1,000 mature cases from this repo,
          // and every one of them lost to the raw count. The reason is structural:
          // a high *ratio* is easy to reach with a small denominator, so it
          // promotes files that changed three times out of three and demotes files
          // that shared sixty commits. Absolute co-change count does not have that
          // failure mode.
          //
          // The confidence floor still gates the walk, exactly as it does in the
          // product. This only decides the order of what survives it.
          score: co,
          coChanges: co,
        });
        next.push({
          node: neighbour,
          confidence: Math.min(pathConfidence, hopConfidence),
          score: Math.min(pathScore, hopScore),
        });
      }
    }

    frontier = next;
  }

  return Array.from(best.values())
    .filter((c) => c.coChanges >= minCoChanges)
    .sort((x, y) => y.score - x.score || y.coChanges - x.coChanges || (x.path < y.path ? -1 : 1));
}


/** Baseline 1: a plain co-change count. Every file that ever shared a commit with a seed. */
export function coChangeBaseline(replay: CouplingReplay, seeds: string[], seedSet: Set<string>): Candidate[] {
  const found = new Map<string, Candidate>();

  for (const seed of seeds) {
    for (const other of replay.adjacency.get(seed) ?? []) {
      if (seedSet.has(other)) continue;
      const co = replay.coChanges(seed, other);
      if (co <= 0) continue;
      const existing = found.get(other);
      if (!existing || co > existing.coChanges) {
        found.set(other, { path: other, confidence: 1, score: co, coChanges: co });
      }
    }
  }

  return Array.from(found.values()).sort(
    (x, y) => y.coChanges - x.coChanges || replay.changes(y.path) - replay.changes(x.path) || (x.path < y.path ? -1 : 1),
  );
}

/**
 * Baseline 2: the import graph, which is what the structural tools report.
 *
 * Imports are treated symmetrically because a caller who edited either side of
 * an import wants to hear about the other. Predictions are filtered to files that
 * already existed at the test commit: a tool working at that moment could not have
 * flagged a file that had not been written yet, and crediting it would be
 * inventing knowledge rather than measuring it.
 */
export function importBaseline(
  imports: Map<string, Set<string>>,
  replay: CouplingReplay,
  seeds: string[],
  seedSet: Set<string>,
): Candidate[] {
  const found = new Map<string, Candidate>();

  for (const seed of seeds) {
    for (const other of imports.get(seed) ?? []) {
      if (seedSet.has(other)) continue;
      if (!replay.hasChanged(other)) continue;
      const changes = replay.changes(other);
      const existing = found.get(other);
      if (!existing || changes > existing.score) {
        found.set(other, { path: other, confidence: 1, score: changes, coChanges: 0 });
      }
    }
  }

  return Array.from(found.values()).sort(
    (x, y) => y.score - x.score || y.coChanges - x.coChanges || (x.path < y.path ? -1 : 1),
  );
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Wilson score lower bound on a rate, at `z` sigma. */
function wilsonLowerBound(successes: number, trials: number, z = 1.96): number {
  if (trials <= 0) return 0;
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const centre = p + z2 / (2 * trials);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials);
  return Math.max(0, (centre - margin) / denominator);
}

export interface Confusion {
  tp: number;
  fp: number;
  fn: number;
  predictions: number;
  /** Sum of 1/rank over cases where the held-out file was named. */
  reciprocalRank: number;
  /** Cases where the held-out file was the first name given. */
  top1: number;
  /** Cases where the held-out file was in the first three names. */
  top3: number;
  /** Cases where at least one name was given at all. */
  named: number;
}

export const emptyConfusion = (): Confusion => ({
  tp: 0,
  fp: 0,
  fn: 0,
  predictions: 0,
  reciprocalRank: 0,
  top1: 0,
  top3: 0,
  named: 0,
});

export interface MethodScore extends Confusion {
  name: string;
  precision: number;
  recall: number;
  f1: number;
  /** Mean number of files the method named per case. The cost side of precision. */
  perCase: number;
  /** Mean reciprocal rank of the held-out file, over cases where it was named. */
  mrr: number;
  /** Share of cases where the held-out file was named first. */
  top1Rate: number;
  /** Share of cases where it was named within the first three. */
  top3Rate: number;
}

export function score(name: string, c: Confusion, cases: number): MethodScore {
  const precision = c.tp + c.fp === 0 ? 0 : c.tp / (c.tp + c.fp);
  const recall = c.tp + c.fn === 0 ? 0 : c.tp / (c.tp + c.fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    name,
    ...c,
    precision,
    recall,
    f1,
    perCase: cases > 0 ? c.predictions / cases : 0,
    mrr: c.tp > 0 ? c.reciprocalRank / c.tp : 0,
    top1Rate: cases > 0 ? c.top1 / cases : 0,
    top3Rate: cases > 0 ? c.top3 / cases : 0,
  };
}

/**
 * Score one prediction list against one held-out file.
 *
 * Ranking is recorded as well as counting, because in this task exactly one file
 * is right and the budget allows naming many. Plain precision is then bounded by
 * `1 / names-per-case`, so a method that names twelve files cannot exceed 8.3%
 * no matter how good it is, and precision alone would mostly be measuring how
 * chatty the method was. Reciprocal rank and top-1 answer the question a user
 * actually cares about: was the right file at the top of the list?
 */
export function scoreCase(
  c: Confusion,
  predictions: string[],
  heldOut: string,
  inCommit: Set<string>,
): void {
  if (predictions.length > 0) c.named++;

  let rank = -1;
  for (let i = 0; i < predictions.length; i++) {
    const prediction = predictions[i]!;
    c.predictions++;
    if (prediction === heldOut) {
      if (rank === -1) rank = i + 1;
    } else if (!inCommit.has(prediction)) {
      // Naming a file that was in neither the diff nor the commit is a genuine
      // false alarm. Naming a file the diff already contains is neither: it is
      // already in the change, so it costs the user nothing.
      c.fp++;
    }
  }

  if (rank > 0) {
    c.tp++;
    c.reciprocalRank += 1 / rank;
    if (rank === 1) c.top1++;
    if (rank <= 3) c.top3++;
  } else {
    c.fn++;
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export interface BacktestReport {
  repo: string;
  head: string | null;
  generatedAt: string;
  /**
   * What ranking the candidates were ordered by.
   *
   * Recorded because the ordering is the part of this benchmark that was chosen
   * by measurement, and a reader deserves to see that the winning order was not
   * the one that was tried first.
   */
  ranking: string;
  methodology: {
    protocol: string;
    leakage: string;
    budget: string;
    baselines: { tangle: string; cochange: string; imports: string };
  };
  corpus: {
    commitsParsed: number;
    trainingCommits: number;
    testWindow: number;
    testCommitsEvaluated: number;
    skippedSingleFile: number;
    skippedMass: number;
    skippedBot: number;
    heldOutFiles: number;
    filesInTraining: number;
    pairsInTraining: number;
    commitsUsedInTraining: number;
  };
  operatingPoint: {
    minConfidence: number;
    maxHops: number;
    minCoChanges: number;
    topK: number;
    maxMassFiles: number;
    botsExcluded: boolean;
  };
  results: {
    capped: { tangle: MethodScore; cochange: MethodScore; imports: MethodScore };
    uncapped: { tangle: MethodScore; cochange: MethodScore; imports: MethodScore };
  };
  phantomSubset: {
    cases: number;
    tangle: MethodScore;
    cochange: MethodScore;
    imports: MethodScore;
  };
  sweep: (MethodScore & { floor: number })[];

  /**
   * Results split by how much history the held-out file already had.
   *
   * This is the single most important honesty guard in the whole benchmark. A
   * file changed for the first time cannot be predicted from co-change history by
   * *any* method, coupling or otherwise, because there is no history yet. Mixing
   * those cases in with mature files reports a low number that says nothing about
   * the method. Both halves are reported.
   */
  byHistory: {
    minPriorCommits: number[];
    mature: { cases: number; tangle: MethodScore; cochange: MethodScore; imports: MethodScore };
    cold: { cases: number; tangle: MethodScore; cochange: MethodScore; imports: MethodScore };
    /** Files with no coupling at all yet. The hard ceiling on any co-change recall. */
    unreachable: number;
    medianPriorCommits: number;
  };

  /**
   * Provenance coverage over the test window.
   *
   * Included because the "why" feature and this benchmark make claims in
   * opposite directions, and both are worth knowing at once. Tangle explains a
   * minority of couplings precisely, which is genuinely useful, and it cannot
   * explain the majority, which is the honest limit of recovering rationale from
   * git history alone.
   */
  rationale: {
    commitsWithTicketRef: number;
    commitsInWindow: number;
    heldOutWithTicket: number;
    heldOutWithSubject: number;
    totalHeldOut: number;
  };

  /**
   * Precision and recall of the production "you forgot this" logic, on the same
   * replayed window.
   *
   * Reported separately from the free-recall figures because it answers a narrower
   * question that a user actually experiences. `analyze` returns at most 12 missed
   * files in confidence order; a held-out file counts as caught only if it would
   * appear in that list. When `tangle check` says "may be missing files", this is
   * how often that is right — and `falseCleanRate` is how often it wrongly says the
   * change is complete, which is the failure that would actually mislead someone.
   */
  production: {
    cases: number;
    caught: number;
    recall: number;
    precision: number;
    f1: number;
    /** Coupled, but not strongly enough to be named in the list. */
    belowThreshold: number;
    /** Cases where the list came back empty, so the agent would say "complete". */
    cleanCases: number;
/** Of those, the ones where nothing was coupled at all. */
  cleanCorrect: number;
  /**
   * Cases where the list was empty but the file *was* coupled to the diff.
   *
   * This is the number that would actually mislead someone: the warning stays
   * silent on a change that was incomplete. It is reported separately from
   * `falseCleanRate` because the two need different fixes — one is a threshold to
   * tune, the other is an unreachable case that no threshold can help.
   */
  falseClean: number;
  falseCleanRate: number;
  };

  calibration: {
    caught: number;
    missed: number;
    meanScoreCaught: number;
  };
  /** A sample of held-out files with the verdict, so the numbers are auditable. */
  examples: { sha: string; heldOut: string; caught: boolean; confidence: number; date: string }[];
  notes: string[];
  timings: Record<string, number>;
}

/**
 * The honest one-liner.
 *
 * Both figures are reported, and neither is flattering by construction. The whole
 * window includes brand-new files that no history-based method could have named;
 * the mature segment is the fair comparison. Both point the same way here, and if
 * they ever stopped agreeing this line would have to say so instead of picking the
 * better one.
 */
export function backtestHeadline(report: BacktestReport): string {
  const { tangle } = report.results.capped;
  const mature = report.byHistory.mature;
  const commits = report.corpus.testCommitsEvaluated;
  const held = report.corpus.heldOutFiles;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

  // Lead with whichever comparison the data actually supports. If the gated
  // method loses to the trivial baseline, that is the headline; a summary that
  // hid it behind the import-graph comparison would be selecting the flattering
  // baseline after the fact.
  const tangleWins = mature.tangle.recall >= mature.cochange.recall;

  const verdict = tangleWins
    ? `Tangle reaches ${pct(mature.tangle.recall)} recall against ${pct(mature.cochange.recall)} for a plain ` +
      `co-change count and ${pct(mature.imports.recall)} for the import graph.`
    : `Tangle's confidence gate reaches only ${pct(mature.tangle.recall)} recall, where a plain co-change count ` +
      `reaches ${pct(mature.cochange.recall)} and the import graph ${pct(mature.imports.recall)}. On this ` +
      `repository the gate costs recall and does not buy precision back: the ungated count baseline wins, and ` +
      `that is a finding about the operating point, not a result to bury.`;

  return (
    `On ${commits.toLocaleString("en-US")} historical commits in ${report.repo}, Tangle would have flagged ` +
    `${pct(tangle.recall)} of the ${held.toLocaleString("en-US")} files left out of the diff, putting the right file ` +
    `first in ${pct(tangle.top1Rate)} of cases. Restricting to the ${mature.cases.toLocaleString("en-US")} of those files that had ` +
    `already been committed before the commit being scored — the rest were changed for the first time, where a ` +
    `co-change method has nothing to key on — ${verdict}`
  );
}

/** Keep only the first `limit` names, which is what a developer would be shown. */
function cap(candidates: Candidate[], topK: number): Candidate[] {
  return topK > 0 && candidates.length > topK ? candidates.slice(0, topK) : candidates;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export async function runBacktest(input: Partial<BacktestOptions> & { repoId: string }): Promise<BacktestReport> {
  const opts: BacktestOptions = { ...DEFAULT_BACKTEST, ...input };
  const repo = resolveRepo(opts.repoId);
  const started = Date.now();
  const timings: Record<string, number> = {};
  const notes: string[] = [];

  // ---- 1. history, chronological, no file lists truncated ----
  const historyStart = Date.now();
  const dataDir = config.reposDir;
  const cloneDir = await historyRepo(repo.owner, repo.name, dataDir, { force: opts.reclone });
  const head = await repoHead(cloneDir).catch(() => null);

  // `maxMassCommitFiles: 0` disables the parser's truncation so that a commit's
  // real file count is known and mass changes can be recognised and dropped
  // rather than silently reduced to an arbitrary first 80 paths.
  const history = await readHistory(cloneDir, { maxMassCommitFiles: 0 });
  timings.history = Date.now() - historyStart;

  const all = sortChronological(history.commits);
  if (all.length < 50) {
    throw new Error(
      `${repo.id} has only ${all.length} usable commits. A back-test needs a real history; ` +
        `point it at a repository with hundreds of commits.`,
    );
  }

  const windowSize = Math.min(opts.commits, Math.max(1, all.length - 20));
  const testCommits = all.slice(all.length - windowSize);
  const training = all.slice(0, all.length - windowSize);
  log.step(`${repo.id}: ${all.length.toLocaleString("en-US")} commits, testing the newest ${windowSize}`);

  // ---- 2. import graph for the structural baseline ----
  let importAdjacency = new Map<string, Set<string>>();
  if (opts.imports) {
    const importStart = Date.now();
    const sourcesDir = config.sourcesDir;
    let sourceDir: string | null = null;
    try {
      sourceDir = await sourcesRepo(repo.owner, repo.name, sourcesDir, !opts.reclone);
      await prepareSourceTree(sourceDir);
      const extracted = await extractImportsFromTree(sourceDir, { maxFiles: opts.maxImportFiles });
      for (const edge of extracted.edges) {
        if (edge.a === edge.b) continue;
        let a = importAdjacency.get(edge.a);
        if (!a) importAdjacency.set(edge.a, (a = new Set()));
        let b = importAdjacency.get(edge.b);
        if (!b) importAdjacency.set(edge.b, (b = new Set()));
        a.add(edge.b);
        b.add(edge.a);
      }
      log.ok(`import baseline: ${extracted.edges.length.toLocaleString("en-US")} edges, symmetric`);
    } catch (err) {
      notes.push(
        `the import baseline was skipped: ${err instanceof Error ? err.message : String(err)}. ` +
          `Its row is reported as empty rather than omitted.`,
      );
      log.warn(`import baseline unavailable: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (sourceDir && !opts.keepSources) discardSourcesRepo(sourceDir);
    }
    timings.imports = Date.now() - importStart;
  } else {
    notes.push("import baseline disabled by flag (--no-imports); its numbers are empty by construction.");
  }

  // ---- 3. train on everything before the test window ----
  const trainStart = Date.now();
  const replay = new CouplingReplay(opts.maxMassFiles);
  for (const commit of training) replay.add(commit, commitProvenance(commit, repo.id));
  timings.train = Date.now() - trainStart;
  log.ok(
    `trained on ${replay.commitsUsed.toLocaleString("en-US")} commits → ` +
      `${replay.files.toLocaleString("en-US")} files, ${replay.pairs.toLocaleString("en-US")} pairs`,
  );

  // ---- 4. replay the test window ----
  const replayStart = Date.now();
  const floors = Array.from(new Set([...opts.sweep, opts.minConfidence, EDGE_FLOOR])).sort((a, b) => a - b);
  const sweepTotals = new Map<number, Confusion>(floors.map((f) => [f, emptyConfusion()]));
  const cappedTotals = { tangle: emptyConfusion(), cochange: emptyConfusion(), imports: emptyConfusion() };
  const uncappedTotals = { tangle: emptyConfusion(), cochange: emptyConfusion(), imports: emptyConfusion() };
  const phantomTotals = { tangle: emptyConfusion(), cochange: emptyConfusion(), imports: emptyConfusion() };
  const matureTotals = { tangle: emptyConfusion(), cochange: emptyConfusion(), imports: emptyConfusion() };
  const coldTotals = { tangle: emptyConfusion(), cochange: emptyConfusion(), imports: emptyConfusion() };
  const priorCommits: number[] = [];
  let matureCases = 0;
  let coldCases = 0;
  let unreachable = 0;

  let evaluated = 0;
  let heldOut = 0;
  let heldOutWithTicket = 0;
  let heldOutWithSubject = 0;
  let commitsWithTicketRef = 0;
  let productionCaught = 0;
  let productionClean = 0;
  let productionCleanCorrect = 0;
  let productionFalseClean = 0;
  let productionBelowThreshold = 0;
  let productionPredictions = 0;
  let productionFalsePositives = 0;
  let skippedSingle = 0;
  let skippedMass = 0;
  let skippedBot = 0;
  let phantomCases = 0;
  let caught = 0;
  let scoreCaught = 0;
  const examples: BacktestReport["examples"] = [];
  /** Keep the misses too, and enough of each to be worth reading. */
  const caughtExamples: BacktestReport["examples"] = [];

  for (const commit of testCommits) {
    // Noise gates, applied before anything is scored.
    if (commit.files.length < 2) {
      skippedSingle++;
      replay.add(commit);
      continue;
    }
    if (commit.files.length > opts.maxMassFiles) {
      skippedMass++;
      replay.add(commit);
      continue;
    }
    if (opts.excludeBots && isBotAuthor(commit)) {
      skippedBot++;
      replay.add(commit);
      continue;
    }

    const inCommit = new Set(commit.files);
    evaluated++;
    if (extractRefs(commit, repo.id).length > 0) commitsWithTicketRef++;

    for (const forgotten of commit.files) {
      const seeds = commit.files.filter((f) => f !== forgotten);
      const seedSet = new Set(seeds);
      heldOut++;

      const walk = couplingWalk(replay, seeds, opts.maxHops, opts.minCoChanges);
      const raw = coChangeBaseline(replay, seeds, seedSet);
      const imports = importBaseline(importAdjacency, replay, seeds, seedSet);

      // Sweep: every floor, from one walk.
      for (const floor of floors) {
        const at = walk.filter((c) => c.confidence >= floor);
        scoreCase(sweepTotals.get(floor)!, at.map((c) => c.path), forgotten, inCommit);
      }

      // Operating point, capped exactly as shipped.
      const operating = walk.filter((c) => c.confidence >= opts.minConfidence);

      // How much evidence the held-out pair would rest on. Reported rather than
      // optimised: it is the number a sceptical reader should ask for.
      const pairConfidence = replay.edgeScore(
        seeds.reduce(
          (best, s) => (replay.coChanges(s, forgotten) > replay.coChanges(best, forgotten) ? s : best),
          seeds[0] ?? forgotten,
        ),
        forgotten,
      );
      const tangleHit = operating.some((c) => c.path === forgotten);

      // ---- the production list, measured exactly as `analyze` builds it ----
      //
      // This mirrors `analyze`: reach within the hop budget, keep every hop above
      // the floor, require the target's own co-change count to clear the minimum,
      // take the top 12, and report whatever is left. Only then is a held-out file
      // called a catch. Everything above this line was measuring the ranking in
      // isolation; this measures the answer a user actually receives.
      const production = cap(operating, 12);
      const productionHit = production.some((c) => c.path === forgotten);
      if (productionHit) productionCaught++;
      if (production.length === 0) {
        productionClean++;
        if (walk.length === 0) productionCleanCorrect++;
        else productionFalseClean++;
      } else if (walk.length > 0) {
        // Coupled enough to be a candidate, but the floor or the cap hid it.
        productionBelowThreshold++;
      }
      for (const p of production) {
        productionPredictions++;
        // A prediction is a false alarm unless it names a file the commit
        // actually contained, or the held-out one.
        if (p.path !== forgotten && !inCommit.has(p.path)) productionFalsePositives++;
      }

      scoreCase(cappedTotals.tangle, cap(operating, opts.topK).map((c) => c.path), forgotten, inCommit);
      scoreCase(cappedTotals.cochange, cap(raw, opts.topK).map((c) => c.path), forgotten, inCommit);
      scoreCase(cappedTotals.imports, cap(imports, opts.topK).map((c) => c.path), forgotten, inCommit);

      scoreCase(uncappedTotals.tangle, operating.map((c) => c.path), forgotten, inCommit);
      scoreCase(uncappedTotals.cochange, raw.map((c) => c.path), forgotten, inCommit);
      scoreCase(uncappedTotals.imports, imports.map((c) => c.path), forgotten, inCommit);

      // The phantom subset: files with no import path to the diff at all. This is
      // the population Tangle claims to cover and the import graph, by
      // construction, cannot see.
      if (!imports.some((c) => c.path === forgotten)) {
        phantomCases++;
        scoreCase(phantomTotals.tangle, cap(operating, opts.topK).map((c) => c.path), forgotten, inCommit);
        scoreCase(phantomTotals.cochange, cap(raw, opts.topK).map((c) => c.path), forgotten, inCommit);
        scoreCase(phantomTotals.imports, cap(imports, opts.topK).map((c) => c.path), forgotten, inCommit);
      }

      // Split by prior history. A file with no commits before this one is not a
      // case any co-change method can get right, for a reason that has nothing to
      // do with the method's quality.
      const prior = replay.changes(forgotten);
      priorCommits.push(prior);
      if ((replay.adjacency.get(forgotten) ?? []).length === 0) unreachable++;

      // Provenance: did the shared commits between this file and any seed name a
      // ticket? Answered from prefix state only, so it leaks nothing.
      if (hasTicketProvenance(replay.pairProvenance, seeds, forgotten)) heldOutWithTicket++;
      if (hasSubjectProvenance(replay.pairProvenance, seeds, forgotten)) heldOutWithSubject++;

      const isMature = prior >= opts.minCoChanges;
      if (isMature) {
        matureCases++;
        scoreCase(matureTotals.tangle, cap(operating, opts.topK).map((c) => c.path), forgotten, inCommit);
        scoreCase(matureTotals.cochange, cap(raw, opts.topK).map((c) => c.path), forgotten, inCommit);
        scoreCase(matureTotals.imports, cap(imports, opts.topK).map((c) => c.path), forgotten, inCommit);
      } else {
        coldCases++;
        scoreCase(coldTotals.tangle, cap(operating, opts.topK).map((c) => c.path), forgotten, inCommit);
        scoreCase(coldTotals.cochange, cap(raw, opts.topK).map((c) => c.path), forgotten, inCommit);
        scoreCase(coldTotals.imports, cap(imports, opts.topK).map((c) => c.path), forgotten, inCommit);
      }

      // Calibration: does the confidence number mean anything? A tool whose
      // score is uninformative is not better than one that always says "yes".
      const scoreOfHeldOut = tangleHit ? pairConfidence : undefined;
      if (scoreOfHeldOut !== undefined) {
        caught++;
        scoreCaught += scoreOfHeldOut;
      }

      // A sample of both outcomes. Without examples a precision figure is a
      // number nobody can argue with, which is exactly why nobody should have to.
      if (tangleHit && caughtExamples.length < 6) {
        caughtExamples.push({ sha: commit.sha, heldOut: forgotten, caught: true, confidence: scoreOfHeldOut ?? 0, date: commit.date.slice(0, 10) });
      } else if (!tangleHit && examples.length < 6) {
        examples.push({ sha: commit.sha, heldOut: forgotten, caught: false, confidence: 0, date: commit.date.slice(0, 10) });
      }
    }

    // Fold the commit in only after it has been scored. This one line is the
    // difference between a measurement and a tautology.
    replay.add(commit, commitProvenance(commit, repo.id));
  }

  timings.replay = Date.now() - replayStart;
  timings.total = Date.now() - started;

  if (evaluated === 0) {
    throw new Error(
      `None of the ${windowSize} most recent commits in ${repo.id} were eligible to score. ` +
        `Loosen --max-mass-files or --commits.`,
    );
  }

  // ---- 5. notes: everything a critic would ask about ----
  notes.unshift(
    `Provenance is scored on its own terms: a held-out file counts as explained only if some commit shared ` +
      `with the rest of its diff, and strictly older, carried a ticket reference. That is the same extraction ` +
      `the ingest uses, replayed forward in time, so the figure cannot benefit from anything the test commit ` +
      `itself revealed.`,
    `The stored FalkorDB graph is deliberately not consulted. It was built from the whole history and ` +
      `therefore contains the answer key. This replay runs the same coupling arithmetic the ingest uses, ` +
      `frozen at each test commit's parent.`,
    `Import edges come from a shallow clone of today's default branch. Predictions are filtered to files ` +
      `that had already been committed by the test commit, so no future file is ever credited; the cost is ` +
      `that an import deleted since then cannot be predicted, which costs the baseline recall it would have ` +
      `had at that moment.`,
    `A held-out file is a file the developer did change in that commit. This measures recall on files the ` +
      `change needed. It is not a measurement of bugs, and it is not a claim that the omitted file was ` +
      `missed on purpose.`,
  );
  if (replay.commitsSkippedAsMass > 0) {
    notes.push(
      `${replay.commitsSkippedAsMass.toLocaleString("en-US")} mass commit(s) in the training history were ` +
        `excluded from pair counting: their co-changes are real and meaningless.`,
    );
  }
  if (skippedBot > 0) {
    notes.push(
      `${skippedBot} test commit(s) by bot authors were excluded. A dependency bump makes every file it ` +
        `touches look coupled to every other.`,
    );
  }
  if (skippedMass > 0) {
    notes.push(`${skippedMass} test commit(s) touching more than ${opts.maxMassFiles} files were excluded.`);
  }

  const report: BacktestReport = {
    repo: repo.id,
    head,
    generatedAt: new Date().toISOString(),
    ranking: "shared-commit count; confidence ratio gates the walk but does not order it",
    methodology: {
      protocol:
        `leave-one-out: for every eligible commit, each file is held out once. The other files become the ` +
        `simulated diff and the held-out file is the one the developer forgot. A prediction counts only if it ` +
        `names that exact file.`,
      leakage: `only commits strictly older than the test commit feed the graph; the test commit is folded in ` +
        `after it is scored`,
      budget: `every method may name at most ${opts.topK} files, ranked by its own signal`,
      baselines: {
        tangle: `change coupling, every hop clearing confidence ${opts.minConfidence} within ${opts.maxHops} hops, ` +
          `${opts.minCoChanges}+ shared commits`,
        cochange: `any file that ever shared a commit with the diff, ranked by shared-commit count`,
        imports: `direct importers and importees of the diff, existing at the test commit, symmetric`,
      },
    },
    corpus: {
      commitsParsed: all.length,
      trainingCommits: training.length,
      testWindow: windowSize,
      testCommitsEvaluated: evaluated,
      skippedSingleFile: skippedSingle,
      skippedMass,
      skippedBot,
      heldOutFiles: heldOut,
      filesInTraining: replay.files,
      pairsInTraining: replay.pairs,
      commitsUsedInTraining: replay.commitsUsed,
    },
    operatingPoint: {
      minConfidence: opts.minConfidence,
      maxHops: opts.maxHops,
      minCoChanges: opts.minCoChanges,
      topK: opts.topK,
      maxMassFiles: opts.maxMassFiles,
      botsExcluded: opts.excludeBots,
    },
    results: {
      capped: {
        tangle: score("tangle", cappedTotals.tangle, heldOut),
        cochange: score("cochange", cappedTotals.cochange, heldOut),
        imports: score("imports", cappedTotals.imports, heldOut),
      },
      uncapped: {
        tangle: score("tangle", uncappedTotals.tangle, heldOut),
        cochange: score("cochange", uncappedTotals.cochange, heldOut),
        imports: score("imports", uncappedTotals.imports, heldOut),
      },
    },
    phantomSubset: {
      cases: phantomCases,
      tangle: score("tangle", phantomTotals.tangle, phantomCases),
      cochange: score("cochange", phantomTotals.cochange, phantomCases),
      imports: score("imports", phantomTotals.imports, phantomCases),
    },
    sweep: floors.map((floor) => ({ floor, ...score(`floor ${floor}`, sweepTotals.get(floor)!, heldOut) })),
    byHistory: {
      minPriorCommits: [opts.minCoChanges],
      mature: {
        cases: matureCases,
        tangle: score("tangle", matureTotals.tangle, matureCases),
        cochange: score("cochange", matureTotals.cochange, matureCases),
        imports: score("imports", matureTotals.imports, matureCases),
      },
      cold: {
        cases: coldCases,
        tangle: score("tangle", coldTotals.tangle, coldCases),
        cochange: score("cochange", coldTotals.cochange, coldCases),
        imports: score("imports", coldTotals.imports, coldCases),
      },
      unreachable,
      medianPriorCommits: median(priorCommits),
    },
    rationale: {
      commitsWithTicketRef,
      commitsInWindow: testCommits.length,
      heldOutWithTicket,
      heldOutWithSubject,
      totalHeldOut: heldOut,
    },
    production: {
      cases: heldOut,
      caught: productionCaught,
      recall: heldOut > 0 ? productionCaught / heldOut : 0,
      precision:
        productionPredictions > 0 ? productionCaught / productionPredictions : 0,
      f1: 0,
      belowThreshold: productionBelowThreshold,
      cleanCases: productionClean,
      cleanCorrect: productionCleanCorrect,
      falseClean: productionFalseClean,
      falseCleanRate: productionClean > 0 ? 1 - productionCleanCorrect / productionClean : 0,
    },
    calibration: {
      caught,
      missed: heldOut - caught,
      meanScoreCaught: caught > 0 ? scoreCaught / caught : 0,
    },
    examples: [...caughtExamples, ...examples],
    notes,
    timings,
  };

  // F1 needs both rates, so it is filled in once the object exists rather than
  // duplicating the ratio arithmetic inline.
  report.production.f1 =
    report.production.precision + report.production.recall === 0
      ? 0
      : (2 * report.production.precision * report.production.recall) /
        (report.production.precision + report.production.recall);

  return report;
}

/**
 * Provenance lookups for a leave-one-out case.
 *
 * A case is "explained" when any shared commit between the forgotten file and any
 * seed carried a ticket reference. Both predicates read only state built from
 * commits strictly older than the one being scored.
 */
export function hasTicketProvenance(
  provenance: Map<string, { ticket: boolean; subject: boolean }>,
  seeds: string[],
  forgotten: string,
): boolean {
  for (const seed of seeds) {
    if (provenance.get(pairKey(seed, forgotten))?.ticket) return true;
  }
  return false;
}

export function hasSubjectProvenance(
  provenance: Map<string, { ticket: boolean; subject: boolean }>,
  seeds: string[],
  forgotten: string,
): boolean {
  for (const seed of seeds) {
    if (provenance.get(pairKey(seed, forgotten))?.subject) return true;
  }
  return false;
}

/** Classify one commit's provenance contribution, cheaply. */
export function commitProvenance(commit: CommitRecord, homeRepo: string): {
  ticket: boolean;
  subject: boolean;
} {
  const ticket = extractRefs(commit, homeRepo).length > 0;
  // A subject counts when it says something beyond the reference itself.
  const title = titleFromSubject(commit.subject);
  const subject = title.length > 6 && !/^v?\d+\.\d+\.\d+/.test(commit.subject);
  return { ticket, subject };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Oldest first.
 *
 * `git log` emits newest first and that is what the ingest pipeline expects. A
 * back-test needs the opposite order to walk forward through time, and it must be
 * ordered by commit *date* rather than by reversing the output, because author
 * dates in a rebased history do not follow the log's default order.
 */
export function sortChronological(commits: CommitRecord[]): CommitRecord[] {
  return commits
    .map((c, i) => ({ c, i, t: Date.parse(c.date) }))
    .sort((x, y) => (Number.isNaN(x.t) ? 0 : x.t) - (Number.isNaN(y.t) ? 0 : y.t) || x.i - y.i)
    .map((entry) => entry.c);
}
