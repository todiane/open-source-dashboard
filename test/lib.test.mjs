import test from 'node:test';
import assert from 'node:assert/strict';
import { isEligible, isRecent, reviewState, prBucket, healthScore } from '../scripts/lib.mjs';

const cfg = { owners: ['todiane'], exclude: ['skipme'] };
const repo = (o = {}) => ({
  name: 'r', full_name: 'todiane/r', private: false, fork: false, archived: false,
  disabled: false, owner: { login: 'todiane' }, ...o,
});

test('isEligible accepts a public, owned, active repo', () => {
  assert.equal(isEligible(repo(), cfg), true);
});

test('isEligible rejects private, fork, archived, disabled', () => {
  assert.equal(isEligible(repo({ private: true }), cfg), false);
  assert.equal(isEligible(repo({ private: undefined }), cfg), false);
  assert.equal(isEligible(repo({ fork: true }), cfg), false);
  assert.equal(isEligible(repo({ archived: true }), cfg), false);
  assert.equal(isEligible(repo({ disabled: true }), cfg), false);
});

test('isEligible rejects repos owned by someone else (case-insensitive owner match)', () => {
  assert.equal(isEligible(repo({ owner: { login: 'someone' } }), cfg), false);
  assert.equal(isEligible(repo({ owner: { login: 'ToDiane' } }), cfg), true);
});

test('isEligible honours the exclude list by name and full name', () => {
  assert.equal(isEligible(repo({ name: 'skipme' }), cfg), false);
  assert.equal(isEligible(repo(), { ...cfg, exclude: ['todiane/r'] }), false);
});

test('reviewState uses the latest review per user', () => {
  const u = (l) => ({ login: l });
  assert.equal(reviewState([]), 'none');
  assert.equal(reviewState([{ user: u('a'), state: 'APPROVED' }]), 'approved');
  assert.equal(
    reviewState([{ user: u('a'), state: 'CHANGES_REQUESTED' }, { user: u('a'), state: 'APPROVED' }]),
    'approved',
  );
  assert.equal(
    reviewState([{ user: u('a'), state: 'APPROVED' }, { user: u('b'), state: 'CHANGES_REQUESTED' }]),
    'changes_requested',
  );
  assert.equal(reviewState([{ user: u('a'), state: 'COMMENTED' }]), 'none');
});

test('prBucket', () => {
  const o = ['todiane'];
  const base = { draft: false, ci: 'passing', review: 'none', mergeable_state: 'clean', author: 'someone' };
  assert.equal(prBucket({ ...base, draft: true }, o), 'draft');
  assert.equal(prBucket({ ...base, ci: 'failing' }, o), 'needs_changes');
  assert.equal(prBucket({ ...base, mergeable_state: 'dirty' }, o), 'needs_changes');
  assert.equal(prBucket({ ...base, review: 'changes_requested' }, o), 'needs_changes');
  assert.equal(prBucket({ ...base, ci: 'pending' }, o), 'pending');
  assert.equal(prBucket(base, o), 'needs_review');
  assert.equal(prBucket({ ...base, review: 'approved' }, o), 'ready');
  assert.equal(prBucket({ ...base, author: 'Todiane' }, o), 'ready');
});

test('healthScore: perfect repo scores 100, neglected repo scores low', () => {
  const now = Date.parse('2026-10-15T00:00:00Z');
  const c = { stale_days: 14, unanswered_issue_days: 7 };
  const good = healthScore(
    { pushed_at: '2026-10-10T00:00:00Z', ci: 'passing', has_license: true, community: 100,
      oldest_pr_days: null, oldest_unanswered_issue_days: null },
    c, now,
  );
  assert.equal(good.score, 100);
  const bad = healthScore(
    { pushed_at: '2024-01-01T00:00:00Z', ci: 'failing', has_license: false, community: 0,
      oldest_pr_days: 90, oldest_unanswered_issue_days: 90 },
    c, now,
  );
  assert.equal(bad.score, 0);
});

test('isRecent / isEligible apply the max_age_months cutoff', () => {
  const now = Date.parse('2026-10-17T00:00:00Z');
  const recent = repo({ pushed_at: '2025-08-01T00:00:00Z' }); // ~14.5 months
  const old = repo({ pushed_at: '2025-06-01T00:00:00Z' }); // ~16.5 months
  assert.equal(isRecent(recent, 15, now), true);
  assert.equal(isRecent(old, 15, now), false);
  assert.equal(isRecent(old, 0, now), true, 'no limit when unset');
  const c = { ...cfg, max_age_months: 15 };
  assert.equal(isEligible(recent, c, now), true);
  assert.equal(isEligible(old, c, now), false);
});
