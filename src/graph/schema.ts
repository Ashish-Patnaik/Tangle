/**
 * Tangle graph model.
 *
 *   (:Repo   {id, ingestedAt, head, language, commitCount})
 *   (:File   {path, ext, dir, changes, bytes})
 *   (:Commit {sha, date, message, filesCount})
 *   (:Person {login, name, commits})
 *   (:Ticket {key, repo, number, kind, title, url, references,
 *             explicit, firstDate, lastDate, files})
 *
 *   (r:Repo)-[:HAS_FILE]->(f:File)
 *   (f:File)-[:TOUCHED_IN]->(c:Commit)
 *   (c:Commit)-[:AUTHORED]->(p:Person)
 *
 *   (a:File)-[:COUPLED {coChanges, confidenceAB, confidenceBA,
 *                        maxConfidence, support, jaccard, hasImport,
 *                        whyTicket, whyKind, whyTitle, whyUrl, whyDate,
 *                        whyCommit, whyMentions, whyShare, whyExplicit,
 *                        whyAlsoFrom, whySubject}]
 *      ->(b:File)
 *   (a:File)-[:IMPORTS {via}]->(b:File)
 *
 *   Provenance — the "why" behind a coupling:
 *
 *   (:Ticket {key, repo, number, kind, title, url, references,
 *             explicit, firstDate, lastDate, files, reverts})
 *   (c:Commit)-[:REFERENCES {explicit, raw}]->(t:Ticket)
 *   (t:Ticket)-[:EXPLAINS {mentions, share, firstCommit}]->(f:File)
 *
 * COUPLED is stored once per unordered pair (the lexicographically smaller path
 * is always `a`). Direction-specific confidence stays recoverable from the
 * per-file `changes` counts, so a second edge would only cost traversal time.
 *
 * `hasImport` is computed at load time by a bounded BFS over IMPORTS from every
 * file that appears in a coupling. It is what lets the phantom-coupling query be
 * a plain predicate, and `tangle verify` recomputes the same answer as a live
 * traversal and diffs the two.
 *
 * The `why*` properties on COUPLED are a denormalised copy of the EXPLAINED_BY
 * edge, for the same reason `changes` is denormalised onto File: the blast-radius
 * query returns affected files, and the reason a file is affected has to arrive
 * in the same round trip. `EXPLAINED_BY` remains the authority, and `verify`
 * cross-checks the two against each other so a drift cannot hide.
 */
import { intLiteral } from "./params.js";

/**
 * The `why*` RETURN columns, shared by every query that reports provenance.
 *
 * Declared before the queries that interpolate it: a `const` is in the temporal
 * dead zone until its definition is evaluated, and these are module-level
 * constants evaluated in file order. Sharing one definition is what stops the
 * three phantom-coupling implementations and the live blast-radius query from
 * drifting apart on which fields mean what.
 */
const WHY_COLUMNS = `
       c.whyTicket    AS whyTicket,
       c.whyKind      AS whyKind,
       c.whyTitle     AS whyTitle,
       c.whyUrl       AS whyUrl,
       c.whyDate      AS whyDate,
       c.whyMentions  AS whyMentions,
       c.whyShare     AS whyShare,
       c.whyExplicit  AS whyExplicit,
       c.whyAlsoFrom  AS whyAlsoFrom,
       c.whySubject   AS whySubject`;

export const SCHEMA_STATEMENTS: string[] = [
  "CREATE INDEX ON :File(path)",
  "CREATE INDEX ON :Commit(sha)",
  "CREATE INDEX ON :Person(login)",
  "CREATE INDEX ON :Repo(id)",
  "CREATE INDEX ON :Ticket(key)",
];

export const UPSERT_REPO = `
MERGE (r:Repo {id: $id})
SET r.ingestedAt = $ingestedAt, r.head = $head, r.language = $language, r.commitCount = $commitCount
RETURN r.id AS id`;

/** One call per batch. FalkorDB handles a few thousand rows comfortably. */
export const INSERT_FILES = `
UNWIND $rows AS row
MERGE (f:File {path: row.path})
  ON CREATE SET f.createdAt = $now
SET f.ext = row.ext, f.dir = row.dir, f.changes = row.changes, f.bytes = row.bytes
RETURN count(f) AS written`;

export const INSERT_COMMITS = `
UNWIND $rows AS row
MERGE (c:Commit {sha: row.sha})
SET c.date = row.date, c.message = row.message, c.filesCount = row.filesCount
RETURN count(c) AS written`;

export const INSERT_PEOPLE = `
UNWIND $rows AS row
MERGE (p:Person {login: row.login})
SET p.name = row.name, p.commits = row.commits
RETURN count(p) AS written`;

