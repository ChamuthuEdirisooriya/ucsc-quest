import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import * as game from '../src/game.js';

function setup({ milestones = 3, checkpoints = 5, paths = 3 } = {}) {
  const db = openDb(':memory:');
  const huntId = game.createHunt(db, { name: 'Test hunt', milestones });
  game.createCodes(db, huntId, 'checkpoint', Array.from({ length: checkpoints }, (_, i) => ({ label: `Spot ${i + 1}` })));
  game.createCodes(db, huntId, 'decoy', [{ label: 'Decoy', message: 'Nice try!' }]);
  game.generatePaths(db, huntId, paths);
  const bundle = game.getBundle(db, huntId);
  for (const p of bundle.paths) {
    game.savePath(db, p.id, {
      start_clue: `start ${p.name}`,
      steps: p.steps.map((s) => ({ code_id: s.code_id, clue: `${p.name} clue ${s.position}` })),
    });
  }
  game.updateHunt(db, huntId, { status: 'live' });
  const codes = game.getBundle(db, huntId).codes;
  const byKind = (k) => codes.filter((c) => c.kind === k);
  return { db, huntId, start: byKind('start')[0].cards[0], finish: byKind('finish')[0].id, decoy: byKind('decoy')[0].cards[0] };
}

const stepsOf = (db, huntId, team) => game.getBundle(db, huntId).paths.find((p) => p.id === team.path_id).steps;
// The card that is currently real at a location.
const real = (db, codeId) => game.getCard(db, game.realCardId(db, game.getCode(db, codeId)));
const fakes = (db, codeId) => {
  const realId = game.realCardId(db, game.getCode(db, codeId));
  return db.prepare('SELECT * FROM cards WHERE code_id = ? AND id != ?').all(codeId, realId);
};

test('generated paths all have the same number of distinct milestones', () => {
  const { db, huntId } = setup({ milestones: 4, checkpoints: 6, paths: 5 });
  const { paths } = game.getBundle(db, huntId);
  assert.equal(paths.length, 5);
  for (const p of paths) {
    const ids = p.steps.map((s) => s.code_id);
    assert.equal(ids.length, 4);
    assert.equal(new Set(ids).size, 4);
  }
  // 6 checkpoints, 5 paths: first stops should be spread out
  assert.equal(new Set(paths.map((p) => p.steps[0].code_id)).size, 5);
});

test('teams are spread across different paths', () => {
  const { db, huntId, start } = setup({ paths: 3 });
  const teams = ['A', 'B', 'C'].map((n) => game.registerTeam(db, huntId, n, start));
  assert.equal(new Set(teams.map((t) => t.path_id)).size, 3);
  assert.throws(() => game.registerTeam(db, huntId, 'a', start), /already taken/);
});

test('a team walks its path to the shared destination', () => {
  const { db, huntId, start, finish } = setup();
  let team = game.registerTeam(db, huntId, 'Walkers', start);
  const steps = stepsOf(db, huntId, team);
  assert.match(game.teamView(db, team).clue, /^start /);

  assert.equal(game.scanCard(db, real(db, finish), team).type, 'early');
  assert.equal(game.scanCard(db, real(db, steps[1].code_id), team).type, 'off-path'); // ahead of itself

  for (const s of steps) {
    const r = game.scanCard(db, real(db, s.code_id), team);
    assert.equal(r.type, 'found');
    assert.equal(r.position, s.position);
    team = game.getTeamByToken(db, huntId, team.token);
    assert.equal(game.teamView(db, team).clue, s.clue);
  }
  assert.equal(game.scanCard(db, real(db, steps[0].code_id), team).type, 'again');
  const done = game.scanCard(db, real(db, finish), team);
  assert.deepEqual(done, { type: 'finished', justFinished: true });
  team = game.getTeamByToken(db, huntId, team.token);
  assert.equal(game.teamView(db, team).rank, 1);
});

