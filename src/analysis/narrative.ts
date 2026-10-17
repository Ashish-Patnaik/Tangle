import type {
  AnalysisResult,
  Certificate,
  CouplingWhy,
  DiscoveryPair,
  TicketInsight,
} from "../types.js";
import type { StructureReport } from "./structure.js";
import type { BacktestReport, MethodScore } from "./backtest.js";
import { bold, cyan, dim, green, red, yellow } from "../util/log.js";

const pct = (n: number) => `${Math.round(n * 100)}%`;
const file = (path: string) => path;

/** Terminal report. The structure is deliberate: verdict, evidence, then proof. */
export function renderAnalysis(result: AnalysisResult, options: { verbose?: boolean; colour?: boolean } = {}): string {
  const paint = options.colour === false ? (s: string) => s : (s: string) => s;
  void paint;
  const out: string[] = [];

  out.push("");
  out.push(bold(cyan(`Tangle · change impact for ${result.repo}`)));
  out.push(dim(`  ${result.query.changedFiles.length} file(s) in the change`));
  out.push("");

  // ---- verdict ----
  const missedCount = result.missed.length;
  if (missedCount > 0) {
    out.push(bold(yellow(`⚠  ${missedCount} file(s) strongly coupled to your change are not in it`)));
  } else {
    out.push(bold(green("✓  no strongly-coupled file appears to be missing from this change")));
  }

  if (result.blastRadius.length > 0) {
    out.push("");
    out.push(bold("Blast radius"));
    out.push(dim("  confidence = weakest hop on the path, so a long weak chain never overstates itself"));
    for (const f of result.blastRadius.slice(0, 15)) {
      const marker = f.inDiff ? "·" : " ";
      const conf = pct(f.confidence).padStart(4);
      const hops = `h${f.hops}`;
      const line = `  ${marker} ${conf}  ${hops}  ${file(f.path)}`;
      out.push(f.inDiff ? dim(line) : line);
      if (options.verbose) {
        out.push(dim(`        changed together ${f.coChanges}× · evidence ${f.evidence.slice(0, 2).join(", ") || "n/a"}`));
      }
    }
    if (result.blastRadius.length > 15) {
      out.push(dim(`  … and ${result.blastRadius.length - 15} more`));
    }
  }

  // ---- what you forgot ----
  if (result.missed.length > 0) {
    out.push("");
    out.push(bold(yellow("Files you probably forgot")));
    for (const m of result.missed) {
      out.push(`  ${yellow("→")} ${file(m.path)}`);
      out.push(dim(`     ${m.rationale}`));
      if (m.evidence.length > 0) out.push(dim(`     commits: ${m.evidence.join(" ")}`));
      // The provenance is rendered separately so the ticket link stands out from
      // the mechanical evidence above it.
      for (const line of renderWhy(m.why, "     ")) out.push(line);
    }
  }

  // ---- reviewers ----
  if (result.reviewers.length > 0) {
    out.push("");
    out.push(bold("Who should review this"));
    for (const r of result.reviewers) {
      out.push(`  @${r.login.padEnd(22)} affinity ${pct(r.affinity).padStart(4)}   ${r.commits} commit(s) in range`);
      if (options.verbose) out.push(dim(`     owns ${r.files.slice(0, 4).join(", ")}`));
    }
  }

  // ---- proof ----
  out.push("");
  out.push(bold(cyan("Proof of absence")));
  out.push(wrap(result.certificate.statement, 78, "  "));
  out.push("");
  const c = result.certificate;
  out.push(dim(`  searched          ${c.search.filesReached.toLocaleString("en-US")} of ${c.search.repoFilesTotal.toLocaleString("en-US")} files (${c.coverage.filesConsideredPct}%)`));
  out.push(dim(`  edges inspected   ${c.search.edgesScanned.toLocaleString("en-US")} of ${c.search.couplingEdgesTotal.toLocaleString("en-US")} coupling edges (${c.coverage.edgesConsideredPct}%)`));
  out.push(dim(`  rejected as weak  ${c.search.excludedByConfidence.toLocaleString("en-US")}`));
  out.push(dim(`  confidence floor  ${c.parameters.minConfidence}   hop budget ${c.parameters.maxHops}`));
  if (c.search.truncated) {
    out.push(red(`  TRUNCATED         ${c.search.truncationReason}`));
  }

  if (result.degraded.length > 0) {
    out.push("");
    out.push(bold(yellow("Degraded")));
    for (const d of result.degraded) out.push(dim(`  · ${d}`));
  }

  out.push("");
  out.push(dim(`  ${Object.entries(result.timings).map(([k, v]) => `${k} ${v.toFixed(1)}ms`).join("  ")}`));
  out.push("");

  return out.join("\n");
}

