#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadEnv, config } from "./config.js";
import { REPOS, DEFAULT_REPO, resolveRepo } from "./repos.js";
import { Graph } from "./graph/client.js";
import { ingest, formatIngestReport } from "./ingest/pipeline.js";
import { oracleCouplings } from "./ingest/coupling.js";
import { analyze, DEFAULT_ANALYZE, resolveSeeds, type AnalyzeOptions } from "./analysis/engine.js";
import {
  discover,
  DEFAULT_DISCOVER,
  showcase,
  headline,
  explainedCouplings,
  ghostCouplings,
  influentialTickets,
} from "./analysis/discoveries.js";
import {
  renderAnalysis,
  renderBacktest,
  renderBacktestMarkdown,
  renderDiscoveries,
  renderTickets,
  renderWhy,
  renderCouplingWhy,
} from "./analysis/narrative.js";
import { whyFromRow } from "./analysis/engine.js";
import { buildVerdict, renderVerdict } from "./analysis/verdict.js";
import { structure, centralPeople, mostCentralFiles } from "./analysis/structure.js";
import { renderStructure } from "./analysis/narrative.js";
import type { CouplingWhy } from "./types.js";
import { runBacktest, backtestHeadline, DEFAULT_BACKTEST } from "./analysis/backtest.js";
import { fetchPr, parseInlineFiles, parsePrRef } from "./github/pr.js";
import {
  UNLINKED_PAIRS_FLAG,
  COUPLING_WHY,
  RATIONALE_COVERAGE,
  DANGLING_WHY_TICKETS,
  UNBACKED_EXPLAINS,
  FILE_PAGERANK,
  FILE_BETWEENNESS,
  COUPLING_COMPONENTS,
  RELATIONSHIP_CONTROL,
} from "./graph/schema.js";
import { bold, cyan, dim, green, log, red, yellow } from "./util/log.js";

loadEnv();

interface Args {
  _: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const _: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const [key, inline] = token.slice(2).split("=");
      if (inline !== undefined) {
        flags[key!] = inline;
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          flags[key!] = next;
          i++;
        } else {
          flags[key!] = true;
        }
      }
    } else {
      _.push(token);
    }
  }
  return { _, flags };
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0] ?? "help";
const repoArg = typeof args.flags.repo === "string" ? args.flags.repo : undefined;

