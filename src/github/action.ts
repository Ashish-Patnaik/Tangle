/**
 * `tangle pr` — the GitHub Action's implementation, and a usable CLI command.
 *
 * The deliverable people actually share is a comment on a pull request, so that is
 * what this produces:
 *
 *   > You changed `auth.ts` but not `session.ts`.
 *   > They changed together in 11 of the last 12 commits, and the reason is
 *   > issue #4398.
 *
 * Three properties make it survive contact with a real repository.
 *
 * **It is idempotent.** One comment per PR, updated in place, identified by a
 * hidden marker. A bot that appends a new comment on every push is noise that
 * gets the whole thing muted.
 *
 * **It never blocks a merge by surprise.** The default is a comment. `fail-on`
 * opts into a failing check, and even then the exit code distinguishes "found
 * something" from "could not run".
 *
 * **It says when it could not check.** A stale or missing graph produces a comment
 * that says so, rather than silence that reads as approval.
 */

import { analyze, DEFAULT_ANALYZE } from "../analysis/engine.js";
import { buildVerdict } from "../analysis/verdict.js";
import { Graph } from "../graph/client.js";
import { config } from "../config.js";
import { resolveRepo } from "../repos.js";
import { log, dim, green, yellow } from "../util/log.js";

/**
 * The marker that identifies our own comment.
 *
 * An HTML comment, because GitHub renders markdown and hides HTML. The PR number
 * is part of it so a future release can leave old comments alone while still
 * upserting its own.
 */
const MARKER = "<!-- tangle:pr-check -->";

export interface PrOptions {
  /** `owner/name`. Falls back to the GitHub Actions environment. */
  repo?: string;
  /** PR number. Falls back to `GITHUB_REF`/event payload. */
  number?: number;
  /** Files changed. Fetched from the API when absent. */
  files?: string[];
  minConfidence: number;
  maxHops: number;
  /** Post or update the comment. */
  comment: boolean;
  /** Exit non-zero when files are reported missing. */
  failOn: boolean;
  /** Print the comment body instead of posting it. */
  dryRun: boolean;
  quiet: boolean;
}

export const DEFAULT_PR: Omit<PrOptions, "repo" | "number" | "files"> = {
  minConfidence: DEFAULT_ANALYZE.minConfidence,
  maxHops: DEFAULT_ANALYZE.maxHops,
  comment: true,
  failOn: false,
  dryRun: false,
  quiet: false,
};

/** The workflow output name for the count, so a later step can gate on it. */
export const OUTPUT_MISSED = "missed";

interface GhComment {
  id: number;
  body: string;
  user?: { login?: string; type?: string };
}

/**
 * Read the PR's changed files.
 *
 * Uses the local checkout's git when the action has one, which is both faster and
 * free, and falls back to the API. In CI the checkout is usually a merge ref, so
 * the diff against the base is the correct file list for a PR — the same list the
 * API would return, without spending rate limit.
 */
export async function resolveChangedFiles(repo: string, number: number, token?: string): Promise<string[]> {
  const pr = await fetchJson<{ head?: { sha?: string }; base?: { sha?: string } }>(
    `/repos/${repo}/pulls/${number}`,
    token,
  );
  if (!pr) return [];

  const files: string[] = [];
  // GitHub paginates this endpoint at 3000 entries and silently drops the rest.
  for (let page = 1; page <= 10; page++) {
    const batch = await fetchJson<{ filename?: string }[]>(
      `/repos/${repo}/pulls/${number}/files?per_page=100&page=${page}`,
      token,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const f of batch) if (f.filename) files.push(f.filename);
    if (batch.length < 100) break;
  }
  return files;
}

async function fetchJson<T>(path: string, token?: string): Promise<T | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "tangle-impact-agent",
  };
  const auth = token ?? config.githubToken ?? process.env.GITHUB_TOKEN;
  if (auth) headers.Authorization = `Bearer ${auth}`;

  try {
    const res = await fetch(`https://api.github.com${path}`, { headers });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    // Network failure is not a reason to throw from a CI comment path; the
    // caller reports the gap.
    return null;
  }
}

/**
 * The comment body.
 *
 * Written to be read by someone reviewing a diff in a hurry, so the verdict is
 * first, the missing files are the body, and the bounds of the search are the last
 * line rather than a wall of text.
 */