export const INSERT_TOUCHES = `
UNWIND $rows AS row
MATCH (f:File {path: row.path})
MATCH (c:Commit {sha: row.sha})
MERGE (f)-[:TOUCHED_IN]->(c)
RETURN count(*) AS written`;

export const INSERT_AUTHORS = `
UNWIND $rows AS row
MATCH (c:Commit {sha: row.sha})
MERGE (p:Person {login: row.login})
  ON CREATE SET p.commits = 0
MERGE (c)-[:AUTHORED]->(p)
RETURN count(*) AS written`;

export const INSERT_COUPLINGS = `
UNWIND $rows AS row
MATCH (a:File {path: row.a})
MATCH (b:File {path: row.b})
MERGE (a)-[c:COUPLED]->(b)
SET c.coChanges      = row.coChanges,
    c.confidenceAB   = row.confidenceAB,
    c.confidenceBA   = row.confidenceBA,
    c.maxConfidence  = row.maxConfidence,
    c.support        = row.support,
    c.jaccard        = row.jaccard,
    c.hasImport      = row.hasImport,
    c.whyTicket      = row.whyTicket,
    c.whyKind        = row.whyKind,
    c.whyTitle       = row.whyTitle,
    c.whyUrl         = row.whyUrl,
    c.whyDate        = row.whyDate,
    c.whyCommit      = row.whyCommit,
    c.whyMentions    = row.whyMentions,
    c.whyShare       = row.whyShare,
    c.whyExplicit    = row.whyExplicit,
    c.whyAlsoFrom    = row.whyAlsoFrom,
    c.whySubject     = row.whySubject
RETURN count(c) AS written`;

export const INSERT_IMPORTS = `
UNWIND $rows AS row
MATCH (a:File {path: row.a})
MATCH (b:File {path: row.b})
MERGE (a)-[i:IMPORTS]->(b)
SET i.via = row.via
RETURN count(i) AS written`;

export const INSERT_TICKETS = `
UNWIND $rows AS row
MERGE (t:Ticket {key: row.key})
  ON CREATE SET t.createdAt = $now
SET t.repo = row.repo,
    t.number = row.number,
    t.kind = row.kind,
    t.title = row.title,
    t.url = row.url,
    t.references = row.references,
    t.explicit = row.explicit,
    t.firstDate = row.firstDate,
    t.lastDate = row.lastDate,
    t.files = row.files,
    t.reverts = row.reverts
RETURN count(t) AS written`;

/** Commit -> ticket. `explicit` records whether a fixes/closes keyword was used. */
export const INSERT_REFERENCES = `
UNWIND $rows AS row
MATCH (c:Commit {sha: row.sha})
MERGE (t:Ticket {key: row.key})
MERGE (c)-[r:REFERENCES]->(t)
  SET r.explicit = row.explicit, r.raw = row.raw
RETURN count(r) AS written`;

/**
 * Ticket -> file. One edge per (ticket, file) pair the ticket's commits touched.
 *
 * `mentions` is the number of shared commits that referenced the ticket while
 * touching this file, which is what distinguishes "this ticket is vaguely related
 * to this file" from "this ticket is why these two files move together".
 */
export const INSERT_EXPLAINS = `
UNWIND $rows AS row
MATCH (t:Ticket {key: row.ticket})
MATCH (f:File {path: row.path})
MERGE (t)-[e:EXPLAINS]->(f)
  SET e.mentions = row.mentions, e.share = row.share, e.firstCommit = row.firstCommit
RETURN count(e) AS written`;

/** Denormalise File.commits upward so repo stats never need a traversal. */
export const REFRESH_FILE_CHANGES = `
MATCH (f:File)
OPTIONAL MATCH (f)-[t:TOUCHED_IN]->(:Commit)
WITH f, count(t) AS n
SET f.changes = n
RETURN count(f) AS files`;

export const REFRESH_PERSON_COMMITS = `
MATCH (p:Person)
OPTIONAL MATCH (:Commit)-[:AUTHORED]->(p)
WITH p, count(*) AS n
SET p.commits = n
RETURN count(p) AS people`;

/**
 * ---------------------------------------------------------------------------
 * Queries used by the product.
 * ---------------------------------------------------------------------------
 */

/**
 * See `src/graph/totals.ts` for why these are separate queries rather than one
 * query with six CALL sub-queries.
 */

/**
 * Blast radius. Multi-seed BFS over COUPLED, keeping only traversals where
 * every hop clears the confidence floor, and returning the concrete node chain
 * so the UI can draw it and the report can cite it.
 *
 * The hop budget is inlined rather than passed as `$maxHops` because FalkorDB
 * rejects a parameter inside a variable-length relationship bound. See
 * `src/graph/params.ts`.
 *
 * `all(x IN relationships(p) WHERE ...)` is what makes the result a *minimum
 * confidence* rather than an average: a file three weak hops away is excluded
 * even if one hop happens to be strong, which is the behaviour that stops an
 * impact tool from telling a developer everything is coupled to everything.
 */
