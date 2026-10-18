import type { Graph } from "../graph/client.js";
import {
  unlinkedPairsQuery,
  UNLINKED_PAIRS_EXISTS,
  UNLINKED_PAIRS_FLAG,
  OVERSTATIC_PAIRS,
  importPathBetween,
  strongestCouplings,
  EXPLAINED_COUPLINGS,
  GHOST_COUPLINGS,
  INFLUENTIAL_TICKETS,
  TICKET_COUPLINGS,
} from "../graph/schema.js";
import type {
  CouplingWhy,
  DiscoveryPair,
  DiscoveryRow,
  TicketInsight,
  TicketKind,
} from "../types.js";
import { whyFromRow, type WithWhy } from "./engine.js";
import { log } from "../util/log.js";

export interface DiscoverOptions {
  repo: string;
  minConfidence: number;
  minCoChanges: number;
  limit: number;
  importDepth: number;
  /** Cross-check the live traversal against the load-time marker. */
  verify: boolean;
  /** Keep vendored binaries, lockfiles and compiled output in the panel. */
  includeArtifacts: boolean;
}

export const DEFAULT_DISCOVER: DiscoverOptions = {
  repo: "",
  minConfidence: 0.5,
  minCoChanges: 5,
  limit: 40,
  importDepth: 1,
  verify: true,
  includeArtifacts: false,
};

export interface DiscoverResult {
  phantom: DiscoveryPair[];
  /** Which implementation answered. */
  strategy: "cypher-pattern" | "cypher-exists" | "has-import-flag";
  strategyFallbackReason: string | null;
  overstatic: { a: string; b: string }[];
  /** Couplings in the result set that carry a ticket attribution. */
  explained: number;
  /** Provenance coverage, including the pairs with no ticket. */
  rationale: { withTicket: number; withExplicit: number; withoutTicket: number };
  counts: {
    couplingEdges: number;
    phantomFound: number;
    phantomAfterFilter: number;
    filteredOut: number;
  };
  ms: number;
}

/**
 * Paths whose couplings are real but uninteresting.
 *
 * Without this filter the top of the panel is always the same story: six
 * prebuilt `next-swc.*.node` binaries and three lockfiles that ship together
 * because a release script copies them. That is a correct finding and a useless
 * headline. The interesting couplings are the ones a human did not write down —
 * two GitHub Actions workflows that always move together, a config file and the
 * module it configures — so build artifacts are filtered out of the default view
 * and `--include-artifacts` brings them back.
 */
const ARTIFACT_PATTERNS: RegExp[] = [
  /\.node$/,
  /\.wasm$/,
  /(^|\/)(yarn\.lock|package-lock\.json|pnpm-lock\.yaml|Cargo\.lock|go\.sum)$/,
  /(^|\/)compiled\//,
  /(^|\/)\.next\//,
  /(^|\/)dist\//,
  /(^|\/)out\//,
  /\.min\.(js|css)$/,
];

export function isArtifactPath(path: string): boolean {
  return ARTIFACT_PATTERNS.some((re) => re.test(path));
}

/**
 * Phantom couplings: files the import graph says are unrelated, but which
 * history says always move together.
 *
 * This is the discovery nobody ships. A compiler or a vector index has no way to
 * express it: there is no lexical similarity to retrieve and no type signature
 * to follow. It is a statement about two edges in a graph — "these changed
 * together 241 times" and "there is no edge between them" — and the second one
 * is a *negative*, which is exactly what retrieval models are worst at.
 *
 * Three implementations are kept on purpose:
 *
 *   1. `unlinkedPairsQuery(1)` — `NOT (a)-[:IMPORTS]-(b)`, a live graph
 *      predicate. Measured at 746 ms on 143,488 coupling edges. Source of truth.
 *   2. `UNLINKED_PAIRS_EXISTS` — the same idea as a `NOT EXISTS { }` subquery.
 *      Does not parse on this build; kept so a newer server can be detected.
 *   3. `UNLINKED_PAIRS_FLAG` — reads the `hasImport` marker precomputed at ingest
 *      by a bounded JS BFS. Independent of the traversal.
 *
 * `tangle verify` diffs 1 against 3. When they agree, someone who does not trust
 * us can reproduce the answer without running our Cypher at all.
 */