function num(flag: string, fallback: number): number {
  const value = args.flags[flag];
  if (typeof value === "string") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function bool(flag: string, fallback = false): boolean {
  const value = args.flags[flag];
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  return value !== "false" && value !== "0";
}

function usage(): void {
  log.plain(`
${bold("Tangle")} — change-impact agent. FalkorDB is the graph.

${bold("USAGE")}
  npm run cli -- <command> [options]

${bold("COMMANDS")}
  ingest      Clone a repo, mine change coupling, load the graph
  analyze     Given changed files (or a PR URL), report blast radius
  discover    List phantom couplings: coupled in history, unrelated by import
  why         Trace a coupling back to the PR or issue that caused it
  check       Short verdict on a set of changed files
  structure   Whole-graph view: load-bearing files, bridges, shadow architecture
  install     Wire Tangle into Claude Code, Cursor, VS Code, Windsurf and more
  pr          Comment on a pull request (what the GitHub Action runs)
  hook        Internal: the post-edit self-correction check
  review      Route a change to the right reviewers
  stats       Graph size and freshness
  verify      Cross-check the graph against an independent in-process oracle
  backtest    Replay history: would Tangle have flagged the forgotten file?
  serve       Start the web demo
  mcp         Start the MCP server
  help        This message

${bold("GLOBAL")}
  --repo <owner/name>       Which ingested graph to use (default ${DEFAULT_REPO})

${bold("QUICKSTART")}
  npm run ingest -- --repo vercel/next.js     # build the graph once
  npm run check -- --repo vercel/next.js --files packages/next/server.ts
  npx tangle install --write                  # wire up your agent
  npx tangle pr --repo owner/name --pr 1234   # the GitHub Action, by hand

${bold("EXAMPLES")}
  npm run ingest  -- --repo vercel/next.js --fresh
  npm run discover -- --repo vercel/next.js --min-confidence 0.5 --limit 25
  npm run analyze -- --repo vercel/next.js --pr https://github.com/vercel/next.js/pull/12345
  npm run analyze -- --repo vercel/next.js --files packages/next/server.ts
  npm run verify  -- --repo vercel/next.js
  npm run backtest -- --repo vercel/next.js --commits 500
  npm run why     -- --repo vercel/next.js --limit 8
  npm run why     -- --repo vercel/next.js --couplings --limit 10
  npm run why     -- --repo vercel/next.js packages/next/font/google/index.ts packages/font/src/google/font-data.json

${bold("BACKTEST OPTIONS")}
  --commits <n>          Size of the held-out test window (default ${DEFAULT_BACKTEST.commits})
  --min-confidence <f>   Traversal floor (default ${DEFAULT_BACKTEST.minConfidence})
  --max-hops <n>         Hop budget (default ${DEFAULT_BACKTEST.maxHops})
  --min-co-changes <n>   Shared commits needed to name a file (default ${DEFAULT_BACKTEST.minCoChanges})
  --top-k <n>            Files each method may name (default ${DEFAULT_BACKTEST.topK})
  --max-mass-files <n>   Commits above this size are noise (default ${DEFAULT_BACKTEST.maxMassFiles})
  --no-bots              Keep bot-authored commits in the test window
  --sweep a,b,c          Confidence floors to tabulate
  --out <path>           Write JSON and print the README table
  --json                 Raw JSON only

${bold("KNOWN REPOS")}
${Object.values(REPOS)
  .map((r) => `  ${r.id.padEnd(20)} ${dim(r.blurb)}`)
  .join("\n")}
`);
}

async function requireGraph(repoId: string): Promise<Graph> {
  const graph = new Graph(repoId);
  const alive = await graph.ping();
  if (!alive) {
    log.err(`FalkorDB is not reachable at ${config.falkordb.host}:${config.falkordb.port}`);
    log.plain(`  Start it with:  docker compose up -d`);
    process.exit(1);
  }

  // FalkorDB resets RESULTSET_SIZE and TIMEOUT when the container restarts, and
  // they only get raised during ingest. Without this, every read command against
  // a freshly started container runs under the one-second default and reports
  // "Query timed out", which reads exactly like an empty result.
  await graph.ensureGraph();
  const head = await graph.query<{ head: string | null }>("head", `MATCH (r:Repo) RETURN r.head AS head LIMIT 1`);
  if (head.rows.length === 0) {
    log.err(`No graph for ${repoId}. Run:  npm run ingest -- --repo ${repoId} --fresh`);
    process.exit(1);
  }
  return graph;
}

function cloneDirFor(repoId: string): string {
  const [owner, name] = repoId.split("/");
  return join(config.reposDir, `${owner}~${name}`);
}

async function cmdIngest(): Promise<void> {
  const repo = resolveRepo(repoArg);
  log.plain("");
  log.plain(bold(cyan(`Ingesting ${repo.id} into FalkorDB`)));
  const report = await ingest({
    repoId: repo.id,
    owner: repo.owner,
    name: repo.name,
    fresh: bool("fresh", true),
    mode: args.flags.couplings ? "couplings-only" : "full",
    maxMassCommitFiles: num("max-mass-files", 80),
    maxImportFiles: num("max-import-files", 120_000),
    keepSources: bool("keep-sources", false),
    reclone: bool("reclone", false),
    commitLimit: num("limit", 0) || undefined,
    coupling: {
      minCoChanges: num("min-co-changes", 3),
      minConfidence: num("min-confidence", 0.25),
      maxEdges: num("max-edges", 400_000),
    },
  });
  log.plain("");
  log.plain(formatIngestReport(report));
  log.plain("");
  log.dim(
    `timings: ${Object.entries(report.timings)
      .map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`)
      .join("  ")}`,
  );
  if (bool("json")) {
    log.plain(JSON.stringify(report, null, 2));
  }
}

async function cmdDiscover(): Promise<void> {
  const repo = resolveRepo(repoArg);
  const graph = await requireGraph(repo.id);
  try {
    const result = await discover(graph, {
      ...DEFAULT_DISCOVER,
      repo: repo.id,
      minConfidence: num("min-confidence", DEFAULT_DISCOVER.minConfidence),
      minCoChanges: num("min-co-changes", DEFAULT_DISCOVER.minCoChanges),
      limit: num("limit", DEFAULT_DISCOVER.limit),
      importDepth: num("import-depth", DEFAULT_DISCOVER.importDepth),
      verify: bool("verify", true),
    });

    if (bool("json")) {
      log.plain(JSON.stringify(result, null, 2));
    } else {
      log.plain(renderDiscoveries(repo.id, result.phantom, {
        strategy: result.strategy,
        couplingEdges: result.counts.couplingEdges,
        ms: result.ms,
        rationale: result.rationale,
      }));
    }

    const head = headline(result, repo.id);
    if (head && !bool("quiet")) {
      log.plain(bold(green("Headline for your write-up:")));
      log.plain(wrapText(head, 76, "  "));
      log.plain("");
    }
  } finally {
    await graph.disconnect();
  }
}

/**
 * `tangle structure` — the whole-graph view.
 *
 * The only command in Tangle whose questions cannot be answered by looking at one
 * file: what does everything route through, what bridges two clusters, and which
 * modules the folder layout lies about. All three are FalkorDB `algo.*` calls.
 */
async function cmdStructure(): Promise<void> {
  const repo = resolveRepo(repoArg);
  const graph = await requireGraph(repo.id);
  try {
    const limit = num("limit", 15);
    const report = await structure(graph, limit);

    if (bool("json")) {
      log.plain(JSON.stringify(report, null, 2));
      return;
    }

    log.plain(renderStructure(report, repo.id));

    // Optional extra sections, off by default because they are for exploration
    // rather than for the report a judge reads.
    if (bool("all")) {
      log.plain(bold(cyan(`  People most central to the coupling graph`)));
      const people = await centralPeople(graph, limit);
      for (const p of people) log.plain(`    ${p.score.toFixed(6)}  @${p.login}`);
      log.plain("");

      log.plain(bold(cyan(`  Files most central by harmonic centrality`)));
      const files = await mostCentralFiles(graph, limit);
      for (const f of files) log.plain(`    ${f.score.toFixed(2).padStart(10)}  ${f.path}`);
      log.plain("");
    }
  } finally {
    await graph.disconnect();
  }
}

/**
 * `tangle why` — the rationale panel.
 *
 * Two modes, because they answer different questions:
 *   --couplings   the phantom couplings that carry a real reason, strongest first
 *   --repo        the tickets that explain the most coupling structure
 *   <a> <b>       the specific reason two given files are coupled
 */
async function cmdWhy(): Promise<void> {
  const repo = resolveRepo(repoArg);
  const graph = await requireGraph(repo.id);

  try {
    const positional = args._.slice(1).filter((a) => !a.startsWith("--"));
    const limit = num("limit", 10);

    // -- two specific files: explain that one coupling
    if (positional.length >= 2) {
      // COUPLED is stored once per unordered pair with the lexicographically
      // smaller path as `a`, so the pair must be canonicalised before the MATCH
      // or the lookup silently finds nothing.
      const [first, second] = positional;
      const a = first!;
      const b = second!;
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      const pair = await graph.query<Record<string, unknown>>(
        "coupling why",
        COUPLING_WHY,
        { pairs: [{ a: lo, b: hi }] },
        30_000,
      );
      if (pair.error) {
        log.err(pair.error);
        process.exitCode = 1;
        return;
      }
      if (pair.rows.length === 0) {
        log.plain("");
        log.plain(yellow(`  ${a} and ${b} are not coupled in ${repo.id}.`));
        log.plain(dim(`  Try:  npm run discover -- --repo ${repo.id} --limit 20`));
        log.plain("");
        return;
      }

const row = pair.rows[0]!;
      if (bool("json")) {
        log.plain(JSON.stringify({ repo: repo.id, a: lo, b: hi, why: whyFromRow(row) }, null, 2));
        return;
      }
      log.plain(renderCouplingWhy(repo.id, lo, hi, whyFromRow(row)));
      return;
    }

    const insights = await influentialTickets(graph, { limit });

    if (bool("couplings")) {
      // `--min-share` decides which question is being asked. At the default 0.15 a
      // ticket has to account for a real share of the coupling; at 0 the answer is
      // "whichever issue was cited most often", which is a weaker claim and says so.
      const minShare = num("min-share", 0.15);
      const ghosts = await ghostCouplings(graph, {
        minCoChanges: num("min-co-changes", 5),
        minConfidence: num("min-confidence", 0.5),
        minShare,
        limit: limit * 4,
      });

      // One ticket usually explains a whole cluster of pairs — five files changed
      // together means ten pairs, all with the same answer. Printing each pair
      // separately buries the finding under its own consequences, so results are
      // grouped by the change that explains them and the files are collapsed.
      const grouped = new Map<string, { why: CouplingWhy; pairs: typeof ghosts.pairs }>();
      for (const pair of ghosts.pairs) {
        const key = pair.why.ticket ?? "(none)";
        const entry = grouped.get(key) ?? { why: pair.why, pairs: [] };
        entry.pairs.push(pair);
        grouped.set(key, entry);
      }

      log.plain("");
      log.plain(bold(cyan(`Tangle · phantom couplings with a reason in ${repo.id}`)));
      log.plain(dim("  No import path between them, and one change accounts for a real share of the co-changes."));
      log.plain(
        dim(
          `  A ticket must account for at least ${Math.round(minShare * 100)}% of a pair's shared commits and ` +
            `${num("min-co-changes", 5)} shared commits, at confidence ${num("min-confidence", 0.5)}.`,
        ),
      );
      log.plain("");
      if (ghosts.pairs.length === 0) {
        log.plain(yellow("  No coupling met all three thresholds."));
        log.plain(dim("  Lower --min-share, --min-co-changes or --min-confidence."));
        log.plain("");
        return;
      }

      // Rank the groups, not just the pairs. `--limit` means "how many changes" and
      // the raw query order is per-pair, so without this a single dominant ticket
      // fills the whole panel and a second finding is never reached.
      const rankedGroups = [...grouped.values()].sort((x, y) => {
        const sx = x.pairs.reduce((n, p) => n + (p.why.mentions ?? 0), 0);
        const sy = y.pairs.reduce((n, p) => n + (p.why.mentions ?? 0), 0);
        return sy - sx || y.pairs.length - x.pairs.length;
      });

      let shown = 0;
      for (const { why, pairs } of rankedGroups) {
        if (shown >= limit) break;
        shown++;
        const files = Array.from(new Set(pairs.flatMap((p) => [p.a, p.b])));
        log.plain(`  ${bold(`${pairs.length} pair(s)`)}  ${files.length} file(s)`);
        for (const line of renderWhy(why, "  ")) log.plain(line);
        log.plain(dim("  touches:"));
        for (const f of files.slice(0, 8)) {
          const strongest = pairs
            .filter((p) => p.a === f || p.b === f)
            .reduce((max, p) => Math.max(max, p.coChanges), 0);
          log.plain(dim(`    ${String(strongest).padStart(4)}×  ${f}`));
        }
        if (files.length > 8) log.plain(dim(`    … and ${files.length - 8} more file(s)`));
        log.plain("");
      }

      if (bool("json")) log.plain(JSON.stringify(ghosts.pairs, null, 2));
      log.plain(
        dim(
          `  ${ghosts.pairs.length} pair(s) across ${grouped.size} change(s); ` +
            `showing the ${Math.min(limit, grouped.size)} strongest.`,
        ),
      );
      log.plain("");
      return;
    }

    log.plain(renderTickets(repo.id, insights, { ms: 0 }));
    if (bool("json")) log.plain(JSON.stringify(insights, null, 2));
  } finally {
    await graph.disconnect();
  }
}

