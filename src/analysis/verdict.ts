/**
 * The agent-facing verdict.
 *
 * The lesson this file encodes, learned the hard way from tools that ship twenty
 * MCP functions: an agent choosing between twenty options does not choose well, and
 * a twenty-line JSON blob is worse than a paragraph it can act on. So the primary
 * tool is a single `tangle_check` that answers one question in a few sentences:
 *
 *   "You changed these files. Is anything coupled to them missing from the diff?"
 *
 * The answer is short by construction. It states the verdict, names at most a few
 * files, says why each one is coupled, and stops. The full graph, the certificate
 * and the reviewer's reasoning stay behind `tangle_analyze`, which a human opens
 * and an agent asks for when the short answer says to go deeper.
 */

import type { AnalysisResult, CouplingWhy, MissedFile } from "../types.js";

/** Files named in the short verdict. Beyond this it stops being a verdict. */
export const VERDICT_LIMIT = 3;

export type VerdictLevel = "clean" | "caution" | "blocked";

export interface Verdict {
  /** One of: clean, caution, blocked. */
  level: VerdictLevel;
  /** Single sentence. This is what an agent reads first. */
  headline: string;
  /** The specific files, each with the reason it is coupled. */
  findings: { path: string; why: string }[];
  /** Total missed files, which can exceed `findings.length`. */
  missedCount: number;
  /** One line on what Tangle could not check. Never null. */
  caveat: string;
  /** The full prose form, for an MCP text response or a CI comment. */
  text: string;
  /** How the verdict was reached, for anyone who wants to check it. */
  basis: {
    seeds: number;
    affected: number;
    minConfidence: number;
    maxHops: number;
    graphHead: string | null;
  };
}

const LEVEL_WORDS: Record<VerdictLevel, string> = {
  clean: "looks complete",
  caution: "may be missing files",
  blocked: "very likely incomplete",
};

/**
 * Turn an analysis into a short verdict.
 *
 * The threshold for "blocked" is deliberately not a count of missed files. Three
 * missed files in a two-file diff means the change is misunderstood, and the
 * agent should stop and re-read; the same three in a forty-file diff is routine
 * and should not stop anything. The ratio is the signal, not the tally.
 */
export function buildVerdict(result: AnalysisResult, opts: { limit?: number } = {}): Verdict {
  const limit = opts.limit ?? VERDICT_LIMIT;
  const seeds = result.query.changedFiles.length;
  const missed = result.missed;

  const level: VerdictLevel = decideLevel(missed.length, seeds);

  // Rank by co-change count so the strongest coupling is named first, and keep
  // only the ones whose provenance is actually known. A missed file with no
  // recorded reason is still worth naming, but it is reported as "coupled N times"
  // rather than dressed up with a subject line.
  const ranked = [...missed].sort((a, b) => b.coChanges - a.coChanges || b.confidence - a.confidence);
  const findings = ranked.slice(0, limit).map((f) => ({ path: f.path, why: describeMissed(f) }));

  const more = missed.length - findings.length;
  const headline =
    missed.length === 0
      ? `${seeds} file(s) changed; nothing strongly coupled to them is missing.`
      : `${missed.length} file(s) strongly coupled to this change ${missed.length === 1 ? "is" : "are"} not in it — ${LEVEL_WORDS[level]}.`;

  const lines: string[] = [];
  lines.push(`**${headline}**`);
  lines.push("");

  if (findings.length > 0) {
    lines.push("Most likely forgotten:");
    for (const f of findings) lines.push(`- \`${f.path}\` — ${f.why}`);
    if (more > 0) lines.push(`- … and ${more} more.`);
  } else if (missed.length > 0) {
    // Unreachable in practice, but a verdict that contradicts its own numbers
    // is worse than no verdict, so the branch exists.
    lines.push(`${missed.length} file(s) met the coupling threshold but none could be named.`);
  } else {
    lines.push(
      "No file in the graph is coupled strongly enough to your change to be required in it. " +
        "This is a bounded claim, not a proof of correctness — see the line below.",
    );
  }

  const caveat = buildCaveat(result, seeds);
  lines.push("");
  lines.push(caveat);

  if (result.degraded.length > 0) {
    lines.push("");
    lines.push(`Degraded: ${result.degraded.join("; ")}`);
  }

  return {
    level,
    headline,
    findings,
    missedCount: missed.length,
    caveat,
    text: lines.join("\n"),
    basis: {
      seeds,
      affected: result.blastRadius.length,
      minConfidence: Number(result.certificate.parameters.minConfidence),
      maxHops: Number(result.certificate.parameters.maxHops),
      graphHead: null,
    },
  };
}

