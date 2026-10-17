import { join } from "node:path";
import { config } from "../config.js";
import { Graph } from "../graph/client.js";
import {
  historyRepo,
  sourcesRepo,
  discardSourcesRepo,
  detectLanguage,
  repoDefaultBranch,
  repoHead,
  topLevelDirs,
} from "./clone.js";
import { dirBytes } from "./git.js";
import { readHistory } from "./history.js";
import { computeCouplings, type CouplingOptions } from "./coupling.js";
import { extractImportsFromTree, prepareSourceTree, type ImportEdge } from "./imports.js";
import { loadGraph, type LoadStats } from "./load.js";
import { log } from "../util/log.js";

export interface IngestOptions {
  repoId: string;
  owner: string;
  name: string;
  fresh?: boolean;
  /** `full` runs the import pass; `couplings-only` skips the second clone entirely. */
  mode?: "full" | "couplings-only";
  dataDir?: string;
  coupling?: Partial<CouplingOptions>;
  maxMassCommitFiles?: number;
  /** Hard cap on files read during import extraction. */
  maxImportFiles?: number;
  /** Keep the shallow source clone after ingest instead of deleting it. */
  keepSources?: boolean;
  /** Re-clone from scratch. */
  reclone?: boolean;
  commitLimit?: number;
  onPhase?: (phase: string) => void;
}

export interface IngestReport {
  repo: string;
  head: string;
  branch: string;
  language: string;
  history: Awaited<ReturnType<typeof readHistory>>;
  coupling: ReturnType<typeof computeCouplings>["stats"];
  imports: { edges: number; filesScanned: number; ms: number; workspacePackages: number } | null;
  loaded: LoadStats;
  timings: Record<string, number>;
  totalMs: number;
  cloneDir: string;
}

const DEFAULT_EXCLUDES = [
  "node_modules/", "vendor/", "dist/", "build/", ".next/", "target/",
  "coverage/", "test/fixtures/", "__fixtures__/", "third_party/", ".git/",
];

/**
 * Directories worth checking out for import extraction. Restricting the sparse
 * set to known source-bearing names is what keeps the shallow snapshot small.
 */
const SOURCE_DIR_HINTS = [
  "packages", "src", "lib", "apps", "crates", "cmd", "internal", "pkg",
  "test", "tests", "docs", "examples", "scripts", "tools", "benchmarks",
  "client", "server", "shared", "core", "modules", "app",
];