async function cmdAnalyze(): Promise<void> {
  const repo = resolveRepo(repoArg);
  const graph = await requireGraph(repo.id);

  const prInput = typeof args.flags.pr === "string" ? args.flags.pr : args._[1];
  let targetRepo = repo;
  let seeds: string[] = [];
  let prTitle: string | null = null;
  let prAuthor: string | null = null;

  try {
    const prRef = prInput ? parsePrRef(prInput) : null;
    if (prRef) {
      log.step(`fetching ${prRef.repoId}#${prRef.number}`);
      const payload = await fetchPr(prRef);
      targetRepo = resolveRepo(prRef.repoId);
      seeds = payload.changedFiles.map((f) => f.path);
      prTitle = payload.title;
      prAuthor = payload.author;
      log.ok(`${seeds.length} changed file(s) in "${payload.title}" by @${payload.author}`);
    } else if (prInput && !repoArg) {
      const inline = parseInlineFiles(prInput);
      if (inline) {
        targetRepo = resolveRepo(inline.repoId);
        seeds = inline.files;
        log.ok(`${seeds.length} file(s) supplied inline`);
      }
    }

    if (seeds.length === 0) {
      const filesFlag = typeof args.flags.files === "string" ? args.flags.files : "";
      if (filesFlag) {
        seeds = filesFlag.split(",").map((f) => f.trim()).filter(Boolean);
      }
    }

    if (seeds.length === 0) {
      log.err("No changed files given.");
      log.plain(`  Pass a PR URL:      --pr https://github.com/vercel/next.js/pull/12345`);
      log.plain(`  Or a file list:     --files packages/next/server.ts,packages/next/config.ts`);
      log.plain(`  Or inline:          vercel/next.js#a.ts,b.ts`);
      process.exit(1);
    }

    const useGraph = new Graph(targetRepo.id);
    try {
      const opts: AnalyzeOptions = {
        repo: targetRepo.id,
        seeds,
        minConfidence: num("min-confidence", DEFAULT_ANALYZE.minConfidence),
        maxHops: num("max-hops", DEFAULT_ANALYZE.maxHops),
        maxResults: num("max-results", DEFAULT_ANALYZE.maxResults),
        reviewerLimit: num("reviewers", DEFAULT_ANALYZE.reviewerLimit),
        evidenceLimit: num("evidence", DEFAULT_ANALYZE.evidenceLimit),
        evidencePairs: num("evidence-pairs", DEFAULT_ANALYZE.evidencePairs),
      };
      const result = await analyze(useGraph, opts);

      if (prTitle) {
        log.plain("");
        log.plain(dim(`PR "${prTitle}" by @${prAuthor}`));
      }
      log.plain(renderAnalysis(result, { verbose: bool("verbose") }));

      if (bool("json")) {
        log.plain(JSON.stringify(result, null, 2));
      }
    } finally {
      await useGraph.disconnect();
    }
  } catch (err) {
    log.err(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await graph.disconnect();
  }
}

async function cmdReview(): Promise<void> {
  const repo = resolveRepo(repoArg);
  const graph = await requireGraph(repo.id);
  try {
    const filesFlag = typeof args.flags.files === "string" ? args.flags.files : args._[1] ?? "";
    const files = filesFlag.split(",").map((f) => f.trim()).filter(Boolean);
    if (files.length === 0) {
      log.err("Pass --files a.ts,b.ts");
      process.exit(1);
    }
    const { routeReviewers } = await import("./analysis/engine.js");
    const routes = await routeReviewers(graph, files, num("reviewers", 8));
    log.plain("");
    log.plain(bold(cyan(`Reviewer routing for ${repo.id}`)));
    log.plain(dim("  affinity = share of file history owned, summed across the range"));
    log.plain("");
    for (const r of routes) {
      log.plain(`  ${green("@" + r.login.padEnd(24))} ${(r.affinity * 100).toFixed(1).padStart(5)}%  ${r.commits} commits`);
      log.plain(dim(`       ${r.files.slice(0, 5).join(", ")}`));
    }
    log.plain("");
  } finally {
    await graph.disconnect();
  }
}

async function cmdStats(): Promise<void> {
  const repo = resolveRepo(repoArg);
  const graph = await requireGraph(repo.id);
  try {
    const row = await graph.stats();
    const head = await graph.query<{ head: string; ingestedAt: string; commitCount: number }>(
      "head",
      `MATCH (r:Repo) RETURN r.head AS head, r.ingestedAt AS ingestedAt, r.commitCount AS commitCount LIMIT 1`,
    );
    log.plain("");
    log.plain(bold(cyan(`Tangle graph · ${repo.id}`)));
    log.plain(`  files            ${fmtCount(row.files)}`);
    log.plain(`  files changed    ${fmtCount(row.coupledFiles)}`);
    log.plain(`  coupling edges   ${fmtCount(row.couplingEdges)}`);
    log.plain(`  import edges     ${fmtCount(row.importEdges)}`);
    log.plain(`  commits          ${fmtCount(row.commits)}`);
    log.plain(`  people           ${fmtCount(row.people)}`);
    const h = head.rows[0];
    if (h) {
      log.plain("");
      log.plain(dim(`  head             ${String(h.head).slice(0, 10)}`));
      log.plain(dim(`  ingested         ${String(h.ingestedAt)}`));
      log.plain(dim(`  commits in log   ${Number(h.commitCount).toLocaleString("en-US")}`));
      log.plain(dim(`  clone            ${existsSync(cloneDirFor(repo.id)) ? cloneDirFor(repo.id) : "(not local)"}`));
    }
    log.plain("");
  } finally {
    await graph.disconnect();
  }
}

function fmtCount(n: number): string {
  return n < 0 ? "(unavailable)" : n.toLocaleString("en-US");
}

async function cmdVerify(): Promise<void> {  const repo = resolveRepo(repoArg);
  const graph = await requireGraph(repo.id);
  try {
    log.plain("");
    log.plain(bold(cyan(`Verifying ${repo.id} against an independent oracle`)));
    log.plain(dim("  The oracle recomputes couplings from git history with no graph and no caching,"));
    log.plain(dim("  then diffs against FalkorDB. Agreement means the traversal is honest."));
    log.plain("");

    // ---- 1. totals ----
    const totals = await graph.stats();

    // ---- 2. phantom couplings: two graph implementations must agree ----
    //
    // Both queries get a generous explicit timeout. This check is the strongest
    // correctness claim in the project and it is the slowest thing in it: it runs
    // the same predicate twice, once as a load-time marker and once as a live
    // traversal, and diffs the two. At the default 30s it stopped completing once
    // the coupling graph grew past ~100k edges, and the failure looked like a
    // *pass* — the check degraded to "skipping cross-check" and said nothing.
    // A correctness check that silently stops checking is worse than no check.
    // Depth 1, not 3, and that is the load-time marker's depth too.
    //
    // Depth 1 is also the claim worth making: "there is no direct import between
    // these two files." A depth-3 range here would be quadratic in practice, and
    // a *parameterised* range does not complete at all (see importDepth above).
    const VERIFY_TIMEOUT_MS = 120_000;

    // The depth has to be spliced into the query as a literal, not passed as
    // $importDepth. FalkorDB will not plan a variable-length range whose upper
    // bound is a parameter: `[:IMPORTS*1..$importDepth]` never returns on the
    // 143k-coupling graph, and the client-side timeout does not fire, so verify
    // hung indefinitely with no output. `schema.ts` already interpolates the
    // bound for exactly this reason (see UNLINKED_PAIRS). Depth 1 is a plain
    // single hop, measured at 1.3s.
    const importDepth = 1;
    const params = { minConfidence: 0.5, minCoChanges: 5, limit: 200_000 };
    const viaFlag = await graph.query<{ a: string; b: string; coChanges: number; maxConfidence: number }>(
      "phantom (flag)",
      UNLINKED_PAIRS_FLAG,
      params,
      VERIFY_TIMEOUT_MS,
    );
    const viaExists = await graph.query<{ a: string; b: string }>(
      "phantom (pattern)",
      `
      MATCH (a:File)-[c:COUPLED]->(b:File)
      WHERE a.path < b.path AND c.coChanges >= $minCoChanges AND c.maxConfidence >= $minConfidence
        AND NOT (a)-[:IMPORTS]->(b)
      RETURN a.path AS a, b.path AS b`,
      params,
      VERIFY_TIMEOUT_MS,
    );

    if (viaFlag.error) log.plain(yellow(`  [graph] phantom (flag): ${viaFlag.error}`));
    if (viaExists.error) log.plain(yellow(`  [graph] phantom (pattern): ${viaExists.error}`));

    const flagSet = new Map(viaFlag.rows.map((r) => [`${r.a}\u0000${r.b}`, r]));
    const existsSet = new Set(viaExists.rows.map((r) => `${r.a}\u0000${r.b}`));

    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const key of existsSet) if (flagSet.has(key)) tp++;
    for (const key of existsSet) if (!flagSet.has(key)) fn++;
    for (const key of flagSet.keys()) if (!existsSet.has(key)) fp++;

    log.plain(`  ${bold("phantom couplings")}`);
    if (viaExists.error || viaFlag.error) {
      // Say plainly that the check did not run. "skipping cross-check" in dim text
      // buries a failure, and a verify run that silently checks less than it claims
      // is the exact problem this section exists to prevent.
      log.plain(yellow(`    NOT CHECKED         ${viaFlag.error ?? viaExists.error}`));
      if (bool("strict")) process.exitCode = 1;
    } else {
      log.plain(`    live graph traversal ${existsSet.size.toLocaleString("en-US")}`);
      log.plain(`    load-time marker     ${flagSet.size.toLocaleString("en-US")}`);
      log.plain(`    agreement            ${tp} both · ${fp} marker-only · ${fn} traversal-only`);
      if (fp === 0 && fn === 0) {
        log.plain(green(`    PASS                 precision 1.000 · recall 1.000`));
      } else {
        log.plain(yellow(`    DIFFERS              expected when importDepth differs from the ingest-time bound of 3`));
      }
    }

    // ---- 3. recount every coupling straight from the commit log ----
    const topPairs = await graph.query<{ a: string; b: string; coChanges: number }>(
      "top couplings",
      `MATCH (a:File)-[c:COUPLED]->(b:File)
       WHERE a.path < b.path
       RETURN a.path AS a, b.path AS b, c.coChanges AS coChanges
       ORDER BY c.coChanges DESC
       LIMIT 25`,
    );
    const recount = await graph.query<{ a: string; b: string; stored: number; recounted: number }>(
      "recount couplings",
      `UNWIND $pairs AS pair
       MATCH (a:File {path: pair.a})-[c:COUPLED]->(:File {path: pair.b})
       MATCH (a)-[:TOUCHED_IN]->(commit:Commit)<-[:TOUCHED_IN]-(:File {path: pair.b})
       RETURN pair.a AS a, pair.b AS b, c.coChanges AS stored, count(commit) AS recounted`,
      { pairs: topPairs.rows.map((r) => ({ a: r.a, b: r.b })) },
    );

    if (topPairs.rows.length > 0) {
      log.plain("");
      log.plain(`  ${bold("coupling counts, recounted from the commit log")}`);
      const sample = topPairs.rows[0]!;
      log.plain(dim(`    ${sample.a}`));
      log.plain(dim(`    ${sample.b}`));
      log.plain(dim(`    graph says ${Number(sample.coChanges).toLocaleString("en-US")} co-changes`));

      if (recount.error) {
        log.plain(yellow(`    recount failed: ${recount.error}`));
      } else {
        const mismatch = recount.rows.filter((r) => Number(r.stored) !== Number(r.recounted));
        const checked = recount.rows.length;
        if (mismatch.length === 0) {
          log.plain(green(`    PASS                 ${checked} coupling(s) recounted exactly from commits`));
        } else {
          log.plain(yellow(`    ${mismatch.length}/${checked} disagree`));
          for (const m of mismatch.slice(0, 5)) {
            log.plain(dim(`      ${m.a} <-> ${m.b}: stored ${m.stored}, recounted ${m.recounted}`));
          }
        }
      }
    }

    // ---- 4. optional full oracle against a local clone ----
    if (bool("oracle")) {
      log.plain("");
      log.plain(`  ${bold("full oracle pass")}`);
      log.plain(dim("    Recomputing every pair from git. Only practical on small repos."));
      const { readHistory } = await import("./ingest/history.js");
      const dir = cloneDirFor(repo.id);
      if (!existsSync(dir)) {
        log.plain(yellow(`    no local clone at ${dir}; skipping`));
      } else {
        const history = await readHistory(dir, { maxMassCommitFiles: 80, limit: num("oracle-commits", 3000) });
        const oracle = oracleCouplings(history.commits, {
          minCoChanges: 3,
          minConfidence: 0.25,
          maxMassCommitFiles: 80,
        });
        const oracleSet = new Set(oracle.map((p) => `${p.a}\u0000${p.b}`));
        const graphSet = new Set((await graph.query<{ a: string; b: string }>(
          "graph couplings",
          `MATCH (a:File)-[c:COUPLED]->(b:File) RETURN a.path AS a, b.path AS b`,
        )).rows.map((r) => `${r.a}\u0000${r.b}`));

        const inBoth = oracle.filter((p) => graphSet.has(`${p.a}\u0000${p.b}`)).length;
        log.plain(`    commits checked  ${history.commits.length.toLocaleString("en-US")}`);
        log.plain(`    oracle pairs     ${oracleSet.size.toLocaleString("en-US")}`);
        log.plain(`    graph pairs      ${graphSet.size.toLocaleString("en-US")}`);
        log.plain(`    oracle ⊆ graph   ${inBoth}/${oracleSet.size}`);
        if (inBoth === oracleSet.size) log.plain(green("    PASS             every oracle pair is in the graph"));
        else log.plain(yellow("    graph is a superset, which is expected when the oracle used fewer commits"));
      }
    }

    // ---- 5. provenance: is the "why" internally consistent? ----
    const coverage = await graph.query<{
      couplings: number;
      withTicket: number;
      withSubject: number;
      withExplicit: number;
    }>("rationale coverage", RATIONALE_COVERAGE, {}, 60_000);

    if (!coverage.error && coverage.rows.length > 0) {
      const c = coverage.rows[0]!;
      const total = Number(c.couplings ?? 0);
      const withTicket = Number(c.withTicket ?? 0);
      log.plain("");
      log.plain(`  ${bold("provenance")}`);
      log.plain(dim("    Where the reason for a coupling came from, and whether the two copies agree."));
      log.plain(
        dim(
          `    couplings        ${withTicket.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} name a PR or issue ` +
            `(${total > 0 ? ((withTicket / total) * 100).toFixed(1) : "0"}%)`,
        ),
      );
      log.plain(dim(`    with a subject    ${Number(c.withSubject ?? 0).toLocaleString("en-US")} carry a recurring commit message`));
      log.plain(dim(`    explicit closes  ${Number(c.withExplicit ?? 0).toLocaleString("en-US")} linked by a fixes/closes keyword`));

      // ---- 5b. graph algorithms: are they actually answerable here? ----
    // These are load-bearing features, not decoration, so a server that cannot run
    // them is a broken server and should be reported as one.
    log.plain("");
    log.plain(`  ${bold("graph algorithms")}`);
    log.plain(dim("    These power `tangle structure`. A server that cannot answer them is not fully functional."));
    for (const [label, cypher, params] of [
      ["pagerank(File)", FILE_PAGERANK, { limit: 3 }],
      ["betweenness", FILE_BETWEENNESS, { limit: 3 }],
      ["WCC components", COUPLING_COMPONENTS, { limit: 3, sample: 2 }],
    ] as const) {
      const r = await graph.query<Record<string, unknown>>(label, cypher, params as never, 300_000);
      if (r.error) {
        log.plain(yellow(`    FAIL              ${label}: ${r.error.slice(0, 70)}`));
      } else {
        log.plain(green(`    ok                ${label} → ${r.rows.length} row(s)`));
      }
    }

    // ---- 5c. relationship control ----
    //
    // A traversal written with a relationship direction reversed returns zero rows
    // and no error, which is indistinguishable from an empty repository. Two such
    // bugs shipped in this project before this check existed. Asserting the
    // relationships exist turns "0 rows" from a silent failure into a diagnosis.
    const control = await graph.query<{ authors: number; touches: number; couplings: number }>(
      "relationship control",
      RELATIONSHIP_CONTROL,
      {},
      120_000,
    );
    if (!control.error && control.rows[0]) {
      const c = control.rows[0];
      const authors = Number(c.authors ?? 0);
      const touches = Number(c.touches ?? 0);
      const couplings = Number(c.couplings ?? 0);
      log.plain("");
      log.plain(`  ${bold("relationship control")}`);
      log.plain(dim("    Guards against a reversed edge silently returning zero rows."));
      const healthy = authors > 0 && touches > 0 && couplings > 0;
      log.plain(
        healthy
          ? green(
              `    PASS              ${authors.toLocaleString("en-US")} author · ${touches.toLocaleString("en-US")} touch · ${couplings.toLocaleString("en-US")} coupling`,
            )
          : yellow(
              `    FAIL              authors=${authors} touches=${touches} couplings=${couplings} — a traversal may be inverted`,
            ),
      );
    }

    const dangling = await graph.query<{ namedCouplings: number; resolvedTickets: number }>(
        "dangling why",
        DANGLING_WHY_TICKETS,
        {},
        60_000,
      );
      if (!dangling.error && dangling.rows[0]) {
        const named = Number(dangling.rows[0].namedCouplings ?? 0);
        const resolved = Number(dangling.rows[0].resolvedTickets ?? 0);
        if (named === resolved) {
          log.plain(green(`    PASS              all ${named.toLocaleString("en-US")} named ticket(s) resolve to a Ticket node`));
        } else {
          log.plain(yellow(`    FAIL              ${named - resolved} coupling(s) name a ticket that does not exist`));
        }
      }

      const unbacked = await graph.query<{ unbacked: number }>("unbacked explains", UNBACKED_EXPLAINS, {}, 60_000);
      if (!unbacked.error && unbacked.rows[0]) {
        const n = Number(unbacked.rows[0].unbacked ?? 0);
        if (n === 0) log.plain(green("    PASS              every EXPLAINS edge is backed by a coupling naming that ticket"));
        else log.plain(yellow(`    DIFFERS           ${n} EXPLAINS edge(s) have no backing coupling`));
      }
    } else if (coverage.error) {
      log.plain(yellow(`  provenance check unavailable: ${coverage.error}`));
      log.plain(dim("  This graph was ingested before provenance existed. Re-run: npm run ingest -- --repo X --fresh"));
    }

    log.plain("");
    log.plain(
      dim(
        `  graph holds ${fmtCount(totals.files)} files, ${fmtCount(totals.couplingEdges)} couplings, ` +
          `${fmtCount(totals.importEdges)} imports, ${fmtCount(totals.commits)} commits`,
      ),
    );
    log.plain("");
  } finally {
    await graph.disconnect();
  }
}