test('a shared QR gives each path its own clue; other paths see off-path', () => {
  const db = openDb(':memory:');
  const huntId = game.createHunt(db, { name: 'Overlap', milestones: 2 });
  const [shared, onlyA, onlyB] = game.createCodes(db, huntId, 'checkpoint', [{ label: 'Shared' }, { label: 'A only' }, { label: 'B only' }]);
  const [unused] = game.createCodes(db, huntId, 'checkpoint', [{ label: 'Nobody' }]);
  const pa = game.createPath(db, huntId);
  const pb = game.createPath(db, huntId);
  game.savePath(db, pa, { start_clue: 'go', steps: [{ code_id: shared, clue: 'A: shared -> A only' }, { code_id: onlyA, clue: 'A: to finish' }] });
  game.savePath(db, pb, { start_clue: 'go', steps: [{ code_id: onlyB, clue: 'B: to shared' }, { code_id: shared, clue: 'B: shared -> finish' }] });
  game.updateHunt(db, huntId, { status: 'live' });
  const start = game.getBundle(db, huntId).codes.find((c) => c.kind === 'start').cards[0];

  let a = game.registerTeam(db, huntId, 'A', start);
  let b = game.registerTeam(db, huntId, 'B', start);
  if (a.path_id !== pa) [a, b] = [b, a];

  game.scanCard(db, real(db, shared), a);
  a = game.getTeamByToken(db, huntId, a.token);
  assert.equal(game.teamView(db, a).clue, 'A: shared -> A only');

  assert.equal(game.scanCard(db, real(db, onlyA), b).type, 'off-path');
  assert.equal(game.scanCard(db, real(db, unused), b).type, 'off-path');
  game.scanCard(db, real(db, onlyB), b);
  game.scanCard(db, real(db, shared), b);
  b = game.getTeamByToken(db, huntId, b.token);
  assert.equal(game.teamView(db, b).clue, 'B: shared -> finish');
});

test('standalone decoys show their message and never change progress', () => {
  const { db, huntId, start, decoy } = setup();
  const team = game.registerTeam(db, huntId, 'Fooled', start);
  assert.deepEqual(game.scanCard(db, decoy, team), { type: 'decoy', message: 'Nice try!' });
  assert.deepEqual(game.scanCard(db, decoy, null), { type: 'decoy', message: 'Nice try!' });
  assert.equal(game.getTeamByToken(db, huntId, team.token).progress, 0);
});

test('each checkpoint gets one real card plus decoy cards', () => {
  const { db, huntId } = setup();
  for (const c of game.getBundle(db, huntId).codes.filter((c) => c.kind === 'checkpoint')) {
    assert.equal(c.cards.length, 5); // default: 1 real + 4 decoys
    assert.ok(c.cards.some((k) => k.id === c.real_card_id));
  }
});

test('decoy cards at a location do nothing; the real card moves after it is scanned', () => {
  const { db, huntId, start } = setup();
  let team = game.registerTeam(db, huntId, 'Seekers', start);
  const first = stepsOf(db, huntId, team)[0].code_id;

  for (const fake of fakes(db, first)) {
    const r = game.scanCard(db, fake, team);
    assert.equal(r.type, 'decoy');
    assert.match(r.message, /real code is hiding/);
  }
  assert.equal(game.getTeamByToken(db, huntId, team.token).progress, 0);

  const realCard = real(db, first);
  assert.equal(game.scanCard(db, realCard, team).type, 'found');
  const moved = real(db, first);
  assert.notEqual(moved.id, realCard.id);
  // Copying the card the last team scanned no longer works.
  let other = game.registerTeam(db, huntId, 'Copycats', start);
  assert.equal(game.scanCard(db, realCard, other).type, 'decoy');
});

test('the real card shuffles on a timer between shuffle_min and shuffle_max minutes', () => {
  const { db, huntId } = setup();
  game.updateHunt(db, huntId, { shuffle_min: 5, shuffle_max: 10 });
  const cp = game.getBundle(db, huntId).codes.find((c) => c.kind === 'checkpoint');
  const t0 = Date.now();
  const id0 = game.shuffleRealCard(db, cp.id, t0);
  const due = Date.parse(game.getCode(db, cp.id).next_shuffle_at);
  assert.ok(due >= t0 + 5 * 60_000 && due <= t0 + 10 * 60_000);
  assert.equal(game.realCardId(db, cp, t0 + 4 * 60_000), id0);
  assert.notEqual(game.realCardId(db, cp, t0 + 11 * 60_000), id0);
});

test('cards can be added and removed at a location', () => {
  const { db, huntId } = setup();
  const cp = game.getBundle(db, huntId).codes.find((c) => c.kind === 'checkpoint');
  game.updateCode(db, cp.id, { cards: 7 });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM cards WHERE code_id = ?').get(cp.id).n, 7);
  game.updateCode(db, cp.id, { cards: 1 });
  const only = db.prepare('SELECT * FROM cards WHERE code_id = ?').all(cp.id);
  assert.equal(only.length, 1);
  assert.equal(game.realCardId(db, game.getCode(db, cp.id)), only[0].id);
  assert.throws(() => game.updateCode(db, cp.id, { cards: 0 }), /between 1 and/);
});

