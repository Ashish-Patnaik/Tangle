import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv, config } from "../config.js";
import { Graph } from "../graph/client.js";
import { repoTotals } from "../graph/totals.js";
import { REPOS, DEFAULT_REPO, resolveRepo } from "../repos.js";
import { ingest } from "../ingest/pipeline.js";
import { analyze, DEFAULT_ANALYZE, whyFromRow } from "../analysis/engine.js";
import { discover, DEFAULT_DISCOVER, showcase, influentialTickets } from "../analysis/discoveries.js";
import { structure } from "../analysis/structure.js";
import { fetchPr, parseInlineFiles, parsePrRef } from "../github/pr.js";
import { COUPLING_WHY } from "../graph/schema.js";
import { graphKey } from "../config.js";
import { log } from "../util/log.js";

loadEnv();

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "web");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

/** Which graphs are currently loaded, so the UI never offers a dead option. */
async function availableRepos(): Promise<{ id: string; label: string; primary: boolean; blurb: string; ingested: boolean }[]> {
  const out: { id: string; label: string; primary: boolean; blurb: string; ingested: boolean }[] = [];
  for (const repo of Object.values(REPOS)) {
    let ingested = false;
    try {
      const graph = new Graph(repo.id);
      const result = await graph.query<{ head: string | null }>(
        "probe",
        `MATCH (r:Repo) RETURN r.head AS head LIMIT 1`,
      );
      ingested = !result.error && result.rows.length > 0;
      await graph.disconnect();
    } catch {
      ingested = false;
    }
    out.push({ id: repo.id, label: repo.label, primary: repo.primary, blurb: repo.blurb, ingested });
  }
  return out;
}

async function isIngested(repoId: string): Promise<boolean> {
  const graph = new Graph(repoId);
  try {
    const result = await graph.query<{ head: string | null }>("probe", `MATCH (r:Repo) RETURN r.head AS head LIMIT 1`);
    return !result.error && result.rows.length > 0;
  } catch {
    return false;
  } finally {
    await graph.disconnect().catch(() => undefined);
  }
}

interface IngestJob {
  repo: string;
  status: "running" | "done" | "error";
  phase: string;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

/** One job per repo: concurrent requests for the same repo share it instead of cloning twice. */
const jobs = new Map<string, IngestJob>();

/** Starts (or joins) a background ingest. Couplings-only + a commit cap keeps first-use latency demo-friendly. */
function startIngestJob(repoId: string): IngestJob {
  const existing = jobs.get(repoId);
  if (existing && existing.status === "running") return existing;

  const ref = resolveRepo(repoId);
  const job: IngestJob = { repo: repoId, status: "running", phase: "queued", startedAt: Date.now() };
  jobs.set(repoId, job);

  ingest({
    repoId: ref.id,
    owner: ref.owner,
    name: ref.name,
    mode: "couplings-only",
    fresh: true,
    commitLimit: Number(process.env.TANGLE_ONDEMAND_COMMITS ?? 4000),
    onPhase: (p) => { job.phase = p; },
  })
    .then(() => { job.status = "done"; job.phase = "ready"; job.finishedAt = Date.now(); })
    .catch((err) => {
      job.status = "error";
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = Date.now();
      log.warn(`ingest ${repoId} failed: ${job.error}`);
    });
  return job;
}

interface ApiRoute {
  method: string;
  path: string;
}

const ROUTES: ApiRoute[] = [
  { method: "GET", path: "/api/repos" },
  { method: "GET", path: "/api/repos/:repo/stats" },
  { method: "GET", path: "/api/repos/:repo/discoveries" },
  { method: "GET", path: "/api/repos/:repo/tickets" },
  { method: "GET", path: "/api/repos/:repo/why" },
  { method: "GET", path: "/api/repos/:repo/showcase" },
  { method: "GET", path: "/api/repos/:repo/structure" },
  { method: "POST", path: "/api/analyze" },
];

function numParam(raw: string | null, fallback: number): number {
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith("/api/")) return false;

  const send = (status: number, body: unknown) => {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    res.end(payload);
  };

  const parts = url.pathname.split("/").filter(Boolean);