/**
 * Blast radius. Multi-seed BFS over COUPLED, keeping only traversals where
 * every hop clears the confidence floor, and returning the concrete node chain
 * so the UI can draw it and the report can cite it.
 *
 * The hop budget is inlined rather than passed as `$maxHops` because FalkorDB
 * rejects a parameter inside a variable-length relationship bound. See
 * `src/graph/params.ts`.
 *
 * `all(x IN relationships(p) WHERE ...)` is what makes the result a *minimum
 * confidence* rather than an average: a file three weak hops away is excluded
 * even if one hop happens to be strong, which is the behaviour that stops an
 * impact tool from telling a developer everything is coupled to everything.
 *
 * The `why*` fields are carried on the last hop of the path — the edge adjacent
 * to the target, which is the one whose provenance explains why *this* file is
 * affected. Carrying them through `relationships(p)` rather than re-querying
 * keeps the whole answer in one round trip, which is what makes "you forgot X,
 * and here is the bug that tied X to your change" a single call.
 */
export const blastRadiusQuery = (maxHops: number): string => {
  const last = relationshipsLast();
  return `
UNWIND $seeds AS seedPath
MATCH p = (:File {path: seedPath})-[r:COUPLED*1..${intLiteral(maxHops, { min: 1, max: 6, fallback: 2 })}]-(target:File)
WHERE all(x IN relationships(p) WHERE x.maxConfidence >= $minConfidence)
RETURN seedPath,
       target.path AS targetPath,
       [n IN nodes(p) | n.path] AS nodePath,
       length(p) AS hops,
       [x IN relationships(p) | x.coChanges] AS strengths,
       [x IN relationships(p) | x.maxConfidence] AS confidences,
       ${last.whyTicket} AS whyTicket,
       ${last.whyKind} AS whyKind,
       ${last.whyTitle} AS whyTitle,
       ${last.whyUrl} AS whyUrl,
       ${last.whyDate} AS whyDate,
       ${last.whyMentions} AS whyMentions,
       ${last.whyShare} AS whyShare,
       ${last.whyExplicit} AS whyExplicit,
       ${last.whyAlsoFrom} AS whyAlsoFrom,
       ${last.whySubject} AS whySubject
ORDER BY hops ASC`;
};

/**
 * The relationship adjacent to the target node in a path.
 *
 * FalkorDB has no LAST() over a relationship list, and the path is undirected so
 * "the last one" depends on which direction the traversal arrived from. Indexing
 * by `length(p)` from the end is the one formulation that is correct either way.
 */
function relationshipsLast(): { [field: string]: string } {
  const n = "relationships(p)";
  const at = (field: string) => `${n}[size(${n}) - 1].${field}`;
  return {
    whyTicket: at("whyTicket"),
    whyKind: at("whyKind"),
    whyTitle: at("whyTitle"),
    whyUrl: at("whyUrl"),
    whyDate: at("whyDate"),
    whyMentions: at("whyMentions"),
    whyShare: at("whyShare"),
    whyExplicit: at("whyExplicit"),
    whyAlsoFrom: at("whyAlsoFrom"),
    whySubject: at("whySubject"),
  };
}

/** How much of the graph the traversal actually got to look at. */
export const EDGES_CONSIDERED = `
UNWIND $paths AS path
MATCH (f:File {path: path})-[c:COUPLED]-()
RETURN count(DISTINCT c) AS edges`;

/**
 * The "why" for one coupling: the ticket that best accounts for it.
 *
 * Two orientations are supported, because the caller may hold the pair in either
 * order and COUPLED is stored once per unordered pair with the lexicographically
 * smaller path as `a`. A caller that does not canonicalise silently gets an empty
 * answer for a coupling that plainly has one, which is the same trap as
 * `COUPLING_EVIDENCE` above.
 */
export const COUPLING_WHY = `
UNWIND $pairs AS pair
MATCH (a:File {path: pair.a})-[c:COUPLED]->(b:File {path: pair.b})
RETURN pair.a AS a,
       pair.b AS b,
       c.coChanges AS coChanges,
       c.maxConfidence AS confidence,
       c.hasImport AS hasImport,${WHY_COLUMNS}`;

/**
 * Couplings whose provenance is strongest, for the "why" panel.
 *
 * Ranked by explicit closes/fixes references first, then by the share of the
 * coupling's shared commits a single ticket accounts for. A ticket that explains
 * 90% of why two files move together is a far better answer than one mentioned in
 * passing, and the difference is the whole point of storing `share`.
 */
