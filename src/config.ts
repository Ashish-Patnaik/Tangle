import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** Minimal .env loader. Never throws, never overwrites a real env var. */
export function loadEnv(): void {
  const envPath = resolve(ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const raw of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export const config = {
  root: ROOT,

  /**
   * Where clones and graphs live.
   *
   * Defaults to `<repo>/data`, which is right for a checkout and ignored by git.
   * `TANGLE_DATA_DIR` overrides it, which is what the GitHub Action needs: the
   * action runs Tangle from its own directory but wants the cached history clone
   * to land in the workspace so `actions/cache` can find it and restore it across
   * runs. Without this the cache silently never hits and every pull request pays
   * the full ingest.
   */
  get dataDir(): string {
    return process.env.TANGLE_DATA_DIR
      ? resolve(process.env.TANGLE_DATA_DIR)
      : resolve(ROOT, "data");
  },

  get reposDir(): string {
    return join(this.dataDir, "repos");
  },

  get sourcesDir(): string {
    return join(this.dataDir, "sources");
  },

  get falkordb() {
    return {
      host: process.env.FALKORDB_HOST ?? "127.0.0.1",
      port: Number(process.env.FALKORDB_PORT ?? 6379),
      password: process.env.FALKORDB_PASSWORD || undefined,
    };
  },
  get githubToken(): string | undefined {
    return process.env.GITHUB_TOKEN || undefined;
  },
  get openaiKey(): string | undefined {
    return process.env.OPENAI_API_KEY || undefined;
  },
  get anthropicKey(): string | undefined {
    return process.env.ANTHROPIC_API_KEY || undefined;
  },
  get model(): string {
    return process.env.TANGLE_MODEL ?? "gpt-4o-mini";
  },
  get port(): number {
    return Number(process.env.PORT ?? 8787);
  },
};

/**
 * FalkorDB speaks the Redis protocol. Graph keys are namespaced so several
 * repos and several isolated agent memories can share one instance.
 */
export const graphKey = (repo: string, graph = "main"): string =>
  `tangle:${repo.replace("/", "~")}:${graph}`;

export const shortId = (bytes = 6): string => randomBytes(bytes).toString("hex");