export async function discover(graph: Graph, opts: DiscoverOptions): Promise<DiscoverResult> {
  const started = Date.now();

  // Typed with the `why*` columns because every query that produces a
  // DiscoveryPair returns them alongside it.
  let rows: DiscoveryRow[] = [];
  let strategy: DiscoverResult["strategy"] = "cypher-pattern";
  let fallbackReason: string | null = null;

  const params = {
    minConfidence: opts.minConfidence,
    minCoChanges: opts.minCoChanges,
    limit: Math.max(opts.limit * 20, 2000),
  };

  const live = await graph.query<WithWhy<DiscoveryPair>>(
    "phantom couplings (pattern)",
    unlinkedPairsQuery(opts.importDepth),
    params,
    60_000,
  );

  if (live.error) {
    const exists = await graph.query<WithWhy<DiscoveryPair>>(
      "phantom couplings (EXISTS)",
      UNLINKED_PAIRS_EXISTS,
      params,
      60_000,
    );
    if (!exists.error) {
      rows = exists.rows;
      strategy = "cypher-exists";
    } else {
      fallbackReason = live.error;
      strategy = "has-import-flag";
      log.dim(`live traversal unavailable; using the load-time hasImport marker. Reason: ${live.error}`);
      const flag = await graph.must<WithWhy<DiscoveryPair>>(
        "phantom couplings (flag)",
        UNLINKED_PAIRS_FLAG,
        params,
        60_000,
      );
      rows = flag.rows;
    }
  } else {
    rows = live.rows;
  }

  // Cross-check the live predicate against the load-time marker so a silent
  // drift between the two cannot hide behind a green demo.
  if (strategy !== "has-import-flag" && opts.verify) {
    const flag = await graph.query<DiscoveryPair>(
      "phantom couplings (flag, cross-check)",
      UNLINKED_PAIRS_FLAG,
      params,
      60_000,
    );
    if (!flag.error) {
      const liveSet = new Set(rows.map((r) => `${r.a}\u0000${r.b}`));
      const flagSet = new Set(flag.rows.map((r) => `${r.a}\u0000${r.b}`));
      const onlyLive = rows.filter((r) => !flagSet.has(`${r.a}\u0000${r.b}`)).length;
      const onlyFlag = flag.rows.filter((r) => !liveSet.has(`${r.a}\u0000${r.b}`)).length;
      if (onlyLive || onlyFlag) {
        log.dim(
          `cross-check: ${onlyLive} pair(s) only in the live traversal, ${onlyFlag} only in the marker. ` +
            `Expected when importDepth (${opts.importDepth}) differs from the ingest-time bound of 3.`,
        );
      }
    }
  }

  const phantomFound = rows.length;
  const filtered = opts.includeArtifacts
    ? rows
    : rows.filter((pair) => !isArtifactPath(pair.a) && !isArtifactPath(pair.b));

  // For the headline pairs, prove the negative explicitly and show that the
  // coupling itself is real. This is the part that goes in the video.
  for (const pair of filtered.slice(0, 6)) {
    pair.importPath = await shortestImportPath(graph, pair.a, pair.b, opts.importDepth);
    pair.why = whyFromRow(pair);
  }

  // Provenance coverage over the whole result set, reported honestly including
  // the pairs where no ticket exists. "Explains 41 of 1,000 couplings" is a
  // better headline than "explains the ones we chose to show you".
  const explained = rows.filter((r) => Boolean(r.whyTicket)).length;
  const explicitCount = rows.filter((r) => r.whyExplicit === true).length;

  const overstatic = await graph.query<{ a: string; b: string }>(
    "over-static pairs",
    OVERSTATIC_PAIRS,
    { limit: 20 },
    60_000,
  );

  const edges = Number(
    (
      await graph.query<{ n: number }>(
        "coupling edge count",
        `MATCH ()-[r:COUPLED]->() RETURN count(r) AS n`,
        {},
        60_000,
      )
    ).rows[0]?.n ?? 0,
  );

  return {
    phantom: filtered.slice(0, opts.limit),
    strategy,
    strategyFallbackReason: fallbackReason,
    overstatic: overstatic.rows ?? [],
    explained,
    rationale: {
      /** Phantom pairs in the result set with a ticket attribution. */
      withTicket: explained,
      /** Of those, linked by an explicit `fixes`/`closes` keyword. */
      withExplicit: explicitCount,
      /** Pairs with no ticket at all. The honest denominator. */
      withoutTicket: rows.length - explained,
    },
    counts: {
      couplingEdges: edges,
      phantomFound,
      phantomAfterFilter: filtered.length,
      filteredOut: phantomFound - filtered.length,
    },
    ms: Date.now() - started,
  };
}

/**
 * Phantom couplings that carry a real reason.
 *
 * Ranked so the strongest evidence comes first: an explicit `Fixes #123` outranks
 * a bare `(#123)` suffix, and a ticket accounting for a large share of a pair's
 * shared commits outranks one mentioned in passing. That ordering is what makes
 * the panel a list of findings rather than a list of trivia.
 */
