/**
 * Provenance: why two files move together.
 *
 * Co-change history says *that* two files always move together. It never says
 * *why*, and the reason is almost always written down somewhere — in the pull
 * request that introduced the constraint, or the issue that forced it. This
 * module recovers that link from the git history alone and attributes it to
 * individual coupling edges.
 *
 * Three sources, in descending order of strength:
 *
 *   1. `Fixes #123`, `Closes owner/repo#88`, `Resolves GH-9`. A keyword
 *      commitment. This is the strongest evidence available because someone
 *      stated the causal link deliberately.
 *   2. `Merge pull request #123 from …` and the `(#123)` suffix that a squash
 *      merge appends. Says the change arrived *from* a PR. This is the form used
 *      by roughly 90% of commits in a modern repository.
 *   3. A cross-repository reference such as `vercel/turbo#3835` in a monorepo,
 *      which points outside the ingested repository and is kept with its own
 *      repo so the link is still meaningful.
 *
 * Everything is derived from the commit log. No network call is made and none is
 * required, so ingest stays reproducible and works offline. Titles come from the
 * commit subject, which for a squash merge is the pull request's own title — a
 * good approximation, and an approximation that is labelled as such rather than
 * presented as an API read.
 */

import type { CommitRecord } from "../ingest/history.js";
import type { CouplingEdge } from "../types.js";

export type TicketKind = "pull-request" | "issue";

export interface TicketRef {
  /** Stable identity within a repository: `vercel/next.js#12345`. */
  key: string;
  /** Repository the number belongs to. Differs from the ingested repo for cross-repo refs. */
  repo: string;
  number: number;
  kind: TicketKind;
  /** True when a `fixes`/`closes`/`resolves` keyword made the link explicit. */
  explicit: boolean;
  /** The reference exactly as it appeared in the commit. */
  raw: string;
}

/**
 * A ticket, after the same reference has been seen in several commits.
 */
export interface TicketRecord {
  key: string;
  repo: string;
  number: number;
  kind: TicketKind;
  title: string;
  url: string;
  /** Commits that referenced it. */
  references: number;
  /** Commits where the reference came with an explicit closes/fixes keyword. */
  explicit: number;
  firstDate: string;
  lastDate: string;
  /** Distinct files touched by commits referencing it. */
  files: number;
  /**
   * How many of those referencing commits were reverts or revert-backs.
   *
   * A revert and its re-revert cite the same ticket twice while *undoing* the work
   * rather than causing it. Left unmeasured, a ticket that merely got repeatedly
   * un-done rises to the top of "what holds this codebase together", which is
   * precisely the wrong answer. Measured and reported rather than filtered:
   * dropping the history would be less honest than ranking it correctly.
   */
  reverts: number;
}

/** Undoing work rather than causing it. */
const REVERT_PATTERN = /^\s*revert\b/i;

/**
 * Why one coupling edge exists.
 */
export interface CouplingRationale {
  /** `owner/repo#123`, or null when no reference was found. */
  ticket: string | null;
  kind: TicketKind | null;
  url: string | null;
  title: string | null;
  /** ISO date of the commit that first referenced it. */
  date: string | null;
  /** SHA of the commit that first referenced it. */
  commit: string | null;
  /** How many of the pair's shared commits referenced this ticket. */
  mentions: number;
  /** `mentions / coChanges`. The share of the coupling one ticket accounts for. */
  share: number;
  /** Whether the earliest reference used a closes/fixes keyword. */
  explicit: boolean;
  /** Other tickets that also appear in this pair's shared commits. */
  alsoFrom: string[];
  /**
   * The most common commit subject across the pair's shared commits. Always
   * available, and frequently more informative than the ticket: it names the
   * recurring reason without needing a reference at all.
   */
  subject: string | null;
}

const NUL = "\u0000";



/** `(#12345)` at the end of a subject: the squash-merge convention. */
const TRAILING_PR = /\(#(\d+)\)\s*$/;

/** `Merge pull request #12345 from owner/branch`. */
const MERGE_PR = /^Merge pull request #(\d+)\b/i;

/**
 * `Fixes #123`, `Closes vercel/next.js#88`, `resolve #7`.
 *
 * The owner group is optional but the repo name is not, and that is deliberate:
 * GitHub's own syntax for a same-repository reference is a bare `#123`, while
 * `owner/repo#123` always names a repository. Allowing a lone owner here is what
 * produced the phantom `vercel/#88` key in testing — a reference with no
 * repository in it cannot be linked to anything.
 */
const KEYWORD_REF =
  /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?|address(?:es|ed)?)\b[:\s]+(?:([\w.-]+)\/)?([\w.-]+)#(\d+)/gi;

