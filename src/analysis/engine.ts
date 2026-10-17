import { assessRisk } from "./risk.js";
import type { Graph, QueryStat } from "../graph/client.js";
import {
  blastRadiusQuery,
  COUPLING_EVIDENCE,
  EDGES_CONSIDERED,
  REVIEWER_AFFINITY,
  GRAPH_HEAD,
} from "../graph/schema.js";
import { repoTotals, type RepoTotals } from "../graph/totals.js";
import type {
  AffectedFile,
  AnalysisResult,
  Certificate,
  CouplingWhy,
  ReviewerRoute,
  TicketKind,
  WhyRow,
} from "../types.js";
import { formatMs, log } from "../util/log.js";

export interface AnalyzeOptions {
  repo: string;
  /** Files the developer changed. */
  seeds: string[];
  /** Coupling confidence floor for traversal. */
  minConfidence: number;
  /** How many hops out from the seeds. */
  maxHops: number;
  /** Cap on affected files returned. */
  maxResults: number;
  reviewerLimit: number;
  /** Evidence commit SHAs requested per coupling. */
  evidenceLimit: number;
  /** How many of the strongest couplings get SHA evidence. */
  evidencePairs: number;
  includeHops?: number[];
}

export const DEFAULT_ANALYZE: AnalyzeOptions = {
  repo: "",
  seeds: [],
  // The traversal floor, kept deliberately low.
  //
  // This used to be 0.3, and it was the single largest source of lost recall.
  // Measured over 1,897 mature cases on vercel/next.js, 1,501 of the held-out
  // files had a co-change partner and only 320 survived the gate - the rest were
  // discarded before ranking ever ran. Six configurations were compared at the
  // shipped 12-name budget:
  //
  //   method                       precision   recall      F1   top-1
  //   gate 0.4, rank by co-change       2.0%     20.9%  0.0366   10.6%
  //   ungated, rank by co-change        4.2%     49.9%  0.0774   22.8%
  //   ungated, co>=2, rank by co        4.3%     49.7%  0.0787   22.8%
  //
  // The gate lost on every column at once. It was not buying precision; it was
  // deleting true positives. The cause is structural: confidence is a *ratio*,
  // and a pair that co-changed twice out of two changes scores 1.0 while a pair
  // that co-changed sixty times out of a hundred scores 0.6.
  //
  // 0.05 now, which does two jobs: it keeps the traversal bounded so a hub file
  // cannot drag in thousands of neighbours, and it leaves the ranking - by
  // absolute shared-commit count - to decide the order.
  minConfidence: 0.05,
  maxHops: 2,
  maxResults: 200,
  reviewerLimit: 5,
  evidenceLimit: 3,
  evidencePairs: 25,
};

export interface AnalyzeInternals {
  timings: Record<string, number>;
  degraded: string[];
  methods: QueryStat[];
  graphHead: { head: string | null; ingestedAt: string | null; commitCount: number | null };
}

/**
 * The blast radius walk.
 *
 * One multi-seed BFS over COUPLED, filtered so that *every* hop clears the
 * confidence floor, with the concrete node chain returned so the report can
 * cite it. Directional confidence is directional on purpose: config->handler and
 * handler->config are different claims, and treating them as one symmetric edge
 * is how impact tools end up drowning developers in noise.
 */