export function renderDiscoveries(
  repo: string,
  phantom: DiscoveryPair[],
  meta: { strategy: string; couplingEdges: number; ms: number; rationale?: { withTicket: number; withExplicit: number; withoutTicket: number } },
): string {
  const out: string[] = [];
  out.push("");
  out.push(bold(cyan(`Tangle · phantom couplings in ${repo}`)));
  out.push(dim("  Files that always move together, with no static import path between them."));
  out.push(dim("  A compiler cannot find these. A vector index cannot find these."));
  out.push("");

  if (phantom.length === 0) {
    out.push(yellow("  No pair met the threshold. Lower --min-confidence or --min-co-changes."));
    out.push("");
    return out.join("\n");
  }

  out.push(bold(`${phantom.length.toLocaleString("en-US")} pair(s) found`));
  if (meta.rationale) {
    const total = meta.rationale.withTicket + meta.rationale.withoutTicket;
    out.push(
      dim(
        `  ${meta.rationale.withTicket.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} carry a pull request or issue as the reason` +
          `${meta.rationale.withExplicit > 0 ? `; ${meta.rationale.withExplicit} linked by an explicit closes/fixes` : ""}`,
      ),
    );
  }
  out.push("");
  for (const pair of phantom.slice(0, 20)) {
    out.push(`  ${bold(pct(pair.confidence).padStart(4))} ${bold(`${pair.coChanges.toLocaleString("en-US")}×`)}  ${green("no import path")}`);
    out.push(`        ${pair.a}`);
    out.push(`        ${pair.b}`);
    for (const line of renderWhy(pair.why, "        ")) out.push(line);
  }
  if (phantom.length > 20) out.push(dim(`  … and ${phantom.length - 20} more`));

  out.push("");
  out.push(dim(`  answered by: ${meta.strategy} · ${meta.couplingEdges.toLocaleString("en-US")} coupling edges scanned in ${meta.ms.toFixed(0)}ms`));
  out.push("");
  return out.join("\n");
}

/**
 * Render the "why" of a coupling as one or two indented lines.
 *
 * The ticket link is the claim, so it goes first and in colour. The share is what
 * makes it a finding rather than a coincidence: a ticket named in 40% of the
 * shared commits is explaining the coupling, one named in a single commit is
 * merely mentioned in it, and the report says which.
 */
export function renderWhy(why: CouplingWhy | null | undefined, indent = "     "): string[] {
  if (!why) return [];

  const out: string[] = [];

  if (why.ticket) {
    const kind = why.kind === "pull-request" ? "PR" : "issue";
    const share = why.share > 0 ? ` · ${pct(why.share)} of their shared commits` : "";
    const explicit = why.explicit ? green(" · linked by closes/fixes") : "";
    out.push(`${indent}${bold(cyan(`${kind} ${why.ticket}`))}${share}${explicit}`);
    if (why.title) out.push(`${indent}${why.title}`);
    if (why.url) out.push(`${indent}${dim(why.url)}`);
  } else if (why.subject) {
    out.push(`${indent}${dim(`no ticket; tied by a recurring commit: "${why.subject}"`)}`);
  }

  if (why.alsoFrom && why.alsoFrom.length > 0) {
    out.push(`${indent}${dim(`also referenced by ${why.alsoFrom.join(", ")}`)}`);
  }

  return out;
}

/**
 * The directories a set of coupled pairs spans, deepest-but-broadest first.
 *
 * A ticket's top couplings are frequently two files in the same directory —
 * `output/x.js` against `output/x.js.map` — which says nothing about the reach of
 * the decision behind them. Counting distinct directories and keeping the ones
 * that recur turns a list of paths into "this ties the Rust tree-shaker to the
 * JS test snapshots", which is the finding worth reading.
 */
