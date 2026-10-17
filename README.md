# Open Source Dashboard

One page to watch all of your open source projects: open PRs and what is ready to merge, issues nobody has answered, CI status, stars, releases and a simple health score. No server, no database, no build step.

- **Public view** (what everyone sees): stars, forks, open PRs/issues, CI, releases, health scores.
- **Owner mode** (only you): live traffic stats (views and clones) and **Merge** buttons.

## How it works

```
GitHub Action (every 6h)  ->  scripts/collect.mjs  ->  docs/data/*.json  ->  GitHub Pages (docs/)
                                                                     owner mode talks to api.github.com
                                                                     directly from your browser
```

`scripts/collect.mjs` reads public data and commits `docs/data/public.json` (current state) and `docs/data/history.json` (a daily star/fork snapshot, used for the sparklines and "+N in 30 days").

## Privacy rules (enforced in code and tests)

- Only repos that are **public, not forks, not archived, and pushed to within `max_age_months`**, and **owned by an account listed in `config.json`** are ever included. Nobody can add a repo to your dashboard without a commit to this repo.
- The collector uses the Action's built-in token and only reads public data. **Traffic stats are never collected into the repo** (it is public, so they would leak). Owner mode fetches them live into your browser.
- Your token for owner mode is stored in your browser's `localStorage` and only sent to `api.github.com`. It is rejected unless it belongs to one of the `owners`. "Sign out" deletes it.
- All text from GitHub (PR titles etc.) is rendered as plain text.

## Set up

1. Edit `config.json`:
   ```json
   { "owners": ["todiane"], "exclude": [], "max_age_months": 15, "stale_days": 14, "unanswered_issue_days": 7 }
   ```
   `max_age_months` hides repos that haven't been pushed to for that long (set to `0` to show everything). Repos are listed newest push first. `exclude` takes repo names (`"pipeline"`) or full names (`"todiane/pipeline"`).
2. **Settings → Pages**: deploy from branch `main`, folder `/docs`.
3. **Actions → Collect data → Run workflow** for the first collection. After that it refreshes every 6 hours.
4. Optional, for owner mode: create a [fine-grained token](https://github.com/settings/personal-access-tokens/new) for your account, with access to your public repos and these permissions: *Pull requests: read & write*, *Contents: read & write* (needed to merge), *Administration: read* (needed for traffic). A classic token with the `public_repo` scope also works. Click **Owner mode** and paste it.

### A second account (e.g. a separate Djangify account)

A GitHub token only works for one account, so run a second copy: fork or copy this repo into the other account, set `"owners": ["djangify"]` in its `config.json`, and enable Pages and the Action there. Use a token from that account for its owner mode.

## Merging

The **Merge…** button (owner mode) always asks for confirmation, re-checks the PR on GitHub first (still open, not a draft, no conflicts), and sends the PR's current head commit with the request, so GitHub refuses the merge if new commits landed in the meantime. Nothing merges automatically.

## Health score (0-100)

| Part | Points | Full marks when |
|---|---|---|
| Activity | 25 | pushed in the last 30 days (18 ≤ 90d, 10 ≤ 180d, 4 ≤ 1y) |
| CI | 20 | latest default-branch checks pass (10 if no CI, 12 pending) |
| Licence | 10 | repo has a licence |
| Community files | 15 | GitHub community profile (README, contributing, etc.) |
| PR responsiveness | 15 | no open PR older than `stale_days` |
| Issue responsiveness | 15 | no issue from someone else unanswered for more than `unanswered_issue_days` |

## PR status

`Ready to merge` (CI green, no conflicts, approved or your own) · `Needs your review` · `Waiting on author` (failing CI, conflicts or changes requested) · `CI running` · `Draft`.

## Development

```sh
npm test            # unit tests + collector end-to-end test against a mock GitHub API
npm run collect     # run the collector (set GITHUB_TOKEN to avoid low rate limits)
npm run serve       # preview docs/ at http://localhost:8000
```

No dependencies; Node 20+.