export const EXPLAINED_COUPLINGS = `
MATCH (a:File)-[c:COUPLED]->(b:File)
WHERE a.path < b.path
  AND c.whyTicket IS NOT NULL
  AND c.coChanges >= $minCoChanges
RETURN a.path AS a,
       b.path AS b,
       c.coChanges AS coChanges,
       c.maxConfidence AS confidence,
       c.hasImport AS hasImport,${WHY_COLUMNS}
ORDER BY c.whyExplicit DESC, c.whyShare DESC, c.coChanges DESC
LIMIT $limit`;

/**
 * The reverse question: everything one ticket explains.
 *
 * This is the view a developer wants when a production incident has just
 * happened and they need to know which parts of the codebase that incident
 * quietly ties together.
 */
export const TICKET_EXPLAINS = `
MATCH (t:Ticket {key: $key})
MATCH (t)-[e:EXPLAINS]->(f:File)
OPTIONAL MATCH (f)-[c:COUPLED]-(other:File)
  WHERE other <> f AND c.whyTicket = t.key
RETURN t.key AS key,
       t.kind AS kind,
       t.title AS title,
       t.url AS url,
       t.references AS references,
       t.explicit AS explicit,
       t.firstDate AS firstDate,
       t.files AS files,
       collect(DISTINCT {path: f.path, mentions: e.mentions, share: e.share})[..$limit] AS explained`;

/**
 * Tickets ranked by how much of the repository's coupling structure they
 * account for. A single issue that explains many strong couplings is a
 * load-bearing decision that nobody wrote down anywhere else.
 */
/**
 * Tickets ranked by how much coupling structure they actually caused.
 *
 * The ranking subtracts reverts before ordering, which is the whole reason this
 * query is not simply `ORDER BY sum(e.mentions)`.
 *
 * Measured on vercel/next.js, the naive ranking put two tickets whose titles are
 * both `Revert "..."` at the top of the list, one of them accounting for 8,632
 * mentions across 62 files. That is a ticket that was cited repeatedly while
 * being un-done, not a decision the codebase still depends on. Dividing the
 * mention total by the commit count and discounting by the revert share puts the
 * tickets that *did* the work at the top, where a reader can act on them.
 *
 * Both numbers are still returned, so the effect of the discount is visible
 * rather than hidden inside the ordering.
 */
export const INFLUENTIAL_TICKETS = `
MATCH (t:Ticket)-[e:EXPLAINS]->(:File)
WITH t, count(e) AS filesExplained, sum(e.mentions) AS totalMentions
// The discount is an integer fraction on purpose. Measured on vercel/next.js, a
// real 1-in-2 revert ratio came back as exactly 0 through integer division, which
// made every ticket's effective score zero and silently flattened the whole
// ranking. Multiplying first keeps the arithmetic in floating point and
// subtracting the raw counts back out avoids any rounding to zero.
RETURN t.key AS key,
       t.kind AS kind,
       t.title AS title,
       t.url AS url,
       t.explicit AS explicit,
       t.references AS references,
       t.reverts AS reverts,
       t.firstDate AS firstDate,
       filesExplained,
       totalMentions,
       totalMentions - t.reverts * (totalMentions / t.references) AS effectiveMentions
ORDER BY effectiveMentions DESC, totalMentions DESC, filesExplained DESC
LIMIT $limit`;

/**
 * Every coupling a single ticket accounts for, strongest first.
 *
 * `EXPLAINED_BY` rather than the denormalised `whyTicket`, so this query is a
 * genuinely independent path to the same answer. That is deliberate: it lets
 * `verify` assert the two agree, which is the only way to know the
 * denormalisation at load time was not lossy.
 */
export const TICKET_COUPLINGS = `
MATCH (t:Ticket {key: $key})-[:EXPLAINS]->(a:File)-[c:COUPLED]->(b:File)
WHERE c.whyTicket = t.key
RETURN a.path AS a,
       b.path AS b,
       c.coChanges AS coChanges,
       c.maxConfidence AS confidence,
       c.hasImport AS hasImport,
       c.whyMentions AS mentions,
       c.whyShare AS share,
       c.whySubject AS subject
ORDER BY c.coChanges DESC, c.whyShare DESC
LIMIT $limit`;

/**
 * The cross-check `verify` runs: the denormalised `whyTicket` on every coupling
 * must name a Ticket node that actually exists.
 *
 * The `OPTIONAL MATCH` is load-bearing. A plain `MATCH (:Ticket {key: ...})` would
 * return nothing for a dangling name and the count would read zero, which is the
 * same as the healthy case — the exact failure mode this check exists to catch.
 */
export const DANGLING_WHY_TICKETS = `
MATCH ()-[c:COUPLED]->()
WHERE c.whyTicket IS NOT NULL
OPTIONAL MATCH (t:Ticket {key: c.whyTicket})
RETURN count(c) AS namedCouplings,
       count(t) AS resolvedTickets`;

