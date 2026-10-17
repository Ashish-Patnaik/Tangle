/**
 * `tangle install` — the one command.
 *
 * Prints every supported agent's configuration by default and edits nothing.
 * `--write` applies it. The split is deliberate: a tool that rewrites a user's
 * editor settings on first run is a tool people uninstall, and the people most
 * likely to be reading this are the ones with the most to lose in those files.
 */

import {
  AGENTS,
  configSnippet,
  installForAgent,
  installHook,
  nextSteps,
  type AgentId,
  type InstallOptions,
} from "./agents.js";
import { bold, cyan, dim, green, log, yellow } from "../util/log.js";

export async function runInstallCommand(argv: string[]): Promise<void> {
  const write = argv.includes("--write") || argv.includes("-w");
  const hook = argv.includes("--hook") || argv.includes("--hooks");
  const verbose = argv.includes("--verbose");
  const pkg = argValue(argv, "--package");

  const requested = argv
    .filter((a) => a.startsWith("--agent="))
    .flatMap((a) => a.slice("--agent=".length).split(","))
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean) as AgentId[];

  const unknown = requested.filter((id) => !AGENTS.some((a) => a.id === id));
  if (unknown.length > 0) {
    log.err(`Unknown agent(s): ${unknown.join(", ")}`);
    log.plain(`  Known: ${AGENTS.map((a) => a.id).join(", ")}`);
    process.exit(2);
  }

  const targets = requested.length > 0 ? AGENTS.filter((a) => requested.includes(a.id)) : AGENTS;

  const opts: InstallOptions = {
    write,
    agents: requested,
    hook,
    cwd: argValue(argv, "--cwd") ?? process.cwd(),
    ...(pkg ? { packageName: pkg } : {}),
  };

  log.plain("");
  log.plain(bold(cyan("Tangle install")));
  log.plain(
    dim(
      write
        ? "  Applying configuration. Existing settings are preserved; backups are written alongside."
        : "  Dry run. Nothing has been written. Re-run with --write to apply.",
    ),
  );
  log.plain("");

  const results = targets.map((agent) => installForAgent(agent, opts));

  for (const result of results) {
    const badge =
      result.status === "written"
        ? green("written")
        : result.status === "unchanged"
          ? dim("unchanged")
          : result.status === "failed"
            ? yellow("FAILED")
            : dim(result.status);

    log.plain(`  ${badge.padEnd(10)} ${result.agent.label}`);
    log.plain(dim(`             ${result.path}`));
    if (result.status === "failed") log.plain(yellow(`             ${result.detail}`));
    if (result.backupPath) log.plain(dim(`             previous version at ${result.backupPath}`));
    if (!result.agent.mergeable) {
      log.plain(dim(`             ${result.agent.note}`));
      for (const line of snippetFor(result.agent.id, pkg)) log.plain(dim(`             ${line}`));
    } else if (!write || result.status === "unchanged") {
      log.plain(dim(`             ${result.agent.note}`));
    }
    log.plain("");
  }

  if (hook) {
    // The hook test must never touch the real `~/.claude/settings.json`. A test
    // that silently edits the developer's own agent configuration is a test that
    // will, eventually, break their setup.
    const isolated = process.env.TANGLE_INSTALL_TEST_HOME;
    if (isolated) {
      log.plain(dim("  Skipping the post-edit hook: TANGLE_INSTALL_TEST_HOME is set (isolated test run)."));
      log.plain("");
    } else {
      const installed = installHook(opts);
      const badge =
        installed.status === "written"
          ? green("written")
          : installed.status === "failed"
            ? yellow("FAILED")
            : dim(installed.status);
      log.plain(`  ${badge.padEnd(10)} post-edit hook (Claude Code)`);
      log.plain(dim(`             ${installed.path}`));
      log.plain(dim(`             ${installed.detail}`));
      if (installed.backupPath) log.plain(dim(`             previous version at ${installed.backupPath}`));
      log.plain("");
    }
  } else {
    log.plain(dim("  Optional: --hook also runs the check after every edit, so an agent catches"));
    log.plain(dim("  a missing file itself instead of only when you remember to ask."));
    log.plain("");
  }

  const failed = results.filter((r) => r.status === "failed");
  log.plain(bold("Next:"));
  for (const step of nextSteps(pkg)) log.plain(`  ${dim(step)}`);
  log.plain("");
  log.plain(dim(`  docs: ${AGENTS.map((a) => `${a.label} ${a.docsUrl}`).join("\n        ")}`));
  log.plain("");

  if (failed.length > 0) process.exitCode = 1;
  void verbose;
}

function snippetFor(agent: string, pkg?: string): string[] {
  const spec = AGENTS.find((a) => a.id === agent);
  if (!spec) return [];
  return configSnippet(spec, pkg).split("\n");
}

function argValue(argv: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  for (const arg of argv) if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  const bare = argv.indexOf(name);
  if (bare !== -1 && argv[bare + 1] && !argv[bare + 1]!.startsWith("--")) return argv[bare + 1]!;
  return undefined;
}