/**
 * How strong the warning should be.
 *
 * Ratio-based rather than count-based, because a count has no meaning across
 * diff sizes: three missed files in a two-file change means the change is
 * misunderstood, and the same three in a forty-file change is unremarkable.
 *
 * Every level says something was or was not found. The clean verdict never says
 * "your change is correct", because the back-test measured that reading as wrong in
 * 61% of the empty-list cases on vercel/next.js — coupled files that fell below
 * the floor and were never warned about at all.
 */
function decideLevel(missed: number, seeds: number): VerdictLevel {
  if (missed === 0) return "clean";
  if (seeds > 0 && missed / seeds >= 0.5) return "blocked";
  if (missed >= 5) return "blocked";
  return "caution";
}

function describeMissed(file: MissedFile): string {
  const times = `changed together ${file.coChanges}×`;
  const why = shortWhy(file.why);
  return why ? `${times}, and ${why}` : times;
}

/**
 * One clause about why a file is coupled.
 *
 * Prefers a ticket because "issue #19914 — a cache-control regression" tells the
 * agent what class of change this is, while "tied by a commit message" does not.
 */
function shortWhy(why: CouplingWhy | null | undefined): string | null {
  if (!why) return null;
  if (why.ticket) {
    const label = why.ticket.split("#")[1] ? `issue or PR #${why.ticket.split("#")[1]}` : why.ticket;
    if (why.title) return `${why.title} (#${label.split("#")[1]})`;
    return `tied by ${label}`;
  }
  if (why.subject) return `recurring commit "${truncate(why.subject, 60)}"`;
  return null;
}

/**
 * What the short answer could not cover.
 *
 * This is the sentence that keeps the verdict honest. A tool that says "you forgot
 * nothing" while having inspected 0.01% of the graph is lying by omission, and this
 * is the cheapest place to stop it.
 */
/**
 * The bounds of the search, stated in the answer rather than on request.
 *
 * Always returns a sentence. A clean verdict with no caveat is the one output
 * that cannot be trusted, because "nothing found" and "nothing found within these
 * limits" are different claims and only the second one is true. The measured
 * numbers behind this wording are in `npm run backtest`: on vercel/next.js, 116 of
 * 190 empty-list cases were coupled below the floor and never warned about.
 */
function buildCaveat(result: AnalysisResult, seeds: number): string {
  const c = result.certificate;

  if (seeds === 0) {
    return "Nothing was checked: no changed file resolved against the graph. Check the paths.";
  }

  const notes: string[] = [];
  if (c.search.truncated) notes.push(`the result was truncated (${c.search.truncationReason ?? "cap reached"})`);
  if (c.search.excludedByConfidence > 0) {
    notes.push(
      `${c.search.excludedByConfidence.toLocaleString("en-US")} coupling edge(s) were rejected below confidence ${c.parameters.minConfidence}`,
    );
  }

  const basis =
    `confidence ≥ ${c.parameters.minConfidence}, ${c.parameters.maxHops} hop(s), ` +
    `${c.search.edgesScanned.toLocaleString("en-US")} of ${c.search.couplingEdgesTotal.toLocaleString("en-US")} coupling edges inspected`;

  if (notes.length > 0) {
    return `_Not a proof: ${basis}, and ${notes.join("; ")}._`;
  }
  return `_Bounded claim: ${basis}. Absence of a coupling here is not proof of independence._`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/** The `tangle check` CLI output: the same verdict, with the repository named. */
export function renderVerdict(verdict: Verdict, repo: string): string {
  const out: string[] = [];
  out.push("");
  out.push(`Tangle · ${repo}`);
  out.push("");
  out.push(verdict.text);
  out.push("");
  return out.join("\n");
}