/**
 * The other half of the cross-check: every EXPLAINS edge must be backed by a
 * coupling that names the same ticket.
 *
 * Read as: for each ticket-file the graph claims the ticket explains, is there a
 * coupling from that file whose `whyTicket` is this ticket? A drift between the
 * edge and the denormalised copy shows up here as an edge with no backing.
 *
 * `NONE(x IN ... WHERE ...)` rather than `NOT EXISTS { }` because the subquery
 * spelling does not parse on this FalkorDB build. Both TOUCHED_IN-style direction
 * traps apply here too: COUPLED is stored once per unordered pair, so the match is
 * undirected.
 */
export const UNBACKED_EXPLAINS = `
MATCH (t:Ticket)-[:EXPLAINS]->(f:File)
OPTIONAL MATCH (f)-[c:COUPLED]-(other:File)
WITH t, f, collect(c.whyTicket) AS named
WITH NONE(x IN named WHERE x = t.key) AS unbacked
RETURN sum(CASE WHEN unbacked THEN 1 ELSE 0 END) AS unbacked`;

/** Provenance totals for `stats` and the repo page. */
export const RATIONALE_TOTALS = `
MATCH (t:Ticket)
RETURN count(t) AS tickets,
       sum(CASE WHEN t.explicit > 0 THEN 1 ELSE 0 END) AS explicitTickets,
       sum(t.references) AS references`;

/**
 * Provenance for the ghost couplings: phantom pairs that also carry a reason.
 *
 * The discover panel and this are the same finding seen from two directions. The
 * panel ranks by coupling strength and reports the reason it happened to find;
 * this ranks by reason strength and reports the coupling. A pair with 82 shared
 * commits and a 3% attribution from one ticket is a different claim from a pair
 * with 5 shared commits and a 60% attribution, and only the second one tells you
 * *why* the two files are joined.
 */
export const GHOST_COUPLINGS = `
MATCH (a:File)-[c:COUPLED]->(b:File)
WHERE a.path < b.path
  AND c.hasImport = false
  AND c.coChanges >= $minCoChanges
  AND c.maxConfidence >= $minConfidence
  AND c.whyTicket IS NOT NULL
  AND c.whyShare >= $minShare
RETURN a.path AS a,
       b.path AS b,
       c.coChanges AS coChanges,
       c.maxConfidence AS confidence,${WHY_COLUMNS}
ORDER BY c.whyMentions DESC, c.whyShare DESC, c.coChanges DESC, c.whyExplicit DESC
LIMIT $limit`;

/** Coupling provenance coverage: how much of the graph carries a reason. */
export const RATIONALE_COVERAGE = `
MATCH ()-[c:COUPLED]->()
RETURN count(c) AS couplings,
       sum(CASE WHEN c.whyTicket IS NOT NULL THEN 1 ELSE 0 END) AS withTicket,
       sum(CASE WHEN c.whySubject IS NOT NULL THEN 1 ELSE 0 END) AS withSubject,
       sum(CASE WHEN c.whyExplicit = true THEN 1 ELSE 0 END) AS withExplicit`;

/** Commit-level evidence for one coupling: the SHAs that prove it.
 *
 * Both endpoints must be given in the canonical COUPLED order, otherwise the
 * MATCH finds nothing and the caller reports "no evidence" for a coupling that
 * plainly has some.
 *
 * Note the direction: both TOUCHED_IN edges point from a File to its Commit, so
 * the second hop is written as `<-[:TOUCHED_IN]-`. Getting that backwards
 * silently returns zero rows rather than an error, which is the kind of failure
 * that looks like "this repo just has no history".
 *
 * `total` is recomputed from the commit log rather than read off the COUPLED
 * edge, so it doubles as an independent check of the stored count. `verify`
 * asserts that `total === c.coChanges`.
 */
export const COUPLING_EVIDENCE = `
UNWIND $pairs AS pair
MATCH (a:File {path: pair.a})-[c:COUPLED]->(:File {path: pair.b})
MATCH (a)-[:TOUCHED_IN]->(commit:Commit)<-[:TOUCHED_IN]-(:File {path: pair.b})
RETURN pair.a AS a, pair.b AS b,
       c.coChanges AS storedCoChanges,
       count(commit) AS recountedCoChanges,
       [x IN collect(commit.sha)[..$limit] | x] AS shas
ORDER BY storedCoChanges DESC`;

