/**
 * Tangle as a standalone executable.
 *
 * Two things live here that the internal CLI does not need.
 *
 * **`--mcp`**, so the package can be launched by an agent with no arguments. An
 * MCP server that requires remembering a subcommand is one that silently fails to
 * start inside someone else's process manager.
 *
 * **`hook check`**, the self-correction loop. It reads the edited paths from
 * stdin or from `--files`, runs the same verdict as `tangle_check`, and prints
 * nothing at all when there is nothing to say. That silence is the feature: a
 * hook that fires on every edit is a hook people disable, and the measured
 * false-clean rate in `npm run backtest` means it cannot be trusted to be quiet
 * only when it is certain, so it says what it checked and how.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { analyze, DEFAULT_ANALYZE } from "../analysis/engine.js";
import { buildVerdict } from "../analysis/verdict.js";
import { repoFromGit } from "../install/agents.js";
import { Graph } from "../graph/client.js";
import { loadEnv } from "../config.js";
import { DEFAULT_REPO, resolveRepo } from "../repos.js";
import { log, dim, green, yellow, bold } from "../util/log.js";

loadEnv();

/**
 * Read the edited files out of whatever the calling agent provides.
 *
 * Claude Code's `PostToolUse` hook passes a JSON payload on stdin containing the
 * tool input. Cursor and others pass argv. All three are accepted so the same
 * command line works everywhere, because a hook that only works in one agent is
 * not worth installing.
 */
export function parseHookPayload(raw: string): { files: string[]; repo?: string } {
  if (!raw || raw.trim().length === 0) return { files: [] };

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return { files: collectPaths(parsed), repo: findRepo(parsed) };
  } catch {
    // Not JSON. Treat every line that looks like a path as one.
    const files = raw
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && !s.startsWith("{"));
    return { files };
  }
}

/** Find edited paths anywhere in a nested hook payload. */
function collectPaths(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || value == null) return out;

  if (Array.isArray(value)) {
    for (const item of value) collectPaths(item, out, depth + 1);
    return out;
  }

  if (typeof value === "string") {
    // A single string is a path only if it looks like one: no spaces, and either
    // it has a file extension or it is an absolute path.
    if (/^[\w./@\\-]+$/.test(value) && (value.includes(".") || value.startsWith("/") || value.startsWith("."))) {
      out.push(value);
    }
    return out;
  }

  if (typeof value === "object") {
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      // Explicit path fields first, so `file_path` beats a `command` string.
      if (key === "file_path" || key === "path" || key === "notebook_path" || key === "filePath") {
        if (typeof inner === "string") out.push(inner);
        continue;
      }
      if (key === "edits" && Array.isArray(inner)) {
        for (const edit of inner) collectPaths(edit, out, depth + 1);
        continue;
      }
      collectPaths(inner, out, depth + 1);
    }
  }

  return out;
}