  try {
    // GET /api/repos
    if (req.method === "GET" && parts.length === 2 && parts[1] === "repos") {
      send(200, { repos: await availableRepos(), default: DEFAULT_REPO });
      return true;
    }

    // GET /api/repos/:repo/stats
    if (req.method === "GET" && parts.length === 4 && parts[1] === "repos" && parts[3] === "stats") {
      const repoId = decodeURIComponent(parts[2]!);
      const graph = new Graph(repoId);
      try {
        const totals = await repoTotals(graph);
        const head = await graph.query<{ head: string; ingestedAt: string; commitCount: number; language: string }>(
          "head",
          `MATCH (r:Repo) RETURN r.head AS head, r.ingestedAt AS ingestedAt, r.commitCount AS commitCount, r.language AS language LIMIT 1`,
        );
        if (head.rows.length === 0) {
          send(404, { error: `No graph for ${repoId}. Run: npm run ingest -- --repo ${repoId}` });
          return true;
        }
        send(200, { repo: repoId, graphKey: graphKey(repoId), totals, ...head.rows[0] });
        return true;
      } finally {
        await graph.disconnect();
      }
    }

    // GET /api/repos/:repo/discoveries
    if (req.method === "GET" && parts.length === 4 && parts[1] === "repos" && parts[3] === "discoveries") {
      const repoId = decodeURIComponent(parts[2]!);
      const graph = new Graph(repoId);
      try {
        const result = await discover(graph, {
          ...DEFAULT_DISCOVER,
          repo: repoId,
          minConfidence: numParam(url.searchParams.get("minConfidence"), DEFAULT_DISCOVER.minConfidence),
          minCoChanges: numParam(url.searchParams.get("minCoChanges"), DEFAULT_DISCOVER.minCoChanges),
          limit: Math.min(200, numParam(url.searchParams.get("limit"), 40)),
          importDepth: Math.min(4, Math.max(1, Math.round(numParam(url.searchParams.get("importDepth"), 1)))),
          includeArtifacts: url.searchParams.get("includeArtifacts") === "true",
          verify: url.searchParams.get("verify") !== "false",
        });
        send(200, result);
        return true;
      } finally {
        await graph.disconnect();
      }
    }

    // GET /api/repos/:repo/tickets
    // The tickets that explain the most coupling structure, and for each one the
    // couplings it accounts for.
    if (req.method === "GET" && parts.length === 4 && parts[1] === "repos" && parts[3] === "tickets") {
      const repoId = decodeURIComponent(parts[2]!);
      const graph = new Graph(repoId);
      try {
        const limit = Math.min(100, numParam(url.searchParams.get("limit"), 12));
        send(200, {
          repo: repoId,
          tickets: await influentialTickets(graph, {
            limit,
            couplingsPerTicket: Math.min(20, numParam(url.searchParams.get("couplings"), 6)),
          }),
        });
        return true;
      } finally {
        await graph.disconnect();
      }
    }

    // GET /api/repos/:repo/why?a=<path>&b=<path>
    // Why two specific files are coupled. The single most useful provenance call:
    // an agent holding a diff can ask about any pair it suspects.
    if (req.method === "GET" && parts.length === 4 && parts[1] === "repos" && parts[3] === "why") {
      const repoId = decodeURIComponent(parts[2]!);
      const a = url.searchParams.get("a");
      const b = url.searchParams.get("b");
      if (!a || !b) {
        send(400, { error: "Both a and b are required.", example: `/api/repos/${repoId}/why?a=src/a.ts&b=src/b.ts` });
        return true;
      }
      const graph = new Graph(repoId);
      try {
        // COUPLED is stored once per unordered pair, so canonicalise first.
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const result = await graph.query<Record<string, unknown>>(
          "coupling why",
          COUPLING_WHY,
          { pairs: [{ a: lo, b: hi }] },
          30_000,
        );
        if (result.error) {
          send(500, { error: result.error });
          return true;
        }
        const row = result.rows[0];
        send(200, {
          repo: repoId,
          a: lo,
          b: hi,
          coupled: Boolean(row),
          why: row ? whyFromRow(row) : null,
        });
        return true;
      } finally {
        await graph.disconnect();
      }
    }

    // GET /api/repos/:repo/showcase
    if (req.method === "GET" && parts.length === 4 && parts[1] === "repos" && parts[3] === "showcase") {
      const repoId = decodeURIComponent(parts[2]!);
      const graph = new Graph(repoId);
      try {
        send(200, await showcase(graph, repoId, 10));
        return true;
      } finally {
        await graph.disconnect();
      }
    }

    // GET /api/repos/:repo/structure
    // Whole-graph questions an agent could otherwise only ask from a terminal:
    // load-bearing files, bridges between clusters, subsystems, bus factor.
    if (req.method === "GET" && parts.length === 4 && parts[1] === "repos" && parts[3] === "structure") {
      const repoId = decodeURIComponent(parts[2]!);
      const graph = new Graph(repoId);
      try {
        const limit = Math.min(60, numParam(url.searchParams.get("limit"), 15));
        send(200, { repo: repoId, ...(await structure(graph, limit)) });
        return true;
      } finally {
        await graph.disconnect();
      }
    }

    // POST /api/analyze
    if (req.method === "POST" && parts.length === 2 && parts[1] === "analyze") {
      const body = await readBody(req);
      const input = (body ?? {}) as {
        pr?: string;
        files?: string;
        repo?: string;
        minConfidence?: number;
        maxHops?: number;
        maxResults?: number;
      };

      let repoId = input.repo ?? DEFAULT_REPO;
      let seeds: string[] = [];
      let pr = null as Awaited<ReturnType<typeof fetchPr>> | null;

      const inline = input.pr ? parseInlineFiles(input.pr) : null;
      const prRef = input.pr ? parsePrRef(input.pr) : null;

      if (prRef) {
        pr = await fetchPr(prRef);
        repoId = pr.ref.repoId;
        seeds = pr.changedFiles.map((f) => f.path);
      } else if (inline) {
        repoId = inline.repoId;
        seeds = inline.files;
      } else {
        // A bare comma-separated list of paths, analysed against `repo`. This is
        // the shape the UI sends when someone types file names instead of a PR
        // URL, so it has to work rather than 400.
        const raw = (input.files ?? input.pr ?? "").trim();
        seeds = raw
          .split(/[,\n]/)
          .map((s) => s.trim())
          .filter(Boolean);
      }

      if (seeds.length === 0) {
        send(400, {
          error: "No changed files. Send a GitHub PR URL, or a comma-separated file list.",
          examples: [
            "https://github.com/vercel/next.js/pull/12345",
            "packages/next/src/server/config.ts,packages/next/src/build/index.ts",
          ],
        });
        return true;
      }

      const graph = new Graph(repoId);
      try {
        const alive = await graph.ping();
        if (!alive) {
          send(503, { error: "FalkorDB is not reachable." });
          return true;
        }

        // On-demand ingest: an unseen repo is cloned and loaded the first time
        // someone asks about it, instead of being rejected.
        if (!(await isIngested(repoId))) {
          const prev = jobs.get(repoId);
          if (prev && prev.status === "error") {
            jobs.delete(repoId); // report once; the next request retries
            send(502, { error: `Could not ingest ${repoId}: ${prev.error}` });
            return true;
          }
          const job = startIngestJob(repoId);
          send(202, { ingesting: true, repo: repoId, phase: job.phase, startedAt: job.startedAt });
          return true;
        }

        const result = await analyze(graph, {
          repo: repoId,
          seeds,
          minConfidence: clamp(input.minConfidence ?? DEFAULT_ANALYZE.minConfidence, 0.05, 1),
          maxHops: Math.round(clamp(input.maxHops ?? DEFAULT_ANALYZE.maxHops, 1, 4)),
          maxResults: Math.round(clamp(input.maxResults ?? DEFAULT_ANALYZE.maxResults, 10, 500)),
          reviewerLimit: DEFAULT_ANALYZE.reviewerLimit,
          evidenceLimit: DEFAULT_ANALYZE.evidenceLimit,
          evidencePairs: DEFAULT_ANALYZE.evidencePairs,
        });

        send(200, { pr, ...result });
        return true;
      } finally {
        await graph.disconnect();
      }
    }

    send(404, { error: `No route for ${req.method} ${url.pathname}` });
    return true;
  } catch (err) {
    log.warn(`api ${url.pathname}: ${err instanceof Error ? err.message : String(err)}`);
    send(500, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((res, rej) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 2_000_000) rej(new Error("Request body too large"));
    });
    req.on("end", () => {
      if (!raw.trim()) return res({});
      try {
        res(JSON.parse(raw));
      } catch {
        rej(new Error("Body was not valid JSON"));
      }
    });
    req.on("error", rej);
  });
}