/**
 * A bare `#123`, or `owner/repo#123`.
 *
 * The leading character class deliberately excludes `=`, which is what keeps a
 * URL fragment in a body (`.../issues/91`) from becoming a reference. A lone
 * owner is excluded for the same reason as above: `vercel/#88` names nothing.
 */
const BARE_REF = /(?:^|[\s(,;[])((?:[\w.-]+\/)?[\w.-]+)?#(\d+)\b/g;

/**
 * Pull a ticket reference out of one commit.
 *
 * Returns an empty array rather than a single value because a commit can
 * legitimately reference both a PR and the issue it fixes, and the two play
 * different roles: the PR is where the change was made, the issue is why.
 */
export function extractRefs(commit: CommitRecord, homeRepo?: string): TicketRef[] {
  const subject = commit.subject ?? "";
  const body = commit.body ?? "";
  const found = new Map<string, TicketRef>();

  const add = (repo: string, number: number, kind: TicketKind, explicit: boolean, raw: string): void => {
    if (!Number.isInteger(number) || number <= 0) return;
    const key = `${repo}#${number}`;
    const existing = found.get(key);
    if (existing) {
      // Explicit beats implicit: one `Fixes #12` in the body outweighs five
      // incidental mentions in subjects.
      existing.explicit = existing.explicit || explicit;
      return;
    }
    found.set(key, { key, repo, number, kind, explicit, raw });
  };

  // `homeRepo` is required to classify a bare `#123`: the same number means a
  // pull request on GitHub and an issue elsewhere, and the distinction decides
  // whether the link is clickable to a diff or to a discussion.
  if (homeRepo) {
    const merge = MERGE_PR.exec(subject);
    if (merge) add(homeRepo, Number(merge[1]), "pull-request", true, merge[0]);
  }

  const trailing = TRAILING_PR.exec(subject);
  if (trailing && homeRepo) add(homeRepo, Number(trailing[1]), "pull-request", false, trailing[0]);

  // `(#123)` and a `Fixes #123` in the subject are both statements about a change
  // arriving via a pull request, because GitHub closes an issue when its fixing
  // PR merges.
  for (const m of subject.matchAll(KEYWORD_REF)) {
    const repo = m[1] && m[2] ? `${m[1]}/${m[2]}` : homeRepo;
    if (!repo) continue;
    add(repo, Number(m[3]), "pull-request", true, m[0]);
  }

  // In the body, `Fixes #123` almost always names the problem being solved.
  for (const m of body.matchAll(KEYWORD_REF)) {
    const repo = m[1] && m[2] ? `${m[1]}/${m[2]}` : homeRepo;
    if (!repo) continue;
    add(repo, Number(m[3]), "issue", true, m[0]);
  }

  for (const m of `${subject} ${body}`.matchAll(BARE_REF)) {
    const repo = m[1] ?? homeRepo;
    if (!repo) continue;
    // A bare number with no keyword has a genuinely ambiguous role. It is
    // recorded as an issue because the issue URL always resolves, while the same
    // integer on the pull-request path can 404 for a number that was only ever
    // an issue.
    add(repo, Number(m[2]), "issue", false, m[0]);
  }

  return Array.from(found.values());
}

/** GitHub renders pull requests and issues under different paths. */
export function ticketUrl(ref: { repo: string; number: number; kind: TicketKind }): string {
  const suffix = ref.kind === "pull-request" ? "pull" : "issues";
  return `https://github.com/${ref.repo}/${suffix}/${ref.number}`;
}

/**
 * Strip the provenance markers off a subject to recover a human title.
 *
 * `Fix \`slugify()\` twice (#82)` becomes `Fix \`slugify()\` twice`. For a squash
 * merge that remainder *is* the pull request title, which is why this is worth
 * doing, and why the result is stored as `title` with `subject` kept alongside.
 */
export function titleFromSubject(subject: string): string {
  // A merge subject is entirely boilerplate. There is no title to recover from
  // it — the pull request's real subject lives on the other commits in the merge,
  // and those are what `buildRationale` prefers. Returning "" rather than the
  // stripped boilerplate makes that preference visible instead of storing
  // "Merge pull request" as if it were a description.
  if (MERGE_PR.test(subject)) return "";
  return subject.replace(TRAILING_PR, "").replace(/\s{2,}/g, " ").trim();
}

/** Collapse a subject to a shape that can be counted across commits. */
function subjectKey(subject: string): string {
  return titleFromSubject(subject).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export interface RationaleIndex {
  tickets: Map<string, TicketRecord>;
  /** Canonical pair key -> rationale. */
  rationales: Map<string, CouplingRationale>;
  /** SHA -> refs, so the load can write REFERENCES edges. */
  refsByCommit: Map<string, TicketRef[]>;
  stats: {
    commitsScanned: number;
    commitsWithRefs: number;
    refsFound: number;
    explicitRefs: number;
    crossRepoRefs: number;
    /** References that appeared in a revert commit. */
    revertRefs: number;
    tickets: number;
    /** Tickets whose mentions are majority reverts. */
    revertHeavyTickets: number;
    /** Couplings that received at least one ticket attribution. */
    explainedCouplings: number;
    /** Couplings that got a subject-based rationale but no ticket. */
    subjectOnlyCouplings: number;
    ms: number;
  };
}

export interface RationaleOptions {
  /** The repository being ingested, e.g. `vercel/next.js`. */
  repoId: string;
  /** Commits touching more files than this are skipped, as everywhere else. */
  maxMassFiles?: number;
  /** Cap on extra tickets retained per coupling. */
  maxAlsoFrom?: number;
}

/**
 * Attribute every coupling edge to the tickets and subjects behind it.
 *
 * Cost is one pass over the commit list. Only commits that actually carry a
 * reference do per-pair work, and only pairs that are real couplings are kept,
 * so the memory held is proportional to the number of couplings and not to the
 * number of co-change occurrences.
 */
export function buildRationale(
  commits: CommitRecord[],
  couplings: CouplingEdge[],
  opts: RationaleOptions,
): RationaleIndex {
  const started = Date.now();
  const maxMassFiles = opts.maxMassFiles ?? 80;
  const maxAlsoFrom = opts.maxAlsoFrom ?? 3;

  // Only pairs that survived the coupling thresholds are worth explaining.
  const livePairs = new Set(couplings.map((e) => pairKey(e.a, e.b)));

  const tickets = new Map<string, TicketRecord>();
  const refsByCommit = new Map<string, TicketRef[]>();

  /** pair -> ticket key -> how many shared commits cited it. */
  const pairTickets = new Map<string, Map<string, number>>();
  /** pair -> subject key -> count. */
  const pairSubjects = new Map<string, Map<string, number>>();
  /**
   * subject key -> a human-readable rendering of it.
   *
   * Global rather than per-pair: the same commit subject keys off the same
   * display text everywhere it appears, and storing one copy per pair would be
   * both wasteful and — worse — free to drift from the key it describes.
   */
  const subjectDisplay = new Map<string, string>();
  /** pair -> earliest referencing commit, for display. */
  const firstRef = new Map<string, { sha: string; date: string; ticket: string; explicit: boolean }>();

  let commitsWithRefs = 0;
  let refsFound = 0;
  let explicitRefs = 0;
  let crossRepoRefs = 0;
  let revertRefs = 0;

  for (const commit of commits) {
    const files = commit.files;
    if (files.length < 2 || files.length > maxMassFiles) continue;

    const refs = extractRefs(commit, opts.repoId);
    const isRevert = REVERT_PATTERN.test(commit.subject);
    if (refs.length > 0) {
      commitsWithRefs++;
      refsFound += refs.length;
      refsByCommit.set(commit.sha, refs);
      for (const ref of refs) {
        if (ref.explicit) explicitRefs++;
        if (ref.repo !== opts.repoId) crossRepoRefs++;
        if (isRevert) revertRefs++;

        const existing = tickets.get(ref.key);
        if (existing) {
          existing.references++;
          if (ref.explicit) existing.explicit++;
          if (commit.date < existing.firstDate) existing.firstDate = commit.date;
          if (commit.date > existing.lastDate) existing.lastDate = commit.date;
          existing.files = Math.max(existing.files, files.length);
          if (isRevert) existing.reverts++;

          // A subject that is only the reference itself ("(#82)") carries no
          // information about the change. Prefer a real title from a later
          // commit rather than keeping that.
          const candidate = titleFromSubject(commit.subject);
          const existingIsBare = /^\(?#?\d*\)?$/.test(existing.title) || existing.title.length <= 3;
          if (candidate.length > 3 && existingIsBare) existing.title = candidate;
        } else {
          tickets.set(ref.key, {
            key: ref.key,
            repo: ref.repo,
            number: ref.number,
            kind: ref.kind,
            title: titleFromSubject(commit.subject),
            url: ticketUrl(ref),
            references: 1,
            explicit: ref.explicit ? 1 : 0,
            firstDate: commit.date,
            lastDate: commit.date,
            files: files.length,
            reverts: isRevert ? 1 : 0,
          });
        }
      }
    }

    const unique = Array.from(new Set(files));
    const subjectKeyed = subjectKey(commit.subject);
    if (subjectKeyed.length > 3 && !/^v?\d+\.\d+\.\d+/.test(commit.subject)) {
      // Version-bump subjects ("v13.1.7-canary.30") are near-identical across
      // releases and would otherwise dominate every subject count.
      for (let i = 0; i < unique.length; i++) {
        for (let j = i + 1; j < unique.length; j++) {
          const key = pairKey(unique[i]!, unique[j]!);
          if (!livePairs.has(key)) continue;
          let counts = pairSubjects.get(key);
          if (!counts) pairSubjects.set(key, (counts = new Map()));
          counts.set(subjectKeyed, (counts.get(subjectKeyed) ?? 0) + 1);
          if (!subjectDisplay.has(subjectKeyed)) {
            subjectDisplay.set(subjectKeyed, titleFromSubject(commit.subject));
          }
        }
      }
    }

    if (refs.length === 0) continue;

    // A revert, or the commit that reverts a revert, cites a ticket while undoing
    // the work rather than causing it. Two `Revert "..."` commits referencing one
    // issue produced 8,632 "mentions" for it on vercel/next.js — the count was
    // accurate and the conclusion was nonsense. Reverts still write their
    // REFERENCES edges, because the history is real and `t.reverts` records the
    // discount; they just do not count as evidence for *why* a pair is coupled.
    const attributing = !isRevert;

    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const key = pairKey(unique[i]!, unique[j]!);
        if (!livePairs.has(key) || !attributing) continue;

        let map = pairTickets.get(key);
        if (!map) pairTickets.set(key, (map = new Map()));

        for (const ref of refs) {
          map.set(ref.key, (map.get(ref.key) ?? 0) + 1);
          const seen = firstRef.get(key);
          if (!seen || commit.date < seen.date || (commit.date === seen.date && ref.explicit && !seen.explicit)) {
            firstRef.set(key, { sha: commit.sha, date: commit.date, ticket: ref.key, explicit: ref.explicit });
          }
        }
      }
    }
  }

  // ---- assemble one rationale per coupling ----
  const rationales = new Map<string, CouplingRationale>();
  let explained = 0;
  let subjectOnly = 0;

  for (const edge of couplings) {
    const key = pairKey(edge.a, edge.b);
    const counts = pairTickets.get(key);

    const subjectCounts = pairSubjects.get(key);
    let bestSubject: string | null = null;
    if (subjectCounts && subjectCounts.size > 0) {
      let best = 0;
      for (const [k, n] of subjectCounts) {
        if (n > best) {
          best = n;
          bestSubject = subjectDisplay.get(k) ?? null;
        }
      }
    }

    if (!counts || counts.size === 0) {
      if (bestSubject) {
        subjectOnly++;
        rationales.set(key, emptyRationale(bestSubject));
      }
      continue;
    }

    explained++;
    const ranked = [...counts.entries()].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1));
    const topKey = ranked[0]![0];
    const topCount = ranked[0]![1];
    const ticket = tickets.get(topKey);
    const first = firstRef.get(key);

    rationales.set(key, {
      ticket: topKey,
      kind: ticket?.kind ?? null,
      url: ticket?.url ?? null,
      title: ticket?.title ?? null,
      date: first?.date ?? ticket?.firstDate ?? null,
      commit: first?.sha ?? null,
      mentions: topCount,
      share: edge.coChanges > 0 ? round(topCount / edge.coChanges) : 0,
      explicit: first?.explicit ?? false,
      alsoFrom: ranked.slice(1, 1 + maxAlsoFrom).map(([k]) => k),
      subject: bestSubject,
    });
  }

  return {
    tickets,
    rationales,
    refsByCommit,
    stats: {
      commitsScanned: commits.length,
      commitsWithRefs,
      refsFound,
      explicitRefs,
      crossRepoRefs,
      revertRefs,
      tickets: tickets.size,
      /** Tickets where reverts outnumber the commits that actually did the work. */
      revertHeavyTickets: Array.from(tickets.values()).filter((t) => t.reverts * 2 > t.references).length,
      explainedCouplings: explained,
      subjectOnlyCouplings: subjectOnly,
      ms: Date.now() - started,
    },
  };
}

function emptyRationale(subject: string | null): CouplingRationale {
  return {
    ticket: null,
    kind: null,
    url: null,
    title: null,
    date: null,
    commit: null,
    mentions: 0,
    share: 0,
    explicit: false,
    alsoFrom: [],
    subject,
  };
}

const canonical = (a: string, b: string): [string, string] => (a <= b ? [a, b] : [b, a]);
export const pairKey = (a: string, b: string): string => {
  const [x, y] = canonical(a, b);
  return `${x}${NUL}${y}`;
};

export function splitPairKey(key: string): { a: string; b: string } {
  const at = key.indexOf(NUL);
  return { a: key.slice(0, at), b: key.slice(at + 1) };
}

function round(n: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}