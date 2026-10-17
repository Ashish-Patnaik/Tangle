/**
 * Structure: what FalkorDB's graph algorithms know that the coupling query cannot.
 *
 * Everything else in Tangle asks a local question — "what is coupled to this file",
 * "why are these two linked". This module asks global questions, and the answer
 * genuinely requires a graph database to compute:
 *
 *   **Load-bearing files.** PageRank over COUPLED. Not "most changed" — a file that
 *   many *other* files route their co-changes through.
 *
 *   **Bridge files.** Betweenness over COUPLED. The files that, if a change missed
 *   them, break a link between two clusters. This is the review question.
 *
 *   **Shadow architecture.** Weakly connected components. The directory layout says
 *   these are separate modules; history says they are one thing, and they have
 *   probably been edited by one person for years.
 *
 *   **How are these connected.** Shortest path over COUPLED, which for a phantom
 *   coupling is the only path that exists.
 *
 * The first three call `algo.*`, which is where the graph database earns its keep:
 * PageRank and betweenness are iterative matrix computations over the whole graph,
 * and there is no way to answer them by querying one file at a time.
 */

import type { Graph } from "../graph/client.js";
import {
  FILE_PAGERANK,
  FILE_BETWEENNESS,
  FILE_HARMONIC,
  PERSON_PAGERANK,
  COUPLING_COMPONENTS,
  BUS_FACTOR_SIMPLE,
  BUS_FACTOR_TOTAL,
  couplingPathBetween,
} from "../graph/schema.js";
import { pathToNodes } from "./discoveries.js";
import { log } from "../util/log.js";

export interface LoadBearingFile {
  path: string;
  score: number;
  changes: number;
  /** PageRank rank, 1-based, as a fraction of 1.0. */
  share: number;
}

export interface BridgeFile {
  path: string;
  score: number;
  /** Couplings on this file. A high betweenness with a low count is a real bridge. */
  couplings: number;
  changes: number;
}

export interface Island {
  component: number;
  files: number;
  /** Total changes across the island's files. */
  totalChanges: number;
  sample: string[];
}

export interface IslandOwners {
  component: number;
  people: number;
  sample: string[];
}

/**
 * One person's concentration of coupling knowledge.
 */
export interface BusFactorEntry {
  login: string;
  name: string;
  /** Share of all authored couplings, 0..1. */
  shareOfCouplings: number;
  files: number;
  couplings: number;
}

export interface StructureReport {
  /** Load-bearing files by PageRank. */
  loadBearing: LoadBearingFile[];
  /** Bridge files by betweenness. */
  bridges: BridgeFile[];
  /** Coupling components: clusters history says belong together. */
  islands: Island[];
  /**
   * How concentrated coupling knowledge is, per person.
   *
   * This replaces a "bus factor" *number*, which cannot be reduced to one integer
   * honestly. The distribution is the finding.
   */
  busFactor: BusFactorEntry[];
  /** Largest island as a share of all files, 0..1. */
  largestIslandShare: number;
  /** True when the directory layout disagrees with the clustering. */
  layoutDisagrees: boolean;
  /** Which algorithm answered what, or why it could not. */
  available: Record<string, "ok" | "unavailable">;
  ms: number;
}

/**
 * Files that other files route their co-changes through.
 *
 * The `share` is PageRank score divided by the top score, which makes the numbers
 * readable in a terminal. PageRank scores sum to 1.0 across the whole graph, so on
 * a repository with 58,759 files the absolute values are all near zero and only
 * their ratio carries information.
 */
export async function loadBearingFiles(graph: Graph, limit = 20): Promise<LoadBearingFile[]> {
  const result = await graph.query<{ path: string; score: number }>(
    "file pagerank",
    FILE_PAGERANK,
    { limit: Math.max(1, Math.min(500, limit)) },
    120_000,
  );

  if (result.error) {
    // Not a crash: this is an enrichment, and the rest of the report is still valid.
    log.dim(`PageRank unavailable on this server: ${result.error}`);
    return [];
  }

  const top = result.rows[0]?.score ?? 0;
  const changes = await changeCountsFor(graph, result.rows.map((r) => r.path));

  return result.rows.map((row) => ({
    path: row.path,
    score: Number(row.score ?? 0),
    changes: changes.get(row.path) ?? 0,
    share: top > 0 ? Number(row.score ?? 0) / top : 0,
  }));
}

/**
 * Files that bridge two clusters.
 *
 * Ranked by betweenness, but reported with the coupling count next to it, because
 * the score alone misleads: a single coupling can have a huge betweenness score if
 * it happens to be the only link between two halves of the graph, and that is a
 * very different thing from a file bridging dozens of well-connected modules.
 */
