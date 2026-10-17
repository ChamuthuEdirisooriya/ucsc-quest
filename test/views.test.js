import test from 'node:test';
import assert from 'node:assert/strict';
import * as views from '../src/views.js';

function view(overrides = {}) {
  return {
    hunt: { id: 1, name: 'UCSC Quest', status: 'live', milestones: 3, finish_message: 'Well done', welcome: 'Hi', shuffle_min: 5, shuffle_max: 10 },
    team: { name: 'Null <Pointers>', join_code: 'ABC123', started_at: '2026-10-17T08:00:00Z', finished_at: null },
    total: 3,
    progress: 1,
    clue: 'Under the <b>oak</b>',
    finished: false,
    rank: null,
    ...overrides,
  };
}

test('team page shows the known flash messages', () => {
  const html = views.teamPage(view(), { s: 'found', n: '1' });
  assert.match(html, /Milestone 1 found/);
  assert.match(html, /class="field f-green"/);
});

test('team page ignores inherited keys and hostile query values', () => {
  for (const s of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    const html = views.teamPage(view(), { s, field: '"><script>alert(1)</script>', n: '<img src=x>' });
    assert.doesNotMatch(html, /<script>alert/);
    assert.doesNotMatch(html, /<img src=x>/);
    assert.match(html, /class="field f-blue"/); // falls back to the plain clue screen
  }
});

test('team page escapes the team name and clue', () => {
  const html = views.teamPage(view(), {});
  assert.match(html, /Null &lt;Pointers&gt;/);
  assert.match(html, /Under the &lt;b&gt;oak&lt;\/b&gt;/);
});

test('finish screen announces the place', () => {
  const html = views.teamPage(view({ finished: true, progress: 3, rank: 2, team: { ...view().team, finished_at: '2026-10-17T08:42:00Z' } }), {});
  assert.match(html, /2nd<span class="sr-only"> place<\/span>/);
  assert.match(html, /42m 0s/);
});