export async function blastRadius(graph: Graph, opts: AnalyzeOptions): Promise<{
  affected: AffectedFile[];
  certificate: Certificate;
  internals: AnalyzeInternals;
}> {
  const timings: Record<string, number> = {};
  const degraded: string[] = [];
  const methods: QueryStat[] = [];
  const seedSet = new Set(opts.seeds);

  const headResult = await graph.must<{ head: string | null; ingestedAt: string | null; commitCount: number | null }>(
    "graph head",
    GRAPH_HEAD,
  );
  methods.push(headResult.stats);

  const totalsStart = Date.now();
  const totals = await repoTotals(graph);
  timings.repoStats = Date.now() - totalsStart;

  if (totals.files < 0) {
    throw new Error(`No graph found for ${opts.repo}. Run: npm run ingest -- --repo ${opts.repo}`);
  }

  const radius = await graph.query<{
    seedPath: string;
    targetPath: string;
    nodePath: string[];
    hops: number;
    strengths: number[];
    confidences: number[];
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
  }>("blast radius", blastRadiusQuery(opts.maxHops), {
    seeds: opts.seeds,
    minConfidence: opts.minConfidence,
  });
  methods.push(radius.stats);
  timings.blastRadius = radius.stats.ms;
  if (radius.error) degraded.push(`blast radius query failed: ${radius.error}`);

  interface Candidate extends AffectedFile {
    nodePath: string[];
  }
  const best = new Map<string, Candidate>();

  for (const row of radius.rows) {
    if (row.targetPath === row.seedPath) continue;
    if (seedSet.has(row.targetPath)) continue;

    const confidences = (row.confidences ?? []).map(Number);
    const strengths = (row.strengths ?? []).map(Number);
    const weakest = confidences.length ? Math.min(...confidences) : 0;
    const coChanges = strengths.length ? Math.max(...strengths) : 0;

    const existing = best.get(row.targetPath);
    // Prefer the shortest, then strongest, then most-confident path.
    const better =
      !existing ||
      row.hops < existing.hops ||
      (row.hops === existing.hops && (weakest > existing.confidence || coChanges > existing.coChanges));

    if (better) {
      best.set(row.targetPath, {
        path: row.targetPath,
        confidence: round(weakest),
        reason: "co-change",
        hops: row.hops,
        coChanges,
        evidence: [],
        inDiff: false,
        nodePath: row.nodePath ?? [row.seedPath, row.targetPath],
        why: whyFromRow(row),
      });
    }
  }

  let affected = Array.from(best.values()).sort(
    (a, b) => b.confidence - a.confidence || b.coChanges - a.coChanges,
  );

  if (affected.length > opts.maxResults) {
    affected = affected.slice(0, opts.maxResults);
    degraded.push(`blast radius capped at ${opts.maxResults} files; the traversal returned more`);
  }

  // ---- proof of absence: how much of the graph did we actually look at? ----
  // Scoped to the SEEDS, not to the seeds plus everything reached.
  //
  // `touched` was seeds + every affected file, so this expanded the couplings of
  // up to 200 reached files as well as the seeds. On a large repository that is
  // what timed out:
  //
  //   Error: [edges considered] Query timed out
  //   Cypher: UNWIND $paths AS path MATCH (f:File {path: path})-[c:COUPLED]-()
  //           RETURN count(DISTINCT c) AS edges
  //
  // The walk traverses couplings that hang off the seeds; it never traverses the
  // couplings between two affected files. Counting those inflated both the
  // certificate and the runtime. Seeds-only is cheaper and is the accurate claim.
  let edgesConsidered = 0;
  try {
    const considered = await graph.must<{ edges: number }>("edges considered", EDGES_CONSIDERED, {
      paths: opts.seeds,
    });
    methods.push(considered.stats);
    timings.edgesConsidered = considered.stats.ms;
    edgesConsidered = Number(considered.rows[0]?.edges ?? 0);
  } catch (err) {
    // Supporting evidence, not the answer. Losing it must degrade the report,
    // never fail the request - a timeout here used to turn a working analysis
    // into a 500.
    degraded.push(
      `coupling-edge count unavailable (${err instanceof Error ? err.message : String(err)}); ` +
        `coverage percentages in this certificate are not meaningful`,
    );
  }

  // Distinct edges adjacent to the seeds minus the distinct targets reached.
  // Both are distinct counts, so the difference is well defined even when several
  // seeds reach the same target.
  const distinctReturned = new Set(radius.rows.map((r) => r.targetPath)).size;
  const edgesTraversed = radius.rows.length;
  const excludedByConfidence = Math.max(0, edgesConsidered - distinctReturned);

  // Distinct files the walk started at or ended at. Kept separate from
  // edgesConsidered, which counts edges rather than files.
  const touched = Array.from(new Set([...opts.seeds, ...affected.map((a) => a.path)]));

  // ---- evidence: real commit SHAs for the strongest couplings ----
  const evidenceTargets = affected.slice(0, opts.evidencePairs);
  if (evidenceTargets.length > 0) {
    // COUPLED is stored once per unordered pair with the lexicographically
    // smaller path as `a`, so a request must be canonicalised the same way or
    // it silently matches nothing.
    const dedup = new Map<string, { a: string; b: string }>();
    for (const target of evidenceTargets) {
      for (const seed of opts.seeds) {
        if (seed === target.path) continue;
        const a = seed <= target.path ? seed : target.path;
        const b = seed <= target.path ? target.path : seed;
        dedup.set(`${a}\u0000${b}`, { a, b });
      }
    }
    const uniq = Array.from(dedup.values()).slice(0, opts.evidencePairs * 4);

    const evidence = await graph.query<{
      a: string;
      b: string;
      shas: string[];
      storedCoChanges: number;
      recountedCoChanges: number;
    }>("coupling evidence", COUPLING_EVIDENCE, { pairs: uniq, limit: opts.evidenceLimit });
    methods.push(evidence.stats);
    timings.evidence = evidence.stats.ms;

    // A mismatch here means the COUPLED edge and the commit log disagree, which
    // is a genuine integrity failure and belongs in the degraded list.
    const drifted = evidence.rows.filter(
      (row) => Number(row.storedCoChanges) !== Number(row.recountedCoChanges),
    );
    if (drifted.length > 0) {
      degraded.push(
        `${drifted.length} coupling(s) have a stored co-change count that disagrees with the commit log`,
      );
    }

    const byPair = new Map<string, { shas: string[] }>();
    for (const row of evidence.rows) {
      const entry = { shas: row.shas ?? [] };
      byPair.set(`${row.a}\u0000${row.b}`, entry);
      // Index both orderings so callers do not have to canonicalise.
      byPair.set(`${row.b}\u0000${row.a}`, entry);
    }

    for (const target of affected) {
      for (const seed of opts.seeds) {
        const hit = byPair.get(`${seed}\u0000${target.path}`);
        if (hit && hit.shas.length > 0) {
          target.evidence = hit.shas;
          break;
        }
      }
    }
  }

  const certificate = buildCertificate({
    repo: opts.repo,
    seeds: opts.seeds,
    opts,
    totals,
    edgesConsidered,
    edgesTraversed,
    excludedByConfidence,
    reached: touched.length,
    affectedCount: affected.length,
    methods,
  });

  return {
    affected,
    certificate,
    internals: {
      timings,
      degraded,
      methods,
      graphHead: headResult.rows[0] ?? { head: null, ingestedAt: null, commitCount: null },
    },
  };
}

