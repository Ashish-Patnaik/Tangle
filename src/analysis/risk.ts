import type { AffectedFile, MissedFile, ReviewerRoute } from "../types.js";

export interface RiskFactor {
  key: "forgotten" | "blast" | "breadth" | "ownership";
  points: number;
  max: number;
  detail: string;
}

export interface RiskAssessment {
  /** 0-100. A triage heuristic, NOT a calibrated probability of failure. */
  score: number;
  level: "low" | "medium" | "high" | "critical";
  factors: RiskFactor[];
  /** What a reviewer should do about it, most important first. */
  actions: string[];
  caveat: string;
}

const cap = (v: number, max: number): number => Math.round(Math.min(max, Math.max(0, v)));

/**
 * Merge-risk triage score, derived only from evidence already in the analysis:
 * files that usually ship with this change but are missing, how much strongly
 * coupled code sits outside the diff, how wide the diff is, and whether anyone
 * demonstrably owns the area. Every point is traceable to a factor.
 *
 * It is deliberately explainable and capped per factor so no single signal
 * (a hub file with a huge blast radius) can saturate the score on its own.
 */
export function assessRisk(input: {
  changedFiles: string[];
  blastRadius: AffectedFile[];
  missed: MissedFile[];
  reviewers: ReviewerRoute[];
}): RiskAssessment {
  const { changedFiles, blastRadius, missed, reviewers } = input;

  const missedWeight = missed.reduce((s, m) => s + m.confidence, 0);
  const forgotten = cap(missedWeight * 14, 40);

  const strongOutside = blastRadius.filter((a) => !a.inDiff && a.confidence >= 0.5).length;
  const blast = cap(strongOutside * 3, 30);

  const breadth = cap(Math.log2(Math.max(1, changedFiles.length)) * 3.5, 15);

  const topAffinity = reviewers[0]?.affinity ?? 0;
  const ownership = reviewers.length === 0 ? 15 : topAffinity < 0.2 ? 8 : 0;

  const factors: RiskFactor[] = [
    {
      key: "forgotten",
      points: forgotten,
      max: 40,
      detail: missed.length
        ? `${missed.length} file(s) that usually change with this code are not in the diff`
        : "no commonly co-changed file is missing",
    },
    {
      key: "blast",
      points: blast,
      max: 30,
      detail: `${strongOutside} strongly coupled file(s) outside the diff (confidence >= 50%)`,
    },
    {
      key: "breadth",
      points: breadth,
      max: 15,
      detail: `${changedFiles.length} file(s) changed`,
    },
    {
      key: "ownership",
      points: ownership,
      max: 15,
      detail: reviewers.length === 0
        ? "no clear owner found in history"
        : `top reviewer @${reviewers[0]!.login} owns ${Math.round(topAffinity * 100)}% of the touched area`,
    },
  ];

  const score = Math.min(100, factors.reduce((s, f) => s + f.points, 0));
  const level = score < 25 ? "low" : score < 50 ? "medium" : score < 75 ? "high" : "critical";

  const actions: string[] = [];
  for (const m of missed.slice(0, 3)) actions.push(`Check whether ${m.path} also needs to change (${Math.round(m.confidence * 100)}% co-change).`);
  if (reviewers[0]) actions.push(`Request review from @${reviewers[0].login}.`);
  if (changedFiles.length > 15) actions.push("Consider splitting this PR; wide diffs hide coupled changes.");
  if (actions.length === 0) actions.push("No action suggested by the history.");

  return {
    score,
    level,
    factors,
    actions,
    caveat:
      "Triage heuristic from co-change history, not a measured failure probability. " +
      "An empty warning list is not proof the change is complete.",
  };
}