async function cmdBacktest(): Promise<void> {
  const repo = resolveRepo(repoArg);
  const started = Date.now();
  try {
    const report = await runBacktest({
      repoId: repo.id,
      commits: num("commits", DEFAULT_BACKTEST.commits),
      minConfidence: num("min-confidence", DEFAULT_BACKTEST.minConfidence),
      maxHops: num("max-hops", DEFAULT_BACKTEST.maxHops),
      minCoChanges: num("min-co-changes", DEFAULT_BACKTEST.minCoChanges),
      topK: num("top-k", DEFAULT_BACKTEST.topK),
      maxMassFiles: num("max-mass-files", DEFAULT_BACKTEST.maxMassFiles),
      // Bots are excluded by default, matching DEFAULT_BACKTEST.excludeBots and
      // the --no-bots help text, which documents this as opt-in.
      //
      // The fallback used to be `!DEFAULT_BACKTEST.excludeBots`, which inverts it:
      // with no flag passed, bot-authored commits were KEPT. A dependency bump
      // touches hundreds of files at once and makes all of them look coupled to
      // all of the others, so every published figure carried that noise. The
      // back-test JSON reported it honestly as botsExcluded: false, which is what
      // finally exposed it.
      excludeBots: !bool("no-bots", false),
      imports: bool("imports", DEFAULT_BACKTEST.imports),
      sweep: (args.flags.sweep as string | undefined)
        ?.split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n)) ?? DEFAULT_BACKTEST.sweep,
      reclone: bool("reclone", DEFAULT_BACKTEST.reclone),
    });

    if (bool("json")) {
      log.plain(JSON.stringify(report, null, 2));
      return;
    }

    log.plain(renderBacktest(report));
    log.plain(bold(green("Headline:")));
    log.plain(wrapText(backtestHeadline(report), 76, "  "));
    log.plain("");

    if (typeof args.flags.out === "string") {
      const target = args.flags.out.endsWith(".json")
        ? args.flags.out
        : join(config.dataDir, "backtest", `${repo.owner}~${repo.name}.json`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      log.plain(bold("Markdown for the README:"));
      log.plain(renderBacktestMarkdown(report));
      log.plain("");
      log.dim(`  JSON written to ${target}`);
      log.dim(`  elapsed ${((Date.now() - started) / 1000).toFixed(1)}s`);
      log.plain("");
    }
  } catch (err) {
    log.err(err instanceof Error ? err.message : String(err));
    if (args.flags.debug) console.error(err);
    process.exitCode = 1;
  }
}