export interface ExplainedResult {
  pairs: DiscoveryPair[];
  ms: number;
}

export async function explainedCouplings(
  graph: Graph,
  opts: { minCoChanges: number; limit: number },
): Promise<ExplainedResult> {
  const started = Date.now();
  const result = await graph.query<WithWhy<DiscoveryPair>>(
    "explained couplings",
    EXPLAINED_COUPLINGS,
    { minCoChanges: opts.minCoChanges, limit: opts.limit },
    60_000,
  );
  if (result.error) {
    log.warn(`explained couplings failed: ${result.error}`);
    return { pairs: [], ms: Date.now() - started };
  }
  return {
    pairs: result.rows.map((row) => ({ ...row, why: whyFromRow(row) })),
    ms: Date.now() - started,
  };
}

/**
 * Phantom couplings with a confident reason attached.
 *
 * This is the strongest thing Tangle can say, because every part of it is
 * checked: the two files changed together many times, the import graph has no edge
 * between them, and a specific pull request or issue accounts for a large share of
 * those shared commits. The `minShare` floor is what separates this from the
 * discover panel, which will happily attribute 3% of a coupling to whichever issue
 * happened to be cited most often.
 *
 * Ordered by `whyMentions` rather than `whyShare`, because the share alone
 * rewards thin evidence: a pair that co-changed three times and cites one ticket
 * has a share of 1.00 and would otherwise rank above a pair that co-changed sixty
 * times and cites the same ticket twenty times. Mentions is the count of commits
 * that actually link the two files to the change, which is the quantity a reader
 * should be weighing.
 */
export interface GhostCoupling {
  a: string;
  b: string;
  coChanges: number;
  confidence: number;
  why: CouplingWhy;
}

export async function ghostCouplings(
  graph: Graph,
  opts: { minCoChanges: number; minConfidence: number; minShare: number; limit: number },
): Promise<{ pairs: GhostCoupling[]; ms: number }> {
  const started = Date.now();
  const result = await graph.query<WithWhy<DiscoveryPair>>(
    "ghost couplings",
    GHOST_COUPLINGS,
    {
      minCoChanges: opts.minCoChanges,
      minConfidence: opts.minConfidence,
      minShare: opts.minShare,
      limit: opts.limit,
    },
    60_000,
  );
  if (result.error) {
    log.warn(`ghost couplings failed: ${result.error}`);
    return { pairs: [], ms: Date.now() - started };
  }

  const pairs: GhostCoupling[] = [];
  for (const row of result.rows) {
    const why = whyFromRow(row);
    if (!why?.ticket) continue;
    pairs.push({
      a: row.a,
      b: row.b,
      coChanges: Number(row.coChanges ?? 0),
      confidence: Number(row.confidence ?? 0),
      why,
    });
  }
  return { pairs, ms: Date.now() - started };
}

/**
 * Tickets ranked by how much of the coupling structure they account for.
 *
 * This is the view that produces a headline. "Issue #4398 explains why these
 * eleven files move together" is a finding about a decision; "these eleven files
 * move together" is a statistic.
 */
export async function influentialTickets(
  graph: Graph,
  opts: { limit: number; couplingsPerTicket?: number; includeArtifacts?: boolean },
): Promise<TicketInsight[]> {
  // Ask for more than we display so that filtering generated output cannot leave a
  // short list. Without the headroom, a ticket whose six strongest couplings are
  // all `.js`/`.js.map` pairs would render as empty.
  const perTicket = (opts.couplingsPerTicket ?? 6) * (opts.includeArtifacts ? 1 : 3);

  const ranked = await graph.query<{
    key: string;
    kind: string;
    title: string;
    url: string;
    explicit: boolean;
    references: number;
    reverts: number;
    firstDate: string | null;
    filesExplained: number;
    totalMentions: number;
    effectiveMentions: number;
  }>(
    "influential tickets",
    INFLUENTIAL_TICKETS,
    { limit: opts.limit },
    60_000,
  );

  if (ranked.error) {
    log.warn(`influential tickets failed: ${ranked.error}`);
    return [];
  }

  // One query per ticket rather than a collect over an unbounded expansion: the
  // ticket list is short and each of these is indexed on `:Ticket(key)`.
  const out: TicketInsight[] = [];
  for (const row of ranked.rows) {
    const detail = await graph.query<{
      a: string;
      b: string;
      coChanges: number;
      confidence: number;
      hasImport: boolean;
      mentions: number;
      share: number;
    }>(
      "ticket couplings",
      TICKET_COUPLINGS,
      { key: row.key, limit: perTicket },
      60_000,
    );
    if (detail.error) {
      log.dim(`couplings for ${row.key} unavailable: ${detail.error}`);
      continue;
    }
    out.push({
      key: row.key,
      kind: row.kind as TicketKind,
      title: row.title,
      url: row.url,
      references: Number(row.references ?? 0),
      explicit: Number(row.explicit ?? 0) > 0,
      reverts: Number(row.reverts ?? 0),
      firstDate: row.firstDate,
      filesExplained: Number(row.filesExplained ?? 0),
      totalMentions: Number(row.totalMentions ?? 0),
      effectiveMentions: Number(row.effectiveMentions ?? 0),
      couplings: detail.rows
        .map((c) => ({
          a: c.a,
          b: c.b,
          coChanges: Number(c.coChanges ?? 0),
          confidence: Number(c.confidence ?? 0),
          hasImport: c.hasImport === true,
          mentions: Number(c.mentions ?? 0),
          share: Number(c.share ?? 0),
          artifact: isArtifactPath(c.a) || isArtifactPath(c.b),
        }))
        .filter((c) => opts.includeArtifacts || !c.artifact)
        .slice(0, opts.couplingsPerTicket ?? 6),
    });
  }

  return out;
}