async function serveStatic(url: URL, res: ServerResponse): Promise<void> {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  // normalize + prefix check keeps `..` from escaping the web directory.
  const safe = normalize(requested).replace(/^(\.\.[/\\])+/, "");
  const target = join(WEB_DIR, safe);

  if (!target.startsWith(WEB_DIR) || !existsSync(target)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
    return;
  }

  try {
    const content = await readFile(target);
    res.writeHead(200, {
      "content-type": MIME[extname(target)] ?? "application/octet-stream",
      "cache-control": "public, max-age=3600",
    });
    res.end(content);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  }
}

export async function startServer(port = config.port): Promise<void> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      });
      res.end();
      return;
    }

    if (await handleApi(req, res, url)) return;
    await serveStatic(url, res);
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));

  log.ok(`Tangle serving on http://localhost:${port}`);
  log.dim(`  FalkorDB     ${config.falkordb.host}:${config.falkordb.port}`);
  log.dim(`  primary repo ${DEFAULT_REPO}`);
  log.dim(`  web root     ${WEB_DIR}`);
}

// Allow `node dist/api/server.js` to boot directly.
const invokedDirectly = process.argv[1]?.endsWith("server.js") || process.argv[1]?.endsWith("server.ts");
if (invokedDirectly) {
  startServer().catch((err) => {
    log.err(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

void ROUTES;