export function renderComment(
  verdict: ReturnType<typeof buildVerdict>,
  repo: string,
  number: number,
  meta: { files: number; graphHead: string | null; ms: number; stale: boolean },
): string {
  const out: string[] = [];
  out.push(MARKER);
  out.push("");

  if (verdict.level === "clean") {
    out.push(`### 🛡️ Tangle — nothing strongly coupled is missing`);
    out.push("");
    out.push(
      `Checked ${meta.files} changed file${meta.files === 1 ? "" : "s"} in this PR. No file in the coupling graph is strongly tied to the diff.`,
    );
  } else {
    const icon = verdict.level === "blocked" ? "🚨" : "⚠️";
    out.push(`### ${icon} Tangle — ${verdict.findings.length} coupled file(s) not in this PR`);
    out.push("");
    out.push(verdict.headline);
    out.push("");
    out.push("| File | Why it is coupled |");
    out.push("| --- | --- |");
    for (const f of verdict.findings) {
      out.push(`| \`${f.path}\` | ${escapeCell(f.why)} |`);
    }
    if (verdict.missedCount > verdict.findings.length) {
      out.push("");
      out.push(`_…and ${verdict.missedCount - verdict.findings.length} more, shown in \`tangle analyze\`._`);
    }
  }

  out.push("");
  out.push("<details><summary>How this was checked</summary>");
  out.push("");
  out.push(
    `- **Method:** change coupling mined from ${repo}'s git history, compared against the static import graph.`,
  );
  out.push(
    `- **Bounds:** confidence ≥ ${verdict.basis.minConfidence}, ${verdict.basis.maxHops} hop(s), ` +
      `${verdict.basis.affected} file(s) reached from ${verdict.basis.seeds} changed.`,
  );
  out.push(`- **Graph head:** ${meta.graphHead ?? "unknown"}`);
  if (meta.stale) {
    out.push(
      "- **Stale:** the graph is older than this pull request's base commit, so recent changes are not reflected.",
    );
  }
  out.push(`- **Took:** ${(meta.ms / 1000).toFixed(2)}s`);
  out.push("");
  out.push(
    "Tangle only reports couplings that history actually recorded. Absence of a coupling here is not proof of independence.",
  );
  out.push("");
  out.push("</details>");
  out.push("");
  out.push(dim(`_tangle · PR #${number} · run \`npm run why\` locally for the full picture_`).replace(/^_|_$/g, ""));

  return out.join("\n");
}

/** Markdown tables break on a pipe character, which paths occasionally contain. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

export interface PrOutcome {
  status: "ok" | "findings" | "unavailable";
  comment: string;
  missed: number;
  exitCode: number;
  note: string;
}

/**
 * The whole flow: resolve files, analyse, render, upsert.
 *
 * Returns an outcome rather than exiting so the CLI and the action can decide what
 * to do with it. The action wrapper turns `exitCode` into a process exit.
 */