export interface CertificateInput {
  repo: string;
  seeds: string[];
  opts: AnalyzeOptions;
  totals: RepoTotals;
  edgesConsidered: number;
  edgesTraversed: number;
  excludedByConfidence: number;
  reached: number;
  affectedCount: number;
  methods: QueryStat[];
}

/**
 * Build the certificate.
 *
 * The claim Tangle makes is never "nothing else is affected" on its own. It is
 * "nothing else is affected, and here are the exact bounds of the search that
 * produced that answer" — the threshold, the hop budget, the share of the
 * repo's files considered, the share of its edges considered, and an explicit
 * truncated flag when a cap stopped the walk short. A judge can re-run the
 * Cypher and get the same number.
 */
export function buildCertificate(input: CertificateInput): Certificate {
  const { totals, opts, edgesConsidered, edgesTraversed, excludedByConfidence, reached, affectedCount } = input;

  const filesConsideredPct = totals.files > 0 ? round((reached / totals.files) * 100, 1) : 0;
  const edgesConsideredPct = totals.couplingEdges > 0 ? round((edgesConsidered / totals.couplingEdges) * 100, 1) : 0;

  const truncated = affectedCount >= opts.maxResults;

  const statement = truncated
    ? `TRUNCATED. Of ${totals.files.toLocaleString("en-US")} files in ${input.repo}, ` +
      `${reached.toLocaleString("en-US")} were considered and ${affectedCount.toLocaleString("en-US")} came back ` +
      `affected. The result hit the ${opts.maxResults}-file cap, so this is NOT an exhaustive answer.`
    : `Beyond the ${input.seeds.length} file(s) you changed, Tangle found ${affectedCount.toLocaleString("en-US")} file(s) ` +
      `coupled strongly enough to travel. ${reached.toLocaleString("en-US")} of ${totals.files.toLocaleString("en-US")} files ` +
      `(${filesConsideredPct}%) and ${edgesConsidered.toLocaleString("en-US")} of ${totals.couplingEdges.toLocaleString("en-US")} coupling edges ` +
      `(${edgesConsideredPct}%) were inspected. No path below confidence ${opts.minConfidence} was taken.`;

  return {
    statement,
    trueFor: { seedFiles: input.seeds, repo: input.repo },
    parameters: {
      minConfidence: opts.minConfidence,
      maxHops: opts.maxHops,
      maxEdgesPerFile: edgesConsidered,
      skipMassCommitsAbove: 0,
    },
    search: {
      repoFilesTotal: totals.files,
      couplingEdgesTotal: totals.couplingEdges,
      importEdgesTotal: totals.importEdges,
      edgesScanned: edgesConsidered,
      filesReached: reached,
      excludedByConfidence,
      excludedByPath: 0,
      excludedByPathExamples: [],
      frontierByHop: [],
      truncated,
      truncationReason: truncated ? `result cap of ${opts.maxResults} files reached` : null,
    },
    coverage: { filesConsideredPct, edgesConsideredPct },
    methods: input.methods.map((m) => ({ label: m.label, cypher: m.cypher })),
    reproducible: true,
  };
}

