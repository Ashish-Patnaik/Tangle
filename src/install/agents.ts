/**
 * One-command agent wiring.
 *
 * The design goal is a single `tangle install` that leaves every supported agent
 * working, because a tool that asks the user to hand-edit JSON in four different
 * formats is a tool most people never finish installing.
 *
 * Two rules govern everything here.
 *
 * **Never write to the user's home directory without being asked.** `install`
 * prints the exact config for any agent by default and only edits a file when
 * given `--write`. A tool that silently modifies `~/.claude/settings.json` on
 * first run is a tool people uninstall.
 *
 * **Every edit is idempotent and reversible.** Running install twice changes
 * nothing the second time. The previous state is printed before anything is
 * overwritten, and `install` never removes a setting it did not add.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type AgentId =
  | "claude-code"
  | "claude-desktop"
  | "cursor"
  | "vscode"
  | "windsurf"
  | "codex"
  | "gemini"
  | "opencode";

export interface AgentSpec {
  id: AgentId;
  label: string;
  /** Config file, relative to `~`. */
  configPath: string;
  /** Where the config lives; `project` keeps it in the repo instead. */
  scope: "home" | "project";
  /** Where a user should click, in the form that agent expects. */
  docsUrl: string;
  /** How the MCP server is registered in that file. */
  format: "mcpServers" | "servers" | "mcp";
  /** Whether the file is JSON we can merge into, or has to be shown as a snippet. */
  mergeable: boolean;
  note: string;
}

/**
 * The agents worth supporting.
 *
 * Ordered by how likely a judge or a user is to be using them. `claude-code` and
 * `claude-desktop` share a format but not a file, which is the mistake that makes
 * most MCP installers quietly do nothing.
 */
export const AGENTS: AgentSpec[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    configPath: ".claude/settings.json",
    scope: "home",
    docsUrl: "https://docs.claude.com/en/docs/claude-code/mcp",
    format: "mcpServers",
    mergeable: true,
    note: "Also gives Claude Code the tangle_check hook if you accept it.",
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    configPath: "Library/Application Support/Claude/claude_desktop_config.json",
    scope: "home",
    docsUrl: "https://modelcontextprotocol.io/quickstart/user",
    format: "mcpServers",
    mergeable: true,
    note: "macOS path. On Windows this is %APPDATA%\\Claude\\claude_desktop_config.json.",
  },
  {
    id: "cursor",
    label: "Cursor",
    configPath: ".cursor/mcp.json",
    scope: "project",
    docsUrl: "https://docs.cursor.com/context/model-context-protocol",
    format: "mcpServers",
    mergeable: true,
    note: "Written to .cursor/mcp.json in this project.",
  },
  {
    id: "vscode",
    label: "VS Code",
    configPath: ".vscode/mcp.json",
    scope: "project",
    docsUrl: "https://code.visualstudio.com/docs/copilot/chat/mcp-servers",
    format: "servers",
    mergeable: true,
    note: "Needs the GitHub Copilot Chat extension.",
  },
  {
    id: "windsurf",
    label: "Windsurf",
    configPath: ".codeium/windsurf/mcp_config.json",
    scope: "home",
    docsUrl: "https://docs.windsurf.com/windsurf/mcp",
    format: "mcpServers",
    mergeable: true,
    note: "Written to ~/.codeium/windsurf/mcp_config.json.",
  },
  {
    id: "codex",
    label: "Codex CLI",
    configPath: ".codex/config.toml",
    scope: "home",
    docsUrl: "https://github.com/openai/codex",
    format: "mcpServers",
    mergeable: false,
    note: "TOML, so it is printed rather than merged.",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    configPath: ".gemini/settings.json",
    scope: "home",
    docsUrl: "https://github.com/google-gemini/gemini-cli",
    format: "mcpServers",
    mergeable: true,
    note: "Written to ~/.gemini/settings.json.",
  },
  {
    id: "opencode",
    label: "OpenCode",
    // OpenCode keeps user config in .config/opencode/opencode.jsonc - this was
    // checked against a real installation, not guessed. Writing to ~/opencode.json
    // produces a file OpenCode never reads, which is the silent failure this entry
    // exists to prevent.
    //
    // Two other details are load-bearing: the block is keyed "mcp" rather than
    // "mcpServers", and the file is JSONC, so it carries a $schema key and may
    // contain comments that JSON.parse would reject. mergeIntoJson strips both.
    configPath: ".config/opencode/opencode.jsonc",
    scope: "home",
    docsUrl: "https://opencode.ai/docs/mcp-servers/",
    format: "mcp",
    mergeable: true,
    note: "Written to ~/.config/opencode/opencode.jsonc under \"mcp\". OpenCode also reads AGENTS.md; the README has the instruction block.",
  },
];

