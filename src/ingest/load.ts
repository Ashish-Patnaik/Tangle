import type { Graph } from "../graph/client.js";
import {
  SCHEMA_STATEMENTS,
  UPSERT_REPO,
  INSERT_FILES,
  INSERT_COMMITS,
  INSERT_PEOPLE,
  INSERT_TOUCHES,
  INSERT_AUTHORS,
  INSERT_COUPLINGS,
  INSERT_IMPORTS,
  INSERT_TICKETS,
  INSERT_REFERENCES,
  INSERT_EXPLAINS,
} from "../graph/schema.js";
import type { CouplingEdge } from "../types.js";
import type { CommitRecord } from "./history.js";
import { dirOf, extOf, loginOf } from "./history.js";
import type { ImportEdge } from "./imports.js";
import { buildRationale, pairKey, type RationaleIndex } from "../analysis/rationale.js";
import { log } from "../util/log.js";

const NUL = "\u0000";

export interface LoadInput {
  repoId: string;
  head: string;
  language: string;
  commits: CommitRecord[];
  fileCounts: Map<string, number>;
  couplings: CouplingEdge[];
  imports: ImportEdge[];
  /** Blob size in bytes per tracked path, from ls-tree. Used for display only. */
  fileBytes?: Map<string, number>;
  /** Commits touching more files than this are treated as mass changes. */
  maxMassFiles?: number;
  /** Drop and rebuild the graph first. */
  fresh: boolean;
  batchSize?: number;
  /** Bounded reachability depth when precomputing hasImport. */
  importDepthForPath?: number;
  /** Cap on nodes visited per reachability search. */
  reachCap?: number;
}

export interface LoadStats {
  files: number;
  commits: number;
  people: number;
  touches: number;
  couplings: number;
  imports: number;
  phantomCouplings: number;
  tickets: number;
  references: number;
  explains: number;
  /** Couplings with a ticket attribution. */
  explainedCouplings: number;
  rationale: ReturnType<typeof buildRationale>["stats"];
  ms: number;
}