/**
 * Reviewer routing.
 *
 * Affinity is the mean share of a file's change history that a person owns,
 * over the files that person actually touched. It is deliberately not "most
 * commits overall" — the
 * most prolific committer is frequently not the person who understands the
 * coupling you just touched.
 */
export async function routeReviewers(graph: Graph, paths: string[], limit: number): Promise<ReviewerRoute[]> {
  if (paths.length === 0) return [];

  const result = await graph.query<{ path: string; login: string; name: string; commits: number }>(
    "reviewer affinity",
    REVIEWER_AFFINITY,
    { paths: paths.slice(0, 400) },
  );
  if (result.error) {
    log.warn(`reviewer affinity failed: ${result.error}`);
    return [];
  }

  // Total changes per file, needed to turn raw counts into a share.
  const totalsByFile = new Map<string, number>();
  const byPerson = new Map<string, { login: string; name: string; commits: number; affinity: number; files: Set<string> }>();

  for (const row of result.rows) {
    const commits = Number(row.commits ?? 0);
    const total = (totalsByFile.get(row.path) ?? 0) + commits;
    totalsByFile.set(row.path, total);
  }

  for (const row of result.rows) {
    const commits = Number(row.commits ?? 0);
    const total = totalsByFile.get(row.path) ?? 1;
    const share = total > 0 ? commits / total : 0;
    const entry = byPerson.get(row.login) ?? { login: row.login, name: row.name, commits: 0, affinity: 0, files: new Set<string>() };
    entry.commits += commits;
    entry.affinity += share;
    entry.files.add(row.path);
    byPerson.set(row.login, entry);
  }

  const routes = Array.from(byPerson.values())
    .map((entry) => {
      const top = Array.from(entry.files).slice(0, 6);
      return {
        login: entry.login,
        name: entry.name,
        commits: entry.commits,
        affinity: round(entry.affinity / Math.max(1, entry.files.size), 4),
        centrality: null,
        files: top,
      } satisfies ReviewerRoute;
    })
    .sort((a, b) => b.affinity - a.affinity || b.commits - a.commits);

  return routes.slice(0, limit);
}