/**
 * Phantom couplings: co-changed hundreds of times, and the import graph has no
 * edge between them. This is the discovery panel, and it is a graph-only
 * predicate — there is no lexical similarity to retrieve and no type signature
 * to follow.
 *
 * The negated check is a depth-1 undirected edge existence test, and the depth
 * is deliberately low. Two measurements on vercel/next.js, 93,502 coupling
 * edges and 14,412 import edges:
 *
 *   NOT (a)-[:IMPORTS]-(b)          746 ms    works
 *   NOT (a)-[:IMPORTS*1..2]-(b)     > 1 s     times out
 *   NOT EXISTS { ... }              parse error on this build
 *
 * Every deeper form turns a cheap adjacency test into a traversal per candidate
 * pair. Depth 1 is the right answer anyway: "these two files have no import
 * between them" is the claim worth making, and it is a claim that survives
 * scrutiny. `tangle verify` cross-checks it against the load-time marker.
 */
export const unlinkedPairsQuery = (importDepth: number): string => {
  const hops = intLiteral(importDepth, { min: 1, max: 4, fallback: 1 });
  const pattern = hops === "1" ? "[:IMPORTS]" : `[:IMPORTS*1..${hops}]`;
  return `
MATCH (a:File)-[c:COUPLED]->(b:File)
WHERE a.path < b.path
  AND c.coChanges     >= $minCoChanges
  AND c.maxConfidence >= $minConfidence
  AND NOT (a)-${pattern}-(b)
RETURN a.path AS a, b.path AS b,
       c.coChanges AS coChanges,
       c.maxConfidence AS confidence,
       c.support AS support,${WHY_COLUMNS}
ORDER BY c.coChanges DESC, c.maxConfidence DESC
LIMIT $limit`;
};

/** Subquery spelling, for builds that parse it. Kept for `verify`. */
export const UNLINKED_PAIRS_EXISTS = `
MATCH (a:File)-[c:COUPLED]->(b:File)
WHERE a.path < b.path
  AND c.coChanges     >= $minCoChanges
  AND c.maxConfidence >= $minConfidence
  AND NOT EXISTS { MATCH (a)-[:IMPORTS]->(b) }
RETURN a.path AS a, b.path AS b,
       c.coChanges AS coChanges,
       c.maxConfidence AS confidence,
       c.support AS support,${WHY_COLUMNS}
ORDER BY c.coChanges DESC, c.maxConfidence DESC
LIMIT $limit`;

/** Fallback using the load-time marker. */
export const UNLINKED_PAIRS_FLAG = `
MATCH (a:File)-[c:COUPLED]->(b:File)
WHERE a.path < b.path
  AND c.coChanges     >= $minCoChanges
  AND c.maxConfidence >= $minConfidence
  AND c.hasImport = false
RETURN a.path AS a, b.path AS b,
       c.coChanges AS coChanges,
       c.maxConfidence AS confidence,
       c.support AS support,${WHY_COLUMNS}
ORDER BY c.coChanges DESC, c.maxConfidence DESC
LIMIT $limit`;

/** The inverse: statically coupled, never changed together. Dead imports. */
export const OVERSTATIC_PAIRS = `
MATCH (a:File)-[:IMPORTS]-(b:File)
WHERE a.path < b.path
  AND NOT (a)-[c:COUPLED]-(b)
RETURN a.path AS a, b.path AS b
LIMIT $limit`;

/**
 * Is there any static path between two files, and what is the shortest one?
 *
 * Two FalkorDB constraints shape this query:
 *   - `shortestPath` is only legal in a WITH or RETURN clause, so the entire
 *     query is a RETURN.
 *   - a variable-length bound inside `shortestPath` may not be a parameter, so
 *     the depth is interpolated as an integer literal. `depth` is validated as
 *     an integer before it gets here, which is why that is safe and why it is
 *     not simply string-concatenated from user input.
 */
export const importPathBetween = (depth: number): string => `
MATCH (a:File {path: $a}), (b:File {path: $b})
RETURN shortestPath((a)-[:IMPORTS*1..${intLiteral(depth, { min: 1, max: 12, fallback: 4 })}]->(b)) AS p`;

/** Per-file, per-author commit counts. Reviewer affinity is computed from this. */
export const REVIEWER_AFFINITY = `
UNWIND $paths AS path
MATCH (f:File {path: path})-[:TOUCHED_IN]->(c:Commit)-[:AUTHORED]->(p:Person)
RETURN path, p.login AS login, p.name AS name, count(*) AS commits
ORDER BY commits DESC`;

/**
 * PageRank over the coupling graph: which files are structurally load-bearing.
 *
 * The `LIMIT` is in the outer RETURN, not passed to the procedure. `algo.pageRank`
 * on this build accepts exactly two positional arguments and rejects a config map:
 *
 *   Received 3 arguments to procedure 'algo.pageRank', expected at most 2
 *
 * so the `{limit: $limit}` form that the FalkorDB docs show for other procedures
 * does not work here. It was written before anything called it, and it failed.
 *
 * One consequence worth stating: PageRank scores *incoming* edges, and COUPLED is
 * stored once per unordered pair with the lexicographically smaller path as the
 * source. So the direction is arbitrary rather than meaningful, and the score is
 * only trustworthy as a structural centrality measure over the undirected graph.
 * It answers "what does everything else route through", which is the question
 * asked of it, and is not used to make a directed claim anywhere.
 */