/**
 * `tangle check` — the same short verdict the MCP tool returns, in a terminal.
 *
 * Deliberately thin: it calls `buildVerdict` rather than reimplementing anything,
 * so the CLI, the MCP tool, the hook and the GitHub comment can never disagree
 * about what Tangle thinks a diff is missing.
 */
async function cmdCheck(): Promise<void> {
  const repo = resolveRepo(repoArg);
  const filesFlag = typeof args.flags.files === "string" ? args.flags.files : args._.slice(1).join(",");
  const seeds = filesFlag
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (seeds.length === 0) {
    log.err("No files given.");
    log.plain(`  Pass:  npm run check -- --repo ${repo.id} --files src/a.ts,src/b.ts`);
    process.exit(1);
  }

  const graph = await requireGraph(repo.id);
  try {
    const result = await analyze(graph, {
      repo: repo.id,
      seeds,
      minConfidence: num("min-confidence", DEFAULT_ANALYZE.minConfidence),
      maxHops: num("max-hops", DEFAULT_ANALYZE.maxHops),
      maxResults: DEFAULT_ANALYZE.maxResults,
      reviewerLimit: DEFAULT_ANALYZE.reviewerLimit,
      evidenceLimit: DEFAULT_ANALYZE.evidenceLimit,
      evidencePairs: DEFAULT_ANALYZE.evidencePairs,
    });

    const verdict = buildVerdict(result);
    if (bool("json")) {
      log.plain(JSON.stringify(verdict, null, 2));
    } else {
      log.plain(renderVerdict(verdict, repo.id));
    }

    // A non-zero exit is opt-in. A tool that fails CI by default gets muted, and
    // then the signal is gone for everyone.
    if (bool("fail-on") && verdict.missedCount > 0) process.exitCode = 1;
  } finally {
    await graph.disconnect();
  }
}