export async function loadGraph(graph: Graph, input: LoadInput): Promise<LoadStats> {
  // Rationale is built before any writing, because every coupling row carries
  // its own provenance and the two have to be computed together.
  const rationaleStart = Date.now();
  const rationale = buildRationale(input.commits, input.couplings, {
    repoId: input.repoId,
    maxMassFiles: input.maxMassFiles ?? 80,
  });
  const rationaleMs = Date.now() - rationaleStart;
  log.ok(
    `provenance: ${rationale.stats.tickets.toLocaleString("en-US")} tickets from ` +
      `${rationale.stats.commitsWithRefs.toLocaleString("en-US")} commits; ` +
      `${rationale.stats.explainedCouplings.toLocaleString("en-US")} coupling(s) explained by a ticket, ` +
      `${rationale.stats.subjectOnlyCouplings.toLocaleString("en-US")} by subject alone ` +
      `(${rationale.stats.explicitRefs.toLocaleString("en-US")} explicit closes/fixes refs, ` +
      `${rationale.stats.crossRepoRefs.toLocaleString("en-US")} cross-repo) in ${(rationaleMs / 1000).toFixed(1)}s`,
  );
  const started = Date.now();
  const batch = input.batchSize ?? 1500;
  // Matches the depth `tangle discover` defaults to. Keeping the load-time
  // marker and the live traversal at the same depth is what lets `verify`
  // diff them for exact agreement instead of explaining a discrepancy away.
  const depth = input.importDepthForPath ?? 1;
  const reachCap = input.reachCap ?? 1500;

  if (input.fresh) {
    log.step("dropping existing graph");
    try {
      await graph.drop();
    } catch (err) {
      // Dropping a graph that does not exist yet is not a reason to fail ingest.
      log.dim(`no existing graph to drop (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  await graph.ensureGraph();

  for (const statement of SCHEMA_STATEMENTS) {
    // Index creation is idempotent in FalkorDB but still surfaces real errors.
    const result = await graph.query("index", statement);
    if (result.error && !/already/i.test(result.error)) log.dim(`index: ${result.error}`);
  }

  const people = collectPeople(input.commits);
  const touchedFiles = new Set<string>();
  for (const c of input.commits) for (const f of c.files) touchedFiles.add(f);

  // Only keep coupling edges whose endpoints are real graph nodes.
  const couplings = input.couplings.filter((e) => touchedFiles.has(e.a) && touchedFiles.has(e.b));

  // Denormalise provenance onto each coupling row so the blast-radius query can
  // return a reason in the same round trip it returns the file.
  for (const edge of couplings) {
    const why = rationale.rationales.get(pairKey(edge.a, edge.b));
    edge.whyTicket = why?.ticket ?? null;
    edge.whyKind = why?.kind ?? null;
    edge.whyTitle = why?.title ?? null;
    edge.whyUrl = why?.url ?? null;
    edge.whyDate = why?.date ?? null;
    edge.whyCommit = why?.commit ?? null;
    edge.whyMentions = why?.mentions ?? 0;
    edge.whyShare = why?.share ?? 0;
    edge.whyExplicit = why?.explicit ?? false;
    edge.whyAlsoFrom = why?.alsoFrom ?? [];
    edge.whySubject = why?.subject ?? null;
  }

  const importEdges = dedupeImports(input.imports, touchedFiles);

  const now = new Date().toISOString();

  await graph.query("repo", UPSERT_REPO, {
    id: input.repoId,
    head: input.head,
    language: input.language,
    commitCount: input.commits.length,
    ingestedAt: now,
  });

  log.step(`writing ${touchedFiles.size.toLocaleString("en-US")} files`);
  const fileRows = Array.from(touchedFiles, (path) => ({
    path,
    ext: extOf(path),
    dir: dirOf(path),
    changes: input.fileCounts.get(path) ?? 0,
    bytes: 0,
  }));
  await batched(
    graph,
    "files",
    INSERT_FILES,
    fileRows,
    batch,
    (n) => log.dim(`  files ${n.toLocaleString("en-US")}`),
    { now },
  );

  log.step(`writing ${input.commits.length.toLocaleString("en-US")} commits`);
  const commitRows = input.commits.map((c) => ({
    sha: c.sha,
    date: c.date,
    message: c.subject.slice(0, 300),
    filesCount: c.files.length,
  }));
  await batched(graph, "commits", INSERT_COMMITS, commitRows, batch, (n) =>
    log.dim(`  commits ${n.toLocaleString("en-US")}`),
  );

  const personRows = Array.from(people.values());
  await batched(graph, "people", INSERT_PEOPLE, personRows, batch);

  const authorRows: { sha: string; login: string }[] = [];
  for (const c of input.commits) {
    const p = people.get(loginOf(c.name, c.email));
    if (p) authorRows.push({ sha: c.sha, login: p.login });
  }
  log.step(`writing ${authorRows.length.toLocaleString("en-US")} authorship edges`);
  await batched(graph, "authors", INSERT_AUTHORS, authorRows, batch);

  const touchRows: { path: string; sha: string }[] = [];
  for (const c of input.commits) {
    for (const f of c.files) touchRows.push({ path: f, sha: c.sha });
  }
  log.step(`writing ${touchRows.length.toLocaleString("en-US")} file-change edges`);
  await batched(graph, "touches", INSERT_TOUCHES, touchRows, batch, (n) =>
    log.dim(`  file-change edges ${n.toLocaleString("en-US")}`),
  );

  log.step(`writing ${importEdges.length.toLocaleString("en-US")} import edges`);
  await batched(graph, "imports", INSERT_IMPORTS, importEdges, batch, (n) =>
    log.dim(`  import edges ${n.toLocaleString("en-US")}`),
  );

  log.step(`marking phantom couplings (bounded reachability, depth ${depth})`);
  const adjacency = new Map<string, string[]>();
  for (const e of importEdges) {
    const list = adjacency.get(e.a);
    if (list) list.push(e.b);
    else adjacency.set(e.a, [e.b]);
  }

  let marked = 0;
  const byA = new Map<string, CouplingEdge[]>();
  for (const e of couplings) {
    const list = byA.get(e.a);
    if (list) list.push(e);
    else byA.set(e.a, [e]);
  }

  for (const [a, group] of byA) {
    const seen = bfs(adjacency, a, depth, reachCap);
    for (const e of group) {
      if (seen.has(e.b)) e.hasImport = true;
      else marked++;
    }
  }
  log.ok(`${marked.toLocaleString("en-US")} of ${couplings.length.toLocaleString("en-US")} couplings have no static import path`);

  log.step(`writing ${couplings.length.toLocaleString("en-US")} coupling edges`);
  await batched(graph, "couplings", INSERT_COUPLINGS, couplings, batch, (n) =>
    log.dim(`  coupling edges ${n.toLocaleString("en-US")}`),
  );

  // ---- provenance ----
  const ticketRows = Array.from(rationale.tickets.values()).map((t) => ({
    key: t.key,
    repo: t.repo,
    number: t.number,
    kind: t.kind,
    // A merge commit's subject is pure boilerplate and yields an empty title.
    // Storing an empty string is honest; storing "Merge pull request" is not.
    title: t.title,
    url: t.url,
    references: t.references,
    explicit: t.explicit,
    firstDate: t.firstDate,
    lastDate: t.lastDate,
    files: t.files,
    reverts: t.reverts,
  }));
  log.step(`writing ${ticketRows.length.toLocaleString("en-US")} tickets`);
  await batched(graph, "tickets", INSERT_TICKETS, ticketRows, batch, undefined, { now });

  const referenceRows: { sha: string; key: string; explicit: boolean; raw: string }[] = [];
  for (const [sha, refs] of rationale.refsByCommit) {
    for (const ref of refs) {
      referenceRows.push({ sha, key: ref.key, explicit: ref.explicit, raw: ref.raw });
    }
  }
  log.step(`writing ${referenceRows.length.toLocaleString("en-US")} commit→ticket references`);
  await batched(graph, "references", INSERT_REFERENCES, referenceRows, batch);

  const explainsRows = buildExplainsRows(rationale, couplings);
  log.step(`writing ${explainsRows.length.toLocaleString("en-US")} ticket→file explanations`);
  await batched(graph, "explains", INSERT_EXPLAINS, explainsRows, batch);

  const stats: LoadStats = {
    files: touchedFiles.size,
    commits: input.commits.length,
    people: personRows.length,
    touches: touchRows.length,
    couplings: couplings.length,
    imports: importEdges.length,
    phantomCouplings: marked,
    tickets: ticketRows.length,
    references: referenceRows.length,
    explains: explainsRows.length,
    explainedCouplings: rationale.stats.explainedCouplings,
    rationale: rationale.stats,
    ms: Date.now() - started,
  };
  return stats;
}

/**
 * One EXPLAINS edge per (ticket, file) pair, aggregated across every coupling
 * that ticket is the *primary* explanation for.
 *
 * A ticket explains a file through *pairs* — it touched this file together with
 * that one, and with another one. Writing an edge per pair would give the same
 * file many edges from the same ticket with different counts, so the counts are
 * summed.
 *
 * Secondary tickets (`whyAlsoFrom`) are deliberately **not** given an edge here.
 * They did co-occur in the shared commits, so "this ticket explains this file" is
 * not false for them — but it is not what the graph asserts elsewhere either, and
 * an EXPLAINED edge is the strong claim. They remain available on the coupling's
 * `whyAlsoFrom` list and as `REFERENCES` edges from the individual commits, which
 * is where a mention rather than an explanation belongs.
 */
function buildExplainsRows(
  rationale: RationaleIndex,
  couplings: CouplingEdge[],
): { ticket: string; path: string; mentions: number; share: number; firstCommit: string | null }[] {
  const acc = new Map<string, { ticket: string; path: string; mentions: number; share: number; firstCommit: string | null }>();

  for (const edge of couplings) {
    const why = rationale.rationales.get(pairKey(edge.a, edge.b));
    if (!why?.ticket) continue;

    for (const path of [edge.a, edge.b]) {
      const id = `${why.ticket}${NUL}${path}`;
      const existing = acc.get(id);
      if (existing) {
        existing.mentions += why.mentions;
        // Share is per-coupling, so it takes the strongest claim rather than a
        // sum that would not mean anything.
        existing.share = Math.max(existing.share, why.share);
        if (!existing.firstCommit) existing.firstCommit = why.commit;
      } else {
        acc.set(id, { ticket: why.ticket, path, mentions: why.mentions, share: why.share, firstCommit: why.commit });
      }
    }
  }

  return Array.from(acc.values());
}

async function batched<T>(
  graph: Graph,
  label: string,
  cypher: string,
  rows: T[],
  size: number,
  onProgress?: (written: number) => void,
  extraParams: Record<string, unknown> = {},
): Promise<void> {
  let written = 0;
  let lastLogged = 0;
  const logEvery = Math.max(size, Math.ceil(rows.length / 6));

  for (let i = 0; i < rows.length; i += size) {
    const slice = rows.slice(i, i + size);
    const result = await graph.query(label, cypher, { rows: slice as never[], ...extraParams } as never);
    if (result.error) throw new Error(`[ingest/${label}] ${result.error}`);
    written += slice.length;
    if (onProgress && written - lastLogged >= logEvery) {
      lastLogged = written;
      onProgress(written);
    }
  }
  if (onProgress) onProgress(written);
}

function collectPeople(commits: CommitRecord[]): Map<string, { login: string; name: string; commits: number }> {
  const people = new Map<string, { login: string; name: string; commits: number }>();
  for (const c of commits) {
    const login = loginOf(c.name, c.email);
    const existing = people.get(login);
    if (existing) existing.commits++;
    else people.set(login, { login, name: c.name || login, commits: 1 });
  }
  return people;
}

function dedupeImports(edges: ImportEdge[], touched: Set<string>): ImportEdge[] {
  const seen = new Set<string>();
  const out: ImportEdge[] = [];
  for (const e of edges) {
    if (!touched.has(e.a) || !touched.has(e.b)) continue;
    const k = `${e.a}\u0000${e.b}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}

function bfs(adjacency: Map<string, string[]>, start: string, maxDepth: number, cap: number): Set<string> {
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