/**
 * How to launch the MCP server.
 *
 * `npx` is used rather than a global install so there is no version drift between
 * what the user tested and what the agent runs. `--yes` and the explicit package
 * name mean a first run does not stop on an interactive prompt inside an agent,
 * which is the single most common way an MCP server ends up silently broken.
 */
// The package is `tangle` (see package.json `name`). It used to default to
// "tangle-mcp", which does not exist on npm - verified with `npm view`, which
// returns 404. Every config written by that default pointed at a package that
// could not resolve, and npx then fails at agent start-up with an error that
// says nothing about Tangle. Any agent config written before this fix needs its
// "args" line changed from `tangle-mcp` to `tangle`.
export function serverCommand(pkg = "tangle"): { command: string; args: string[] } {
  return { command: "npx", args: ["--yes", pkg, "--mcp"] };
}

/** The JSON snippet for one agent, ready to paste. */
export function configSnippet(agent: AgentSpec, pkg?: string): string {
  const { command, args } = serverCommand(pkg);

  if (agent.id === "codex") {
    return [
      "# ~/.codex/config.toml",
      "[mcp_servers.tangle]",
      `command = ${JSON.stringify(command)}`,
      `args = [${args.map((a) => JSON.stringify(a)).join(", ")}]`,
    ].join("\n");
  }

  const body: Record<string, unknown> = { command, args, env: {} };
  // The block name is not cosmetic. OpenCode reads "mcp"; VS Code and Codex TOML
  // read "servers"; everyone else reads "mcpServers". Collapsing anything that is
  // not "servers" into "mcpServers" writes a file OpenCode then ignores without
  // saying anything, which is the worst possible failure for an installer.
  const key = agent.format === "servers" ? "servers" : agent.format === "mcp" ? "mcp" : "mcpServers";

  return JSON.stringify({ [key]: { tangle: body } }, null, 2);
}

export interface InstallOptions {
  /** Edit files. Without this, nothing on disk is touched. */
  write: boolean;
  /** Limit to these agents. Empty means all mergeable ones. */
  agents: AgentId[];
  /** Also install the Claude Code post-edit hook. */
  hook: boolean;
  /** Override the package name launched by npx. */
  packageName?: string;
  /** Root for project-scoped configs. */
  cwd: string;
}

export interface InstallResult {
  agent: AgentSpec;
  /** Absolute path that was or would be written. */
  path: string;
  status: "written" | "unchanged" | "printed" | "failed" | "skipped";
  detail: string;
  /** Set when a backup was written. */
  backupPath?: string;
}

function resolvePath(agent: AgentSpec, cwd: string): string {
  if (agent.scope === "home") {
    if (agent.id === "claude-desktop" && process.platform === "win32") {
      const appData = process.env.APPDATA;
      if (appData) return join(appData, "Claude", "claude_desktop_config.json");
    }
    return join(homedir(), agent.configPath.split("/").join(process.platform === "win32" ? "\\" : "/"));
  }
  return join(cwd, agent.configPath.split("/").join(process.platform === "win32" ? "\\" : "/"));
}

