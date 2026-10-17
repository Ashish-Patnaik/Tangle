import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { git, isGitDir, dirBytes } from "./git.js";
import { log, yellow } from "../util/log.js";

export interface CloneOptions {
  /** Reuse an existing clone and fetch into it instead of re-cloning. */
  force?: boolean;
}

const url = (owner: string, name: string) => `https://github.com/${owner}/${name}.git`;

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;

/**
 * Two clones, on purpose.
 *
 * `historyRepo` is a blobless full-history clone: just commits and trees, a few
 * hundred megabytes, and `git log --name-only` over it runs in seconds. That is
 * all change coupling needs.
 *
 * `sourcesRepo` is a depth-1 clone with real blobs, used only to read file
 * contents, and deleted as soon as imports are extracted.
 *
 * Reading contents from the blobless clone instead — the obvious thing to try —
 * does not work. Git then fetches blobs one at a time and repacks after almost
 * every batch. On vercel/next.js that turned a 100 MB source tree into an 8 GB
 * clone and ran for over two hours. Two cheap clones beat one clever one.
 */
export async function historyRepo(
  owner: string,
  name: string,
  baseDir: string,
  opts: CloneOptions = {},
): Promise<string> {
  const dir = resolve(baseDir, `${owner}~${name}`);

  if (existsSync(dir) && (await isGitDir(dir))) {
    if (!opts.force) {
      log.dim(`reusing history clone (${mb(dirBytes(dir))})`);
      return dir;
    }
    log.step(`fetching ${owner}/${name} history`);
    await git(["fetch", "--filter=blob:none", "--tags", "--prune", "origin"], dir);
    log.ok(`history clone ${mb(dirBytes(dir))}`);
    return dir;
  }

  mkdirSync(baseDir, { recursive: true });
  log.step(`cloning ${owner}/${name} history (blobless, full)`);
  const started = Date.now();

  await git(
    ["clone", "--no-checkout", "--single-branch", "--filter=blob:none", url(owner, name), dir],
    baseDir,
  );

  log.ok(`history clone in ${((Date.now() - started) / 1000).toFixed(1)}s (${mb(dirBytes(dir))})`);
  return dir;
}

/**
 * Shallow, blob-complete clone used only to read file contents.
 *
 * `depth 1` without a blob filter means the whole HEAD snapshot arrives in one
 * bulk fetch rather than dribbling out blob by blob. Disk cost is bounded by the
 * repository's current tree, and it is reclaimed immediately afterwards.
 *
 * It lives in a *separate* directory from the history clone. When the two
 * shared a path, this function handed back the blobless history clone, found no
 * working tree in it, and the cleanup step then deleted the history — which
 * surfaced much later as a baffling `spawn git ENOENT` during the graph load.
 */
export async function sourcesRepo(owner: string, name: string, baseDir: string, reuse = true): Promise<string> {
  const dir = resolve(baseDir, `${owner}~${name}`);
  mkdirSync(baseDir, { recursive: true });

  if (reuse && existsSync(dir) && (await isGitDir(dir)) && (await hasWorkingTree(dir))) {
    log.dim(`reusing source clone (${mb(dirBytes(dir))})`);
    return dir;
  }

  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });

  log.step(`cloning ${owner}/${name} sources (depth 1)`);
  const started = Date.now();

  await git(["clone", "--depth", "1", "--no-checkout", url(owner, name), dir], baseDir);

  log.ok(`source clone in ${((Date.now() - started) / 1000).toFixed(1)}s (${mb(dirBytes(dir))})`);
  return dir;
}

/** A sparse checkout of a few thousand files, or nothing at all. */
async function hasWorkingTree(dir: string): Promise<boolean> {
  try {
    const { stdout } = await git(["ls-files", "--cached"], dir, 60_000);
    return stdout.split("\n").filter(Boolean).length > 0;
  } catch {
    return false;
  }
}

export function discardSourcesRepo(dir: string): void {
  // Refuse to delete anything that is not actually inside the sources area.
  // This function previously fired on the history clone after a path collision,
  // and a guard is cheaper than that lesson.
  if (!/data[/\\]sources[/\\]/.test(dir)) {
    log.warn(`refusing to remove ${dir}: not under data/sources`);
    return;
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    log.warn(`could not remove ${dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function repoHead(dir: string): Promise<string> {
  const { stdout } = await git(["rev-parse", "HEAD"], dir);
  return stdout.trim();
}

export async function repoDefaultBranch(dir: string): Promise<string> {
  try {
    const { stdout } = await git(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir);
    const name = stdout.trim().replace(/^origin\//, "");
    if (name) return name;
  } catch {
    // Fall through to the common default.
  }
  return existsSync(join(dir, ".git")) ? detectDefaultBranch(dir) : "main";
}

function detectDefaultBranch(dir: string): string {
  for (const candidate of ["main", "master"]) {
    try {
      statSync(join(dir, ".git", "refs", "heads", candidate));
      return candidate;
    } catch {
      // Try the next one.
    }
  }
  return "main";
}

/**
 * Primary language, chosen by comparing language *families* rather than raw
 * extension counts.
 *
 * A per-extension tally gets this wrong on real repositories: a TypeScript
 * monorepo carries thousands of `.md` and `.json` files, and because each of
 * those contributes a small non-zero weight they can outvote the language the
 * code is actually written in. Grouping extensions into families fixes it.
 */
const LANGUAGE_FAMILIES: Record<string, string[]> = {
  typescript: [".ts", ".tsx", ".mts", ".cts"],
  javascript: [".js", ".jsx", ".mjs", ".cjs"],
  python: [".py"],
  go: [".go"],
  rust: [".rs"],
  java: [".java"],
  ruby: [".rb"],
  php: [".php"],
};

export function detectLanguage(files: Iterable<string>): string {
  const scores = new Map<string, number>();
  let total = 0;

  for (const f of files) {
    const dot = f.lastIndexOf(".");
    if (dot === -1) continue;
    const ext = f.slice(dot).toLowerCase();

    // TypeScript is a superset of JavaScript, so a .ts file is evidence for both.
    if (ext === ".ts" || ext === ".tsx") {
      scores.set("typescript", (scores.get("typescript") ?? 0) + 1);
      scores.set("javascript", (scores.get("javascript") ?? 0) + 0.5);
    } else {
      for (const [language, exts] of Object.entries(LANGUAGE_FAMILIES)) {
        if (exts.includes(ext)) {
          scores.set(language, (scores.get(language) ?? 0) + 1);
          break;
        }
      }
    }
    total++;
  }

  // A language only qualifies if it accounts for a real share of the history,
  // otherwise a repo of mostly markdown reports whichever family edged ahead.
  let best = "unknown";
  let bestScore = 0;
  for (const [language, score] of scores) {
    if (score > bestScore) {
      best = language;
      bestScore = score;
    }
  }
  const share = total > 0 ? bestScore / total : 0;
  return share >= 0.1 ? best : "mixed";
}

/** Top-level directories that look like they hold source. */
export function topLevelDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Warn before a clone fills the disk. Better than discovering it halfway. */
export function assertFreeSpace(bytesNeeded: number, where: string): void {
  if (bytesNeeded <= 0) return;
  log.dim(`${where} needs roughly ${mb(bytesNeeded)} of free disk`);
  if (bytesNeeded > 6 * 1024 ** 3) {
    log.warn(yellow(`this is a large clone; make sure ${mb(6 * 1024 ** 3)} of disk is free`));
  }
}