export async function bridgeFiles(graph: Graph, limit = 20): Promise<BridgeFile[]> {
  const result = await graph.query<{ path: string; score: number }>(
    "file betweenness",
    FILE_BETWEENNESS,
    { limit: Math.max(1, Math.min(500, limit)) },
    300_000,
  );

  if (result.error) {
    log.dim(`betweenness unavailable on this server: ${result.error}`);
    return [];
  }

  const paths = result.rows.map((r) => r.path);
  const [changes, couplings] = await Promise.all([
    changeCountsFor(graph, paths),
    couplingCountsFor(graph, paths),
  ]);

  return result.rows.map((row) => ({
    path: row.path,
    score: Number(row.score ?? 0),
    couplings: couplings.get(row.path) ?? 0,
    changes: changes.get(row.path) ?? 0,
  }));
}

/**
 * Coupling islands: clusters that history keeps together.
 *
 * A large island spanning several top-level directories is the shadow
 * architecture finding — the folder tree claims these are unrelated and history
 * says otherwise.
 */
/**
 * How concentrated coupling knowledge is.
 *
 * Measured as: of the couplings each person has ever authored, what share of the
 * repository's total authored-coupling count is theirs. The top entry is the number
 * that matters — if one person owns a third of the coupling edges, the knowledge
 * of why files move together leaves the building when they do.
 *
 * Note the direction of the ratio. Dividing by *total* couplings rather than by
 * per-file authorship means a prolific generalist and a focused specialist are
 * comparable, which is what makes the ranking meaningful across a repository.
 */
export async function busFactor(graph: Graph, limit = 8): Promise<BusFactorEntry[]> {
  // Two queries rather than a window function: see `BUS_FACTOR_TOTAL` for why.
  //
  // Over-fetch, because bots are filtered *after* the query and the Cypher LIMIT
  // applies before that. Asking for exactly `limit` would return a short list on
  // any repository with active release automation.
  const [result, totalRow] = await Promise.all([
    graph.query<{ login: string; name: string; couplings: number; files: number }>(
      "bus factor",
      BUS_FACTOR_SIMPLE,
      { limit: Math.max(1, Math.min(500, limit * 4)) },
      180_000,
    ),
    graph.query<{ total: number }>("bus factor total", BUS_FACTOR_TOTAL, {}, 180_000),
  ]);

  if (result.error) {
    log.dim(`bus factor unavailable: ${result.error}`);
    return [];
  }

  const total = Number(totalRow.rows[0]?.total ?? 0);
  const rows = result.rows.map((row) => ({
    login: row.login,
    name: row.name,
    couplings: Number(row.couplings ?? 0),
    files: Number(row.files ?? 0),
    shareOfCouplings: total > 0 ? Number(row.couplings ?? 0) / total : 0,
  }));

  // Release bots author the largest share of couplings in a mature repository —
  // on vercel/next.js the top three entries are all automation, which answers no
  // question a reader has. Filtered here so the same rule as the back-test's bot
  // gate applies, rather than printing service accounts as though they were people
  // holding institutional knowledge.
  const humans = rows.filter((row) => !isBotLogin(row.login));
  const dropped = rows.length - humans.length;
  if (dropped > 0) {
    log.dim(`bus factor: ${dropped} bot account(s) excluded from the ranking`);
  }

  return humans.slice(0, limit);
}

/**
 * Does this login look like automation?
 *
 * Deliberately narrow. Release bots are named consistently across repositories,
 * and a false positive here silently drops a real contributor from a report about
 * who holds knowledge — the worse failure of the two.
 */
function isBotLogin(login: string): boolean {
  return /(^|[-_.\s])(bot|bots)([-_.\s@]|$)|\[bot\]|github-actions|dependabot|renovate|greenkeeper|imgbot/i.test(
    login,
  );
}

export async function couplingIslands(graph: Graph, limit = 12, sample = 5): Promise<Island[]> {
  const result = await graph.query<{
    component: number;
    files: number;
    totalChanges: number;
    sample: string[];
  }>(
    "coupling components",
    COUPLING_COMPONENTS,
    { limit: Math.max(1, Math.min(200, limit)), sample: Math.max(1, Math.min(20, sample)) },
    120_000,
  );

  if (result.error) {
    log.dim(`WCC unavailable on this server: ${result.error}`);
    return [];
  }

  return result.rows.map((row) => ({
    component: Number(row.component ?? 0),
    files: Number(row.files ?? 0),
    totalChanges: Number(row.totalChanges ?? 0),
    sample: row.sample ?? [],
  }));
}

/**
 * Shortest coupling path between two files, exposed as a sentence.
 *
 * The chain is the argument: each hop is a pair history recorded, so a path from
 * `auth.ts` to `login.ts` through `session.ts` is a claim that all three move
 * together, with the intermediate file as evidence rather than as a guess.
 */