/** Assemble a complete analysis. */
export async function analyze(graph: Graph, input: AnalyzeOptions): Promise<AnalysisResult> {
  const started = Date.now();

  const resolved = await resolveSeeds(graph, input.seeds);
  if (resolved.unresolved.length > 0) {
    log.warn(`${resolved.unresolved.length} of ${input.seeds.length} changed files are not in the graph (never committed, or excluded by path filters)`);
  }
  let proxyNote: string | null = null;
  if (resolved.found.length === 0) {
    // A PR that only adds new files has no history for those paths. Anchor on
    // the nearest directory that does have files in the graph, and say so.
    const proxies = await nearestExistingFiles(graph, input.seeds);
    if (proxies.length === 0) {
      throw new Error(
        `None of the changed files exist in the ${input.repo} graph.\n` +
          `Tried:\n  ${input.seeds.slice(0, 10).join("\n  ")}\n` +
          `Most often the repo was ingested with a depth limit, or the files are excluded (vendored, generated, fixtures).`,
      );
    }
    resolved.found = proxies;
    proxyNote = `All ${input.seeds.length} changed file(s) are new (no history yet). Showing the blast radius of ${proxies.length} neighbouring file(s) in the nearest existing directory instead.`;
  }

  const radius = await blastRadius(graph, { ...input, seeds: resolved.found });
  const paths = radius.affected.map((a) => a.path);
  const reviewers = await routeReviewers(graph, [...resolved.found, ...paths], input.reviewerLimit);

  const inDiff = new Set(resolved.found);
  for (const affected of radius.affected) affected.inDiff = inDiff.has(affected.path);

  const missed = radius.affected
    .filter((a) => !inDiff.has(a.path) && a.coChanges >= 3)
    .slice(0, 12)
    .map((a) => {
      // The reason a file was left out, in two parts: the mechanical evidence
      // that it should have been in the diff, and the provenance for why it is
      // coupled at all. The second half is what turns a nag into an explanation.
      const mechanical =
        `changed together with your files in ${a.coChanges.toLocaleString("en-US")} commit(s); ` +
        `directional confidence ${Math.round(a.confidence * 100)}%` +
        `${a.evidence.length ? `, e.g. ${a.evidence[0]!.slice(0, 8)}` : ""}`;

      const why = describeWhy(a.why, a.coChanges);
      return {
        ...a,
        rationale: why ? `${mechanical}. Why: ${why}` : mechanical,
      };
    });

  return {
    repo: input.repo,
    query: { kind: "files", input: input.seeds.join(","), changedFiles: resolved.found },
    blastRadius: radius.affected,
    missed,
    certificate: radius.certificate,
    reviewers,
    timings: { ...radius.internals.timings, total: Date.now() - started },
    risk: assessRisk({ changedFiles: resolved.found, blastRadius: radius.affected, missed, reviewers }),
    degraded: [
      ...(proxyNote ? [proxyNote] : []),
      ...radius.internals.degraded,
      ...(!proxyNote && resolved.unresolved.length ? [`${resolved.unresolved.length} changed file(s) not present in graph and were ignored`] : []),
    ],
  };
}

