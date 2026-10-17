/** Shared domain types. Kept dependency-free so the API, CLI and MCP server agree. */

export interface RepoRef {
  /** `owner/name`, e.g. `vercel/next.js` */
  id: string;
  owner: string;
  name: string;
  /** Set when the repo was ingested by Tangle. */
  ingested?: boolean;
}

export interface FileNode {
  repo: string;
  path: string;
  ext: string;
  dir: string;
  changes: number;
  lines: number;
}

export interface Person {
  repo: string;
  login: string;
  name: string;
  commits: number;
}

/**
 * Why a coupling exists, denormalised onto the COUPLED relationship.
 *
 * Copied from the `EXPLAINED_BY` edge at load time so that the blast-radius
 * query can return a reason alongside the file. Every field is nullable because
 * most couplings in a real repository have no ticket reference at all, and a
 * fabricated one would be worse than an honest blank.
 */
export interface CouplingWhy {
  /** `owner/repo#12345`. */
  ticket: string | null;
  kind: TicketKind | null;
  title: string | null;
  url: string | null;
  /** ISO date of the earliest commit that referenced it. */
  date: string | null;
  /** SHA of that commit. */
  commit: string | null;
  /** Shared commits referencing this ticket. */
  mentions: number;
  /** `mentions / coChanges`. */
  share: number;
  /** A `fixes`/`closes`/`resolves` keyword made the link explicit. */
  explicit: boolean;
  /** Other tickets seen in the same shared commits. */
  alsoFrom: string[];
  /** Most common commit subject across the shared commits. */
  subject: string | null;
}

export type TicketKind = "pull-request" | "issue";

/** A single co-change coupling edge. Persisted on the COUPLED relationship. */
export interface CouplingEdge {
  a: string;
  b: string;
  /** Commits in which both files changed. */
  coChanges: number;
  changesA: number;
  changesB: number;
  /** Fraction of A's commits that also touched B. */
  confidenceAB: number;
  /** Fraction of B's commits that also touched A. */
  confidenceBA: number;
  maxConfidence: number;
  /** Fraction of all commits containing both files. */
  support: number;
  jaccard: number;
  /** True when a static import path already explains the coupling. */
  hasImport: boolean;
  whyTicket?: string | null;
  whyKind?: TicketKind | null;
  whyTitle?: string | null;
  whyUrl?: string | null;
  whyDate?: string | null;
  whyCommit?: string | null;
  whyMentions?: number;
  whyShare?: number;
  whyExplicit?: boolean;
  whyAlsoFrom?: string[];
  whySubject?: string | null;
}

export type CouplingReason = "co-change" | "import";

export interface AffectedFile {
  path: string;
  /** Strongest coupling edge that reached this file. */
  confidence: number;
  reason: CouplingReason;
  hops: number;
  coChanges: number;
  /** Evidence: commit SHAs where the seed and this file co-changed. */
  evidence: string[];
  /** True when the file is in the diff already. */
  inDiff: boolean;
  /**
   * Why this file is coupled to the diff. Null when the shared commits carried
   * no ticket reference, which is the common case and is reported as such rather
   * than filled with a plausible-sounding guess.
   */
  why?: CouplingWhy | null;
}

/** A file that is strongly coupled to the diff but was left out of it. */
export interface MissedFile extends AffectedFile {
  /** Why we think it was forgotten, in one line. */
  rationale: string;
}

/**
 * Proof of absence. Tangle never claims "nothing else is affected" without
 * publishing the bounds of the search that produced it.
 */
export interface Certificate {
  statement: string;
  trueFor: { seedFiles: string[]; repo: string };
  parameters: {
    minConfidence: number;
    maxHops: number;
    maxEdgesPerFile: number;
    skipMassCommitsAbove: number;
  };
  search: {
    repoFilesTotal: number;
    couplingEdgesTotal: number;
    importEdgesTotal: number;
    edgesScanned: number;
    filesReached: number;
    excludedByConfidence: number;
    excludedByPath: number;
    excludedByPathExamples: string[];
    frontierByHop: { hop: number; files: number }[];
    /** True when a cap stopped the traversal before it ran to exhaustion. */
    truncated: boolean;
    truncationReason: string | null;
  };
  coverage: {
    /** Share of the repo's files the traversal actually considered. */
    filesConsideredPct: number;
    /** Share of the repo's coupling edges the traversal actually considered. */
    edgesConsideredPct: number;
  };
  methods: { label: string; cypher: string }[];
  reproducible: boolean;
}

export interface ReviewerRoute {
  login: string;
  name: string;
  commits: number;
  /** Coupling-weighted affinity across the blast radius, 0..1. */
  affinity: number;
  /** PageRank share over the Person/File projection, 0..1, when available. */
  centrality: number | null;
  files: string[];
}

/**
 * Flat `why*` columns as a graph query returns them.
 *
 * Kept as columns rather than a nested object because FalkorDB returns whatever
 * the RETURN clause names, and `whyFromRow` turns these into a `CouplingWhy`.
 */
export interface WhyRow {
  whyTicket?: string | null;
  whyKind?: string | null;
  whyTitle?: string | null;
  whyUrl?: string | null;
  whyDate?: string | null;
  whyMentions?: number | null;
  whyShare?: number | null;
  whyExplicit?: boolean | null;
  whyAlsoFrom?: string[] | null;
  whySubject?: string | null;
}

export interface DiscoveryPair {
  a: string;
  b: string;
  coChanges: number;
  confidence: number;
  support: number;
  /** Shortest import path found, if any. Null means the graph found none. */
  importPath: string[] | null;
  /**
   * The pull request or issue behind this coupling. This is what separates Tangle
   * from a plain co-change graph: not just "these two files always move together"
   * but "they move together because of this incident, and here it is".
   */
  why?: CouplingWhy | null;
}

/** A discovery row as the graph returns it: the pair plus its `why*` columns. */
export type DiscoveryRow = WithWhyColumns<DiscoveryPair>;

type WithWhyColumns<T> = T & WhyRow;

/** A ticket, and the part of the codebase it ties together. */
export interface TicketInsight {
  key: string;
  kind: TicketKind;
  title: string;
  url: string;
  references: number;
  explicit: boolean;
  /** Referencing commits that were reverts. Discounted in the ranking. */
  reverts: number;
  firstDate: string | null;
  filesExplained: number;
  totalMentions: number;
  /** `totalMentions` discounted by the revert share. This is what ranks. */
  effectiveMentions: number;
  /** Strongest couplings this ticket accounts for. */
  couplings: {
    a: string;
    b: string;
    coChanges: number;
    confidence: number;
    hasImport: boolean;
    mentions: number;
    share: number;
    /**
     * True when both endpoints are generated or vendored output.
     *
     * The strongest couplings on a large repository are frequently a file and its
     * own `.map`, or a lockfile and the manifest that produced it. Those are real
     * couplings and explaining them is useless, so they are marked and can be
     * filtered by the caller rather than silently dropped from the graph.
     */
    artifact: boolean;
  }[];
}

export interface AnalysisResult {
  repo: string;
  query: {
    kind: "pr" | "files";
    input: string;
    changedFiles: string[];
  };
  blastRadius: AffectedFile[];
  missed: MissedFile[];
  certificate: Certificate;
  reviewers: ReviewerRoute[];
  timings: Record<string, number>;
  degraded: string[];
  /** Explainable merge-risk triage score. */
  risk?: import("./analysis/risk.js").RiskAssessment;
}

/** One file the developer changed, resolved against the graph. */
export interface ChangedFile {
  path: string;
  additions?: number;
  deletions?: number;
  status?: string;
}