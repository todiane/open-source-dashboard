// Collects public data for every eligible repo and writes docs/data/*.json.
// Only public information is read or written. Traffic stats are deliberately
// NOT collected here: the dashboard fetches them live in the owner's browser.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { isEligible, reviewState, prBucket, healthScore, daysSince } from './lib.mjs';

const root = new URL('../', import.meta.url);
const cfg = JSON.parse(await readFile(new URL('config.json', root), 'utf8'));
const TOKEN = process.env.GITHUB_TOKEN;
const API = process.env.GITHUB_API_URL || 'https://api.github.com';
const OUT = process.env.OUT_DIR ? new URL(`file://${process.env.OUT_DIR.replace(/\/?$/, '/')}`) : new URL('docs/data/', root);
const MAX_PRS = 25;
const MAX_ISSUES = 40;

async function gh(path, { allow = [404, 409, 451] } = {}) {
  const res = await fetch(API + path, {
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'open-source-dashboard',
      ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  if (allow.includes(res.status)) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${path}`);
  return res.json();
}

// Optional lookups must never take down the whole run.
async function safe(fn, fallback = null) {
  try {
    return (await fn()) ?? fallback;
  } catch (err) {
    console.warn(`  warn: ${err.message}`);
    return fallback;
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

async function listRepos(owner) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const batch = await gh(`/users/${owner}/repos?type=owner&per_page=100&sort=pushed&page=${page}`);
    if (!batch?.length) break;
    all.push(...batch);
    if (batch.length < 100) break;
  }
  return all;
}

const BAD = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'];
async function ciState(full, ref) {
  const [runs, status] = await Promise.all([
    safe(() => gh(`/repos/${full}/commits/${ref}/check-runs?per_page=50`)),
    safe(() => gh(`/repos/${full}/commits/${ref}/status`)),
  ]);
  const results = (runs?.check_runs ?? []).map((r) => (r.status !== 'completed' ? 'pending' : r.conclusion));
  const hasStatus = (status?.total_count ?? 0) > 0;
  if (results.some((c) => BAD.includes(c)) || (hasStatus && ['failure', 'error'].includes(status.state))) {
    return 'failing';
  }
  if (results.includes('pending') || (hasStatus && status.state === 'pending')) return 'pending';
  if (!results.length && !hasStatus) return 'none';
  return 'passing';
}

async function collectRepo(r) {
  const full = r.full_name;
  console.log(`- ${full}`);
  const url = `https://github.com/${full}`;

  const [pulls, issues, release, community, ci] = await Promise.all([
    safe(() => gh(`/repos/${full}/pulls?state=open&per_page=${MAX_PRS}&sort=created&direction=asc`), []),
    safe(() => gh(`/repos/${full}/issues?state=open&per_page=100&sort=created&direction=asc`), []),
    safe(() => gh(`/repos/${full}/releases/latest`)),
    safe(() => gh(`/repos/${full}/community/profile`)),
    ciState(full, r.default_branch),
  ]);

  const prs = await mapLimit(pulls, 4, async (p) => {
    const [detail, reviews, prCi] = await Promise.all([
      safe(() => gh(`/repos/${full}/pulls/${p.number}`), {}),
      safe(() => gh(`/repos/${full}/pulls/${p.number}/reviews?per_page=100`), []),
      ciState(full, p.head.sha),
    ]);
    const pr = {
      repo: full,
      number: p.number,
      title: p.title,
      author: p.user?.login ?? 'ghost',
      author_is_bot: p.user?.type === 'Bot',
      url: `${url}/pull/${p.number}`,
      draft: !!p.draft,
      created_at: p.created_at,
      updated_at: p.updated_at,
      head_sha: p.head.sha,
      ci: prCi,
      review: reviewState(reviews),
      mergeable_state: detail.mergeable_state ?? 'unknown',
      comments: (detail.comments ?? 0) + (detail.review_comments ?? 0),
      additions: detail.additions ?? null,
      deletions: detail.deletions ?? null,
    };
    pr.bucket = prBucket(pr, cfg.owners);
    return pr;
  });

  const openIssues = issues
    .filter((i) => !i.pull_request)
    .slice(0, MAX_ISSUES)
    .map((i) => ({
      repo: full,
      number: i.number,
      title: i.title,
      author: i.user?.login ?? 'ghost',
      url: `${url}/issues/${i.number}`,
      created_at: i.created_at,
      updated_at: i.updated_at,
      comments: i.comments,
      labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name)).slice(0, 5),
      unanswered:
        i.comments === 0 && !cfg.owners.map((o) => o.toLowerCase()).includes(String(i.user?.login).toLowerCase()),
    }));

  let unreleased = null;
  if (release?.tag_name) {
    const cmp = await safe(() => gh(`/repos/${full}/compare/${encodeURIComponent(release.tag_name)}...${r.default_branch}`));
    unreleased = cmp?.ahead_by ?? null;
  }

  const oldestPr = prs.length ? Math.max(...prs.map((p) => daysSince(p.created_at))) : null;
  const unanswered = openIssues.filter((i) => i.unanswered);
  const oldestUnanswered = unanswered.length ? Math.max(...unanswered.map((i) => daysSince(i.created_at))) : null;

  const health = healthScore(
    {
      pushed_at: r.pushed_at,
      ci,
      has_license: !!r.license,
      community: community?.health_percentage ?? null,
      oldest_pr_days: oldestPr,
      oldest_unanswered_issue_days: oldestUnanswered,
    },
    cfg,
  );

  return {
    repo: {
      full_name: full,
      owner: r.owner.login,
      name: r.name,
      url,
      description: r.description,
      language: r.language,
      license: r.license?.spdx_id ?? null,
      topics: r.topics ?? [],
      default_branch: r.default_branch,
      stars: r.stargazers_count,
      forks: r.forks_count,
      watchers: r.subscribers_count ?? null,
      open_prs: prs.length,
      open_issues: openIssues.length,
      unanswered_issues: unanswered.length,
      pushed_at: r.pushed_at,
      ci,
      latest_release: release ? { tag: release.tag_name, published_at: release.published_at, url: release.html_url } : null,
      unreleased_commits: unreleased,
      community: community?.health_percentage ?? null,
      health,
    },
    prs,
    issues: openIssues,
  };
}