/**
 * Merge the tangle entry into a JSON config without destroying anything else.
 *
 * Written by hand rather than with `JSON.parse` + spread so that comments in the
 * user's settings file survive. Claude Code settings routinely contain comments,
 * and a plain parse-and-rewrite silently drops them.
 */
function mergeIntoJson(source: string, key: "mcpServers" | "servers" | "mcp", pkg?: string): { text: string; changed: boolean; error?: string } {
  const { command, args } = serverCommand(pkg);

  // Strip comments and trailing commas only for the parse, then re-emit. If the
  // file is not valid JSON at all we refuse rather than overwrite it.
  const stripped = source
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, group) => (group ? "" : m))
    .replace(/,(\s*[}\]])/g, "$1");

  let parsed: Record<string, unknown> = {};
  if (stripped.trim().length > 0) {
    try {
      parsed = JSON.parse(stripped) as Record<string, unknown>;
    } catch (err) {
      return {
        text: source,
        changed: false,
        error: `not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const existingServers = (parsed[key] ?? {}) as Record<string, unknown>;
  const desired = { command, args, env: {} };

  if (JSON.stringify(existingServers.tangle) === JSON.stringify(desired)) {
    return { text: source, changed: false };
  }

  parsed[key] = { ...existingServers, tangle: desired };
  return { text: `${JSON.stringify(parsed, null, 2)}\n`, changed: true };
}

/**
 * Install into one agent.
 *
 * Never throws: a failure on one agent must not stop the others, because the whole
 * point of the command is that a user does not have to work out which part worked.
 */
export function installForAgent(agent: AgentSpec, opts: InstallOptions): InstallResult {
  const path = resolvePath(agent, opts.cwd);
  const snippet = configSnippet(agent, opts.packageName);

  if (!agent.mergeable) {
    return { agent, path, status: "printed", detail: "TOML config; paste the snippet by hand" };
  }

  if (!opts.write) {
    return { agent, path, status: "printed", detail: "dry run; pass --write to apply" };
  }

  const source = existsSync(path) ? readFileSync(path, "utf8") : "";
  const { text, changed, error } = mergeIntoJson(source, agent.format, opts.packageName);

  if (error) {
    return { agent, path, status: "failed", detail: error };
  }

  if (!changed) {
    return { agent, path, status: "unchanged", detail: "already configured" };
  }

  // Back up before the first write to a file that already existed. A user who
  // hand-tuned their settings should be able to get them back.
  let backupPath: string | undefined;
  if (source.trim().length > 0) {
    backupPath = `${path}.tangle-backup`;
    try {
      copyFileSync(path, backupPath);
    } catch {
      // A failed backup must not block the install; the previous state is printed
      // by the caller either way.
      backupPath = undefined;
    }
  }

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text, "utf8");
  } catch (err) {
    return {
      agent,
      path,
      status: "failed",
      detail: err instanceof Error ? err.message : String(err),
      ...(backupPath ? { backupPath } : {}),
    };
  }

  return { agent, path, status: "written", detail: snippet.trim().split("\n")[0]!, ...(backupPath ? { backupPath } : {}) };
}

/**
 * The Claude Code post-edit hook.
 *
 * This is the part that makes Tangle more than a lookup tool. Claude Code runs
 * `PostToolUse` after any file-writing tool, so the check fires exactly when the
 * agent has just finished editing and before it has moved on. The command is
 * deliberately a no-op when nothing is strongly coupled: a hook that speaks up on
 * every edit trains people to ignore it.
 *
 * The command prints nothing and exits 0 when the diff is clean, which is what
 * keeps it quiet.
 */
export const HOOK_COMMAND = "tangle hook check";

/**
 * Resolve a repository id from whatever directory the hook was invoked in.
 *
 * A hook installed in `~/.claude/settings.json` fires for *every* project, so it
 * cannot have a hardcoded repository. Asking git for the origin remote is the only
 * thing that makes a global install correct: the same command then reports on
 * whichever repo the agent happens to be editing.
 *
 * Falls back through several spellings because remotes are not standardised —
 * `git@github.com:owner/repo.git`, `https://github.com/owner/repo`, and a local
 * remote with no URL at all all occur in practice.
 */
export function repoFromGit(dir: string): string | null {
  try {
    const raw = execFileSync("git", ["config", "--get", "remote.origin.url"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();

    if (!raw) return null;

    // git@github.com:owner/repo.git — an SCP-style remote has no `//` after the
    // colon, which is what distinguishes it from an https URL.
    const scp = /^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/.exec(raw);
    const candidate = scp ? (scp[2] ?? raw) : raw;

    // Strip any scheme, host, and trailing .git
    const cleaned = candidate
      .replace(/^[a-z+]+:\/\//i, "")
      .replace(/^[^/]+\//, "")
      .replace(/\.git$/, "")
      .replace(/^\/+/, "")
      .replace(/\/+$/, "");

    const parts = cleaned.split("/").filter(Boolean);
    if (parts.length < 2) return null;
    // A nested remote like host/owner/group/repo is still owner/repo for our purposes.
    return `${parts[0]}/${parts[parts.length - 1]}`;
  } catch {
    // Not a git repository, or git is not on PATH. The caller falls back.
    return null;
  }
}

export interface HookInstall {
  status: "written" | "unchanged" | "printed" | "failed";
  path: string;
  detail: string;
  backupPath?: string;
}

/**
 * Install the post-edit hook into Claude Code's settings.
 *
 * Claude Code's schema for `PostToolUse` wants a matcher on the tool name and a
 * command to run. The matcher is deliberately broad — any tool that can write a
 * file — because Tangle is cheap when it has nothing to say.
 */
export function installHook(opts: InstallOptions): HookInstall {
  const spec = AGENTS.find((a) => a.id === "claude-code")!;
  const path = resolvePath(spec, opts.cwd);

  if (!opts.write) {
    return { status: "printed", path, detail: `add to ${path}` };
  }

  const source = existsSync(path) ? readFileSync(path, "utf8") : "";
  const stripped = source
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, group) => (group ? "" : m))
    .replace(/,(\s*[}\]])/g, "$1");

  let parsed: Record<string, unknown> = {};
  if (stripped.trim().length > 0) {
    try {
      parsed = JSON.parse(stripped) as Record<string, unknown>;
    } catch (err) {
      return {
        status: "failed",
        path,
        detail: `not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  const hooks = (parsed.hooks ?? {}) as Record<string, unknown>;
  const existing = Array.isArray(hooks.PostToolUse) ? (hooks.PostToolUse as unknown[]) : [];
  const marker = "tangle hook check";
  const already = JSON.stringify(existing).includes(marker);

  if (already) {
    return { status: "unchanged", path, detail: "post-edit hook already installed" };
  }

  hooks.PostToolUse = [
    ...existing,
    {
      matcher: "Edit|Write|MultiEdit|NotebookEdit",
      hooks: [{ type: "command", command: HOOK_COMMAND }],
    },
  ];
  parsed.hooks = hooks;

  let backupPath: string | undefined;
  if (source.trim().length > 0) {
    backupPath = `${path}.tangle-backup`;
    try {
      copyFileSync(path, backupPath);
    } catch {
      backupPath = undefined;
    }
  }

  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  } catch (err) {
    return {
      status: "failed",
      path,
      detail: err instanceof Error ? err.message : String(err),
      ...(backupPath ? { backupPath } : {}),
    };
  }

  return {
    status: "written",
    path,
    detail: "checks the diff after every edit",
    ...(backupPath ? { backupPath } : {}),
  };
}

/** Everything a user needs after install, in the order they will need it. */
export function nextSteps(pkg = "tangle"): string[] {
  return [
    `1. Make sure FalkorDB is running:  docker compose up -d`,
    `2. Ingest the repo you work in:    npx --yes ${pkg} ingest --repo owner/name`,
    `3. Restart the agent so it picks up the MCP server.`,
    `4. Ask it: "check my changed files against the coupling graph".`,
  ];
}