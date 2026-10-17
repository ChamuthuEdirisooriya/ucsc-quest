import express from 'express';
import cookieParser from 'cookie-parser';
import QRCode from 'qrcode';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, getSetting, setSetting, tx } from './db.js';
import * as game from './game.js';
import { UserError } from './game.js';
import * as views from './views.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The address printed into every QR code: http(s), a host, optionally a path; nothing else. */
export function cleanBaseUrl(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    url = null;
  }
  if (!url || !/^https?:$/.test(url.protocol) || /\s/.test(text) || url.username || url.password || url.search || url.hash) {
    throw new UserError('Enter a web address like https://quest.example.com (no spaces, ? or #).');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

export function createApp({ db, adminPassword, trustProxy = 'loopback, linklocal, uniquelocal' }) {
  let secret = getSetting(db, 'cookie_secret');
  if (!secret) {
    secret = crypto.randomBytes(32).toString('hex');
    setSetting(db, 'cookie_secret', secret);
  }

  const app = express();
  // Only trust X-Forwarded-* from local/private proxies, so clients can't spoof req.ip.
  app.set('trust proxy', trustProxy);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.body ??= {}; // Express 5 leaves it undefined when no parser matched
    next();
  });
  app.use(cookieParser(secret));
  app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

  const isProd = process.env.NODE_ENV === 'production';
  const teamCookie = (huntId) => `team_${huntId}`;
  const setTeamCookie = (res, team) =>
    res.cookie(teamCookie(team.hunt_id), team.token, {
      signed: true, httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 1000 * 60 * 60 * 24 * 30,
    });
  const teamFor = (req, huntId) => game.getTeamByToken(db, huntId, req.signedCookies[teamCookie(huntId)]);
  // The admin session value is derived from the password, so changing
  // ADMIN_PASSWORD signs every existing session out.
  const adminSession = crypto.createHmac('sha256', secret).update(`admin:${adminPassword}`).digest('base64url');
  const isAdmin = (req) => req.signedCookies.admin === adminSession;

  const baseUrl = (req) =>
    (getSetting(db, 'base_url') || process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  const cardUrl = (req, card) => `${baseUrl(req)}/q/${card.token}`;

  /* ------------------------------------------------ live updates (SSE) */

  const listeners = new Map(); // huntId -> Set<res>
  const notify = (huntId) => {
    for (const res of listeners.get(Number(huntId)) ?? []) res.write(`data: ${Date.now()}\n\n`);
  };

  /* ------------------------------------------------ player routes */

  // Players can only play live hunts (and ended ones read-only). Admins can test drafts.
  function playable(req, res, hunt) {
    if (hunt.status === 'draft' && !isAdmin(req)) {
      res.status(403).send(views.messagePage('Not started yet', 'This hunt has not started. Check back soon!', { huntName: hunt.name }));
      return false;
    }
    return true;
  }

  app.get('/q/:token', (req, res) => {
    const card = game.getCardByToken(db, req.params.token);
    if (!card) return res.status(404).send(views.messagePage('Unknown QR code', 'This QR code is not part of any hunt.'));
    const hunt = game.getHunt(db, game.getCode(db, card.code_id).hunt_id);
    if (!playable(req, res, hunt)) return;
    const team = teamFor(req, hunt.id);

    if (hunt.status === 'ended') {
      return res.send(views.messagePage('The hunt is over', 'Thanks for playing!', {
        huntName: hunt.name, link: team ? { href: `/play/${hunt.id}`, label: 'See your team' } : null,
      }));
    }

    const result = game.scanCard(db, card, team);
    if (!['join', 'resume'].includes(result.type)) notify(hunt.id);

    switch (result.type) {
      case 'join': return res.send(views.joinPage(hunt, card));
      case 'resume': return res.redirect(303, `/play/${hunt.id}`);
      case 'decoy': return res.send(views.decoyPage(hunt, result.message, team));
      case 'no-team': return res.send(views.noTeamPage(hunt));
      case 'found': return res.redirect(303, `/play/${hunt.id}?s=found&n=${result.position}`);
      case 'again': return res.redirect(303, `/play/${hunt.id}?s=again&n=${result.position}`);
      case 'off-path': return res.redirect(303, `/play/${hunt.id}?s=nope`);
      case 'early': return res.redirect(303, `/play/${hunt.id}?s=early&n=${result.progress}&t=${result.total}`);
      case 'finished': return res.redirect(303, `/play/${hunt.id}`);
    }
  });

  app.post('/q/:token/join', (req, res) => {
    const card = game.getCardByToken(db, req.params.token);
    const code = card && game.getCode(db, card.code_id);
    if (!code || code.kind !== 'start') return res.status(404).send(views.messagePage('Unknown QR code', 'This QR code is not a starting point.'));
    const hunt = game.getHunt(db, code.hunt_id);
    if (!playable(req, res, hunt)) return;
    if (hunt.status === 'ended') return res.redirect(303, `/q/${card.token}`);
    if (teamFor(req, hunt.id)) return res.redirect(303, `/play/${hunt.id}`);
    try {
      const team = game.registerTeam(db, hunt.id, req.body.name, card);
      setTeamCookie(res, team);
      notify(hunt.id);
      res.redirect(303, `/play/${hunt.id}?s=welcome`);
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      res.status(err.status).send(views.joinPage(hunt, card, { error: err.message, name: req.body.name }));
    }
  });

  app.post('/h/:huntId/rejoin', (req, res) => {
    const hunt = game.getHunt(db, req.params.huntId);
    if (!hunt) return res.status(404).send(views.messagePage('Unknown hunt', 'This hunt does not exist.'));
    if (!playable(req, res, hunt)) return;
    const team = game.getTeamByJoinCode(db, hunt.id, req.body.code);
    if (!team) {
      return res.status(400).send(views.noTeamPage(hunt, { joinError: 'No team has that code. Check the code on your teammate’s phone.', joinCode: req.body.code }));
    }
    setTeamCookie(res, team);
    res.redirect(303, `/play/${hunt.id}?s=rejoined`);
  });

  app.get('/play/:huntId', (req, res) => {
    const hunt = game.getHunt(db, req.params.huntId);
    if (!hunt) return res.status(404).send(views.messagePage('Unknown hunt', 'This hunt does not exist.'));
    if (!playable(req, res, hunt)) return;
    const team = teamFor(req, hunt.id);
    if (!team) return res.send(views.noTeamPage(hunt));
    res.set('Cache-Control', 'no-store');
    res.send(views.teamPage(game.teamView(db, team), req.query));
  });

  /* ------------------------------------------------ admin auth */

  const api = express.Router();
  app.use('/api', api);

  const failures = new Map(); // ip -> { count, until }
  const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();

  api.post('/login', (req, res) => {
    const now = Date.now();
    const record = failures.get(req.ip);
    if (record && record.until > now && record.count >= LOGIN_MAX_FAILURES) {
      res.set('Retry-After', String(Math.ceil((record.until - now) / 1000)));
      return res.status(429).json({ error: 'Too many wrong passwords. Try again in a few minutes.' });
    }
    // Compare fixed-length digests so the check takes the same time whatever the input length.
    if (!crypto.timingSafeEqual(digest(req.body.password ?? ''), digest(adminPassword))) {
      if (failures.size > 5000) for (const [ip, r] of failures) if (r.until <= now) failures.delete(ip);
      const fresh = !record || record.until <= now;
      failures.set(req.ip, { count: fresh ? 1 : record.count + 1, until: fresh ? now + LOGIN_WINDOW_MS : record.until });
      return res.status(401).json({ error: 'Wrong password.' });
    }
    failures.delete(req.ip);
    res.cookie('admin', adminSession, { signed: true, httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 1000 * 60 * 60 * 24 * 7 });
    res.json({ ok: true });
  });

  api.post('/logout', (req, res) => {
    res.clearCookie('admin');
    res.json({ ok: true });
  });

  api.get('/me', (req, res) => res.json({ admin: isAdmin(req) }));

  api.use((req, res, next) => (isAdmin(req) ? next() : res.status(401).json({ error: 'Please sign in.' })));

  const need = (value, what = 'Not found') => {
    if (!value) throw new UserError(what, 404);
    return value;
  };

  /* ------------------------------------------------ admin API */

  api.get('/settings', (req, res) => {
    const lan = Object.values(os.networkInterfaces()).flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal)
      .map((i) => `${req.protocol}://${i.address}:${req.socket.localPort}`);
    res.json({ base_url: getSetting(db, 'base_url') ?? '', effective_base_url: baseUrl(req), suggestions: lan });
  });

  api.put('/settings', (req, res) => {
    setSetting(db, 'base_url', cleanBaseUrl(req.body.base_url));
    res.json({ ok: true });
  });

  api.get('/hunts', (req, res) => {
    res.json(db.prepare(`
      SELECT h.*,
        (SELECT COUNT(*) FROM teams t WHERE t.hunt_id = h.id) AS team_count,
        (SELECT COUNT(*) FROM teams t WHERE t.hunt_id = h.id AND t.finished_at IS NOT NULL) AS finished_count,
        (SELECT COUNT(*) FROM paths p WHERE p.hunt_id = h.id) AS path_count,
        (SELECT COUNT(*) FROM codes c WHERE c.hunt_id = h.id) AS code_count
      FROM hunts h ORDER BY h.id DESC
    `).all());
  });

  api.post('/hunts', (req, res) => {
    res.status(201).json({ id: game.createHunt(db, req.body) });
  });

  api.get('/hunts/:id', (req, res) => {
    const bundle = need(game.getBundle(db, req.params.id), 'Hunt not found.');
    const teamCount = db.prepare('SELECT COUNT(*) AS n FROM teams WHERE hunt_id = ?').get(bundle.hunt.id).n;
    for (const c of bundle.codes) for (const k of c.cards) k.url = cardUrl(req, k);
    res.json({ ...bundle, team_count: teamCount, issues: game.validateHunt(bundle) });
  });

  api.put('/hunts/:id', (req, res) => {
    res.json(game.updateHunt(db, Number(req.params.id), req.body));
    notify(req.params.id);
  });

  api.delete('/hunts/:id', (req, res) => {
    db.prepare('DELETE FROM hunts WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  api.post('/hunts/:id/codes', (req, res) => {
    res.status(201).json({ ids: game.createCodes(db, Number(req.params.id), req.body.kind, req.body.items) });
  });

  api.put('/codes/:id', (req, res) => res.json(game.updateCode(db, req.params.id, req.body)));

  api.post('/codes/:id/shuffle', (req, res) => {
    need(game.getCode(db, req.params.id), 'QR not found.');
    res.json({ real_card_id: game.shuffleRealCard(db, req.params.id) });
  });

  api.post('/hunts/:id/shuffle', (req, res) => {
    game.shuffleAll(db, Number(req.params.id));
    res.json({ ok: true });
  });

  // Set the number of cards (1 real + decoys) on every checkpoint at once.
  api.post('/hunts/:id/cards', (req, res) => {
    const ids = db.prepare("SELECT id FROM codes WHERE hunt_id = ? AND kind = 'checkpoint'").all(req.params.id);
    tx(db, () => ids.forEach(({ id }) => game.setCardCount(db, id, Number(req.body.cards))));
    res.json({ ok: true });
  });

  api.delete('/codes/:id', (req, res) => {
    game.deleteCode(db, req.params.id);
    res.json({ ok: true });
  });

  api.get('/cards/:id/qr.svg', async (req, res) => {
    const card = need(game.getCard(db, req.params.id), 'QR not found.');
    const svg = await QRCode.toString(cardUrl(req, card), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('Cache-Control', 'no-cache').send(svg);
  });

  api.post('/hunts/:id/paths', (req, res) => {
    res.status(201).json({ id: game.createPath(db, Number(req.params.id), req.body) });
  });

  api.post('/hunts/:id/generate-paths', (req, res) => {
    res.status(201).json({ ids: game.generatePaths(db, Number(req.params.id), req.body.count, { replace: Boolean(req.body.replace) }) });
  });

  api.put('/paths/:id', (req, res) => {
    game.savePath(db, Number(req.params.id), req.body);
    res.json({ ok: true });
  });

  api.delete('/paths/:id', (req, res) => {
    game.deletePath(db, req.params.id);
    res.json({ ok: true });
  });

  api.get('/hunts/:id/live', (req, res) => {
    res.json(need(game.liveData(db, Number(req.params.id)), 'Hunt not found.'));
  });

  api.get('/hunts/:id/stream', (req, res) => {
    const huntId = Number(req.params.id);
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 3000\n\n');
    if (!listeners.has(huntId)) listeners.set(huntId, new Set());
    listeners.get(huntId).add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => {
      clearInterval(ping);
      listeners.get(huntId)?.delete(res);
    });
  });

  api.delete('/hunts/:id/teams', (req, res) => {
    db.prepare('DELETE FROM teams WHERE hunt_id = ?').run(req.params.id);
    db.prepare('DELETE FROM scans WHERE hunt_id = ?').run(req.params.id);
    notify(req.params.id);
    res.json({ ok: true });
  });

  api.get('/teams/:id', (req, res) => res.json(need(game.teamDetail(db, Number(req.params.id)), 'Team not found.')));

  api.put('/teams/:id', (req, res) => {
    game.updateTeam(db, Number(req.params.id), req.body);
    const team = game.teamDetail(db, Number(req.params.id));
    notify(team.team.hunt_id);
    res.json(team);
  });

  api.delete('/teams/:id', (req, res) => {
    const team = need(db.prepare('SELECT hunt_id FROM teams WHERE id = ?').get(req.params.id), 'Team not found.');
    db.prepare('DELETE FROM teams WHERE id = ?').run(req.params.id);
    notify(team.hunt_id);
    res.json({ ok: true });
  });

  api.use((err, req, res, next) => {
    if (err instanceof UserError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong on the server.' });
  });

  /* ------------------------------------------------ printable QR sheet */

  app.get('/admin/print/:huntId', async (req, res) => {
    if (!isAdmin(req)) return res.redirect('/admin/');
    const bundle = game.getBundle(db, req.params.huntId);
    if (!bundle) return res.status(404).send('Hunt not found');
    const kinds = String(req.query.kinds || 'start,checkpoint,decoy,finish').split(',');
    const only = req.query.ids ? new Set(String(req.query.ids).split(',').map(Number)) : null;
    const pathName = new Map(bundle.paths.map((p) => [p.id, p.name]));
    const codes = bundle.codes.filter((c) => kinds.includes(c.kind) && (!only || only.has(c.id)));
    const cards = await Promise.all(codes.flatMap((code) => code.cards.map(async (card) => ({
      code,
      card,
      svg: await QRCode.toString(cardUrl(req, card), { type: 'svg', margin: 0, errorCorrectionLevel: 'M' }),
      usage: code.usage.map((u) => `${pathName.get(u.path_id)} #${u.position}`).join(', '),
    }))));
    res.send(views.printPage(bundle.hunt, cards, { labels: req.query.labels === '1' }));
  });

  app.get('/', (req, res) => res.redirect('/admin/'));

  app.use((err, req, res, next) => {
    if (err instanceof UserError) return res.status(err.status).send(views.messagePage('Hold on', err.message));
    console.error(err);
    res.status(500).send(views.messagePage('Something went wrong', 'Please try again in a moment.'));
  });

  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  const dbFile = process.env.DATABASE_FILE || path.join(ROOT, 'data', 'hunt.db');
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin';
  if (!process.env.ADMIN_PASSWORD) {
    if (process.env.NODE_ENV === 'production') {
      console.error('ADMIN_PASSWORD must be set when NODE_ENV=production.');
      process.exit(1);
    }
    console.warn('⚠  ADMIN_PASSWORD is not set — using "admin". Set it before running a real event.');
  }

  // TRUST_PROXY: a hop count ("1"), "true", or a list of proxy addresses/subnets.
  const proxy = process.env.TRUST_PROXY;
  const trustProxy = !proxy ? undefined : /^\d+$/.test(proxy) ? Number(proxy) : proxy === 'true' ? true : proxy;
  const app = createApp({ db: openDb(dbFile), adminPassword, trustProxy });
  app.listen(port, '0.0.0.0', () => {
    console.log(`Scavenger Hunt running → http://localhost:${port}/admin/`);
    for (const i of Object.values(os.networkInterfaces()).flat()) {
      if (i && i.family === 'IPv4' && !i.internal) console.log(`  on your network → http://${i.address}:${port}/admin/`);
    }
  });
}
