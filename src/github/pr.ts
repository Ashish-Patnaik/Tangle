import { config } from "../config.js";
import type { ChangedFile } from "../types.js";

export interface ParsedPrRef {
  owner: string;
  repo: string;
  number: number;
  repoId: string;
}

export interface PrPayload {
  ref: ParsedPrRef;
  title: string;
  body: string;
  author: string;
  state: string;
  headSha: string;
  baseBranch: string;
  changedFiles: ChangedFile[];
  additions: number;
  deletions: number;
  htmlUrl: string;
}

/**
 * Accepts every shape a person might paste:
 *   https://github.com/vercel/next.js/pull/12345
 *   https://github.com/vercel/next.js/pull/12345/files
 *   vercel/next.js#12345
 *   vercel/next.js pull 12345
 */
export function parsePrRef(input: string): ParsedPrRef | null {
  const text = input.trim();

  const url = /(?:^|\s)(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/i.exec(text);
  if (url) {
    return { owner: url[1]!, repo: url[2]!.replace(/\.git$/, ""), number: Number(url[3]), repoId: `${url[1]}/${url[2]!.replace(/\.git$/, "")}` };
  }

  const hash = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/.exec(text);
  if (hash) {
    return { owner: hash[1]!, repo: hash[2]!, number: Number(hash[3]), repoId: `${hash[1]}/${hash[2]}` };
  }

  const words = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\s+pr\s*#?(\d+)$/i.exec(text);
  if (words) {
    return { owner: words[1]!, repo: words[2]!, number: Number(words[3]), repoId: `${words[1]}/${words[2]}` };
  }

  return null;
}

export function looksLikePr(input: string): boolean {
  return parsePrRef(input) !== null;
}

/** `owner/repo/a.ts,b.ts` or `owner/repo#a.ts,b.ts` — the offline escape hatch. */
export function parseInlineFiles(input: string): { repoId: string; files: string[] } | null {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)[#](.+)$/.exec(input.trim());
  if (!match) return null;
  const files = match[3]!
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean);
  if (files.length === 0) return null;
  return { repoId: `${match[1]}/${match[2]}`, files };
}

interface GhFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

export async function fetchPr(ref: ParsedPrRef): Promise<PrPayload> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "tangle-impact-agent",
  };
  if (config.githubToken) headers.Authorization = `Bearer ${config.githubToken}`;

  const base = `https://api.github.com/repos/${ref.owner}/${ref.repo}`;

  const prRes = await fetch(`${base}/pulls/${ref.number}`, { headers });
  if (!prRes.ok) {
    throw new Error(await githubError(prRes, ref));
  }
  const pr = (await prRes.json()) as {
    title?: string;
    body?: string | null;
    state?: string;
    additions?: number;
    deletions?: number;
    html_url?: string;
    user?: { login?: string };
    head?: { sha?: string; ref?: string };
    base?: { ref?: string };
  };

  const changedFiles: ChangedFile[] = [];
  let additions = pr.additions ?? 0;
  let deletions = pr.deletions ?? 0;

  // GitHub paginates the files endpoint at 100. PRs over 100 files are rare but
  // they do exist, and silently truncating them would be exactly the kind of
  // dishonesty this project is arguing against.
  for (let page = 1; page <= 10; page++) {
    const res = await fetch(`${base}/pulls/${ref.number}/files?per_page=100&page=${page}`, { headers });
    if (!res.ok) {
      if (page === 1) throw new Error(await githubError(res, ref));
      break;
    }
    const files = (await res.json()) as GhFile[];
    if (!Array.isArray(files) || files.length === 0) break;
    for (const f of files) {
      changedFiles.push({ path: f.filename, additions: f.additions, deletions: f.deletions, status: f.status });
      additions += f.additions;
      deletions += f.deletions;
    }
    if (files.length < 100) break;
  }

  return {
    ref,
    title: pr.title ?? "(untitled)",
    body: pr.body ?? "",
    author: pr.user?.login ?? "unknown",
    state: pr.state ?? "unknown",
    headSha: pr.head?.sha ?? "",
    baseBranch: pr.base?.ref ?? "main",
    changedFiles,
    additions,
    deletions,
    htmlUrl: pr.html_url ?? `https://github.com/${ref.repoId}/pull/${ref.number}`,
  };
}

async function githubError(res: Response, ref: ParsedPrRef): Promise<string> {
  const remaining = res.headers.get("x-ratelimit-remaining");
  if (res.status === 403 || res.status === 429) {
    const reset = res.headers.get("x-ratelimit-reset");
    const when = reset ? new Date(Number(reset) * 1000).toISOString() : "shortly";
    return `GitHub rate limit hit (${remaining ?? "0"} remaining, resets ${when}). Set GITHUB_TOKEN in .env for 5000 requests/hour.`;
  }
  let detail = "";
  try {
    const body = (await res.json()) as { message?: string };
    detail = body.message ?? "";
  } catch {
    // Some errors have no JSON body.
  }
  if (res.status === 404) {
    return `PR ${ref.owner}/${ref.repo}#${ref.number} not found, or it is private. Tangle only reads public repositories.`;
  }
  return `GitHub returned ${res.status} for ${ref.repoId}#${ref.number}. ${detail}`;
}

/** Truncate a PR description for display without pretending it is short. */
export function summariseBody(body: string, max = 600): string {
  const trimmed = body.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max).trimEnd()}\n…[${trimmed.length - max} more characters]`;
}