import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, statSync } from "node:fs";

const exec = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
  ms: number;
}

/** git log on a mature repo is large. Give it room and never truncate silently. */
const BIG = 10 * 1024 * 1024;

/**
 * Reading the file lists of a very large monorepo's full history produces far
 * more than 10 MB: vercel/next.js at ~36k commits is roughly 90 MB of paths. A
 * silently exceeded buffer surfaces as an opaque ENOBUFS, so callers that expect
 * a full-history walk raise it deliberately.
 */
const HUGE = 512 * 1024 * 1024;

export async function git(args: string[], cwd: string, timeoutMs = 900_000, maxBuffer = BIG): Promise<GitResult> {
  const started = process.hrtime.bigint();
  const { stdout, stderr } = await exec("git", args, {
    cwd,
    maxBuffer,
    timeout: timeoutMs,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_LFS_SKIP_SMUDGE: "1",
      // A promisor clone accumulates loose objects as blobs are fetched, which
      // makes git repack continuously. That was a large part of an eight-hour
      // ingest. Tangle never benefits from the automatic repack.
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "gc.auto",
      GIT_CONFIG_VALUE_0: "0",
      GIT_PAGER: "cat",
    },
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  return { stdout, stderr, ms };
}

export async function isGitDir(dir: string): Promise<boolean> {
  try {
    await git(["rev-parse", "--git-dir"], dir, 20_000);
    return true;
  } catch {
    return false;
  }
}

export const hasCommand = async (cmd: string): Promise<boolean> => {
  try {
    await exec(cmd, ["--version"], { timeout: 10_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
};

/** Bytes currently held by a directory, for disk-guard reporting. */
export function dirBytes(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = `${current}/${entry.name}`;
      try {
        if (entry.isDirectory()) stack.push(full);
        else total += statSync(full).size;
      } catch {
        // Ignore anything that disappears mid-walk.
      }
    }
  }
  return total;
}