export async function runPr(opts: PrOptions): Promise<PrOutcome> {
  const repoId = opts.repo ?? repoFromEnvironment();
  const number = opts.number ?? numberFromEnvironment();
  const token = config.githubToken ?? process.env.GITHUB_TOKEN;

  const started = Date.now();

  if (!repoId || !number) {
    return {
      status: "unavailable",
      comment: "",
      missed: 0,
      // Exit 0: a missing PR context is a configuration problem, not a finding, and
      // failing the job for it would make the action look broken rather than unused.
      exitCode: 0,
      note: `no repository or PR number in the environment (repo=${repoId ?? "-"}, pr=${number ?? "-"})`,
    };
  }

  const ref = resolveRepo(repoId);
  const files = opts.files?.length ? opts.files : await resolveChangedFiles(ref.id, number, token);

  if (files.length === 0) {
    return {
      status: "unavailable",
      comment: "",
      missed: 0,
      exitCode: 0,
      note: `could not read the changed files for ${ref.id}#${number}`,
    };
  }

  const graph = new Graph(ref.id);
  let head: string | null = null;
  let stale = false;

  try {
    if (!(await graph.ping())) {
      return {
        status: "unavailable",
        comment: unavailableComment(ref.id, number, "FalkorDB is not reachable"),
        missed: 0,
        exitCode: 0,
        note: "FalkorDB is not reachable",
      };
    }

    const headRow = await graph.query<{ head: string | null; ingestedAt: string | null }>(
      "head",
      `MATCH (r:Repo) RETURN r.head AS head, r.ingestedAt AS ingestedAt LIMIT 1`,
    );
    if (headRow.rows.length === 0) {
      return {
        status: "unavailable",
        comment: unavailableComment(ref.id, number, "this repository has not been ingested"),
        missed: 0,
        exitCode: 0,
        note: `${ref.id} has no graph; run \`tangle ingest --repo ${ref.id}\``,
      };
    }
    head = headRow.rows[0]!.head ?? null;
    // A graph older than a week is stale enough to say so. The comparison is
    // against ingest time because the graph's head is the clone's, not the PR base.
    const ingestedAt = headRow.rows[0]!.ingestedAt;
    if (ingestedAt) stale = Date.now() - Date.parse(ingestedAt) > 7 * 24 * 3600 * 1000;

    const result = await analyze(graph, {
      repo: ref.id,
      seeds: files,
      minConfidence: opts.minConfidence,
      maxHops: opts.maxHops,
      maxResults: DEFAULT_ANALYZE.maxResults,
      reviewerLimit: DEFAULT_ANALYZE.reviewerLimit,
      evidenceLimit: DEFAULT_ANALYZE.evidenceLimit,
      evidencePairs: DEFAULT_ANALYZE.evidencePairs,
    });

    const verdict = buildVerdict(result);
    const comment = renderComment(verdict, ref.id, number, {
      files: files.length,
      graphHead: head,
      ms: Date.now() - started,
      stale,
    });

    if (!opts.dryRun && opts.comment) {
      const posted = await upsertComment(ref.id, number, comment, token);
      if (!posted.ok && !opts.quiet) {
        log.warn(`could not post the comment: ${posted.detail ?? "unknown error"}`);
      }
    } else if (!opts.dryRun && !opts.comment && !opts.quiet) {
      log.dim("commenting disabled (--no-comment)");
    }

    const missed = verdict.missedCount;
    return {
      status: missed > 0 ? "findings" : "ok",
      comment,
      missed,
      exitCode: opts.failOn && missed > 0 ? 1 : 0,
      note: missed > 0 ? `${missed} coupled file(s) not in the diff` : "nothing strongly coupled is missing",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      status: "unavailable",
      comment: unavailableComment(ref.id, number, message),
      missed: 0,
      // A crash is reported, not enforced. `fail-on` is about findings, not about
      // Tangle having a bad day.
      exitCode: 0,
      note: `check failed: ${message}`,
    };
  } finally {
    await graph.disconnect();
  }
}

/**
 * Post once, then update in place.
 *
 * The existing comment is found by our own marker rather than by author, so a bot
 * or a maintainer renaming the account cannot cause a duplicate.
 */