function findRepo(value: unknown, depth = 0): string | undefined {
  if (depth > 5 || value == null || typeof value !== "object") return undefined;
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if ((key === "repo" || key === "repository") && typeof inner === "string" && inner.includes("/")) return inner;
    const found = findRepo(inner, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/**
 * Make an edited path usable as a graph key.
 *
 * Agents report absolute paths (`/home/dev/repo/src/a.ts`, or a Windows path with
 * a drive letter), and the graph is keyed by repo-relative POSIX paths. Getting
 * this wrong is silent and total: stripping the leading slash from
 * `/home/dev/slugify/index.js` yields `home/dev/slugify/index.js`, which matches
 * nothing in the graph, so the hook reports "not in the graph" for every file and
 * effectively never fires.
 *
 * Three cases, in order of reliability:
 *   1. The path is absolute and inside the working directory: `path.relative`
 *      against the cwd is exact.
 *   2. The path is already repo-relative: return it unchanged, normalised.
 *   3. Neither: fall back to matching the longest known suffix, which is the
 *      best guess available without knowing the agent's project root.
 */
export function toRepoRelative(rawPath: string, root: string): string {
  const normalised = rawPath.replace(/\\/g, "/");

  const isAbsolute = normalised.startsWith("/") || /^[A-Za-z]:\//.test(normalised);
  const normalisedRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");

  if (isAbsolute && normalisedRoot) {
    const caseInsensitive = process.platform === "win32";
    const rootCmp = caseInsensitive ? normalisedRoot.toLowerCase() : normalisedRoot;
    const pathCmp = caseInsensitive ? normalised.toLowerCase() : normalised;
    if (pathCmp === rootCmp) return "";
    if (pathCmp.startsWith(`${rootCmp}/`)) {
      return normalised.slice(normalisedRoot.length + 1);
    }
  }

  // Already relative, or rooted somewhere we do not know. Strip a leading `./`.
  const trimmed = normalised.replace(/^\.\//, "");
  // A leading `/` on a *relative* input is a formatting artefact, not a real root.
  return isAbsolute ? trimmed.replace(/^\/+/, "") : trimmed;
}

/**
 * Best-effort match of an absolute path to a repo-relative graph key.
 *
 * Used when the cwd is not the repository the agent is editing — common when the
 * hook runs from a config directory. Takes the longest suffix that looks like a
 * real source path, which for a monorepo is better than returning nothing.
 */
export function guessRepoRelative(rawPath: string, known?: Set<string>): string {
  const direct = toRepoRelative(rawPath, process.cwd());
  if (!known || direct.length === 0 || known.has(direct)) return direct;

  const parts = rawPath.replace(/\\/g, "/").split("/").filter(Boolean);
  for (let start = 1; start < parts.length; start++) {
    const candidate = parts.slice(start).join("/");
    if (known.has(candidate)) return candidate;
  }
  return direct;
}

/**
 * Load the repository's file paths so an absolute path can be matched.
 *
 * Cached per process because a hook fires once per edit and would otherwise
 * re-read tens of thousands of paths on every keystroke-triggered tool call.
 */
const keyCache = new Map<string, Set<string>>();

async function graphKeys(graph: Graph, repoId: string): Promise<Set<string>> {
  const cached = keyCache.get(repoId);
  if (cached) return cached;

  const result = await graph.query<{ path: string }>(
    "file keys",
    `MATCH (f:File) RETURN f.path AS path`,
    {},
    60_000,
  );
  const keys = new Set(result.error ? [] : result.rows.map((r) => r.path));
  keyCache.set(repoId, keys);
  return keys;
}

/** A real path from the graph, so the error message shows the expected shape. */
function examplePath(known: Set<string>): string | null {
  for (const p of known) {
    if (p.includes("/") && /\.(ts|js|tsx|jsx|py|go|rs)$/.test(p)) return p;
  }
  return null;
}

/**
 * Run the check and return the lines to print.
 *
 * An empty array means "say nothing", and that is the correct output far more often
 * than a clean verdict, because a hook that interrupts every edit is noise.
 */
export async function runHookCheck(options: {
  files: string[];
  /** Explicit repo. When absent the hook asks git for the origin remote. */
  repo?: string;
  cwd: string;
  quiet: boolean;
  minConfidence: number;
}): Promise<{ lines: string[]; level: string }> {
  if (options.files.length === 0) {
    return {
      lines: options.quiet ? [] : ["tangle: no edited files found in the hook payload; nothing checked."],
      level: "unknown",
    };
  }

// A hook installed globally has no way to know which repository it is in, and
  // hardcoding one would make it report on the wrong project for everyone who
  // installed it. Ask git.
  const explicit = options.repo ?? process.env.TANGLE_REPO;
  const detected = repoFromGit(options.cwd);
  const repoId = explicit ?? detected;
  if (!repoId) {
    return {
      lines: options.quiet ? [] : ["tangle: not a git repository, so the repository could not be determined."],
      level: "unknown",
    };
  }

  const repo = resolveRepo(repoId);
  const graph = new Graph(repo.id);

  try {
    if (!(await graph.ping())) {
      return {
        lines: options.quiet ? [] : [`tangle: FalkorDB is not reachable, so the check could not run.`],
        level: "unavailable",
      };
    }

    // Resolve the graph's own path vocabulary before guessing. This is what turns
    // an absolute path from an unknown root into something that matches.
    const known = await graphKeys(graph, repo.id);

    // "No graph for this repository" and "these paths are not in the graph" are
    // different problems with different fixes, and telling a user the wrong one
    // costs them ten minutes of debugging. Empty `known` means the former.
    if (known.size === 0) {
      return {
        lines: [
          `tangle: ${repo.id} has no coupling graph yet.`,
          `  Run:  tangle ingest --repo ${repo.id}`,
          `  Until then the check cannot run and no verdict should be assumed.`,
        ],
        level: "no-graph",
      };
    }

    const seeds = Array.from(new Set(options.files.map((f) => guessRepoRelative(f, known)))).filter(
      (f) => f.length > 0 && known.has(f),
    );

    if (seeds.length === 0) {
      // Reporting this is more useful than silence: the hook is installed, it ran,
      // and it could not recognise the paths it was given. That is a configuration
      // problem the user can fix, and a hook that never says anything makes it
      // invisible.
return {
    lines: options.quiet
      ? []
      : [
          `tangle: ${options.files.length} edited path(s) matched nothing in ${repo.id}.`,
          `  Edited: ${options.files.slice(0, 3).join(", ")}`,
          `  Expected repo-relative paths such as ${examplePath(known) ?? "src/index.ts"}.`,
        ],
    level: "nomatch",
  };
}

    const result = await analyze(graph, {
      repo: repo.id,
      seeds,
      minConfidence: options.minConfidence,
      maxHops: DEFAULT_ANALYZE.maxHops,
      maxResults: DEFAULT_ANALYZE.maxResults,
      reviewerLimit: DEFAULT_ANALYZE.reviewerLimit,
      evidenceLimit: DEFAULT_ANALYZE.evidenceLimit,
      evidencePairs: DEFAULT_ANALYZE.evidencePairs,
    });

    const verdict = buildVerdict(result);

    // Silent on a clean verdict, unless the caller asked to see everything.
    if (verdict.level === "clean" && options.quiet) return { lines: [], level: verdict.level };

    const lines: string[] = [];
    if (verdict.findings.length > 0) {
      lines.push(`Tangle: ${verdict.findings.length} file(s) strongly coupled to what you just edited are not in the change.`);
      for (const f of verdict.findings) lines.push(`  ${f.path} — ${f.why}`);
      if (verdict.missedCount > verdict.findings.length) {
        lines.push(`  … and ${verdict.missedCount - verdict.findings.length} more.`);
      }
      lines.push(verdict.caveat ?? "");
    } else {
      lines.push(`Tangle: nothing strongly coupled to these ${seeds.length} file(s) is missing from the change.`);
      lines.push(verdict.caveat ?? "");
    }

    return { lines, level: verdict.level };
  } catch (err) {
    // A hook that throws breaks the agent's edit loop, which is worse than a hook
    // that says nothing. Every failure degrades to silence.
    const message = err instanceof Error ? err.message : String(err);
    return {
      lines: options.quiet ? [] : [`tangle: check failed (${message}).`],
      level: "error",
    };
  } finally {
    await graph.disconnect();
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      raw += chunk;
      // A hook payload is small. Cap it so a misbehaving caller cannot exhaust
      // memory here.
      if (raw.length > 1_000_000) {
        process.stdin.destroy();
        resolve(raw.slice(0, 1_000_000));
      }
    });
    process.stdin.on("end", () => resolve(raw));
    process.stdin.on("error", () => resolve(raw));
    // Never hang an agent waiting on us.
    setTimeout(() => resolve(raw), 5000).unref?.();
  });
}