/**
 * The shortest coupling path between two files, or null.
 *
 * This is the question a phantom coupling leaves open. Two files with no import
 * between them are still connected — this returns the chain, and each hop in it
 * is a pair that history recorded. If this returns null, they are genuinely
 * independent as far as the coupling graph is concerned, which is a real answer
 * rather than an absence.
 */
export async function couplingPath(
  graph: Graph,
  a: string,
  b: string,
  depth = 3,
): Promise<{ path: string[]; hops: number } | null> {
  const result = await graph.query<{ p: unknown }>("coupling path", couplingPathBetween(depth), { a, b }, 60_000);
  if (result.error) return null;
  const nodes = pathToNodes(result.rows[0]?.p);
  if (!nodes || nodes.length < 2) return null;
  return { path: nodes, hops: nodes.length - 1 };
}

/** Files most responsible for coupling, by harmonic centrality. */
export async function mostCentralFiles(graph: Graph, limit = 15): Promise<{ path: string; score: number }[]> {
  const result = await graph.query<{ path: string; score: number }>(
    "harmonic centrality",
    FILE_HARMONIC,
    { limit: Math.max(1, Math.min(500, limit)) },
    180_000,
  );
  if (result.error) return [];
  return result.rows.map((r) => ({ path: r.path, score: Number(r.score ?? 0) }));
}

/** People who own the most coupled files, by PageRank over AUTHORED. */
export async function centralPeople(
  graph: Graph,
  limit = 15,
): Promise<{ login: string; score: number }[]> {
  const result = await graph.query<{ login: string; score: number }>(
    "person pagerank",
    PERSON_PAGERANK,
    { limit: Math.max(1, Math.min(500, limit)) },
    120_000,
  );
  if (result.error) return [];
  return result.rows.map((r) => ({ login: r.login, score: Number(r.score ?? 0) }));
}

/**
 * Everything at once.
 *
 * The four enrichment queries run concurrently because each is an independent
 * whole-graph computation; serialised they would cost the sum, and on a large
 * repository that is the difference between one round trip and four.
 */
export async function structure(graph: Graph, limit = 15): Promise<StructureReport> {
  const started = Date.now();

  const [loadBearing, bridges, islands, factor] = await Promise.all([
    loadBearingFiles(graph, limit),
    bridgeFiles(graph, limit),
    couplingIslands(graph, 12, 5),
    busFactor(graph, Math.max(6, limit)),
  ]);

  // Largest island as a share of the repository, and whether it crosses
  // directory boundaries. The latter is the finding: an island entirely inside one
  // directory is just a directory.
  const totals = await graph.query<{ files: number }>("file total", `MATCH (f:File) RETURN count(f) AS files`, {}, 60_000);
  const fileTotal = Number(totals.rows[0]?.files ?? 0);
  const largest = islands[0]?.files ?? 0;
  const largestIslandShare = fileTotal > 0 ? largest / fileTotal : 0;

  const biggest = islands[0];
  const layoutDisagrees = Boolean(
    biggest && biggest.files > 1 && new Set(biggest.sample.map((p) => p.split("/")[0] ?? "")).size > 1,
  );

  return {
    loadBearing,
    bridges,
    islands,
    busFactor: factor,
    largestIslandShare,
    layoutDisagrees,
    available: {
      pagerank: loadBearing.length > 0 ? "ok" : "unavailable",
      betweenness: bridges.length > 0 ? "ok" : "unavailable",
      wcc: islands.length > 0 ? "ok" : "unavailable",
    },
    ms: Date.now() - started,
  };
}

/** Batch the File.changes lookup so it is one query, not N. */
async function changeCountsFor(graph: Graph, paths: string[]): Promise<Map<string, number>> {
  if (paths.length === 0) return new Map();
  const result = await graph.query<{ path: string; changes: number }>(
    "changes for paths",
    `UNWIND $paths AS path MATCH (f:File {path: path}) RETURN f.path AS path, f.changes AS changes`,
    { paths: paths.slice(0, 500) },
    60_000,
  );
  if (result.error) return new Map();
  return new Map(result.rows.map((r) => [r.path, Number(r.changes ?? 0)]));
}

/** How many couplings each path has, in one query. */
async function couplingCountsFor(graph: Graph, paths: string[]): Promise<Map<string, number>> {
  if (paths.length === 0) return new Map();
  const result = await graph.query<{ path: string; n: number }>(
    "couplings for paths",
    `UNWIND $paths AS path
     MATCH (f:File {path: path})-[c:COUPLED]-()
     RETURN path, count(c) AS n`,
    { paths: paths.slice(0, 500) },
    60_000,
  );
  if (result.error) return new Map();

  // The query returns the requested `path`, which for the undirected match is the
  // one we asked about rather than the other endpoint, so counts are per-path.
  const out = new Map<string, number>();
  for (const row of result.rows) out.set(row.path, Number(row.n ?? 0));
  return out;
}