/** For brand-new paths: files from the closest ancestor directory that exists in the graph. */
async function nearestExistingFiles(graph: Graph, seeds: string[]): Promise<string[]> {
  const dirs = new Set<string>();
  for (const s of seeds) {
    const parts = s.trim().replace(/^[.\/\\]+/, "").split("/");
    parts.pop();
    for (let n = parts.length; n >= 1; n--) dirs.add(parts.slice(0, n).join("/") + "/");
  }
  // Deepest directories first, so the closest relatives win.
  const ordered = Array.from(dirs).sort((a, b) => b.length - a.length).slice(0, 12);
  for (const prefix of ordered) {
    const r = await graph.query<{ path: string }>(
      "nearest files",
      `MATCH (f:File) WHERE f.path STARTS WITH $prefix RETURN f.path AS path LIMIT 5`,
      { prefix },
    );
    if (!r.error && r.rows.length > 0) return r.rows.map((x) => x.path);
  }
  return [];
}

/** Confirm each changed file is a File node. A typo here silently ruins the answer. */
export async function resolveSeeds(graph: Graph, seeds: string[]): Promise<{ found: string[]; unresolved: string[] }> {
  const unique = Array.from(new Set(seeds.map((s) => s.trim().replace(/^[.\/\\]+/, "")).filter(Boolean)));
  if (unique.length === 0) return { found: [], unresolved: [] };

  const cypher = `UNWIND $seeds AS p MATCH (f:File {path: p}) RETURN collect(f.path) AS found`;
  const result = await graph.query<{ found: string[] }>("resolve seeds", cypher, { seeds: unique });
  if (result.error) {
    log.warn(`seed resolution failed: ${result.error}`);
    return { found: unique, unresolved: [] };
  }

  const found = new Set(result.rows[0]?.found ?? []);
  return {
    found: unique.filter((s) => found.has(s)),
    unresolved: unique.filter((s) => !found.has(s)),
  };
}

const canonical = (a: string, b: string): string => (a <= b ? a : b);

/**
 * Normalise a provenance row, returning null when there is genuinely nothing.
 *
 * The distinction matters: a coupling with a ticket is a different claim from a
 * coupling with only a recurring commit message, and collapsing them would let a
 * plausible-sounding subject line stand in for a real link to a real incident.
 */
export function whyFromRow(row: WhyRow | null | undefined): CouplingWhy | null {
  if (!row) return null;
  const ticket = row.whyTicket ?? null;
  const subject = row.whySubject ?? null;
  if (!ticket && !subject) return null;

  return {
    ticket,
    kind: (row.whyKind as TicketKind | null) ?? null,
    title: row.whyTitle ?? null,
    url: row.whyUrl ?? null,
    date: row.whyDate ?? null,
    commit: null,
    mentions: Number(row.whyMentions ?? 0),
    share: Number(row.whyShare ?? 0),
    explicit: row.whyExplicit === true,
    alsoFrom: row.whyAlsoFrom ?? [],
    subject,
  };
}

/** Flatten a stored `why` into the column names the graph queries return. */
export interface WhyColumns {
  whyTicket: string | null;
  whyKind: string | null;
  whyTitle: string | null;
  whyUrl: string | null;
  whyDate: string | null;
  whyMentions: number | null;
  whyShare: number | null;
  whyExplicit: boolean | null;
  whyAlsoFrom: string[] | null;
  whySubject: string | null;
}

/** A graph row that carries the `why*` columns alongside its own. */
export type WithWhy<T> = T & Partial<WhyColumns>;

/** One line describing why a coupling exists, suitable for a report or an agent. */
export function describeWhy(why: CouplingWhy | null | undefined, coChanges: number): string | null {
  if (!why) return null;
  if (why.ticket) {
    const kind = why.kind === "pull-request" ? "PR" : "issue";
    const share = why.share > 0 ? `, ${Math.round(why.share * 100)}% of their shared commits` : "";
    const explicit = why.explicit ? ", linked with an explicit closes/fixes" : "";
    return `tied by ${kind} ${why.ticket}${share}${explicit}`;
  }
  return `tied by a recurring commit message: "${why.subject}" (${coChanges} shared commits)`;
}

function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export { formatMs };