export async function ingest(options: IngestOptions): Promise<IngestReport> {
  const started = Date.now();
  const dataDir = options.dataDir ?? join(config.root, "data", "repos");
  // The source clone is disposable and must live apart from the history clone,
  // which is expensive to recreate.
  const sourcesDir = options.dataDir ?? join(config.root, "data", "sources");
  const mode = options.mode ?? "full";
  const timings: Record<string, number> = {};

  const phase = (name: string) => {
    options.onPhase?.(name);
    log.plain("");
    log.dim(`-- ${name} --`);
  };

  // ---- 1. history: blobless, full depth, cheap ----
  const cloneDir = await historyRepo(options.owner, options.name, dataDir, {
    force: options.reclone ?? false,
  });

  phase("history");
  const historyStart = Date.now();
  const history = await readHistory(cloneDir, {
    maxMassCommitFiles: options.maxMassCommitFiles ?? 80,
    excludePaths: DEFAULT_EXCLUDES,
    limit: options.commitLimit,
  });
  timings.readHistory = Date.now() - historyStart;

  // ---- 2. coupling ----
  phase("coupling matrix");
  const couplingStart = Date.now();
  const coupling = computeCouplings(history.commits, options.coupling ?? {});
  timings.coupling = Date.now() - couplingStart;
  log.ok(
    `${coupling.edges.length.toLocaleString("en-US")} coupling edges from ` +
      `${coupling.stats.pairsConsidered.toLocaleString("en-US")} co-occurrences ` +
      `over ${history.commits.length.toLocaleString("en-US")} commits (${(coupling.stats.ms / 1000).toFixed(1)}s)`,
  );

  // ---- 3. imports: shallow source clone, then thrown away ----
  let importEdges: ImportEdge[] = [];
  let imports: IngestReport["imports"] = null;

  if (mode === "full") {
    phase("static imports");
    const importStart = Date.now();
    // Timed step by step. This phase dominates a cold ingest, and a single
    // "static imports: 275s" number tells nobody where the time went. Knowing
    // the clone is the cost makes it obvious that --couplings skips it, and that
    // re-ingesting the same repo afterwards is the cheap one.
    const breakdown: Record<string, number> = {};
    let sourceDir: string | null = null;
    try {
      const cloneStart = Date.now();
      sourceDir = await sourcesRepo(options.owner, options.name, sourcesDir, !options.reclone);
      breakdown.clone = Date.now() - cloneStart;

      const checkoutStart = Date.now();
      await prepareSourceTree(sourceDir);
      breakdown.checkout = Date.now() - checkoutStart;

      const extractStart = Date.now();
      const extracted = await extractImportsFromTree(sourceDir, {
        maxFiles: options.maxImportFiles ?? 120_000,
      });
      breakdown.extract = Date.now() - extractStart;

      importEdges = extracted.edges;
      imports = {
        edges: extracted.edges.length,
        filesScanned: extracted.filesScanned,
        ms: extracted.ms,
        workspacePackages: extracted.workspacePackages,
      };
      log.dim(
        `  clone ${(breakdown.clone / 1000).toFixed(1)}s | ` +
          `checkout ${(breakdown.checkout / 1000).toFixed(1)}s | ` +
          `scan ${(breakdown.extract / 1000).toFixed(1)}s`,
      );
    } catch (err) {
      // Coupling is the product; imports enrich it. Losing them must degrade
      // the graph, never the ingest.
      log.warn(
        `import extraction failed, continuing with couplings only: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      if (sourceDir && !options.keepSources) discardSourcesRepo(sourceDir);
    }
    timings.imports = Date.now() - importStart;
  } else {
    log.dim("skipping import extraction (--mode couplings-only)");
  }

  // ---- 4. load ----
  phase("graph load");
  const loadStart = Date.now();
  const head = await repoHead(cloneDir);
  const branch = await repoDefaultBranch(cloneDir);
  const language = detectLanguage(history.commits.flatMap((c) => c.files));

  const graph = new Graph(options.repoId);
  let loaded: LoadStats;
  try {
    const alive = await graph.ping();
    if (!alive) {
      throw new Error(
        `FalkorDB is not reachable at ${config.falkordb.host}:${config.falkordb.port}. Run: docker compose up -d`,
      );
    }

    loaded = await loadGraph(graph, {
      repoId: options.repoId,
      head,
      language,
      commits: history.commits,
      fileCounts: coupling.fileCounts,
      couplings: coupling.edges,
      imports: importEdges,
      fresh: options.fresh ?? true,
    });
    timings.load = Date.now() - loadStart;

    const totals = await graph.stats();

    log.plain("");
    log.ok(
      `graph ready: ${loaded.files.toLocaleString("en-US")} files | ` +
        `${loaded.couplings.toLocaleString("en-US")} couplings | ` +
        `${loaded.imports.toLocaleString("en-US")} imports | ` +
        `${loaded.phantomCouplings.toLocaleString("en-US")} with no static import path`,
    );
    log.dim(
      `FalkorDB holds ${fmt(totals.files)} files, ${fmt(totals.commits)} commits, ` +
        `${fmt(totals.couplingEdges)} coupling edges, ${fmt(totals.importEdges)} import edges`,
    );

    return {
      repo: options.repoId,
      head,
      branch,
      language,
      history,
      coupling: coupling.stats,
      imports,
      loaded,
      timings,
      totalMs: Date.now() - started,
      cloneDir,
    };
  } finally {
    await graph.disconnect();
  }
}

/**
 * Choose which top-level directories to check out.
 *
 * Restricted to known source-bearing names so a monorepo's `docs`,
 * `benchmark-results` and generated directories do not turn a 40 MB snapshot
 * into a 400 MB one.
 */
function pickSourceDirs(dir: string): string[] {
  const top = topLevelDirs(dir);
  const hints = top.filter((d) => SOURCE_DIR_HINTS.includes(d));
  return hints.length > 0 ? hints : top.slice(0, 12);
}

const fmt = (n: number): string => (n < 0 ? "?" : n.toLocaleString("en-US"));

export const dataDirFor = (): string => join(config.root, "data", "repos");

export function formatIngestReport(report: IngestReport): string {
  return [
    `repo            ${report.repo} @ ${report.head.slice(0, 8)} (${report.branch}, ${report.language})`,
    `commits         ${report.history.commits.length.toLocaleString("en-US")}`,
    `files           ${report.loaded.files.toLocaleString("en-US")}`,
    `couplings       ${report.loaded.couplings.toLocaleString("en-US")} (${report.loaded.phantomCouplings.toLocaleString("en-US")} phantom)`,
    `imports         ${report.loaded.imports.toLocaleString("en-US")}`,
    `people          ${report.loaded.people.toLocaleString("en-US")}`,
    `clone on disk   ${(dirBytes(report.cloneDir) / 1024 / 1024).toFixed(0)} MB`,
    `elapsed         ${(report.totalMs / 1000).toFixed(1)}s`,
  ].join("\n");
}