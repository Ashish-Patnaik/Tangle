import { git } from "./git.js";
import { log } from "../util/log.js";

export interface CommitRecord {
  sha: string;
  date: string;
  email: string;
  name: string;
  subject: string;
  /**
   * Full commit message body. This is where the strongest provenance signal
   * lives: `Fixes #1234`, `Closes vercel/next.js#88`. Subjects only carry the
   * `(#1234)` that a squash merge appends, which says the change came *from* a
   * PR but not what it was *for*.
   */
  body: string;
  files: string[];
}

export interface HistoryOptions {
  /** Skip commits touching more files than this. Mass refactors and vendoring dominate pair counts otherwise. */
  maxMassCommitFiles: number;
  /** Only these extensions produce coupling edges. Empty means all. */
  includeExts?: string[];
  excludePaths?: string[];
  limit?: number;
  /**
   * Raise the stdout buffer. A full-history `--name-only` walk of a large
   * monorepo emits far more than the default; without this the read fails with
   * `stdout maxBuffer length exceeded` rather than returning partial data.
   */
  maxBufferBytes?: number;
}

const FIELD = "\u001f";
const RECORD = "\u001e";

/**
 * Room for a full-history file listing of a large repository.
 *
 * `git log --name-only` over vercel/next.js produces tens of megabytes of paths
 * across ~36k commits. The default 10 MB buffer aborts the read, and the failure
 * mode looks like a git problem rather than a Node one.
 */
const BIG_HISTORY_BUFFER = 512 * 1024 * 1024;

/**
 * One `git log` pass over the whole history.
 *
 * `--name-only` rather than `--numstat` is load-bearing, not a shortcut. On a
 * blobless clone `--numstat` makes git compute diffs, which pulls every blob in
 * the repository's entire history over the network. `--name-only` only walks
 * trees, so a full-history pass over a large monorepo costs seconds instead of
 * tens of minutes. We only ever needed file lists: change coupling is a
 * statement about which files moved together, not about how many lines moved.
 *
 * The format string is chosen so no repository-controlled value can break
 * parsing: the subject cannot realistically contain \x1e or \x1f, and `-z`
 * terminates every path with NUL.
 */
export async function readHistory(dir: string, opts: HistoryOptions): Promise<{ commits: CommitRecord[]; skippedMass: number; ms: number }> {
  // `%B` is the full message (subject, blank line, body) and is multi-line, so it
  // is placed FIRST and the five single-line fields follow it. That ordering is
  // what makes parsing unambiguous: the header ends at the first newline after
  // the last separator, and nothing between the separators can contain a newline.
  const args = [
    "log",
    "-z",
    "--name-only",
    "--no-merges",
    "--no-renames",
    `--format=format:${RECORD}%B${FIELD}%H${FIELD}%aI${FIELD}%aE${FIELD}%aN${FIELD}%s`,
  ];
  if (opts.limit) args.push(`--max-count=${opts.limit}`);

  log.step("reading git history");
  const { stdout, ms } = await git(args, dir, 900_000, opts.maxBufferBytes ?? BIG_HISTORY_BUFFER);

  const commits = parseLog(stdout, opts);
  const skippedMass = commits.reduce((n, c) => n + (c.massSkipped ?? 0), 0);

  log.ok(
    `parsed ${commits.length.toLocaleString("en-US")} commits in ${(ms / 1000).toFixed(1)}s` +
      (skippedMass ? ` (${skippedMass.toLocaleString("en-US")} files from mass commits dropped)` : ""),
  );

  return { commits, skippedMass, ms };
}

interface ParsedCommit extends CommitRecord {
  massSkipped?: number;
}

/**
 * `%B` is the whole message, so it begins with the subject and then a blank line
 * and the real body. The subject is stripped back off and the remainder is
 * flattened onto one line: provenance is extracted with patterns that never span
 * a newline, and a multi-line string per commit is a memory cost on a repository
 * with 35,000 of them.
 */
function foldBody(raw: string, subject: string): string {
  let body = raw.trim();
  if (subject && body.startsWith(subject)) body = body.slice(subject.length);
  body = body.replace(/\r/g, "").replace(/\n+/g, " ").replace(/\s{2,}/g, " ").trim();
  // Long boilerplate tails (templates, changelog blocks, diffstat) are noise for
  // reference extraction and dominate memory on large histories.
  return body.length > 2000 ? `${body.slice(0, 2000)}…` : body;
}

/**
 * Split on the record separator, take the five \x1f-delimited separators that
 * divide the six header fields, and treat the remainder as NUL-delimited paths.
 */
export function parseLog(raw: string, opts: HistoryOptions): ParsedCommit[] {
  const include = opts.includeExts?.length ? new Set(opts.includeExts.map((e) => e.toLowerCase())) : null;
  const exclude = opts.excludePaths?.length ? opts.excludePaths : null;
  const maxFiles = opts.maxMassCommitFiles;

  const out: ParsedCommit[] = [];

  for (const chunk of raw.split(RECORD)) {
    if (!chunk.trim()) continue;

    const headerEnd = findHeaderEnd(chunk);
    if (headerEnd === -1) continue;

    const parts = chunk.slice(0, headerEnd).split(FIELD);
    if (parts.length < 6) continue;
    const [rawBody, sha, date, email, name, subject] = parts as [string, string, string, string, string, string];
    if (!/^[0-9a-f]{7,40}$/.test(sha.trim())) continue;

    const rows = chunk.slice(headerEnd).split("\u0000");
    const files: string[] = [];
    let massSkipped = 0;

    for (const row of rows) {
      // The header is followed by exactly one newline before the first path.
      const path = row.replace(/^[\r\n]+/, "");
      if (!path || path === " => ") continue;
      if (exclude?.some((p) => path.startsWith(p))) continue;
      if (include && !include.has(extOf(path))) continue;

      if (maxFiles > 0 && files.length >= maxFiles) {
        massSkipped++;
        continue;
      }
      files.push(path);
    }

    if (files.length === 0) continue;
    out.push({ sha: sha.trim(), date, email, name, subject: subject.replace(/\s+$/, ""), body: foldBody(rawBody, subject), files, massSkipped });
  }

  return out;
}

function findHeaderEnd(chunk: string): number {
  const first = chunk.indexOf(FIELD);
  if (first === -1) return -1;
  const second = chunk.indexOf(FIELD, first + 1);
  const third = chunk.indexOf(FIELD, second + 1);
  const fourth = chunk.indexOf(FIELD, third + 1);
  if (fourth === -1) return -1;
  const nl = chunk.indexOf("\n", fourth);
  return nl === -1 ? -1 : nl + 1;
}

export function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

export function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "." : path.slice(0, slash);
}

/** Collapse git author emails into a stable, human-recognisable login. */
export function loginOf(name: string, email: string): string {
  const fromEmail = email.includes("@") ? email.slice(0, email.indexOf("@")) : "";
  const candidate = (fromEmail || name || "unknown").trim().toLowerCase();
  const cleaned = candidate.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "unknown";
}