/**
 * Prove the negative out loud. Returns the shortest import path, or null.
 *
 * A null here is the entire point of the feature, so it must be produced by a
 * query that searched, not by a lookup that missed.
 */
export async function shortestImportPath(graph: Graph, a: string, b: string, depth: number): Promise<string[] | null> {
  const result = await graph.query<{ p: unknown }>(
    "import path",
    importPathBetween(depth),
    { a, b },
    30_000,
  );
  if (result.error) return null;
  const nodes = pathToNodes(result.rows[0]?.p);
  return nodes && nodes.length > 0 ? nodes : null;
}

/**
 * Normalise whatever `shortestPath` returns into a list of file paths.
 *
 * FalkorDB hands back a Path object whose `nodes()` yields node objects with a
 * `properties` bag, but the shape differs across versions and it may also
 * arrive as a plain array. Handle all three rather than betting on one.
 */
export function pathToNodes(value: unknown): string[] | null {
  if (value === null || value === undefined) return null;

  const raw =
    typeof value === "object" && typeof (value as { nodes?: unknown }).nodes === "function"
      ? (value as { nodes: () => unknown[] }).nodes()
      : value;

  if (!Array.isArray(raw)) return null;

  return raw.map((node) => {
    if (typeof node === "string") return node;
    if (node && typeof node === "object") {
      const n = node as { path?: string; properties?: Record<string, unknown> };
      if (typeof n.path === "string") return n.path;
      if (n.properties && typeof n.properties.path === "string") return n.properties.path;
    }
    return String(node);
  });
}

/** Showcase numbers for the repo page and the video's opening frame. */
export interface Showcase {
  repo: string;
  strongest: { a: string; b: string; coChanges: number; confidence: number; hasImport: boolean }[];
  phantomCount: number;
  couplingEdges: number;
}

export async function showcase(graph: Graph, repo: string, limit = 12): Promise<Showcase> {
  const [strong, phantom] = await Promise.all([
    graph.query<Showcase["strongest"][number]>("strongest couplings", strongestCouplings(limit * 3), {}, 30_000),
    graph.query<DiscoveryPair>(
      "phantom count",
      UNLINKED_PAIRS_FLAG,
      { minConfidence: 0.5, minCoChanges: 5, limit: 1000000 },
      60_000,
    ),
  ]);

  const edges = Number(
    (
      await graph.query<{ n: number }>("edge count", `MATCH ()-[r:COUPLED]->() RETURN count(r) AS n`, {}, 60_000)
    ).rows[0]?.n ?? 0,
  );

  return {
    repo,
    strongest: (strong.rows ?? []).filter((r) => r.hasImport).slice(0, limit),
    phantomCount: (phantom.rows ?? []).length,
    couplingEdges: edges,
  };
}

/**
 * The claim the README and the video lead with, generated from live data so it
 * can never drift away from the graph.
 */
export function headline(result: DiscoverResult, repo: string): string | null {
  const top = result.phantom[0];
  if (!top) return null;
  const a = displayPath(top.a);
  const b = displayPath(top.b);
  return (
    `In ${repo}, ${a} and ${b} have been committed together ` +
    `${top.coChanges.toLocaleString("en-US")} times, and no import connects them. ` +
    `No compiler and no vector index will ever surface that pair.`
  );
}

/** Trim a long repo-relative path to the last two segments, which is what a human reads. */
function displayPath(path: string): string {
  const parts = path.split("/");
  return parts.length <= 2 ? path : `...${parts.slice(-2).join("/")}`;
}