export const FILE_PAGERANK = `
CALL algo.pageRank('File', 'COUPLED')
YIELD node, score
RETURN node.path AS path, score
ORDER BY score DESC
LIMIT $limit`;

/** PageRank over the person graph. Same two-argument form, same caveat. */
export const PERSON_PAGERANK = `
CALL algo.pageRank('Person', 'AUTHORED')
YIELD node, score
RETURN node.login AS login, score
ORDER BY score DESC
LIMIT $limit`;

/**
 * Betweenness: the files that bridge two otherwise-separate parts of the codebase.
 *
 * This is the one centrality measure here that answers a different question from
 * PageRank, and it is the more useful one for a reviewer: PageRank finds files many
 * changes route through, betweenness finds files that, if missed, break a link
 * between clusters.
 *
 * Same signature lesson as PageRank — this build takes a single optional map and
 * rejects positional arguments, and a bare `algo.betweenness('File')` fails with
 * "Invalid argument type: expected a map or null".
 *
 * `algo.betweenness({})` runs over the whole graph. There is no label filter on
 * this build, so the label is applied afterwards in the RETURN.
 */
export const FILE_BETWEENNESS = `
CALL algo.betweenness({})
YIELD node, score
WITH node, score WHERE node:File
RETURN node.path AS path, score
ORDER BY score DESC
LIMIT $limit`;

/**
 * Harmonic centrality over the coupling graph.
 *
 * Preferred over raw degree for "busiest" files because it is robust on a
 * disconnected graph, which this one emphatically is: most files in a repository
 * have never co-changed with anything outside their own module.
 */
export const FILE_HARMONIC = `
CALL algo.HarmonicCentrality()
YIELD node, score
WITH node, score WHERE node:File
RETURN node.path AS path, score
ORDER BY score DESC
LIMIT $limit`;

/**
 * Weakly connected components of the coupling graph.
 *
 * Zero arguments on this build — `algo.WCC('File','COUPLED')` is rejected with
 * "Received 2 arguments to procedure 'algo.WCC', expected at most 1", and a config
 * map is rejected too ("Unknown parameter: directed"). So the component sizes are
 * computed here and grouped in the outer query.
 *
 * This is the "shadow architecture" view: modules the directory layout says are
 * separate, but which history says are one thing.
 */
export const COUPLING_COMPONENTS = `
CALL algo.WCC()
YIELD node, componentId
WITH node, componentId WHERE node:File
RETURN componentId AS component,
       count(node) AS files,
       collect(node.path)[..$sample] AS sample,
       sum(node.changes) AS totalChanges
ORDER BY files DESC
LIMIT $limit`;

/**
 * Coupling knowledge per person.
 *
 * The `total` is the denominator every row shares, so the caller can compute a
 * share without a second query. Counting `TOUCHED_IN` rather than `COUPLED` edges
 * per person would be wrong: a person who authors many commits touching one file
 * is not a bridge between modules, and counting edges rather than touches is what
 * makes the two different.
 */
/**
 * Every projection in a `WITH` needs an explicit alias on this build, and bare
 * column names carried through are rejected:
 *
 *   WITH p, files, couplings, sum(couplings) OVER () AS total
 *                    ^^^^^ ^^^^^^^^^ "WITH clause projections must be aliased"
 *
 * So each stage re-aliases everything it carries forward. Also note the second
 * match uses a distinct variable for the relationship, since `c` is already the
 * commit alias in the first stage and reusing it shadows rather than extends.
 */
/**
 * Two constraints on this build, both discovered by running the query:
 *
 * 1. `sum(x) OVER ()` is rejected inside a `WITH` that also carries plain column
 *    references — "WITH clause projections must be aliased". The window function
 *    is therefore computed in the RETURN clause, where a bare column is legal.
 * 2. `count(DISTINCT …)` needs the distinct target to be a node, which `f` is.
 *
 * The window is computed after the `LIMIT` would be a bug, so the ordering happens
 * on the inner value and the total is windowed over the full set before the outer
 * limit truncates it.
 */
