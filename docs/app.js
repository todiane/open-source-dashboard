// Open Source Dashboard. Public view reads data/public.json; owner mode adds
// live traffic and merge buttons using a token that never leaves this browser.
const $ = (s) => document.querySelector(s);
const API = 'https://api.github.com';
const TOKEN_KEY = 'osd_token';
const DAY = 86_400_000;

// ---- tiny DOM helper: text is always set via textContent (titles are untrusted) ----
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'href') el.setAttribute('href', safeUrl(v));
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const safeUrl = (u) => (String(u).startsWith('https://github.com/') ? u : '#');
const link = (url, text, extra = {}) => h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', ...extra }, text);
const clear = (el) => el.replaceChildren();
const ago = (iso, now = Date.now()) => {
  if (!iso) return '–';
  const d = Math.floor((now - new Date(iso)) / DAY);
  if (d < 1) return 'today';
  if (d < 60) return `${d}d ago`;
  if (d < 730) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
};
const ageDays = (iso) => Math.floor((Date.now() - new Date(iso)) / DAY);
const fmt = (n) => (n == null ? '–' : n.toLocaleString());

const BUCKETS = {
  ready: ['Ready to merge', 'good'],
  needs_review: ['Needs your review', 'info'],
  needs_changes: ['Waiting on author', 'warn'],
  pending: ['CI running', 'neutral'],
  draft: ['Draft', 'neutral'],
};

const state = { data: null, history: {}, filter: 'all', sort: { key: 'stars', dir: -1 }, token: null, me: null, traffic: null };

