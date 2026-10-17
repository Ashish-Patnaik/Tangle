import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { git } from "./git.js";
import { log } from "../util/log.js";

export interface ImportEdge {
  a: string;
  b: string;
  via: string;
}

export interface ImportExtraction {
  edges: ImportEdge[];
  filesScanned: number;
  bytesRead: number;
  ms: number;
  workspacePackages: number;
  truncated: boolean;
}

const SOURCE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts",
  ".py", ".vue", ".svelte", ".go", ".rs", ".java", ".rb", ".php",
]);

const RESOLVE_EXT = ["", ".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".json"];

const SKIP_DIR = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", "target",
  "coverage", "vendor", "third_party", "__pycache__", ".venv", "venv",
  ".turbo", ".cache", ".yarn", "fixtures", "__fixtures__", "__snapshots__",
  "generated", "snapshots", "snap", "outputs", "golden", "testdata",
]);

/** Files larger than this are assumed to be generated, vendored or fixtures. */
const MAX_FILE_BYTES = 400 * 1024;

/**
 * Materialise the working tree so files can be read with plain `fs`.
 *
 * Sparse checkout was tried first and abandoned: `ls-files --cached` reported
 * 33,875 tracked paths while only 7 source files were actually on disk, so the
 * import pass silently extracted nothing and the graph ended up claiming every
 * coupling was a phantom. A full `git checkout HEAD` on a depth-1 clone gives
 * 25,000 source files in about 35 seconds and needs no cleverness at all. The
 * clone is deleted as soon as extraction finishes.
 */
export async function prepareSourceTree(cloneDir: string): Promise<void> {
  if (!existsSync(join(cloneDir, ".git"))) throw new Error(`Not a git repository: ${cloneDir}`);

  log.step("materialising the working tree for import extraction");
  const started = Date.now();
  await git(["checkout", "HEAD"], cloneDir);
  log.ok(`working tree ready in ${((Date.now() - started) / 1000).toFixed(1)}s`);
}

export interface WalkOptions {
  /** Hard cap on files read, so a pathological monorepo cannot run away. */
  maxFiles: number;
  onProgress?: (read: number, edges: number) => void;
}

/**
 * Extract static import edges from a materialised working tree.
 *
 * Extraction is by pattern rather than AST. On a monorepo containing generated
 * code a full parse is slower than it is worth, and imprecise resolution is
 * handled by construction: a specifier that does not resolve to a real tracked
 * file simply produces no edge.
 */
/**
 * How many files to read at once. Enough to keep a cold disk busy, small enough
 * that 24k open handles are never outstanding.
 */
const READ_CONCURRENCY = 24;

/**
 * Read every readable source file under the size cap, keyed by path.
 *
 * Missing and unreadable files are simply absent from the map. That matches the
 * previous behaviour, which swallowed the error and skipped the file.
 */
async function readAll(sources: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let next = 0;

  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= sources.length) return;
      const file = sources[i]!;
      try {
        const buf = await readFile(file);
        if (buf.byteLength > MAX_FILE_BYTES) continue;
        out.set(file, buf.toString("utf8"));
      } catch {
        continue;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, sources.length) }, worker));
  return out;
}

export async function extractImportsFromTree(root: string, options: WalkOptions): Promise<ImportExtraction> {
  const started = Date.now();

  const { sources, manifests } = walk(root, options.maxFiles);
  log.step(`scanning ${sources.length.toLocaleString("en-US")} source files`);

  const known = new Set(sources.map((f) => toRepoPath(root, f)));
  const workspace = buildWorkspaceIndex(root, manifests);
  const edges: ImportEdge[] = [];
  let bytesRead = 0;
  let processed = 0;

  // Reading the tree is I/O bound, not CPU bound. Measured on next.js: the
  // same 24,547 files scan in 147.6s cold and 14.2s warm - roughly 420 KB/s
  // from cold disk, which is the cost of 24,547 serial reads each paying full
  // latency, not of the regexes. A small pool overlaps that latency.
  //
  // Contents are keyed by index rather than interleaved as they land, so the
  // edge list is byte-for-byte what the serial version produced. Parallelism
  // that reorders output would be a silent behaviour change in the load phase.
  const contents = await readAll(sources);
  for (const file of sources) {
    const content = contents.get(file);
    if (content === undefined) continue;
    bytesRead += Buffer.byteLength(content, "utf8");

    const rel = toRepoPath(root, file);
    for (const spec of extractSpecifiers(content, rel)) {
      const target = resolveSpecifier(spec, rel, known, workspace);
      if (!target || target === rel) continue;
      edges.push({ a: rel, b: target, via: spec });
    }

    processed++;
    if (options.onProgress && processed % 5000 === 0) options.onProgress(processed, edges.length);
  }

  log.ok(
    `${edges.length.toLocaleString("en-US")} import edges from ${sources.length.toLocaleString("en-US")} files ` +
      `(${fmtBytes(bytesRead)}, ${workspace.byName.size} workspace packages, ${((Date.now() - started) / 1000).toFixed(1)}s)`,
  );

  return {
    edges,
    filesScanned: sources.length,
    bytesRead,
    ms: Date.now() - started,
    workspacePackages: workspace.byName.size,
    truncated: false,
  };
}

