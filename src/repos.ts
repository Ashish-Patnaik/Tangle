import type { RepoRef } from "./types.js";

/**
 * The demo dataset. `primary` is what the video and the front page point at.
 * `secondary` exists to prove nothing here is hardcoded: one flag, second graph.
 */
export const REPOS: Record<string, RepoRef & { label: string; primary: boolean; blurb: string }> = {
  "vercel/next.js": {
    id: "vercel/next.js",
    owner: "vercel",
    name: "next.js",
    label: "Next.js",
    primary: true,
    blurb: "The most-read React framework on earth. Dense TS-native history, brutal config coupling.",
  },
  "microsoft/vscode": {
    id: "microsoft/vscode",
    owner: "microsoft",
    name: "vscode",
    label: "VS Code",
    primary: false,
    blurb: "An Electron monorepo with its own build system. Nothing like Next.js, same code.",
  },
  "vitejs/vite": {
    id: "vitejs/vite",
    owner: "vitejs",
    name: "vite",
    label: "Vite",
    primary: false,
    blurb: "Small, fast, high-churn. A good sanity check that coupling is not a Next.js artifact.",
  },
};

export const DEFAULT_REPO = "vercel/next.js";

export function resolveRepo(input?: string): RepoRef {
  const id = (input ?? DEFAULT_REPO).replace(/\.git$/, "").replace(/^https?:\/\/github\.com\//, "").replace(/\/$/, "");
  const hit = REPOS[id];
  if (hit) return hit;
  const [owner, name] = id.split("/");
  if (!owner || !name) throw new Error(`Not a repo: ${input ?? id}. Expected owner/name.`);
  return { id, owner, name };
}

export const isPrimary = (id: string): boolean => REPOS[id]?.primary ?? false;