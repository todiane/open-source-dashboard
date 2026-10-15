// Pure helpers shared by the collector and the tests.

export const DAY = 86_400_000;

export function daysSince(iso, now = Date.now()) {
  if (!iso) return Infinity;
  return Math.floor((now - new Date(iso).getTime()) / DAY);
}

/**
 * The one gate that decides whether a repo may appear on the dashboard.
 * Public, not a fork, not archived/disabled, owned by an allow-listed account,
 * and not on the exclude list.
 */
export function isEligible(repo, { owners, exclude = [] }) {
  if (!repo || repo.private !== false) return false;
  if (repo.fork || repo.archived || repo.disabled) return false;
  const owner = String(repo.owner?.login ?? '').toLowerCase();
  if (!owners.map((o) => o.toLowerCase()).includes(owner)) return false;
  const skip = exclude.map((e) => e.toLowerCase());
  if (skip.includes(String(repo.name).toLowerCase())) return false;
  if (skip.includes(String(repo.full_name).toLowerCase())) return false;
  return true;
}

/** Collapse a PR's reviews to 'changes_requested' | 'approved' | 'none'. */
export function reviewState(reviews = []) {
  const latest = new Map();
  for (const r of reviews) {
    if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(r.state)) continue;
    latest.set(r.user?.login, r.state);
  }
  const states = [...latest.values()];
  if (states.includes('CHANGES_REQUESTED')) return 'changes_requested';
  if (states.includes('APPROVED')) return 'approved';
  return 'none';
}

/**
 * Where a PR stands, from the maintainer's point of view.
 *  draft          - author still working
 *  needs_changes  - blocked on the author (failing CI, conflicts, requested changes)
 *  pending        - CI still running
 *  ready          - can be merged
 *  needs_review   - waiting on you
 */
export function prBucket(pr, owners) {
  if (pr.draft) return 'draft';
  if (pr.review === 'changes_requested' || pr.ci === 'failing' || pr.mergeable_state === 'dirty') {
    return 'needs_changes';
  }
  if (pr.ci === 'pending') return 'pending';
  const mine = owners.map((o) => o.toLowerCase()).includes(String(pr.author).toLowerCase());
  if (pr.review === 'approved' || mine) return 'ready';
  return 'needs_review';
}

/** 0-100 health score with a breakdown so the UI can explain it. */
export function healthScore(m, cfg, now = Date.now()) {
  const parts = {};

  const idle = daysSince(m.pushed_at, now);
  parts.activity = idle <= 30 ? 25 : idle <= 90 ? 18 : idle <= 180 ? 10 : idle <= 365 ? 4 : 0;

  parts.ci = { passing: 20, pending: 12, none: 10, failing: 0 }[m.ci] ?? 10;

  parts.license = m.has_license ? 10 : 0;

  parts.community = m.community == null ? 8 : Math.round((m.community / 100) * 15);

  const prAge = m.oldest_pr_days;
  parts.prs = prAge == null ? 15 : prAge <= cfg.stale_days ? 15 : prAge <= cfg.stale_days * 2 ? 8 : 0;

  const issueAge = m.oldest_unanswered_issue_days;
  parts.issues =
    issueAge == null || issueAge <= cfg.unanswered_issue_days
      ? 15
      : issueAge <= cfg.stale_days
        ? 8
        : 0;

  const score = Object.values(parts).reduce((a, b) => a + b, 0);
  return { score, parts };
}