const fmtBytes = (n: number): string =>
  n < 1024 * 1024 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

/**
 * One pass over the tree collecting both source files and package manifests.
 *
 * Manifests are collected here rather than probed per file: looking for a
 * package.json at every ancestor of every source file is hundreds of thousands
 * of syscalls on a monorepo, and it produced the same answers.
 */
function walk(root: string, maxFiles: number): { sources: string[]; manifests: string[] } {
  const sources: string[] = [];
  const manifests: string[] = [];
  const stack: string[] = [root];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIR.has(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        const dot = entry.name.lastIndexOf(".");
        if (dot <= 0) continue;
        const ext = entry.name.slice(dot).toLowerCase();

        // Only the root manifest and package-root manifests matter for
        // workspace resolution; a manifest deeper than that declares a nested
        // package that nothing imports by name.
        if (entry.name === "package.json") {
          const depth = toRepoPath(root, full).split("/").length;
          if (depth <= 4) manifests.push(full);
        }
        if (!SOURCE_EXT.has(ext)) continue;
        if (sources.length >= maxFiles) return { sources, manifests };
        sources.push(full);
      }
    }
  }
  return { sources, manifests };
}

function toRepoPath(root: string, full: string): string {
  return full.slice(root.length + 1).replace(/\\/g, "/");
}

export interface WorkspaceIndex {
  byName: Map<string, string>;
}

function buildWorkspaceIndex(root: string, manifests: string[]): WorkspaceIndex {
  const byName = new Map<string, string>();
  for (const file of manifests) {
    try {
      const stat = statSync(file);
      if (stat.size > 200 * 1024) continue;
      const pkg = JSON.parse(readFileSync(file, "utf8")) as { name?: string };
      if (pkg.name) byName.set(pkg.name, toRepoPath(root, join(file, "..")));
    } catch {
      // A malformed or oversized manifest is not a reason to abort ingest.
    }
  }
  return { byName };
}

/**
 * Static specifier extraction.
 *
 * Kept deliberately regex-based. On a monorepo that vendors generated output, a
 * full parse costs more than it returns, and an unresolvable specifier is
 * filtered out downstream anyway.
 */
export function extractSpecifiers(content: string, path: string): string[] {
  const specs = new Set<string>();
  const py = path.endsWith(".py");

  const patterns = py
    ? [/(?:^|\n)\s*from\s+([.\w]+)\s+import\s+/g, /(?:^|\n)\s*import\s+([.\w]+)/g]
    : [
        /(?:^|\n)\s*import\s+(?:type\s+)?[^;\n]*?\s+from\s+['"]([^'"]+)['"]/g,
        /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
        /(?:^|\n)\s*export\s+(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?from\s+['"]([^'"]+)['"]/g,
        /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
        /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      ];

  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(content)) !== null) {
      const spec = m[1];
      if (spec) specs.add(spec);
    }
  }
  return Array.from(specs);
}

/**
 * Resolve a specifier to a repo-relative path, or null.
 *
 * Handles relative specifiers with extension and `/index` probing, workspace
 * package names for monorepos, and Python's dotted module paths. Bare npm
 * specifiers deliberately resolve to nothing: they are external dependencies, not
 * couplings inside this repo, and counting them would inflate every coupling in
 * the graph with a constant.
 */
export function resolveSpecifier(spec: string, fromPath: string, known: Set<string>, workspace: WorkspaceIndex): string | null {
  if (fromPath.endsWith(".py")) return resolvePython(spec, fromPath, known);

  if (spec.startsWith(".")) return probe(joinPath(dirOfPath(fromPath), spec), known);

  const scoped = workspace.byName.get(spec);
  if (scoped) return probe(scoped, known);

  const rootName = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
  const rootDir = workspace.byName.get(rootName);
  if (rootDir) {
    const rest = spec.slice(rootName.length).replace(/^\//, "");
    return probe(rest ? joinPath(rootDir, rest) : rootDir, known);
  }

  return null;
}

function resolvePython(spec: string, fromPath: string, known: Set<string>): string | null {
  if (!spec.startsWith(".")) return probe(`${spec.replace(/\./g, "/")}.py`, known) ?? null;
  const up = /^\.+/.exec(spec)?.[0].length ?? 0;
  const rest = spec.slice(up).replace(/\./g, "/");
  const climb = up > 1 ? "../".repeat(up - 1) : "";
  const base = joinPath(dirOfPath(fromPath), `${climb}${rest}`);
  return probe(`${base}.py`, known) ?? probe(base, known);
}

function probe(base: string, known: Set<string>): string | null {
  for (const ext of RESOLVE_EXT) {
    if (known.has(`${base}${ext}`)) return `${base}${ext}`;
  }
  for (const ext of RESOLVE_EXT) {
    if (ext === "") continue;
    const candidate = `${base}/index${ext}`;
    if (known.has(candidate)) return candidate;
  }
  return null;
}

function dirOfPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}

function joinPath(dir: string, rel: string): string {
  const stack: string[] = [];
  for (const part of `${dir}/${rel}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join("/");
}
