import * as readline from "node:readline";
import { Graph } from "../graph/client.js";
import { analyze, DEFAULT_ANALYZE } from "../analysis/engine.js";
import { discover, DEFAULT_DISCOVER, influentialTickets } from "../analysis/discoveries.js";
import { structure } from "../analysis/structure.js";
import { buildVerdict } from "../analysis/verdict.js";
import { whyFromRow } from "../analysis/engine.js";
import { COUPLING_WHY } from "../graph/schema.js";
import { DEFAULT_REPO } from "../repos.js";
import { log } from "../util/log.js";
import { parseInlineFiles } from "../github/pr.js";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

async function handleMessage(message: any) {
  if (message.method === "initialize") {
    sendResponse(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: {
        tools: {},
      },
      serverInfo: {
        name: "tangle",
        version: "1.0.0",
      },
    });
  } else if (message.method === "tools/list") {
    sendResponse(message.id, {
      tools: [
        {
          name: "tangle_check",
          description:
            "PRIMARY TOOL. Call this before editing or finishing any change. Pass the files you have " +
            "touched or are about to touch; it returns a short verdict naming any file strongly coupled " +
            "to them that is missing from the diff, with the pull request or issue that caused the " +
            "coupling. Levels: 'clean' (nothing strongly coupled is missing), 'caution' (some may be " +
            "missing), 'blocked' (the change is probably incomplete). Every answer is a bounded claim " +
            "and says what it could not check.",
          inputSchema: {
            type: "object",
            properties: {
              files: {
                type: "string",
                description:
                  "Comma-separated list of files changed, or about to be changed. Repo-relative paths.",
              },
              repo: {
                type: "string",
                description: "The repository ID (e.g., 'vercel/next.js'). Defaults to vercel/next.js",
              },
              minConfidence: {
                type: "number",
                description:
                  "Coupling confidence floor, 0.05 to 1.0. Raise it to reduce noise on large diffs. Default 0.3.",
              },
              maxHops: {
                type: "number",
                description: "Coupling hops to traverse, 1 or 2. Default 2.",
              },
            },
            required: ["files"],
          },
        },
        {
          name: "tangle_analyze",
          description:
            "Full analysis for a set of changed files: blast radius, missed files with commit evidence, " +
            "reviewer routing, and the proof-of-absence certificate. Use when tangle_check reports " +
            "something and you need the whole picture, or when a human is reading the output.",
          inputSchema: {
            type: "object",
            properties: {
              repo: {
                type: "string",
                description: "The repository ID (e.g., 'vercel/next.js'). Defaults to vercel/next.js",
              },
              files: {
                type: "string",
                description: "Comma-separated list of files changed in the PR or commit.",
              },
              minConfidence: {
                type: "number",
                description: "Minimum confidence threshold (0.05 to 1.0) for a coupling edge. Default 0.3.",
              },
            },
            required: ["files"],
          },
        },
        {
          name: "tangle_discoveries",
          description: "Discover phantom couplings in a repository (files that change together but have no import edge).",
          inputSchema: {
            type: "object",
            properties: {
              repo: {
                type: "string",
                description: "The repository ID (e.g., 'vercel/next.js'). Defaults to vercel/next.js",
              },
              limit: {
                type: "number",
                description: "Maximum number of phantom couplings to return. Default 10.",
              },
            },
          },
        },
        {
          name: "tangle_why",
          description:
            "Explain why two files are coupled: the pull request or issue that introduced the coupling, " +
            "how much of it that change accounts for, and the commits that prove it. " +
            "Returns null provenance when the reason was never recorded.",
          inputSchema: {
            type: "object",
            properties: {
              repo: {
                type: "string",
                description: "The repository ID (e.g., 'vercel/next.js'). Defaults to vercel/next.js",
              },
              a: {
                type: "string",
                description: "First file path, repo-relative.",
              },
              b: {
                type: "string",
                description: "Second file path, repo-relative.",
              },
            },
            required: ["a", "b"],
          },
        },
        {
          name: "tangle_tickets",
          description:
            "List the pull requests and issues that explain the most coupling structure in a repository. " +
            "Use this to learn which decisions quietly hold parts of the codebase together.",
          inputSchema: {
            type: "object",
            properties: {
              repo: {
                type: "string",
                description: "The repository ID (e.g., 'vercel/next.js'). Defaults to vercel/next.js",
              },
              limit: {
                type: "number",
                description: "How many tickets to return. Default 10.",
              },
            },
          },
        },
        {
          name: "tangle_structure",
          description:
            "Whole-graph questions: load-bearing files by PageRank, bridge files that connect " +
            "clusters by betweenness, coupling islands by weakly-connected-components, and the " +
            "bus factor. Use this to learn which parts of a repository everything else depends on, " +
            "or how few people hold a subsystem together.",
          inputSchema: {
            type: "object",
            properties: {
              repo: {
                type: "string",
                description: "The repository ID (e.g., 'vercel/next.js'). Defaults to vercel/next.js",
              },
              limit: {
                type: "number",
                description: "How many entries per section. Default 15.",
              },
            },
          },
        },
      ],
    });
  } else if (message.method === "tools/call") {
    const { name, arguments: args } = message.params ?? {};

    if (name === "tangle_check") {
      // The primary tool. Everything else exists to be called *after* this one
      // says there is something to look at.
      const repoId = args.repo || DEFAULT_REPO;
      const filesStr = args.files || "";
      const seeds = filesStr.split(/[,\n]/).map((s: string) => s.trim()).filter(Boolean);

      if (seeds.length === 0) {
        sendResponse(message.id, {
          content: [{ type: "text", text: "Error: no files given. Pass `files` as a comma-separated list of repo-relative paths." }],
          isError: true,
        });
        return;
      }

      const graph = new Graph(repoId);
      try {
        if (!(await graph.ping())) {
          sendResponse(message.id, {
            content: [{
              type: "text",
              text:
                "Error: FalkorDB is not reachable, so nothing could be checked.\n" +
                "Start it with `docker compose up -d`, then re-ingest with " +
                "`npm run ingest -- --repo " + repoId + "`.",
            }],
            isError: true,
          });
          return;
        }

        const result = await analyze(graph, {
          repo: repoId,
          seeds,
          minConfidence: args.minConfidence ?? DEFAULT_ANALYZE.minConfidence,
          maxHops: args.maxHops ?? DEFAULT_ANALYZE.maxHops,
          maxResults: DEFAULT_ANALYZE.maxResults,
          reviewerLimit: DEFAULT_ANALYZE.reviewerLimit,
          evidenceLimit: DEFAULT_ANALYZE.evidenceLimit,
          evidencePairs: DEFAULT_ANALYZE.evidencePairs,
        });
        const verdict = buildVerdict(result);

        // The prose verdict is the payload. The structured block is included
        // because an agent that wants to branch on the outcome should not have to
        // parse English to do it.
        sendResponse(message.id, {
          content: [
            { type: "text", text: verdict.text },
            {
              type: "text",
              text: JSON.stringify(
                { level: verdict.level, headline: verdict.headline, findings: verdict.findings, basis: verdict.basis },
                null,
                2,
              ),
            },
          ],
        });
      } catch (err: any) {
        sendResponse(message.id, {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        });
      } finally {
        await graph.disconnect();
      }
    } else if (name === "tangle_analyze") {
      const repoId = args.repo || DEFAULT_REPO;
      const filesStr = args.files || "";
      const seeds = filesStr.split(/[,\n]/).map((s: string) => s.trim()).filter(Boolean);
      
      if (seeds.length === 0) {
        sendResponse(message.id, {
          content: [{ type: "text", text: "Error: No changed files provided." }],
          isError: true,
        });
        return;
      }
      
      const graph = new Graph(repoId);
      try {
        const alive = await graph.ping();
        if (!alive) {
          sendResponse(message.id, {
            content: [{ type: "text", text: "Error: FalkorDB is not reachable." }],
            isError: true,
          });
          return;
        }
        
        const result = await analyze(graph, {
          repo: repoId,
          seeds,
          minConfidence: args.minConfidence ?? DEFAULT_ANALYZE.minConfidence,
          maxHops: DEFAULT_ANALYZE.maxHops,
          maxResults: DEFAULT_ANALYZE.maxResults,
          reviewerLimit: DEFAULT_ANALYZE.reviewerLimit,
          evidenceLimit: DEFAULT_ANALYZE.evidenceLimit,
          evidencePairs: DEFAULT_ANALYZE.evidencePairs,
        });
        
        sendResponse(message.id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      } catch (err: any) {
        sendResponse(message.id, {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        });
      } finally {
        await graph.disconnect();
      }
    } else if (name === "tangle_why") {
      const repoId = args.repo || DEFAULT_REPO;
      const a = (args.a ?? "").trim();
      const b = (args.b ?? "").trim();

      if (!a || !b) {
        sendResponse(message.id, {
          content: [{ type: "text", text: "Error: both `a` and `b` are required, as repo-relative paths." }],
          isError: true,
        });
        return;
      }

      const graph = new Graph(repoId);
      try {
        if (!(await graph.ping())) {
          sendResponse(message.id, {
            content: [{ type: "text", text: "Error: FalkorDB is not reachable." }],
            isError: true,
          });
          return;
        }

        // COUPLED is stored once per unordered pair, so canonicalise first.
        const [lo, hi] = a <= b ? [a, b] : [b, a];
        const result = await graph.query<Record<string, unknown>>(
          "coupling why",
          COUPLING_WHY,
          { pairs: [{ a: lo, b: hi }] },
          30_000,
        );

        const row = result.rows[0];
        if (!row) {
          sendResponse(message.id, {
            content: [
              {
                type: "text",
                text: `${lo} and ${hi} are not coupled above the stored threshold in ${repoId}.`,
              },
            ],
          });
          return;
        }

        const why = whyFromRow(row);
        const lines = [`${lo}`, `${hi}`, ""];
        if (why?.ticket) {
          lines.push(
            `Why: ${why.kind === "pull-request" ? "pull request" : "issue"} ${why.ticket} — ${why.title ?? "(no title)"}`,
          );
          lines.push(`URL: ${why.url}`);
          lines.push(
            `Accounted for by ${why.mentions} shared commit(s) (${Math.round(
              (why.share ?? 0) * 100,
            )}% of their co-changes)${why.explicit ? ", linked by an explicit closes/fixes keyword" : ""}.`,
          );
        } else if (why?.subject) {
          lines.push(`Why: no ticket reference; tied by a recurring commit message: "${why.subject}".`);
        } else {
          lines.push("Why: no pull request or issue reference survives in their shared commits.");
          lines.push("The coupling is real; the reason was never recorded in a form git retains.");
        }

        sendResponse(message.id, { content: [{ type: "text", text: lines.join("\n") }] });
      } catch (err: any) {
        sendResponse(message.id, {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        });
      } finally {
        await graph.disconnect();
      }
    } else if (name === "tangle_tickets") {
      const repoId = args.repo || DEFAULT_REPO;
      const limit = args.limit || 10;

      const graph = new Graph(repoId);
      try {
        if (!(await graph.ping())) {
          sendResponse(message.id, {
            content: [{ type: "text", text: "Error: FalkorDB is not reachable." }],
            isError: true,
          });
          return;
        }

        const tickets = await influentialTickets(graph, { limit });
        const text =
          tickets.length === 0
            ? `No pull request or issue reference was found in the ${repoId} history.`
            : tickets
                .map(
                  (t) =>
                    `${t.key} — ${t.title || "(no title)"}\n  ${t.filesExplained} file(s), ` +
                    `${t.totalMentions} mention(s)${t.explicit ? ", explicit closes/fixes" : ""}\n  ${t.url}` +
                    (t.couplings.length > 0
                      ? `\n  strongest couplings:\n${t.couplings
                          .map((c) => `    ${c.coChanges}x  ${c.a} <-> ${c.b}`)
                          .join("\n")}`
                      : ""),
                )
                .join("\n\n");

        sendResponse(message.id, { content: [{ type: "text", text }] });
      } catch (err: any) {
        sendResponse(message.id, {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        });
      } finally {
        await graph.disconnect();
      }
    } else if (name === "tangle_structure") {
      const repoId = args.repo || DEFAULT_REPO;
      const limit = Number(args.limit) || 15;

      const graph = new Graph(repoId);
      try {
        if (!(await graph.ping())) {
          sendResponse(message.id, {
            content: [{ type: "text", text: "Error: FalkorDB is not reachable." }],
            isError: true,
          });
          return;
        }

        const report = await structure(graph, limit);
        const lines: string[] = [];
        lines.push(`Structure of ${repoId}`);
        lines.push(`algos: ${Object.entries(report.available).map(([k, v]) => `${k}=${v}`).join(" ")}`);
        lines.push("");

        lines.push(`Load-bearing files (${report.loadBearing.length}) - what other changes route through:`);
        for (const f of report.loadBearing) {
          lines.push(`  ${f.path}  rank ${(f.share * 100).toFixed(1)}%, ${f.changes} change(s)`);
        }
        lines.push("");

        lines.push(`Bridge files (${report.bridges.length}) - connect separate clusters:`);
        for (const f of report.bridges) {
          lines.push(`  ${f.path}  ${f.couplings} coupling(s), ${f.changes} change(s)`);
        }
        lines.push("");

        lines.push(`Coupling islands (${report.islands.length}) - clusters history says belong together:`);
        for (const i of report.islands) {
          lines.push(`  component ${i.component}: ${i.files} file(s), ${i.totalChanges} change(s)`);
          if (i.sample.length) lines.push(`    e.g. ${i.sample.slice(0, 3).join(", ")}`);
        }
        lines.push(`  largest island holds ${(report.largestIslandShare * 100).toFixed(1)}% of all files`);
        lines.push(`  directory layout ${report.layoutDisagrees ? "disagrees with the clustering" : "agrees with the clustering"}`);
        lines.push("");

        lines.push(`Bus factor (${report.busFactor.length}) - concentration of coupling knowledge:`);
        for (const b of report.busFactor) {
          lines.push(`  ${b.login} holds ${(b.shareOfCouplings * 100).toFixed(1)}% of all couplings across ${b.files} file(s)`);
        }

        sendResponse(message.id, { content: [{ type: "text", text: lines.join("\n") }] });

      } catch (err: any) {
        sendResponse(message.id, {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        });
      } finally {
        await graph.disconnect();
      }
    } else if (name === "tangle_discoveries") {
      const repoId = args.repo || DEFAULT_REPO;
      const limit = args.limit || 10;
      
      const graph = new Graph(repoId);
      try {
        const alive = await graph.ping();
        if (!alive) {
          sendResponse(message.id, {
            content: [{ type: "text", text: "Error: FalkorDB is not reachable." }],
            isError: true,
          });
          return;
        }
        
        const result = await discover(graph, {
          ...DEFAULT_DISCOVER,
          repo: repoId,
          limit,
        });
        
        sendResponse(message.id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      } catch (err: any) {
        sendResponse(message.id, {
          content: [{ type: "text", text: `Error: ${err.message}` }],
          isError: true,
        });
      } finally {
        await graph.disconnect();
      }
    } else {
      sendResponse(message.id, {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      });
    }
  }
}

function sendResponse(id: string | number, result: any) {
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id,
    result,
  }) + "\n");
}

function sendError(id: string | number, code: number, message: string) {
  process.stdout.write(JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  }) + "\n");
}

rl.on("line", async (line) => {
  if (!line.trim()) return;
  try {
    const message = JSON.parse(line);
    if (message.jsonrpc !== "2.0") return;
    await handleMessage(message);
  } catch (err) {
    // Invalid JSON, just ignore or log to stderr
    process.stderr.write(`Failed to parse message: ${err}\n`);
  }
});

// Allow node dist/mcp/server.js to boot directly.
log.dim("Tangle MCP server started. Waiting for JSON-RPC messages on stdin.");