// ---- main ----
const eligible = [];
for (const owner of cfg.owners) {
  console.log(`Listing repos for ${owner}`);
  const repos = await listRepos(owner);
  eligible.push(...repos.filter((r) => isEligible(r, cfg)));
}
console.log(`${eligible.length} eligible repos`);

const results = [];
for (const r of eligible) results.push(await collectRepo(r));

const repos = results.map((x) => x.repo).sort((a, b) => b.stars - a.stars || a.full_name.localeCompare(b.full_name));
const prs = results.flatMap((x) => x.prs).sort((a, b) => a.created_at.localeCompare(b.created_at));
const issues = results.flatMap((x) => x.issues).sort((a, b) => a.created_at.localeCompare(b.created_at));

const data = {
  generated_at: new Date().toISOString(),
  owners: cfg.owners,
  config: { stale_days: cfg.stale_days, unanswered_issue_days: cfg.unanswered_issue_days },
  totals: {
    repos: repos.length,
    stars: repos.reduce((a, r) => a + r.stars, 0),
    forks: repos.reduce((a, r) => a + r.forks, 0),
    open_prs: prs.length,
    ready_prs: prs.filter((p) => p.bucket === 'ready').length,
    open_issues: issues.length,
  },
  repos,
  prs,
  issues,
};

// Star/fork history, one snapshot per day (public numbers only).
const histUrl = new URL('history.json', OUT);
let history = {};
try {
  history = JSON.parse(await readFile(histUrl, 'utf8'));
} catch {}
const today = data.generated_at.slice(0, 10);
history[today] = Object.fromEntries(repos.map((r) => [r.full_name, { stars: r.stars, forks: r.forks }]));
const keep = Object.keys(history).sort().slice(-400);
history = Object.fromEntries(keep.map((k) => [k, history[k]]));

await mkdir(OUT, { recursive: true });
await writeFile(new URL('public.json', OUT), JSON.stringify(data, null, 2) + '\n');
await writeFile(histUrl, JSON.stringify(history, null, 2) + '\n');
console.log(`Wrote ${repos.length} repos, ${prs.length} PRs, ${issues.length} issues`);
