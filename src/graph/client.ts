import { FalkorDB, Graph as FalkorGraph } from "falkordb";
import { config, graphKey } from "../config.js";
import { log, timed } from "../util/log.js";
import { repoTotals, type RepoTotals } from "./totals.js";

/** Values FalkorDB accepts as a query parameter: scalars, lists, and maps. */
export type ParamValue = string | number | boolean | null | ParamValue[] | { [key: string]: ParamValue };
export type Params = Record<string, ParamValue>;

export interface QueryStat {
  label: string;
  cypher: string;
  ms: number;
  cachedExecution: string | null;
}

export interface QueryResult<T> {
  rows: T[];
  columns: string[];
  stats: QueryStat;
  /** Set when the query failed. Never thrown, so a caller can degrade rather than crash. */
  error: string | null;
}

type Client = Awaited<ReturnType<typeof FalkorDB.connect>>;

/**
 * Thin, typed wrapper over FalkorDB's official client.
 *
 * Two properties matter for this project and are the reason the wrapper exists:
 *
 *  1. A failed query returns `{error}` instead of throwing. The product must be
 *     able to say "this part of the graph is unavailable" rather than die, and
 *     the certificate must never present a partial answer as a complete one.
 *  2. Every query records its Cypher and timing. The certificate publishes
 *     those verbatim, so the answer is reproducible by a judge who does not
 *     trust us.
 */
export class Graph {
  private client: Client;
  private inner: FalkorGraph;
  readonly repo: string;
  readonly graphName: string;

  constructor(repo: string, graph = "main") {
    this.repo = repo;
    this.graphName = graph;
    this.inner = null as unknown as FalkorGraph;
    this.client = null as unknown as Client;
  }

  get key(): string {
    return graphKey(this.repo, this.graphName);
  }

  /** Lazily connect. Keeps construction cheap for callers that may not need a query. */
  private async ready(): Promise<void> {
    if (this.client) return;
    this.client = await FalkorDB.connect({
      host: config.falkordb.host,
      port: config.falkordb.port,
      username: process.env.FALKORDB_USERNAME || "default",
      password: config.falkordb.password,
      socket: { connectTimeout: 8000 },
    });
    this.inner = this.client.selectGraph(this.key);
  }

  async query<T = Record<string, unknown>>(
    label: string,
    cypher: string,
    params: Params = {},
    timeoutMs?: number,
  ): Promise<QueryResult<T>> {
    await this.ready();
    const hasParams = Object.keys(params).length > 0;
    const options = hasParams ? { params: params as never, ...(timeoutMs ? { TIMEOUT: timeoutMs } : {}) } : timeoutMs ? { TIMEOUT: timeoutMs } : undefined;
    const { ms, raw, error } = await timed(() => this.inner.query<T>(cypher, options));

    if (error) {
      log.warn(`[graph] ${label}: ${error}`);
      return { rows: [], columns: [], error, stats: stat(label, cypher, ms, null) };
    }

    const reply = raw as { headers?: string[]; data?: unknown[]; metadata?: unknown[] } | undefined;
    const columns = reply?.headers ?? [];
    const rows = (Array.isArray(reply?.data) ? reply.data : []) as T[];

    const metadata = Array.isArray(reply?.metadata) ? reply.metadata : [];
    const cached =
      metadata.find((m): m is string => typeof m === "string" && m.startsWith("Cached execution")) ?? null;

    return { rows, columns, error: null, stats: stat(label, cypher, ms, cached) };
  }

  /** Throwing variant, for paths where a failed query is a programming error. */
  async must<T = Record<string, unknown>>(
    label: string,
    cypher: string,
    params: Params = {},
    timeoutMs?: number,
  ): Promise<QueryResult<T>> {
    const result = await this.query<T>(label, cypher, params, timeoutMs);
    if (result.error) {
      throw new Error(`[${label}] ${result.error}\n\nCypher:\n${cypher.trim()}`);
    }
    return result;
  }

  /**
 * Create the graph if it does not exist, and put the server into a state where
 * the interesting queries can actually complete.
 *
 * FalkorDB ships with `RESULTSET_SIZE 10000` and a one-second `TIMEOUT`. Both
 * silently cap this project: the phantom-coupling scan returns more than 10,000
 * rows on any real repository, and a query that hits the timeout returns
 * "Query timed out", which is indistinguishable from "no results" unless you
 * know to look. Raising them here means a fresh container and a hand-configured
 * one behave identically.
 */
  async ensureGraph(): Promise<void> {
    await this.ready();
    await this.query("ensure graph", "RETURN 1 AS ok");

    const resultset = await this.rawConfig("RESULTSET_SIZE", "1000000");
    const timeout = await this.rawConfig("TIMEOUT", "30000");
    if (resultset && timeout) {
      log.dim(`FalkorDB configured: RESULTSET_SIZE=${resultset} TIMEOUT=${timeout}ms`);
    }
  }

  /** `GRAPH.CONFIG SET` has no typed wrapper, so it goes over the raw protocol. */
  private async rawConfig(field: string, value: string): Promise<string | null> {
    try {
      const connection = await this.client.connection;
      await connection.sendCommand(["GRAPH.CONFIG", "SET", field, value]);
      return value;
    } catch (err) {
      log.dim(`could not set ${field}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.ready();
      const result = await this.query("ping", "RETURN 1 AS ok");
      return !result.error;
    } catch (err) {
      log.dim(`ping failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  async listGraphs(): Promise<string[]> {
    await this.ready();
    return this.client.list();
  }

  /** Removes the graph and all of its data. */
  async drop(): Promise<void> {
    await this.ready();
    const result = await this.query("drop", "RETURN 1");
    if (result.error) throw new Error(result.error);
    await this.inner.delete();
  }

  async stats(): Promise<RepoTotals> {
    return repoTotals(this);
  }

  async disconnect(): Promise<void> {
    if (!this.client) return;
    await this.client.close().catch(() => undefined);
    this.client = null as unknown as Client;
  }
}

function stat(label: string, cypher: string, ms: number, cachedExecution: string | null): QueryStat {
  return { label, cypher: cypher.trim(), ms, cachedExecution };
}

/**
 * FalkorDB returns each row as an object keyed by its RETURN aliases, so there
 * is nothing to reshape here. This helper exists only for the `CALL { ... }`
 * aggregate queries, where a sub-query with no rows yields a NIL in the data
 * array that has to be tolerated rather than crashing a count.
 */
export function firstRow<T>(result: QueryResult<T>): T | null {
  const row = result.rows.find((r) => r !== null && r !== undefined);
  return (row as T | undefined) ?? null;
}

export async function withGraph<T>(repo: string, fn: (g: Graph) => Promise<T>, graph = "main"): Promise<T> {
  const g = new Graph(repo, graph);
  try {
    const alive = await g.ping();
    if (!alive) {
      throw new Error(`FalkorDB is not reachable at ${config.falkordb.host}:${config.falkordb.port}. Start it with: docker compose up -d`);
    }
    return await fn(g);
  } finally {
    await g.disconnect();
  }
}
