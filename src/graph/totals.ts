import type { Graph, QueryResult } from "./client.js";

export const TOTAL_QUERIES: { key: keyof RepoTotals; cypher: string }[] = [
  { key: "files", cypher: "MATCH (f:File) RETURN count(f) AS n" },
  { key: "commits", cypher: "MATCH (c:Commit) RETURN count(c) AS n" },
  { key: "people", cypher: "MATCH (p:Person) RETURN count(p) AS n" },
  { key: "couplingEdges", cypher: "MATCH ()-[r:COUPLED]->() RETURN count(r) AS n" },
  { key: "importEdges", cypher: "MATCH ()-[r:IMPORTS]->() RETURN count(r) AS n" },
  { key: "coupledFiles", cypher: "MATCH (f:File) WHERE f.changes > 0 RETURN count(f) AS n" },
];

export interface RepoTotals {
  files: number;
  commits: number;
  people: number;
  couplingEdges: number;
  importEdges: number;
  coupledFiles: number;
}

/**
 * Repo totals.
 *
 * Six separate queries issued in parallel, rather than one query with six CALL
 * sub-queries. That is not a stylistic preference. On the FalkorDB build this
 * was developed against, chaining CALL sub-queries that count *relationships*
 * returns 0 for every one of them, while the identical count issued on its own
 * returns the correct number. Node counts chain correctly, which is exactly what
 * makes the bug easy to ship unnoticed.
 *
 * These numbers are the denominators of the coverage claim in Tangle's proof of
 * absence, so they get the correct implementation and a comment explaining why it
 * is not the obvious one.
 *
 * A count that errors returns -1, never 0. A zero would silently shrink a
 * denominator and overstate how much of the repo was actually searched.
 */
export async function repoTotals(graph: Pick<Graph, "query">): Promise<RepoTotals> {
  const results = await Promise.all(
    TOTAL_QUERIES.map((q) => graph.query<{ n: number }>(`total ${q.key}`, q.cypher)),
  );

  const totals = {} as RepoTotals;
  TOTAL_QUERIES.forEach((q, i) => {
    const result = results[i] as QueryResult<{ n: number }>;
    const n = result.error ? undefined : result.rows[0]?.n;
    totals[q.key] = n === undefined || n === null ? -1 : Number(n);
  });
  return totals;
}