function flag(name: string): string | undefined {
  const prefix = `--${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  const bare = process.argv.indexOf(`--${name}`);
  if (bare !== -1 && process.argv[bare + 1] && !process.argv[bare + 1]!.startsWith("--")) {
    return process.argv[bare + 1]!;
  }
  return undefined;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === "hook") {
    const sub = argv[1] ?? "check";
    if (sub !== "check") {
      log.err(`Unknown hook subcommand: ${sub}. Only "check" exists.`);
      process.exit(2);
    }

    const raw = await readStdin();
    const payload = parseHookPayload(raw);
    const files = flag("files")
      ? flag("files")!.split(/[,\n]/).map((s) => s.trim()).filter(Boolean)
      : payload.files;

    const out = await runHookCheck({
      files,
      repo: flag("repo") ?? payload.repo ?? DEFAULT_REPO,
      cwd: flag("cwd") ?? process.cwd(),
      quiet: !has("verbose"),
      minConfidence: Number(flag("min-confidence") ?? DEFAULT_ANALYZE.minConfidence),
    });

    for (const line of out.lines) {
      if (line) process.stdout.write(`${line}\n`);
    }
    process.exit(0);
  }

  if (command === "install") {
    const { runInstallCommand } = await import("../install/cli.js");
    await runInstallCommand(argv.slice(1));
    return;
  }

  if (command === "pr") {
    const { runPrCommand } = await import("../github/action.js");
    await runPrCommand(argv.slice(1));
    return;
  }

  log.err(`tangle: unknown command "${command ?? ""}".`);
  log.plain(dim("  Try: tangle install · tangle hook check · tangle pr"));
  process.exit(2);
}

// Guard against importing this module merely for its helpers, which the test
// scripts do. Only boot when run as the entry point.
const invokedDirectly =
  process.argv[1]?.endsWith("standalone.ts") ||
  process.argv[1]?.endsWith("standalone.js") ||
  process.argv[1]?.endsWith("tangle");

if (invokedDirectly) {
  main().catch((err) => {
    log.err(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

void existsSync;
void readFileSync;
void homedir;
void join;
void green;
void yellow;
void bold;