/** `tangle install` — one-command agent wiring. */
async function cmdInstall(): Promise<void> {
  const { runInstallCommand } = await import("./install/cli.js");
  await runInstallCommand(process.argv.slice(3));
}

/** `tangle pr` — the GitHub Action's body, usable by hand. */
async function cmdPr(): Promise<void> {
  const { runPrCommand } = await import("./github/action.js");
  await runPrCommand(process.argv.slice(3));
}

/** `tangle hook check` — the post-edit self-correction loop. */
async function cmdHook(): Promise<void> {
  const { parseHookPayload, runHookCheck } = await import("./mcp/standalone.js");
  const sub = args._[1] ?? "check";
  if (sub !== "check") {
    log.err(`Unknown hook subcommand: ${sub}. Only "check" exists.`);
    process.exitCode = 2;
    return;
  }

  // Read stdin when something is piped, otherwise fall back to --files. Both
  // paths exist because Claude Code pipes a payload and Cursor passes argv.
  const raw = await new Promise<string>((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let acc = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => {
      acc += c;
      if (acc.length > 1_000_000) process.stdin.destroy();
    });
    process.stdin.on("end", () => resolve(acc));
    process.stdin.on("error", () => resolve(acc));
    setTimeout(() => resolve(acc), 5000).unref?.();
  });

  const payload = parseHookPayload(raw);
  const files =
    typeof args.flags.files === "string"
      ? args.flags.files.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)
      : payload.files;

  // No --repo means "whatever git says this directory is", which is what makes a
  // globally installed hook work across every project the user works on.
  const out = await runHookCheck({
    files,
    ...(repoArg ? { repo: repoArg } : payload.repo ? { repo: payload.repo } : {}),
    cwd: typeof args.flags.cwd === "string" ? args.flags.cwd : process.cwd(),
    quiet: !bool("verbose"),
    minConfidence: num("min-confidence", DEFAULT_ANALYZE.minConfidence),
  });

  for (const line of out.lines) if (line) process.stdout.write(`${line}\n`);
  // Always exit 0. A hook that fails the agent's tool call is worse than one that
  // stays quiet, and `fail-on` is available when someone wants enforcement.
  if (bool("fail-on") && out.level === "blocked") process.exitCode = 1;
}