export async function upsertComment(
  repo: string,
  number: number,
  body: string,
  token?: string,
): Promise<{ ok: boolean; action: "created" | "updated" | "none"; detail?: string }> {
  const auth = token ?? config.githubToken ?? process.env.GITHUB_TOKEN;
  if (!auth) return { ok: false, action: "none", detail: "no GITHUB_TOKEN" };

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "tangle-impact-agent",
    Authorization: `Bearer ${auth}`,
    "content-type": "application/json",
  };

  try {
    // 100 comments is far past the number of times anyone re-pushes one PR, and
    // stops a pathological loop from walking thousands of pages.
    let existing: GhComment | null = null;
    for (let page = 1; page <= 2 && !existing; page++) {
      const res = await fetch(
        `https://api.github.com/repos/${repo}/issues/${number}/comments?per_page=100&page=${page}`,
        { headers },
      );
      if (!res.ok) return { ok: false, action: "none", detail: `listing comments: ${res.status}` };
      const list = (await res.json()) as GhComment[];
      if (!Array.isArray(list)) break;
      existing = list.find((c) => typeof c.body === "string" && c.body.includes(MARKER)) ?? null;
      if (list.length < 100) break;
    }

    if (existing) {
      const res = await fetch(
        `https://api.github.com/repos/${repo}/issues/comments/${existing.id}`,
        { method: "PATCH", headers, body: JSON.stringify({ body }) },
      );
      if (!res.ok) return { ok: false, action: "none", detail: `updating comment: ${res.status}` };
      return { ok: true, action: "updated" };
    }

    const res = await fetch(`https://api.github.com/repos/${repo}/issues/${number}/comments`, {
      method: "POST",
      headers,
      body: JSON.stringify({ body }),
    });
    if (!res.ok) return { ok: false, action: "none", detail: `posting comment: ${res.status}` };
    return { ok: true, action: "created" };
  } catch (err) {
    return { ok: false, action: "none", detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * What gets posted when the check could not run.
 *
 * Silence would read as approval, which is the one outcome a reviewer must never
 * mistake for a passing signal.
 */
function unavailableComment(repo: string, number: number, reason: string): string {
  return [
    MARKER,
    "",
    `### ⚠️ Tangle could not check this pull request`,
    "",
    `${reason}.`,
    "",
    "No verdict is available, and no verdict should be inferred from the absence of one.",
    "",
    "```",
    `tangle ingest --repo ${repo}   # then re-run this workflow`,
    "```",
    "",
    dim(`_tangle · PR #${number}_`).replace(/^_|_$/g, ""),
  ].join("\n");
}

function repoFromEnvironment(): string | undefined {
  const explicit = process.env.TANGLE_REPO ?? process.env.GITHUB_REPOSITORY;
  if (explicit) return explicit;
  return undefined;
}

function numberFromEnvironment(): number | undefined {
  const direct = process.env.TANGLE_PR ?? process.env.PR_NUMBER;
  if (direct) return Number(direct);
  // `refs/pull/123/merge` is the shape Actions checks out for a pull_request event.
  const ref = process.env.GITHUB_REF ?? "";
  const m = /refs\/pull\/(\d+)\//.exec(ref);
  if (m) return Number(m[1]);
  return undefined;
}

/** CLI wrapper, so `tangle pr` is useful without the action. */
export async function runPrCommand(argv: string[]): Promise<void> {
  const opts: PrOptions = {
    ...DEFAULT_PR,
    comment: !argv.includes("--no-comment"),
    failOn: argv.includes("--fail-on"),
    dryRun: argv.includes("--dry-run"),
    quiet: argv.includes("--quiet"),
    minConfidence: numFrom(argv, "--min-confidence") ?? DEFAULT_PR.minConfidence,
    maxHops: numFrom(argv, "--max-hops") ?? DEFAULT_PR.maxHops,
    ...(strFrom(argv, "--repo") ? { repo: strFrom(argv, "--repo") } : {}),
    ...(numFrom(argv, "--pr") ? { number: numFrom(argv, "--pr") } : {}),
    ...(strFrom(argv, "--files")
      ? { files: strFrom(argv, "--files")!.split(/[,\n]/).map((s) => s.trim()).filter(Boolean) }
      : {}),
  };

  const outcome = await runPr(opts);

  if (outcome.comment) {
    process.stdout.write(`${outcome.comment}\n`);
  } else {
    log.dim(`tangle pr: ${outcome.note}`);
  }

  // Written to $GITHUB_OUTPUT so a later workflow step can gate on it.
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    try {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(outputFile, `${OUTPUT_MISSED}=${outcome.missed}\nstatus=${outcome.status}\n`, "utf8");
    } catch {
      // Not being able to write outputs must not change the exit code.
    }
  }

  if (!opts.quiet) {
    const line = outcome.status === "ok" ? green(`ok — ${outcome.note}`) : yellow(`${outcome.status} — ${outcome.note}`);
    log.plain("");
    log.plain(line);
  }

  process.exit(outcome.exitCode);
}

function strFrom(argv: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  for (const a of argv) if (a.startsWith(prefix)) return a.slice(prefix.length);
  const i = argv.indexOf(name);
  if (i !== -1 && argv[i + 1] && !argv[i + 1]!.startsWith("--")) return argv[i + 1]!;
  return undefined;
}

function numFrom(argv: string[], name: string): number | undefined {
  const raw = strFrom(argv, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}