test('cannot go live with incomplete paths or reuse a checkpoint in one path', () => {
  const db = openDb(':memory:');
  const huntId = game.createHunt(db, { name: 'Broken', milestones: 2 });
  const [c1] = game.createCodes(db, huntId, 'checkpoint', [{ label: 'One' }]);
  const p = game.createPath(db, huntId);
  assert.throws(() => game.savePath(db, p, { steps: [{ code_id: c1 }, { code_id: c1 }] }), /same checkpoint twice/);
  game.savePath(db, p, { start_clue: 'x', steps: [{ code_id: c1, clue: 'y' }] });
  assert.throws(() => game.updateHunt(db, huntId, { status: 'live' }), /before going live/);
});

// Pin when each team's advances happened (scans and the team's own record agree).
function arrivedAt(db, team, ...times) {
  const advances = db.prepare("SELECT id FROM scans WHERE team_id = ? AND result = 'advance' ORDER BY id").all(team.id);
  advances.forEach((s, i) => db.prepare('UPDATE scans SET at = ? WHERE id = ?').run(times[i], s.id));
  db.prepare('UPDATE teams SET progress_at = ? WHERE id = ?').run(times.at(-1), team.id);
}

test('the live board ranks equal progress by who reached it first, not by the last scan', () => {
  const { db, huntId, start, decoy } = setup();
  // Registered first, so a tie-break on id alone would wrongly put Late ahead.
  const late = game.registerTeam(db, huntId, 'Late', start);
  const early = game.registerTeam(db, huntId, 'Early', start);
  game.scanCard(db, real(db, stepsOf(db, huntId, early)[0].code_id), early);
  game.scanCard(db, real(db, stepsOf(db, huntId, late)[0].code_id), late);
  arrivedAt(db, early, '2026-10-17T10:05:00.000Z');
  arrivedAt(db, late, '2026-10-17T10:20:00.000Z');
  game.scanCard(db, decoy, early); // a later decoy scan must not cost Early its place
  assert.deepEqual(game.liveData(db, huntId).teams.map((t) => t.name), ['Early', 'Late']);
});

test('moving a team back keeps the time it first reached that milestone', () => {
  const { db, huntId, start } = setup({ paths: 1 });
  const a = game.registerTeam(db, huntId, 'A', start);
  const b = game.registerTeam(db, huntId, 'B', start);
  const steps = stepsOf(db, huntId, a);
  game.scanCard(db, real(db, steps[0].code_id), a);
  game.scanCard(db, real(db, steps[1].code_id), a);
  game.scanCard(db, real(db, steps[0].code_id), b);
  arrivedAt(db, a, '2026-10-17T10:00:00.000Z', '2026-10-17T10:10:00.000Z');
  arrivedAt(db, b, '2026-10-17T10:05:00.000Z');
  game.updateTeam(db, a.id, { progress: 1 }); // the organiser takes milestone 2 away
  assert.deepEqual(game.liveData(db, huntId).teams.map((t) => [t.name, t.progress]), [['A', 1], ['B', 1]]);
});

test('a dialog left open cannot undo progress the team made since', () => {
  const { db, huntId, start, finish } = setup();
  const team = game.registerTeam(db, huntId, 'Runners', start);
  const seen = { path_id: team.path_id, progress: 0, finished_at: null };
  for (const s of stepsOf(db, huntId, team)) game.scanCard(db, real(db, s.code_id), team);
  game.scanCard(db, real(db, finish), team);

  // The stale dialog still shows 0: correcting progress from it is refused...
  assert.throws(() => game.updateTeam(db, team.id, { progress: 0, expect: seen }), (err) => err.status === 409);
  // ...but a rename alone goes through and leaves the finish alone.
  game.updateTeam(db, team.id, { name: 'Runners Up', expect: seen });
  const after = db.prepare('SELECT name, progress, finished_at FROM teams WHERE id = ?').get(team.id);
  assert.equal(after.name, 'Runners Up');
  assert.equal(after.progress, 3);
  assert.ok(after.finished_at);
});