// ---- load ----
async function load() {
  try {
    const [d, hist] = await Promise.all([
      fetch('data/public.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)),
      fetch('data/history.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]);
    state.data = d;
    state.history = hist || {};
  } catch {
    state.data = null;
  }
  render();
}

// ---- derived data ----
function starDelta(full, days) {
  const dates = Object.keys(state.history).sort();
  if (!dates.length) return null;
  const latest = state.history[dates[dates.length - 1]]?.[full]?.stars;
  const cutoff = new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
  const base = dates.filter((d) => d <= cutoff).pop() ?? dates[0];
  const prev = state.history[base]?.[full]?.stars;
  return latest == null || prev == null ? null : latest - prev;
}
const starSeries = (full) => Object.keys(state.history).sort().map((d) => state.history[d]?.[full]?.stars).filter((v) => v != null);

function sparkline(vals) {
  if (vals.length < 2) return null;
  const w = 60, hgt = 18, min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const pts = vals.map((v, i) => `${i ? 'L' : 'M'}${((i / (vals.length - 1)) * w).toFixed(1)} ${(hgt - 2 - ((v - min) / span) * (hgt - 4)).toFixed(1)}`).join('');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'spark'); svg.setAttribute('width', w); svg.setAttribute('height', hgt);
  svg.setAttribute('viewBox', `0 0 ${w} ${hgt}`); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Star history');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', pts); svg.append(p);
  return svg;
}

function attentionItems() {
  const { repos, prs, issues, config } = state.data;
  const items = [];
  for (const r of repos) if (r.ci === 'failing') items.push({ p: 0, tag: ['CI failing', 'bad'], what: link(r.url, r.full_name), note: `default branch (${r.default_branch})`, meta: '' });
  for (const p of prs) {
    if (p.bucket === 'ready') items.push({ p: 1, tag: ['Ready to merge', 'good'], what: [link(p.url, `${p.repo}#${p.number}`), ' ', p.title], meta: `by ${p.author} · ${ageDays(p.created_at)}d` });
    else if (p.bucket === 'needs_review') items.push({ p: 2, tag: ['Needs review', 'info'], what: [link(p.url, `${p.repo}#${p.number}`), ' ', p.title], meta: `by ${p.author} · ${ageDays(p.created_at)}d` });
    if (!p.draft && ageDays(p.updated_at) > config.stale_days) items.push({ p: 3, tag: ['Stale PR', 'warn'], what: [link(p.url, `${p.repo}#${p.number}`), ' ', p.title], meta: `no activity ${ageDays(p.updated_at)}d` });
  }
  for (const i of issues) if (i.unanswered && ageDays(i.created_at) >= config.unanswered_issue_days) items.push({ p: 4, tag: ['No reply yet', 'warn'], what: [link(i.url, `${i.repo}#${i.number}`), ' ', i.title], meta: `by ${i.author} · ${ageDays(i.created_at)}d` });
  for (const r of repos) if ((r.unreleased_commits ?? 0) >= 10) items.push({ p: 5, tag: ['Unreleased', 'neutral'], what: link(r.url, r.full_name), note: `${r.unreleased_commits} commits since ${r.latest_release.tag}`, meta: '' });
  return items.sort((a, b) => a.p - b.p);
}

// ---- render ----
function render() {
  const d = state.data;
  const empty = $('#empty');
  const show = (ids, on) => ids.forEach((id) => ($(id).hidden = !on));
  if (!d || !d.generated_at) {
    $('#sub').textContent = 'No data yet';
    clear(empty);
    empty.append(h('p', {}, 'No data has been collected yet. Run the “Collect data” workflow in the repository’s Actions tab (or wait for the next scheduled run), then refresh.'));
    empty.hidden = false;
    show(['#attention-sec', '#prs-sec', '#repos-sec', '#traffic-sec'], false);
    clear($('#tiles'));
    return;
  }
  empty.hidden = true;
  $('#sub').textContent = `${d.owners.join(' + ')} · updated ${ago(d.generated_at)} · ${d.repos.length} public repos`;

  renderTiles();
  renderAttention();
  renderPRs();
  renderRepos();
  renderTraffic();
  renderOwnerCtl();
}

function renderTiles() {
  const { totals: t, repos } = state.data;
  const gained = repos.reduce((a, r) => a + (starDelta(r.full_name, 30) ?? 0), 0);
  const attn = attentionItems().filter((i) => i.p <= 2).length;
  const tile = (n, l, d) => h('div', { class: 'tile' }, h('div', { class: 'n' }, fmt(n)), h('div', { class: 'l' }, l), d ? h('div', { class: 'd' }, d) : null);
  const el = $('#tiles');
  clear(el);
  el.append(
    tile(t.repos, 'Repositories'),
    tile(t.stars, 'Stars', gained > 0 ? `+${gained} in 30 days` : null),
    tile(t.forks, 'Forks'),
    tile(t.open_prs, 'Open PRs'),
    tile(t.ready_prs, 'Ready to merge'),
    tile(t.open_issues, 'Open issues'),
    tile(attn, 'Need you now'),
  );
}

function renderAttention() {
  const items = attentionItems();
  $('#attention-sec').hidden = false;
  $('#attention-count').textContent = items.length ? `(${items.length})` : '';
  const ul = $('#attention');
  clear(ul);
  if (!items.length) { ul.append(h('li', {}, h('span', { class: 'what muted' }, 'Nothing needs attention. Nice.'))); return; }
  for (const i of items.slice(0, 40)) {
    ul.append(h('li', {}, h('span', { class: `badge ${i.tag[1]}` }, i.tag[0]), h('span', { class: 'what' }, i.what, i.note ? ` – ${i.note}` : ''), h('span', { class: 'meta' }, i.meta)));
  }
}

function renderPRs() {
  const { prs } = state.data;
  $('#prs-sec').hidden = false;
  $('#prs-count').textContent = `(${prs.length})`;
  const chips = $('#pr-filters');
  clear(chips);
  const counts = { all: prs.length };
  for (const p of prs) counts[p.bucket] = (counts[p.bucket] || 0) + 1;
  for (const key of ['all', ...Object.keys(BUCKETS)]) {
    if (key !== 'all' && !counts[key]) continue;
    chips.append(h('button', { class: 'chip', type: 'button', 'aria-pressed': String(state.filter === key), onclick: () => { state.filter = key; renderPRs(); } }, `${key === 'all' ? 'All' : BUCKETS[key][0]} ${counts[key]}`));
  }
  const rows = prs.filter((p) => state.filter === 'all' || p.bucket === state.filter);
  const tbl = $('#prs');
  clear(tbl);
  if (!rows.length) { tbl.append(h('tbody', {}, h('tr', {}, h('td', { class: 'muted' }, 'No open pull requests.')))); return; }
  const canMerge = (p) => state.me && p.repo.split('/')[0].toLowerCase() === state.me.toLowerCase();
  tbl.append(
    h('thead', {}, h('tr', {}, h('th', {}, 'Pull request'), h('th', {}, 'Status'), h('th', {}, 'CI'), h('th', { class: 'hide-sm' }, 'Author'), h('th', { class: 'num' }, 'Age'), h('th', {}, ''))),
    h('tbody', {}, rows.map((p) => h('tr', {},
      h('td', { class: 'title' }, link(p.url, `${p.repo}#${p.number}`), h('br'), p.title),
      h('td', {}, h('span', { class: `badge ${BUCKETS[p.bucket][1]}` }, BUCKETS[p.bucket][0])),
      h('td', {}, h('span', { class: `dot ${p.ci}` }), p.ci),
      h('td', { class: 'hide-sm' }, p.author, p.author_is_bot ? ' 🤖' : ''),
      h('td', { class: 'num' }, `${ageDays(p.created_at)}d`),
      h('td', {}, canMerge(p) && !p.draft ? h('button', { class: 'btn small', type: 'button', onclick: () => openMerge(p) }, 'Merge…') : null),
    ))),
  );
}

function scoreClass(s) { return s >= 80 ? 'good' : s >= 55 ? 'warn' : 'bad'; }
const PART_LABELS = { activity: ['Activity', 25], ci: ['CI', 20], license: ['Licence', 10], community: ['Community files', 15], prs: ['PR responsiveness', 15], issues: ['Issue responsiveness', 15] };

function renderRepos() {
  const { repos } = state.data;
  $('#repos-sec').hidden = false;
  $('#repos-count').textContent = `(${repos.length})`;
  const { key, dir } = state.sort;
  const val = { name: (r) => r.full_name.toLowerCase(), health: (r) => r.health.score, stars: (r) => r.stars, forks: (r) => r.forks, prs: (r) => r.open_prs, issues: (r) => r.open_issues, pushed: (r) => r.pushed_at }[key];
  const sorted = [...repos].sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * dir);
  const th = (k, label, cls = '') => h('th', { class: cls, 'aria-sort': key === k ? (dir > 0 ? 'ascending' : 'descending') : 'none' }, h('button', { type: 'button', onclick: () => { state.sort = { key: k, dir: key === k ? -dir : -1 }; renderRepos(); } }, label + (key === k ? (dir > 0 ? ' ▲' : ' ▼') : '')));
  const tbl = $('#repos');
  clear(tbl);
  const body = h('tbody');
  for (const r of sorted) {
    const detail = h('tr', { class: 'breakdown', hidden: true }, h('td', { colspan: 8 }, Object.entries(r.health.parts).map(([k, v]) => `${PART_LABELS[k][0]} ${v}/${PART_LABELS[k][1]}`).join(' · ')));
    const delta = starDelta(r.full_name, 30);
    body.append(
      h('tr', {},
        h('td', { class: 'title' }, link(r.url, r.full_name), r.description ? h('div', { class: 'repo-desc' }, r.description) : null),
        h('td', {}, h('button', { class: `score ${scoreClass(r.health.score)}`, type: 'button', 'aria-expanded': 'false', title: 'Show breakdown', onclick: (e) => { detail.hidden = !detail.hidden; e.currentTarget.setAttribute('aria-expanded', String(!detail.hidden)); } }, r.health.score)),
        h('td', { class: 'num' }, `★ ${fmt(r.stars)}`, delta ? h('span', { class: 'muted small' }, ` +${delta}`) : null, sparkline(starSeries(r.full_name))),
        h('td', { class: 'num hide-sm' }, fmt(r.forks)),
        h('td', { class: 'num' }, r.open_prs ? link(`${r.url}/pulls`, r.open_prs) : '0'),
        h('td', { class: 'num' }, r.open_issues ? link(`${r.url}/issues`, r.open_issues) : '0'),
        h('td', {}, h('span', { class: `dot ${r.ci}`, title: `CI: ${r.ci}` }), ago(r.pushed_at)),
        h('td', { class: 'hide-sm' }, r.latest_release ? [link(r.latest_release.url, r.latest_release.tag), r.unreleased_commits ? h('span', { class: 'muted small' }, ` +${r.unreleased_commits}`) : null] : h('span', { class: 'muted' }, 'none')),
      ),
      detail,
    );
  }
  tbl.append(h('thead', {}, h('tr', {}, th('name', 'Repository'), th('health', 'Health'), th('stars', 'Stars', 'num'), th('forks', 'Forks', 'num hide-sm'), th('prs', 'PRs', 'num'), th('issues', 'Issues', 'num'), th('pushed', 'Last push'), h('th', { class: 'hide-sm' }, 'Release'))), body);
}

// ---- owner mode ----
function renderOwnerCtl() {
  const badge = $('#owner-badge'), btn = $('#owner-btn');
  if (state.me) { badge.hidden = false; badge.textContent = `owner: ${state.me}`; badge.className = 'badge good'; btn.textContent = 'Sign out'; }
  else { badge.hidden = true; btn.textContent = 'Owner mode'; }
}

async function gh(path, opts = {}) {
  const res = await fetch(API + path, { ...opts, headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', authorization: `Bearer ${state.token}`, ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(body.message || `GitHub ${res.status}`); e.status = res.status; throw e; }
  return body;
}

async function signIn(token) {
  state.token = token;
  const me = await gh('/user'); // throws on a bad token
  const owners = state.data.owners.map((o) => o.toLowerCase());
  if (!owners.includes(me.login.toLowerCase())) {
    state.token = null;
    throw new Error(`This token belongs to “${me.login}”, which is not one of this dashboard’s owners (${state.data.owners.join(', ')}).`);
  }
  state.me = me.login;
  try { localStorage.setItem(TOKEN_KEY, token); } catch {}
  render();
  loadTraffic();
}

function signOut() {
  state.token = null; state.me = null; state.traffic = null;
  try { localStorage.removeItem(TOKEN_KEY); } catch {}
  render();
}

async function loadTraffic() {
  const mine = state.data.repos.filter((r) => r.owner.toLowerCase() === state.me.toLowerCase());
  state.traffic = {};
  renderTraffic();
  for (const r of mine) {
    try {
      const [views, clones] = await Promise.all([gh(`/repos/${r.full_name}/traffic/views`), gh(`/repos/${r.full_name}/traffic/clones`)]);
      state.traffic[r.full_name] = { views, clones };
    } catch (e) {
      state.traffic[r.full_name] = { error: e.status === 403 || e.status === 404 ? 'No access (token needs Administration: read)' : e.message };
    }
    renderTraffic();
  }
}

function renderTraffic() {
  const sec = $('#traffic-sec');
  if (!state.me || !state.traffic) { sec.hidden = true; return; }
  sec.hidden = false;
  const tbl = $('#traffic');
  clear(tbl);
  const rows = state.data.repos.filter((r) => state.traffic[r.full_name]);
  tbl.append(
    h('thead', {}, h('tr', {}, h('th', {}, 'Repository'), h('th', { class: 'num' }, 'Views'), h('th', { class: 'num' }, 'Unique visitors'), h('th', { class: 'num' }, 'Clones'), h('th', { class: 'num' }, 'Unique cloners'), h('th', {}, 'Views, 14 days'))),
    h('tbody', {}, rows.map((r) => {
      const t = state.traffic[r.full_name];
      if (t.error) return h('tr', {}, h('td', {}, r.full_name), h('td', { colspan: 5, class: 'muted' }, t.error));
      return h('tr', {}, h('td', {}, link(r.url, r.full_name)), h('td', { class: 'num' }, fmt(t.views.count)), h('td', { class: 'num' }, fmt(t.views.uniques)), h('td', { class: 'num' }, fmt(t.clones.count)), h('td', { class: 'num' }, fmt(t.clones.uniques)), h('td', {}, sparkline(t.views.views.map((v) => v.count))));
    })),
  );
}

// ---- merge flow (always confirmed, always checks live state first) ----
let mergeTarget = null;
async function openMerge(p) {
  mergeTarget = p;
  $('#merge-title').textContent = `${p.repo}#${p.number} ${p.title}`;
  $('#merge-info').textContent = 'Checking current state…';
  $('#merge-err').hidden = true;
  $('#merge-ok').disabled = true;
  $('#merge-dlg').showModal();
  try {
    const live = await gh(`/repos/${p.repo}/pulls/${p.number}`);
    if (live.state !== 'open' || live.merged) throw new Error('This pull request is no longer open.');
    if (live.draft) throw new Error('This pull request is a draft.');
    if (live.mergeable === false) throw new Error('GitHub reports merge conflicts.');
    mergeTarget = { ...p, head_sha: live.head.sha };
    const changed = live.head.sha !== p.head_sha ? ' It has new commits since the dashboard last refreshed.' : '';
    $('#merge-info').textContent = `Into ${live.base.ref} · mergeable state: ${live.mergeable_state}.${changed} The merge only goes through if the head commit is still ${live.head.sha.slice(0, 7)}.`;
    $('#merge-ok').disabled = false;
  } catch (e) {
    $('#merge-info').textContent = '';
    showErr('#merge-err', e.message);
  }
}
function showErr(sel, msg) { const el = $(sel); el.textContent = msg; el.hidden = false; }

$('#merge-cancel').addEventListener('click', () => $('#merge-dlg').close());
$('#merge-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const p = mergeTarget;
  $('#merge-ok').disabled = true;
  $('#merge-err').hidden = true;
  try {
    await gh(`/repos/${p.repo}/pulls/${p.number}/merge`, { method: 'PUT', body: JSON.stringify({ merge_method: $('#merge-method').value, sha: p.head_sha }) });
    state.data.prs = state.data.prs.filter((x) => !(x.repo === p.repo && x.number === p.number));
    state.data.totals.open_prs = state.data.prs.length;
    state.data.totals.ready_prs = state.data.prs.filter((x) => x.bucket === 'ready').length;
    $('#merge-dlg').close();
    render();
  } catch (err) {
    showErr('#merge-err', err.message);
    $('#merge-ok').disabled = false;
  }
});

$('#owner-btn').addEventListener('click', () => {
  if (state.me) return signOut();
  $('#token-err').hidden = true;
  $('#token-input').value = '';
  $('#token-dlg').showModal();
  $('#token-input').focus();
});
$('#token-cancel').addEventListener('click', () => $('#token-dlg').close());
$('#token-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = $('#token-input').value.trim();
  if (!token) return;
  $('#token-ok').disabled = true;
  try { await signIn(token); $('#token-dlg').close(); }
  catch (err) { showErr('#token-err', err.status === 401 ? 'GitHub rejected that token.' : err.message); }
  finally { $('#token-ok').disabled = false; }
});

await load();
try {
  const saved = localStorage.getItem(TOKEN_KEY);
  if (saved && state.data?.generated_at) await signIn(saved).catch(signOut);
} catch {}
