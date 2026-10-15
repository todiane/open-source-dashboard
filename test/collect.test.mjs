// End-to-end test of the collector against a mock GitHub API.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const owner = { login: 'todiane' };
const mk = (name, o = {}) => ({
  name, full_name: `todiane/${name}`, owner, private: false, fork: false, archived: false, disabled: false,
  default_branch: 'main', stargazers_count: 5, forks_count: 1, subscribers_count: 2, language: 'Python',
  license: { spdx_id: 'MIT' }, topics: [], description: 'd', pushed_at: new Date().toISOString(), ...o,
});

const repos = [
  mk('good'),
  mk('secret', { private: true }),
  mk('forked', { fork: true }),
  mk('old', { archived: true }),
  mk('stranger', { owner: { login: 'someone-else' }, full_name: 'someone-else/stranger' }),
];

const now = new Date().toISOString();
const routes = {
  '/users/todiane/repos': () => repos,
  '/repos/todiane/good/pulls': () => [
    { number: 1, title: '<img src=x onerror=alert(1)>', user: { login: 'contrib', type: 'User' }, draft: false,
      created_at: now, updated_at: now, head: { sha: 'abc' } },
  ],
  '/repos/todiane/good/pulls/1': () => ({ mergeable_state: 'clean', comments: 2, review_comments: 0, additions: 3, deletions: 1 }),
  '/repos/todiane/good/pulls/1/reviews': () => [{ user: { login: 'todiane' }, state: 'APPROVED' }],
  '/repos/todiane/good/issues': () => [
    { number: 2, title: 'bug', user: { login: 'someone' }, comments: 0, created_at: now, updated_at: now, labels: [{ name: 'bug' }] },
    { number: 1, title: 'a PR', pull_request: {}, user: { login: 'contrib' }, comments: 0, created_at: now, updated_at: now, labels: [] },
  ],
  '/repos/todiane/good/releases/latest': () => ({ tag_name: 'v1', published_at: now, html_url: 'https://github.com/todiane/good/releases/v1' }),
  '/repos/todiane/good/compare/v1...main': () => ({ ahead_by: 3 }),
  '/repos/todiane/good/community/profile': () => ({ health_percentage: 80 }),
};
const ciOk = { check_runs: [{ status: 'completed', conclusion: 'success' }] };

test('collector writes only eligible public repos', async () => {
  const hit = [];
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    hit.push(path);
    let body = null;
    if (path.endsWith('/check-runs')) body = ciOk;
    else if (path.endsWith('/status')) body = { state: 'success', total_count: 0 };
    else if (routes[path]) body = routes[path]();
    res.statusCode = body ? 200 : 404;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body ?? { message: 'Not Found' }));
  });
  await new Promise((r) => server.listen(0, r));
  const out = await mkdtemp(join(tmpdir(), 'osd-'));
  try {
    await new Promise((resolve, reject) =>
      execFile(process.execPath, ['scripts/collect.mjs'], {
        env: { ...process.env, GITHUB_TOKEN: '', GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`, OUT_DIR: out },
      }, (err, stdout, stderr) => (err ? reject(new Error(stderr || stdout)) : resolve())),
    );
  } finally {
    server.close();
  }

  const data = JSON.parse(await readFile(join(out, 'public.json'), 'utf8'));
  assert.deepEqual(data.repos.map((r) => r.full_name), ['todiane/good']);
  assert.equal(data.totals.open_prs, 1);
  assert.equal(data.totals.ready_prs, 1);
  assert.equal(data.prs[0].bucket, 'ready');
  assert.equal(data.prs[0].url, 'https://github.com/todiane/good/pull/1');
  assert.equal(data.issues.length, 1, 'PRs listed by the issues API are not counted as issues');
  assert.equal(data.issues[0].unanswered, true);
  assert.equal(data.repos[0].unreleased_commits, 3);
  assert.equal(data.repos[0].health.score, 97); // community 80% = 12/15
  // Nothing about excluded repos may be requested or leak into the output.
  const raw = JSON.stringify(data);
  for (const name of ['secret', 'forked', 'stranger']) assert.ok(!raw.includes(name));
  assert.ok(!hit.some((p) => /secret|forked|stranger|traffic/.test(p)));

  const history = JSON.parse(await readFile(join(out, 'history.json'), 'utf8'));
  assert.deepEqual(Object.values(history)[0], { 'todiane/good': { stars: 5, forks: 1 } });
});
