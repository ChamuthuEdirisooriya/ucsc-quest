import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createApp } from '../src/server.js';
import * as game from '../src/game.js';

// Spin up the real app on a random port with an in-memory database.
async function start({ password = 'secret-pass', db = openDb(':memory:') } = {}) {
  const server = createApp({ db, adminPassword: password }).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { cookie, json, form, body, method, headers } = {}) => fetch(base + path, {
    method: method ?? (json || form || body ? 'POST' : 'GET'),
    redirect: 'manual',
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(json || body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: json ? JSON.stringify(json) : form ? new URLSearchParams(form) : body,
  });
  return { db, base, request, close: () => new Promise((r) => server.close(r)) };
}

const cookieOf = (res) => res.headers.get('set-cookie')?.split(';')[0];

async function login(app, password = 'secret-pass') {
  const res = await app.request('/api/login', { json: { password } });
  assert.equal(res.status, 200);
  return cookieOf(res);
}

/** A live two-milestone hunt with one finished path, built through the game API. */
function liveHunt(db) {
  const huntId = game.createHunt(db, { name: 'UCSC Quest', milestones: 2 });
  game.createCodes(db, huntId, 'checkpoint', [{ label: 'Library' }, { label: 'Fountain' }]);
  const [pathId] = game.generatePaths(db, huntId, 1);
  const { paths, codes } = game.getBundle(db, huntId);
  game.savePath(db, pathId, { start_clue: 'Go', steps: paths[0].steps.map((s) => ({ code_id: s.code_id, clue: 'Next' })) });
  game.updateHunt(db, huntId, { status: 'live' });
  return { huntId, startToken: codes.find((c) => c.kind === 'start').cards[0].token, firstStop: paths[0].steps[0].code_id };
}

test('admin API is closed without a session and opens with one', async (t) => {
  const app = await start();
  t.after(app.close);
  assert.equal((await app.request('/api/hunts')).status, 401);
  assert.equal((await app.request('/api/login', { json: { password: 'wrong' } })).status, 401);
  const cookie = await login(app);
  assert.equal((await app.request('/api/hunts', { cookie })).status, 200);
});

test('a session from another password is rejected', async (t) => {
  const db = openDb(':memory:');
  const first = await start({ password: 'old-pass', db });
  const cookie = await login(first, 'old-pass');
  await first.close();

  const second = await start({ password: 'new-pass', db });
  t.after(second.close);
  assert.equal((await second.request('/api/hunts', { cookie })).status, 401);
});

test('repeated wrong passwords are throttled', async (t) => {
  const app = await start();
  t.after(app.close);
  const statuses = [];
  for (let i = 0; i < 11; i++) statuses.push((await app.request('/api/login', { json: { password: `guess-${i}` } })).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(401));
  assert.equal(statuses[10], 429);
  assert.equal((await app.request('/api/login', { json: { password: 'secret-pass' } })).status, 429);
});

test('requests without a body get a clean error, not a 500', async (t) => {
  const app = await start();
  t.after(app.close);
  assert.equal((await app.request('/api/login', { method: 'POST' })).status, 401);
});

test('the base URL must be a plain web address', async (t) => {
  const app = await start();
  t.after(app.close);
  const cookie = await login(app);
  const put = (base_url) => app.request('/api/settings', { cookie, method: 'PUT', json: { base_url } });
  assert.equal((await put('https://quest.example.com (new)')).status, 400);
  assert.equal((await put('https://quest.example.com/?x=1')).status, 400);
  assert.equal((await put('https://quest.example.com/')).status, 200);
  const settings = await (await app.request('/api/settings', { cookie })).json();
  assert.equal(settings.base_url, 'https://quest.example.com');
});

test('draft hunts are closed to players', async (t) => {
  const app = await start();
  t.after(app.close);
  const huntId = game.createHunt(app.db, { name: 'Draft', milestones: 1 });
  const token = game.getBundle(app.db, huntId).codes.find((c) => c.kind === 'start').cards[0].token;
  assert.equal((await app.request(`/q/${token}`)).status, 403);
});

test('a phone registers at the start, scans its first milestone and can link a second phone', async (t) => {
  const app = await start();
  t.after(app.close);
  const { huntId, startToken, firstStop } = liveHunt(app.db);

  const join = await app.request(`/q/${startToken}/join`, { form: { name: 'Null Pointers' } });
  assert.equal(join.status, 303);
  assert.equal(join.headers.get('location'), `/play/${huntId}?s=welcome`);
  const phone = cookieOf(join);

  const play = await (await app.request(`/play/${huntId}`, { cookie: phone })).text();
  assert.match(play, /Null Pointers/);
  assert.match(play, /Find milestone 1/);

  const real = game.getCard(app.db, game.realCardId(app.db, game.getCode(app.db, firstStop)));
  const scan = await app.request(`/q/${real.token}`, { cookie: phone });
  assert.equal(scan.headers.get('location'), `/play/${huntId}?s=found&n=1`);

  const team = app.db.prepare('SELECT join_code FROM teams').get();
  assert.equal((await app.request(`/h/${huntId}/rejoin`, { form: { code: 'ZZZZZZ' } })).status, 400);
  const rejoin = await app.request(`/h/${huntId}/rejoin`, { form: { code: team.join_code.toLowerCase() } });
  assert.equal(rejoin.status, 303);
  const second = await (await app.request(`/play/${huntId}`, { cookie: cookieOf(rejoin) })).text();
  assert.match(second, /1 of 2 found/);
});