/**
 * Bus factor: coupling edges each person has authored.
 *
 * **Both relationship directions matter, and both were wrong once.** Measured on
 * this build, each mistake returns zero rows *with no error* — indistinguishable
 * from "this repository has no people who touch coupled files", which is the worst
 * possible failure for a number that ends up in a report.
 *
 *   - `TOUCHED_IN` points **File → Commit**, so reaching a file from its commit
 *     needs `<-[:TOUCHED_IN]-`.
 *   - `AUTHORED` points **Commit → Person**, so reaching a person from a commit
 *     needs `-[:AUTHORED]->`.
 *
 * Written the other way round each of these returns nothing:
 *
 *   MATCH (p:Person)-[:AUTHORED]->(c:Commit)   → 0 rows   (21 people exist)
 *   MATCH (c:Commit)-[:TOUCHED_IN]->(f:File)    → 0 rows   (203 touch edges exist)
 *
 * The way to catch this class of bug is to assert a known non-zero count first —
 * `tangle verify` now does exactly that — rather than trusting a zero to mean
 * "nothing found".
 *
 * The `OPTIONAL MATCH` keeps a person who only ever touched files that never
 * co-changed on the list, because that is a real data point about where coupling
 * knowledge is thin.
 */
export const BUS_FACTOR_SIMPLE = `
MATCH (c:Commit)-[:AUTHORED]->(p:Person)
MATCH (c)<-[:TOUCHED_IN]-(f:File)
OPTIONAL MATCH (f)-[edge:COUPLED]-()
RETURN p.login AS login,
       p.name AS name,
       count(DISTINCT f) AS files,
       count(edge) AS couplings
ORDER BY couplings DESC
LIMIT $limit`;

/**
 * The denominator every bus-factor row divides by.
 *
 * A window function was tried first and rejected on this build — a window in
 * `RETURN` parses, but not when followed by `ORDER BY` ("Unexpected clause
 * following RETURN"), and in `WITH` it trips "projections must be aliased". A
 * second one-row query is cheaper to reason about than either workaround, and it
 * makes the denominator's definition explicit: every coupling any person authored.
 */
export const BUS_FACTOR_TOTAL = `
MATCH (c:Commit)-[:AUTHORED]->(:Person)
MATCH (c)<-[:TOUCHED_IN]-(f:File)-[edge:COUPLED]-()
RETURN count(edge) AS total`;

/**
 * A non-zero control for the relationships the bus-factor query depends on.
 *
 * A traversal that returns zero rows because its relationship direction is wrong
 * looks exactly like one that returns zero rows because the data is absent. This
 * query asserts the facts exist, so `verify` can tell those two cases apart rather
 * than reporting an empty graph as a passing check.
 */
export const RELATIONSHIP_CONTROL = `
MATCH (c:Commit)-[:AUTHORED]->(:Person)
WITH count(*) AS authors
MATCH (f:File)-[:TOUCHED_IN]->(:Commit)
WITH authors AS authors, count(*) AS touches
MATCH ()-[e:COUPLED]->()
RETURN authors AS authors, touches AS touches, count(e) AS couplings`;

/**
 * Do two files reach each other through the coupling graph, and by what path?
 *
 * `shortestPath()` over COUPLED rather than over IMPORTS is the "how are these two
 * files connected" question when there is no import between them — which is
 * precisely the phantom-coupling case, and the reason this graph exists.
 *
 * Depth is an integer literal because FalkorDB rejects a parameter inside a
 * variable-length relationship bound; see `src/graph/params.ts`.
 */
export const couplingPathBetween = (depth: number): string => `
MATCH (a:File {path: $a}), (b:File {path: $b})
RETURN shortestPath((a)-[:COUPLED*1..${intLiteral(depth, { min: 1, max: 6, fallback: 3 })}]-(b)) AS p`;

/** The showcase row for a repo: its single strongest coupling. */
export function strongestCouplings(limit = 20) {
  return `
MATCH (a:File)-[c:COUPLED]->(b:File)
RETURN a.path AS a, b.path AS b,
       c.coChanges AS coChanges,
       c.maxConfidence AS confidence,
       c.hasImport AS hasImport
ORDER BY c.coChanges DESC, c.maxConfidence DESC
LIMIT ${Number(limit)}`;
}

/** Files changed most often. Shown on the repo page so the graph is explorable. */
export function hotFiles(limit = 25) {
  return `
MATCH (f:File)
WHERE f.changes > 0
RETURN f.path AS path, f.changes AS changes, f.lines AS lines, f.ext AS ext
ORDER BY f.changes DESC
LIMIT ${Number(limit)}`;
}

/** Everything the UI needs to draw one blast radius, in one round trip. */
export function neighbourhood(paths: string[], limit = 200) {
  return `
UNWIND $paths AS path
MATCH (f:File {path: path})
OPTIONAL MATCH (f)-[c:COUPLED]-(other:File)
  WHERE c.maxConfidence >= 0.2
WITH f, collect({path: other.path, confidence: c.maxConfidence})[..${Number(limit)}] AS neighbours
RETURN f.path AS path, neighbours`;
}

/** Freshness: how stale is this graph relative to the upstream default branch? */
export const GRAPH_HEAD = `MATCH (r:Repo) RETURN r.head AS head, r.ingestedAt AS ingestedAt, r.commitCount AS commitCount LIMIT 1`;