test('checkpoints a team has found stay fixed, and a followed path stays complete', () => {
  const { db, huntId, start } = setup({ paths: 1 });
  const team = game.registerTeam(db, huntId, 'Movers', start);
  const steps = stepsOf(db, huntId, team);
  game.scanCard(db, real(db, steps[0].code_id), team);
  const edit = (order, clue = 'x') => game.savePath(db, team.path_id, { steps: order.map((i) => ({ code_id: steps[i].code_id, clue })) });

  assert.throws(() => edit([1, 0, 2]), /milestone 1.*already found/i); // swapping a found stop
  assert.throws(() => game.savePath(db, team.path_id, { steps: [] }), /already found/); // clearing the route
  assert.throws(() => edit([0]), /stay complete/); // clearing the stops still ahead
  assert.throws(() => edit([0, 1, 2], ''), /stay complete/); // blanking the clues
  edit([0, 2, 1]); // stops not found yet can still move
  // The team was not credited with anything it did not find.
  assert.equal(game.scanCard(db, real(db, steps[0].code_id), team).type, 'again');
  assert.equal(game.scanCard(db, real(db, steps[2].code_id), team).type, 'found');
});

test('a live hunt always keeps a path that new teams can be given', () => {
  const { db, huntId } = setup({ paths: 2 });
  const [a, b] = game.getBundle(db, huntId).paths.map((p) => p.id);
  assert.throws(() => game.generatePaths(db, huntId, 2, { replace: true }), /no ready path/);
  game.deletePath(db, a);
  assert.throws(() => game.deletePath(db, b), /no ready path/);
  assert.throws(() => game.savePath(db, b, { start_clue: '' }), /no ready path/);
  assert.equal(game.getBundle(db, huntId).paths.length, 1);
  // Paused, the organiser can rebuild the paths from scratch.
  game.updateHunt(db, huntId, { status: 'draft' });
  game.generatePaths(db, huntId, 2, { replace: true });
});

test('teams can only be moved to a path that is ready', () => {
  const { db, huntId, start } = setup();
  const team = game.registerTeam(db, huntId, 'Wanderers', start);
  const empty = game.createPath(db, huntId);
  assert.throws(() => game.updateTeam(db, team.id, { path_id: empty }), /not ready/);
  const other = game.getBundle(db, huntId).paths.find((p) => p.id !== team.path_id && p.id !== empty);
  game.updateTeam(db, team.id, { path_id: other.id });
  assert.equal(db.prepare('SELECT path_id FROM teams WHERE id = ?').get(team.id).path_id, other.id);
});

test('generated paths never repeat a route while another route is free', () => {
  for (let run = 0; run < 40; run++) {
    const db = openDb(':memory:');
    const huntId = game.createHunt(db, { name: 'Routes', milestones: 2 });
    game.createCodes(db, huntId, 'checkpoint', [{ label: 'a' }, { label: 'b' }, { label: 'c' }]);
    game.generatePaths(db, huntId, 4);
    game.generatePaths(db, huntId, 2); // 3 checkpoints, 2 stops: exactly 6 routes exist
    const routes = game.getBundle(db, huntId, { cards: false }).paths.map((p) => p.steps.map((s) => s.code_id).join());
    assert.equal(new Set(routes).size, 6, `run ${run}: ${routes.join(' | ')}`);
    assert.throws(() => game.generatePaths(db, huntId, 1), /only 6 different routes.*at most 0 more/);
  }
});

test('changing milestones on a live hunt is refused when it would break every path', () => {
  const { db, huntId } = setup();
  assert.throws(() => game.updateHunt(db, huntId, { milestones: 4 }), /unplayable/);
  assert.equal(game.getHunt(db, huntId).milestones, 3);
});

test('new paths never reuse the name or colour of an existing path', () => {
  const db = openDb(':memory:');
  const huntId = game.createHunt(db, { name: 'Names', milestones: 1 });
  const [a, b, c] = [game.createPath(db, huntId), game.createPath(db, huntId), game.createPath(db, huntId)];
  game.deletePath(db, b);
  const d = game.createPath(db, huntId);
  const rows = db.prepare('SELECT id, name, color FROM paths ORDER BY id').all();
  assert.deepEqual(rows.map((r) => r.name), ['Path A', 'Path C', 'Path B']);
  assert.equal(new Set(rows.map((r) => r.color)).size, 3);
  assert.ok([a, c, d].every(Boolean));
  assert.throws(() => game.createPath(db, huntId, { color: 'red;' }), /Colour/);
});

test('bad input is rejected with a clear message', () => {
  const { db, huntId, start } = setup();
  assert.throws(() => game.createCodes(db, huntId, 'checkpoint', [null]), game.UserError);
  const team = game.registerTeam(db, huntId, 'Short', start);
  assert.throws(() => game.updateTeam(db, team.id, { name: 'x'.repeat(41) }), /40 characters/);
  assert.throws(() => game.registerTeam(db, huntId, 'y'.repeat(41), start), /40 characters/);
});