export function significantAreas(pairs: ReadonlyArray<readonly [string, string]>): string[] {
  const counts = new Map<string, number>();
  for (const [a, b] of pairs) {
    for (const path of [a, b]) {
      // A file at the repository root has no directory component. Slicing to
      // `lastIndexOf("/")` with no guard turns "index.js" into a nine-character
      // prefix of its own name, which is how the panel ended up claiming a
      // coupling "spans index.d.t".
      const slash = path.lastIndexOf("/");
      if (slash === -1) continue;
      const parts = path.slice(0, slash).split("/");
      // Two segments is usually the useful granularity: `packages/next/src` is a
      // module, `packages` alone is too coarse to be actionable.
      const key = parts.length <= 1 ? parts[0]! : parts.slice(0, Math.min(3, parts.length)).join("/");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 4)
    .map(([dir]) => dir);
}

/**
 * `tangle why <fileA> <fileB>` — the single-pair explanation.
 *
 * This is the answer to the question a reviewer actually asks out loud: "why do
 * these two files always change together?" It reads as a claim and a proof, in
 * that order, because the ticket link is the finding and the commit SHA is what
 * makes it checkable.
 */
export function renderCouplingWhy(repo: string, a: string, b: string, why: CouplingWhy | null): string {
  const out: string[] = [];
  out.push("");
  out.push(bold(cyan(`Why are these two files coupled in ${repo}?`)));
  out.push("");
  out.push(`  ${bold(a)}`);
  out.push(`  ${bold(b)}`);
  out.push("");

  if (!why) {
    out.push(yellow("  No pull request or issue reference found in their shared commits."));
    out.push(dim("  The coupling is real; the reason was never written down in a form git retains."));
    out.push("");
    return out.join("\n");
  }

  out.push(...renderWhy(why, "  "));
  if (why.commit) {
    out.push(`  ${dim(`commit ${why.commit.slice(0, 10)}`)}`);
  }
  out.push("");
  return out.join("\n");
}

/**
 * `tangle structure` — the whole-graph view, computed by FalkorDB's algorithms.
 *
 * Renders load-bearing files, bridges, and the shadow architecture. Each section
 * says which `algo.*` call produced it, because a number with no provenance is not
 * checkable and this project's whole argument is that its numbers are.
 */
export function renderStructure(report: StructureReport, repo: string): string {
  const out: string[] = [];
  out.push("");
  out.push(bold(cyan(`Tangle · structure of ${repo}`)));
  out.push(dim("  Whole-graph questions, answered by FalkorDB's matrix algorithms."));
  out.push(dim("  Not retrievable by querying one file at a time."));
  out.push("");

  const unavailable = Object.entries(report.available).filter(([, s]) => s === "unavailable");
  if (unavailable.length > 0) {
    out.push(
      yellow(
        `  ${unavailable.length} algorithm(s) unavailable on this server: ${unavailable.map(([n]) => n).join(", ")}.`,
      ),
      dim("  The rest of this report is unaffected."),
    );
    out.push("");
  }

  // ---- load-bearing ----
  if (report.loadBearing.length > 0) {
    out.push(bold("  Load-bearing files"));
    out.push(dim("    algo.pageRank over COUPLED — files other changes route through, not just busy ones"));
    out.push("");
    for (const f of report.loadBearing.slice(0, 12)) {
      out.push(
        `    ${bold(pct(f.share).padStart(6))}  ${String(f.changes).padStart(6)} changes  ${f.path}`,
      );
    }
    if (report.loadBearing.length > 12) {
      out.push(dim(`    … and ${report.loadBearing.length - 12} more`));
    }
    out.push("");
  }

  // ---- bridges ----
  if (report.bridges.length > 0) {
    out.push(bold("  Bridge files"));
    out.push(dim("    algo.betweenness over COUPLED — the links between clusters; a change that misses one breaks the join"));
    out.push("");
    for (const b of report.bridges.slice(0, 12)) {
      // The coupling count is shown because betweenness alone misleads: one edge
      // can score high purely by being the only link between two halves.
      out.push(
        `    ${b.score.toFixed(1).padStart(8)}  ${String(b.couplings).padStart(5)} couplings  ` +
          `${b.couplings <= 2 ? yellow(b.path) : b.path}`,
      );
    }
    if (report.bridges.length > 12) {
      out.push(dim(`    … and ${report.bridges.length - 12} more`));
    }
    if (report.bridges.some((b) => b.couplings <= 2)) {
      out.push("");
      out.push(dim("    Highlighted: a high score on very few couplings is a thin link — worth knowing exists."));
    }
    out.push("");
  }

  // ---- shadow architecture ----
  //
  // This panel reports what the clustering actually found, including when the
  // answer is "there isn't one". On a repository large enough for hub files to
  // exist, the coupling graph is very often a single connected component, and
  // printing that as a list of tidy modules would be inventing a finding. The
  // interesting half is the isolated tail: files that have never co-changed with
  // anything, which is what the directory layout claims about a repository that
  // does not have that structure.
  if (report.islands.length > 0) {
    out.push(bold("  Clustering"));
    out.push(dim("    algo.WCC over COUPLED — what history keeps together, whatever the folder tree says"));
    out.push("");

    const giant = report.islands[0]!;
    const tail = report.islands.slice(1);

    out.push(
      `    ${pct(report.largestIslandShare)} of the repository (${giant.files.toLocaleString("en-US")} files) is one connected component`,
    );
if (report.largestIslandShare > 0.9) {
      out.push(
        dim("    So the coupling graph is not modular: hub files such as manifests and lockfiles connect"),
      );
      out.push(dim("    almost everything to everything else. That is a true result, not a missing one."));
    } else {
      out.push(
        dim(
          `    ${tail.length + 1} component(s) in total. The largest crossing top-level directories ` +
            `${report.layoutDisagrees ? yellow("does contradict the folder layout") : "matches the folder layout"}.`,
        ),
      );
    }
    out.push("");

    if (tail.length > 0) {
      const isolated = tail.filter((i) => i.files <= 5);
      const small = tail.filter((i) => i.files > 5);
      out.push(
        dim(`    ${isolated.length} small component(s) of ≤5 files, ${small.length} larger than that:`),
      );
      for (const island of tail.slice(0, 6)) {
        out.push(`      ${String(island.files).padStart(5)} files  ${island.sample.slice(0, 2).join(", ")}`);
      }
      out.push("");
    }
  }

  // ---- bus factor ----
  //
  // Reported as a distribution rather than a single number, because "the bus
  // factor of this repository is 1" is only true if you count the founder. What a
  // reviewer needs to know is how much of the coupling graph disappears when the
  // top contributor stops touching it.
  if (report.busFactor && report.busFactor.length > 0) {
    out.push(bold("  Bus factor: coupling knowledge by person"));
    out.push(dim("    share of every coupling anyone has authored, so these add up to the whole repository"));
    out.push("");
    for (const person of report.busFactor.slice(0, 6)) {
      out.push(
        `    @${person.login.padEnd(22)} ${pct(person.shareOfCouplings).padStart(6)}  ` +
          `${String(person.files).padStart(5)} files  ${String(person.couplings).padStart(6)} couplings`,
      );
    }
    out.push("");
    const top = report.busFactor[0]!;
    if (top && top.couplings > 0) {
      out.push(
        dim(
          `    @${top.login} alone authored ${top.couplings.toLocaleString("en-US")} of the couplings` +
            `${top.shareOfCouplings > 0.15 ? `, ${pct(top.shareOfCouplings)} of the total` : ""}.`,
        ),
      );
      out.push(dim("    That is a property of the history, not of the folder layout."));
      out.push("");
    }
  }

  out.push(dim(`  computed in ${(report.ms / 1000).toFixed(2)}s`));
  out.push("");
  return out.join("\n");
}

/** The rationale panel: tickets ranked by how much coupling structure they explain. */
export function renderTickets(repo: string, tickets: TicketInsight[], meta: { ms: number }): string {
  const out: string[] = [];
  out.push("");
  out.push(bold(cyan(`Tangle · why files move together in ${repo}`)));
  out.push(dim("  Every coupling traced back to the pull request or issue that introduced it."));
  out.push(dim("  Derived from the git log alone. No API call, no LLM, no guessing."));
  out.push("");

  if (tickets.length === 0) {
    out.push(yellow("  No ticket reference was found in this history."));
    out.push(dim("  Repositories that squash-merge append (#12345) to every commit subject;"));
    out.push(dim("  repositories that never reference tickets will have nothing to show here."));
    out.push("");
    return out.join("\n");
  }

  // Group each ticket's couplings by directory, then show the two directories it
  // spans. "Which parts of the codebase does this decision tie together" is the
  // question a reader actually has, and the answer is in the paths, not in the
  // first two alphabetically.
  for (const t of tickets) {
    const kind = t.kind === "pull-request" ? "PR" : "issue";
    const areas = significantAreas(t.couplings.map((c) => [c.a, c.b] as const));
    // A ticket whose mentions are mostly reverts explains the coupling *less*, not
    // more. Showing the discount explicitly is the difference between an honest
    // ranking and one that launders repeated un-does into importance.
    const detail =
      `${t.filesExplained} file(s) · ${t.effectiveMentions.toLocaleString("en-US")} effective mention(s)` +
      (t.explicit ? " · explicit closes/fixes" : "");
    out.push(`  ${bold(cyan(`${kind} ${t.key}`))}  ${dim(detail)}`);
    if (t.title) out.push(`    ${t.title}`);
    if (t.url) out.push(`    ${dim(t.url)}`);
    if (t.reverts > 0) {
      out.push(dim(`    ${t.reverts} of ${t.references} citing commit(s) were reverts`));
    }
    if (areas.length > 0) out.push(dim(`    spans ${areas.join("  ·  ")}`));
    for (const c of t.couplings.slice(0, 5)) {
      out.push(
        `    ${dim(`${String(c.coChanges).padStart(4)}×`).padEnd(12)} ${c.a} ${dim("<->")} ${c.b}`,
      );
      const notes: string[] = [];
      if (c.hasImport) notes.push("an import path exists between these");
      // A file and its own sourcemap are the single most common top coupling in a
      // large repository. Saying so is more useful than omitting the row, because
      // it tells the reader the panel has been filtered by judgement, not luck.
      if (c.artifact) notes.push("generated or vendored output");
      if (notes.length > 0) out.push(dim(`                    (${notes.join("; ")})`));
    }
    if (t.couplings.length > 5) out.push(dim(`    … and ${t.couplings.length - 5} more coupling(s)`));
    out.push("");
  }

  out.push(dim(`  ${tickets.length} ticket(s) in ${(meta.ms / 1000).toFixed(2)}s`));
  out.push("");
  return out.join("\n");
}

const pct1 = (n: number) => `${(n * 100).toFixed(1)}%`;
const score3 = (n: number) => n.toFixed(3);

/**
 * The back-test report.
 *
 * Method first, then numbers, then the limits. A benchmark that hides its
 * methodology under the results is indistinguishable from a benchmark that was
 * tuned until the numbers looked good, so the protocol is stated above the
 * figures and every exclusion is counted.
 */
export function renderBacktest(report: BacktestReport): string {
  const out: string[] = [];
  const { tangle, cochange, imports } = report.results.capped;

  out.push("");
  out.push(bold(cyan(`Tangle back-test · ${report.repo}`)));
  out.push(dim("  Would Tangle have flagged the file the developer left out of the diff?"));
  out.push("");

  out.push(bold("  Method"));
  out.push(dim("    " + wrap(report.methodology.protocol, 74, "")));
  out.push(dim(`    leakage guard: ${report.methodology.leakage}`));
  out.push(dim(`    same budget for all three: ${report.methodology.budget}`));
  out.push("");

  out.push(bold("  Corpus"));
  out.push(dim(`    ${report.corpus.commitsParsed.toLocaleString("en-US")} commits parsed`));
  out.push(
    dim(
      `    ${report.corpus.trainingCommits.toLocaleString("en-US")} used to train · ` +
        `${report.corpus.testCommitsEvaluated.toLocaleString("en-US")} test commits scored`,
    ),
  );
  out.push(dim(`    ${report.corpus.heldOutFiles.toLocaleString("en-US")} held-out files · one per file per commit`));
  const excluded =
    report.corpus.skippedMass +
    report.corpus.skippedBot +
    report.corpus.skippedSingleFile;
  if (excluded > 0) {
    const parts: string[] = [];
    if (report.corpus.skippedMass > 0) parts.push(`${report.corpus.skippedMass} mass`);
    if (report.corpus.skippedBot > 0) parts.push(`${report.corpus.skippedBot} bot`);
    if (report.corpus.skippedSingleFile > 0) parts.push(`${report.corpus.skippedSingleFile} single-file`);
    out.push(dim(`    excluded from scoring: ${parts.join(", ")}`));
  }
  out.push(dim(`    training graph: ${report.corpus.filesInTraining.toLocaleString("en-US")} files, ${report.corpus.pairsInTraining.toLocaleString("en-US")} coupling pairs`));
  out.push("");

  out.push(bold("  Operating point (the shipped defaults)"));
  out.push(dim(
    `    confidence ≥ ${report.operatingPoint.minConfidence} · ${report.operatingPoint.maxHops} hops · ` +
      `≥ ${report.operatingPoint.minCoChanges} shared commits · names ≤ ${report.operatingPoint.topK} files`,
  ));
  out.push("");

  // ---- the comparison ----
  out.push(bold("  Would it have been flagged?"));
  out.push(dim("    recall = of the forgotten files, how many were named"));
  out.push(dim("    precision = of the files named, how many really belonged to the change"));
  out.push(dim("    named/file = how much of a list the user would have to read"));
  out.push("");
  out.push(`    ${dim("method".padEnd(30))} ${dim("precision".padStart(11))} ${dim("recall".padStart(9))} ${dim("F1".padStart(8))} ${dim("named/file".padStart(11))}`);
  out.push(`    ${bold("Tangle (change coupling)".padEnd(30))} ${bold(pad(pct1(tangle.precision), 11))} ${bold(pad(pct1(tangle.recall), 9))} ${bold(pad(score3(tangle.f1), 8))} ${dim(pad(tangle.perCase.toFixed(1), 11))}`);
  out.push(`    ${dim("baseline: import graph only".padEnd(30))} ${pad(pct1(imports.precision), 11)} ${pad(pct1(imports.recall), 9)} ${pad(score3(imports.f1), 8)} ${dim(pad(imports.perCase.toFixed(1), 11))}`);
  out.push(`    ${dim("baseline: plain co-change count".padEnd(30))} ${pad(pct1(cochange.precision), 11)} ${pad(pct1(cochange.recall), 9)} ${pad(score3(cochange.f1), 8)} ${dim(pad(cochange.perCase.toFixed(1), 11))}`);
  out.push("");

  // ---- the part only Tangle can see ----
  if (report.phantomSubset.cases > 0) {
    const p = report.phantomSubset;
    out.push(bold(`  Phantom couplings: the ${p.cases.toLocaleString("en-US")} held-out files with no import path`));
    out.push(dim("    the same cases, restricted to files the import graph cannot reach at all"));
    out.push("");
    out.push(`    ${bold("Tangle".padEnd(30))} ${bold(pad(pct1(p.tangle.precision), 11))} ${bold(pad(pct1(p.tangle.recall), 9))} ${bold(pad(score3(p.tangle.f1), 8))}`);
    out.push(`    ${dim("baseline: import graph only".padEnd(30))} ${dim("—".padStart(11))} ${dim("—".padStart(9))} ${dim("by construction".padStart(8))}`);
    out.push("");
  }

  out.push(bold("  Candidates are ordered by"));
  out.push(dim(`    ${report.ranking}`));
  out.push("");

  // ---- confidence sweep: is the threshold doing the work, or luck? ----
  out.push(bold("  Confidence sweep"));
  out.push(dim("    does recall hold up as the bar is raised, or is it an artifact of a loose threshold?"));
  out.push("");
  for (const row of report.sweep) {
    const marker = Math.abs(row.floor - report.operatingPoint.minConfidence) < 1e-9 ? bold("  ← shipped default") : "";
    out.push(
      `    ${dim(`≥ ${row.floor.toFixed(2)}`.padEnd(9))} ` +
        `${pad(pct1(row.precision), 11)} ${pad(pct1(row.recall), 9)} ${pad(score3(row.f1), 8)} ` +
        `${dim(`${row.tp.toLocaleString("en-US")} caught / ${row.fp.toLocaleString("en-US")} wrong`)}${marker}`,
    );
  }
  out.push("");

  // ---- the honesty split: mature files vs brand-new ones ----
  const h = report.byHistory;
  if (h.mature.cases > 0 || h.cold.cases > 0) {
    out.push(bold("  Split by how much history the forgotten file already had"));
    out.push(
      dim(
        `    median prior history of a held-out file: ${h.medianPriorCommits} commits. ` +
          `${h.unreachable.toLocaleString("en-US")} of them had no co-change partner at all, ` +
          `which is a ceiling no history-based method can pass.`,
      ),
    );
    out.push("");
    out.push(`    ${dim("segment".padEnd(30))} ${dim("cases".padStart(7))} ${dim("precision".padStart(11))} ${dim("recall".padStart(9))} ${dim("top-1".padStart(8))}`);
    out.push(
      `    ${bold("had history (mature)".padEnd(30))} ${bold(pad(h.mature.cases.toLocaleString("en-US"), 7))} ` +
        `${bold(pad(pct1(h.mature.tangle.precision), 11))} ${bold(pad(pct1(h.mature.tangle.recall), 9))} ${bold(pad(pct1(h.mature.tangle.top1Rate), 8))}`,
    );
    out.push(
      `    ${dim("  · import graph only".padEnd(30))} ${dim(pad("", 7))} ${dim(pad(pct1(h.mature.imports.precision), 11))} ${dim(pad(pct1(h.mature.imports.recall), 9))} ${dim(pad(pct1(h.mature.imports.top1Rate), 8))}`,
    );
    out.push(
      `    ${dim("  · plain co-change".padEnd(30))} ${dim(pad("", 7))} ${dim(pad(pct1(h.mature.cochange.precision), 11))} ${dim(pad(pct1(h.mature.cochange.recall), 9))} ${dim(pad(pct1(h.mature.cochange.top1Rate), 8))}`,
    );
    out.push(
      `    ${dim("brand new (no history yet)".padEnd(30))} ${dim(pad(h.cold.cases.toLocaleString("en-US"), 7))} ${dim(pad(pct1(h.cold.tangle.precision), 11))} ${dim(pad(pct1(h.cold.tangle.recall), 9))} ${dim(pad(pct1(h.cold.tangle.top1Rate), 8))}`,
    );
    out.push("");
    out.push(dim("    A file with no prior commits is not a case any co-change method can win,"));
    out.push(dim("    so the headline figure below is reported over the whole window *and* over the"));
    out.push(dim("    mature segment separately, rather than blended into one number."));
    out.push("");
  }

  // ---- the number that describes what a user actually gets ----
  const prod = report.production;
  if (prod.cases > 0) {
    out.push(bold("  What the shipped warning actually does"));
    out.push(dim("    replayed through the real logic: hop budget, confidence floor, co-change minimum, top-12 cap"));
    out.push("");
    out.push(
      `    of ${prod.cases.toLocaleString("en-US")} forgotten files, the shipped list would name ` +
        `${bold(pct1(prod.recall))} of them at ${bold(pct1(prod.precision))} precision (F1 ${score3(prod.f1)})`,
    );
    out.push(
      dim(
        `    ${prod.belowThreshold.toLocaleString("en-US")} were coupled enough to be a candidate but fell below the floor or the cap`,
      ),
    );
    out.push("");
    out.push(bold("  The failure that would matter: wrongly saying a change is complete"));
    out.push(
      dim(
        `    in ${prod.cleanCases.toLocaleString("en-US")} case(s) the list came back empty, so an agent would say "complete".`,
      ),
    );
    out.push(
      `    ${prod.cleanCorrect.toLocaleString("en-US")} of those had no coupling at all → ` +
        (prod.falseClean > 0
          ? bold(
              yellow(
                `${prod.falseClean.toLocaleString("en-US")} (${pct1(prod.falseCleanRate)}) were coupled but never warned`,
              ),
            )
          : green("every " + `"complete"` + " verdict in this window was correct")),
    );
    out.push("");
    if (prod.falseClean > 0) {
      out.push(
        dim(
          "    A missed file is an annoyance. A silently dropped warning is a bug that ships. Those " +
            prod.falseClean.toLocaleString("en-US") +
            " case(s) were coupled to the diff but below the floor, and no threshold fixes them — they need the file to have more history.",
        ),
      );
      out.push("");
    }
  }

  // ---- ranking quality, which precision cannot express in this task ----
  out.push(bold("  Where the right file landed in the list"));
  out.push(dim("    exactly one file is correct, so what matters is whether it came first"));
  out.push("");
  for (const m of [tangle, imports, cochange]) {
    out.push(
      `    ${dim(m.name === "tangle" ? "Tangle" : m.name === "imports" ? "import graph" : "plain co-change").padEnd(20)} ` +
        `${bold(pad(pct1(m.top1Rate), 8))} top-1   ${pad(pct1(m.top3Rate), 8)} top-3   ` +
        `${dim(`MRR ${m.mrr.toFixed(3)}`)}`,
    );
  }
  out.push("");

  // ---- provenance coverage ----
  const r = report.rationale;
  if (r.totalHeldOut > 0) {
    const ticketPct = r.heldOutWithTicket / r.totalHeldOut;
    const subjectPct = r.heldOutWithSubject / r.totalHeldOut;
    out.push(bold("  How much of this is explainable"));
    out.push(
      dim(
        `    ${r.commitsWithTicketRef.toLocaleString("en-US")} of ${r.commitsInWindow.toLocaleString("en-US")} commits in the window reference a pull request or issue.`,
      ),
    );
    out.push(
      dim(
        `    So ${pct1(ticketPct)} of the forgotten files had a ticket explaining their coupling and ` +
          `${pct1(subjectPct)} had at least a recurring commit message. The rest are real couplings whose ` +
          `reason was never written down anywhere git kept.`,
      ),
    );
    out.push("");
  }

  // ---- calibration ----
  if (report.calibration.caught > 0) {
    out.push(bold("  Is the confidence number honest?"));
    out.push(
      dim(
        `    when it named the forgotten file it was ${pct1(report.calibration.meanScoreCaught)} confident on average ` +
          `across ${report.calibration.caught.toLocaleString("en-US")} case(s); ` +
          `${report.calibration.missed.toLocaleString("en-US")} it stayed silent or pointed elsewhere`,
      ),
    );
    out.push("");
  }

  // ---- audit trail ----
  if (report.examples.length > 0) {
    out.push(bold("  Audit sample"));
    out.push(dim("    every one of these is a real commit in this repository"));
    out.push("");
    for (const e of report.examples) {
      const verdict = e.caught
        ? green(`caught at ${pct1(e.confidence)}`)
        : yellow("not flagged");
      out.push(`    ${dim(e.sha.slice(0, 8))} ${dim(e.date)}  ${pad(verdict, 20)} ${e.heldOut}`);
    }
    out.push("");
  }

  // ---- the honest limits, in the report itself ----
  out.push(bold("  What this does and does not show"));
  for (const note of report.notes) out.push(dim(`    · ${wrap(note, 72, "")}`));
  out.push("");
  out.push(dim(`  ${Object.entries(report.timings).map(([k, v]) => `${k} ${(v / 1000).toFixed(1)}s`).join("  ")}`));
  out.push("");

  return out.join("\n");
}

/** Markdown table for the README, generated from a measured run rather than typed in. */
export function renderBacktestMarkdown(report: BacktestReport): string {
  const rows = [
    [report.results.capped.tangle, "**Tangle (change coupling)**"],
    [report.results.capped.imports, "Baseline: import graph only"],
    [report.results.capped.cochange, "Baseline: plain co-change count"],
  ] as const;

  const lines = [
    `Measured by \`npm run backtest -- --repo ${report.repo}\`, on ${report.corpus.commitsParsed.toLocaleString("en-US")} commits of real history.`,
    ``,
    `The last ${report.corpus.testWindow.toLocaleString("en-US")} commits were replayed one file at a time. For each commit, one file`,
    `is removed from the diff and Tangle is asked whether it would have flagged that file — using only the commits`,
    `**older** than the one being scored, so the answer is never already in the graph.`,
    `${report.corpus.heldOutFiles.toLocaleString("en-US")} held-out files across ${report.corpus.testCommitsEvaluated.toLocaleString("en-US")} commits. Every method gets the same`,
    `task and the same budget of ${report.operatingPoint.topK} files per case.`,
    ``,
    `### Whole test window`,
    ``,
    `| Method | Precision | Recall | F1 | Top-1 | Files named per case |`,
    `| --- | :---: | :---: | :---: | :---: | :---: |`,
  ];

  for (const [m, label] of rows) {
    lines.push(
      `| ${label} | ${pct1(m.precision)} | ${pct1(m.recall)} | ${score3(m.f1)} | ${pct1(m.top1Rate)} | ${m.perCase.toFixed(1)} |`,
    );
  }

  const r = report.rationale;
  lines.push(
    ``,
    `### How much of it is explainable`,
    ``,
    `${r.commitsWithTicketRef.toLocaleString("en-US")} of ${r.commitsInWindow.toLocaleString("en-US")} commits in the held-out window reference a pull request or issue.`,
    `That makes ${pct1(r.heldOutWithTicket / r.totalHeldOut)} of the forgotten files attributable to a named change, and`,
    `${pct1(r.heldOutWithSubject / r.totalHeldOut)} attributable at least to a recurring commit message. The remainder are genuine`,
    `couplings whose reason was never recorded anywhere git retains.`,
  );

  const h = report.byHistory;
  lines.push(
    ``,
    `### Files that already had change history`,
    ``,
    `${h.mature.cases.toLocaleString("en-US")} of ${report.corpus.heldOutFiles.toLocaleString("en-US")} held-out files had been committed at least ${report.operatingPoint.minCoChanges} times before the`,
    `commit being scored. The other ${h.cold.cases.toLocaleString("en-US")} were changed for the first time, where a co-change method has`,
    `nothing to key on — ${h.unreachable.toLocaleString("en-US")} files had no co-change partner at all. Both segments are reported rather than blended.`,
    ``,
    `| Method | Precision | Recall | F1 | Top-1 |`,
    `| --- | :---: | :---: | :---: | :---: |`,
  );

  const matureRows = [
    [h.mature.tangle, "**Tangle (change coupling)**"],
    [h.mature.imports, "Baseline: import graph only"],
    [h.mature.cochange, "Baseline: plain co-change count"],
  ] as const;
  for (const [m, label] of matureRows) {
    lines.push(
      `| ${label} | ${pct1(m.precision)} | ${pct1(m.recall)} | ${score3(m.f1)} | ${pct1(m.top1Rate)} |`,
    );
  }

  const p = report.phantomSubset;
  if (p.cases > 0) {
    lines.push(
      ``,
      `### Phantom couplings only`,
      ``,
      `The same mature cases, restricted to the ${p.cases.toLocaleString("en-US")} held-out files that no import path reaches.`,
      `The import-graph baseline scores zero here by construction; Tangle is the only method with anything to say.`,
      ``,
      `| Method | Precision | Recall | F1 |`,
      `| --- | :---: | :---: | :---: |`,
      `| **Tangle (change coupling)** | ${pct1(p.tangle.precision)} | ${pct1(p.tangle.recall)} | ${score3(p.tangle.f1)} |`,
      `| Baseline: plain co-change count | ${pct1(p.cochange.precision)} | ${pct1(p.cochange.recall)} | ${score3(p.cochange.f1)} |`,
    );
  }

  return lines.join("\n");
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

/** Markdown report, for the README and the blog post side prize. */
export function renderCertificateMarkdown(c: Certificate): string {
  return [
    `> **${c.statement.split(". ")[0]}.**`,
    `>`,
    `> | bound | value |`,
    `> | --- | --- |`,
    `> | files in repo | ${c.search.repoFilesTotal.toLocaleString("en-US")} |`,
    `> | files considered | ${c.search.filesReached.toLocaleString("en-US")} (${c.coverage.filesConsideredPct}%) |`,
    `> | coupling edges in repo | ${c.search.couplingEdgesTotal.toLocaleString("en-US")} |`,
    `> | edges inspected | ${c.search.edgesScanned.toLocaleString("en-US")} (${c.coverage.edgesConsideredPct}%) |`,
    `> | edges rejected below floor | ${c.search.excludedByConfidence.toLocaleString("en-US")} |`,
    `> | confidence floor | ${c.parameters.minConfidence} |`,
    `> | hop budget | ${c.parameters.maxHops} |`,
    `> | truncated | ${c.search.truncated ? `yes — ${c.search.truncationReason}` : "no"} |`,
  ].join("\n");
}

export function wrap(text: string, width: number, indent = ""): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length > width) {
      lines.push(current.trim());
      current = word;
    } else {
      current = `${current} ${word}`;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines.map((l) => `${indent}${l}`).join("\n");
}