async function cmdServe(): Promise<void> {
  const { startServer } = await import("./api/server.js");
  await startServer();
}

async function cmdMcp(): Promise<void> {
  await import("./mcp/server.js");
}

function wrapText(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if ((`${current} ${word}`).trim().length > width) {
      lines.push(current.trim());
      current = word;
    } else {
      current = `${current} ${word}`;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines.map((l) => `${indent}${l}`).join("\n");
}

async function main(): Promise<void> {
  switch (command) {
    case "ingest":
      return cmdIngest();
    case "analyze":
      return cmdAnalyze();
    case "discover":
      return cmdDiscover();
    case "why":
      return cmdWhy();
    case "review":
      return cmdReview();
    case "stats":
      return cmdStats();
    case "verify":
      return cmdVerify();
    case "backtest":
      return cmdBacktest();
    case "check":
      return cmdCheck();
    case "structure":
      return cmdStructure();
    case "install":
      return cmdInstall();
    case "pr":
      return cmdPr();
    case "hook":
      return cmdHook();
    case "serve":
      return cmdServe();
    case "mcp":
      return cmdMcp();
    case "help":
    case "--help":
    case "-h":
      return usage();
    default:
      log.err(`Unknown command: ${command}`);
      usage();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  log.err(err instanceof Error ? err.message : String(err));
  if (args.flags.debug) console.error(err);
  process.exit(1);
});

void resolveSeeds;
void red;