/** A live hunt with two registered teams, each holding its phone's cookie. */
async function twoTeams(app) {
  const { huntId, startToken } = liveHunt(app.db);
  const phone = async (name) => cookieOf(await app.request(`/q/${startToken}/join`, { form: { name } }));
  const mine = await phone('Victims');
  await phone('Attackers');
  const code = (name) => app.db.prepare('SELECT join_code FROM teams WHERE name = ?').get(name).join_code;
  return { huntId, mine, attackersCode: code('Attackers') };
}

test('another website cannot link a phone to a different team', async (t) => {
  const app = await start();
  t.after(app.close);
  const { huntId, mine, attackersCode } = await twoTeams(app);
  for (const headers of [{ 'sec-fetch-site': 'cross-site' }, { origin: 'https://evil.example' }, { origin: 'null' }]) {
    const res = await app.request(`/h/${huntId}/rejoin`, { cookie: mine, form: { code: attackersCode, confirm: '1' }, headers });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('set-cookie'), null);
  }
  // The same request from the hunt's own page is fine.
  const own = await app.request(`/h/${huntId}/rejoin`, { cookie: mine, form: { code: attackersCode, confirm: '1' }, headers: { origin: app.base } });
  assert.equal(own.status, 303);
});

test('a phone on a team only switches teams when its holder confirms', async (t) => {
  const app = await start();
  t.after(app.close);
  const { huntId, mine, attackersCode } = await twoTeams(app);
  const ask = await app.request(`/h/${huntId}/rejoin`, { cookie: mine, form: { code: attackersCode } });
  assert.equal(ask.status, 200);
  assert.equal(ask.headers.get('set-cookie'), null);
  assert.match(await ask.text(), /Switch teams\?[\s\S]*This phone is on Victims/);
  const yes = await app.request(`/h/${huntId}/rejoin`, { cookie: mine, form: { code: attackersCode, confirm: '1' } });
  assert.equal(yes.status, 303);
  assert.ok(yes.headers.get('set-cookie'));
});

test('X-Forwarded-For cannot get around the login limit', async (t) => {
  const app = await start();
  t.after(app.close);
  const statuses = [];
  for (let i = 0; i < 12; i++) {
    statuses.push((await app.request('/api/login', { json: { password: `guess-${i}` }, headers: { 'x-forwarded-for': `10.0.0.${i}` } })).status);
  }
  assert.deepEqual(statuses.slice(10), [429, 429]);
});

test('signing out ends the session on the server, and sessions expire', async (t) => {
  const app = await start();
  t.after(app.close);
  const kept = await login(app);
  assert.equal((await app.request('/api/logout', { cookie: kept, method: 'POST' })).status, 200);
  assert.equal((await app.request('/api/hunts', { cookie: kept })).status, 401); // a copy of the cookie is dead too

  const other = await login(app);
  app.db.prepare('UPDATE admin_sessions SET expires_at = ?').run(Date.now() - 1);
  assert.equal((await app.request('/api/hunts', { cookie: other })).status, 401);
});

test('malformed requests get a 4xx JSON error, not a 500 page', async (t) => {
  const app = await start();
  t.after(app.close);
  const bad = await app.request('/api/login', { body: '{"invalid":' });
  assert.equal(bad.status, 400);
  assert.match(bad.headers.get('content-type'), /json/);
  assert.deepEqual(await bad.json(), { error: 'The request body is not valid JSON.' });
  const huge = await app.request('/api/login', { body: JSON.stringify({ password: 'x'.repeat(2 * 1024 * 1024) }) });
  assert.equal(huge.status, 413);
  const cookie = await login(app);
  const missing = await app.request('/api/nothing-here', { cookie });
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('content-type'), /json/);
});

test('the print sheet prints nothing when every kind is unticked', async (t) => {
  const app = await start();
  t.after(app.close);
  const { huntId } = liveHunt(app.db);
  const cookie = await login(app);
  const cards = async (query) => ((await (await app.request(`/admin/print/${huntId}${query}`, { cookie })).text()).match(/class="card"/g) ?? []).length;
  assert.equal(await cards('?kinds=&labels=1'), 0);
  assert.equal(await cards('?ids='), 0);
  assert.ok((await cards('')) > 0);
});
