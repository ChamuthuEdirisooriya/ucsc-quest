import crypto from 'node:crypto';
import { tx } from './db.js';

// Errors whose message is safe to show to a player or admin.
export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I/L

export function randomCode(length) {
  let out = '';
  for (const byte of crypto.randomBytes(length)) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

export const PATH_COLORS = ['#e4572e', '#2e86ab', '#3bb273', '#9b5de5', '#f4a259', '#e84393', '#17a2b8', '#7a9e1a', '#c0392b', '#5352ed'];

const DEFAULT_WELCOME = 'Welcome, explorers! Pick a team name to receive your first clue. Keep using this same phone for every QR code you scan.';
const DEFAULT_FINISH = 'You found the final destination. Congratulations!';

/* ---------------------------------------------------------------- hunts */

export function createHunt(db, { name, milestones }) {
  name = String(name ?? '').trim();
  milestones = Number(milestones);
  if (!name) throw new UserError('Give the hunt a name.');
  if (!Number.isInteger(milestones) || milestones < 1 || milestones > 50) {
    throw new UserError('Milestones per team must be a whole number between 1 and 50.');
  }
  return tx(db, () => {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO hunts (name, milestones, welcome, finish_message) VALUES (?, ?, ?, ?)')
      .run(name, milestones, DEFAULT_WELCOME, DEFAULT_FINISH);
    const id = Number(lastInsertRowid);
    insertCode(db, id, 'start', 'Starting point');
    insertCode(db, id, 'finish', 'Final destination');
    return id;
  });
}

export function getHunt(db, id) {
  return db.prepare('SELECT * FROM hunts WHERE id = ?').get(id) ?? null;
}

export function updateHunt(db, id, changes) {
  const hunt = getHunt(db, id);
  if (!hunt) throw new UserError('Hunt not found.', 404);
  const next = { ...hunt };

  if (changes.name !== undefined) {
    next.name = String(changes.name).trim();
    if (!next.name) throw new UserError('Give the hunt a name.');
  }
  if (changes.welcome !== undefined) next.welcome = String(changes.welcome);
  if (changes.finish_message !== undefined) next.finish_message = String(changes.finish_message);

  if (changes.milestones !== undefined && Number(changes.milestones) !== hunt.milestones) {
    const n = Number(changes.milestones);
    if (!Number.isInteger(n) || n < 1 || n > 50) throw new UserError('Milestones per team must be between 1 and 50.');
    const teams = db.prepare('SELECT COUNT(*) AS n FROM teams WHERE hunt_id = ?').get(id).n;
    if (teams > 0) throw new UserError('Milestone count cannot change once teams have started. Reset the teams first.');
    next.milestones = n;
  }

  if (changes.status !== undefined && changes.status !== hunt.status) {
    if (!['draft', 'live', 'ended'].includes(changes.status)) throw new UserError('Unknown status.');
    if (changes.status === 'live') {
      const { errors } = validateHunt(getBundle(db, id, { milestones: next.milestones }));
      if (errors.length) throw new UserError(`Fix ${errors.length} problem(s) before going live: ${errors[0].message}`);
    }
    next.status = changes.status;
  }

  tx(db, () => {
    db.prepare('UPDATE hunts SET name = ?, welcome = ?, finish_message = ?, milestones = ?, status = ? WHERE id = ?')
      .run(next.name, next.welcome, next.finish_message, next.milestones, next.status, id);
    if (next.milestones < hunt.milestones) {
      db.prepare('DELETE FROM path_steps WHERE position > ? AND path_id IN (SELECT id FROM paths WHERE hunt_id = ?)')
        .run(next.milestones, id);
    }
  });
  return getHunt(db, id);
}

/** Hunt plus all of its codes and paths (each path padded to exactly `milestones` steps). */
export function getBundle(db, huntId, overrides = {}) {
  const found = getHunt(db, huntId);
  if (!found) return null;
  const hunt = { ...found, ...overrides };

  const codes = db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM scans s WHERE s.code_id = c.id) AS scan_count
    FROM codes c WHERE c.hunt_id = ?
    ORDER BY CASE c.kind WHEN 'start' THEN 0 WHEN 'checkpoint' THEN 1 WHEN 'decoy' THEN 2 ELSE 3 END, c.id
  `).all(huntId);

  const paths = db.prepare(`
    SELECT p.*, (SELECT COUNT(*) FROM teams t WHERE t.path_id = p.id) AS team_count
    FROM paths p WHERE p.hunt_id = ? ORDER BY p.id
  `).all(huntId);

  const steps = db.prepare(`
    SELECT ps.* FROM path_steps ps JOIN paths p ON p.id = ps.path_id
    WHERE p.hunt_id = ? ORDER BY ps.path_id, ps.position
  `).all(huntId);

  for (const p of paths) {
    p.steps = Array.from({ length: hunt.milestones }, (_, i) => ({ position: i + 1, code_id: null, clue: '' }));
  }
  const byId = new Map(paths.map((p) => [p.id, p]));
  for (const s of steps) {
    const p = byId.get(s.path_id);
    if (p && s.position >= 1 && s.position <= hunt.milestones) {
      p.steps[s.position - 1] = { position: s.position, code_id: s.code_id, clue: s.clue };
    }
  }

  // Where each code is used: [{ path_id, position }]
  for (const c of codes) c.usage = [];
  const codeById = new Map(codes.map((c) => [c.id, c]));
  for (const p of paths) {
    for (const s of p.steps) {
      if (s.code_id && codeById.has(s.code_id)) codeById.get(s.code_id).usage.push({ path_id: p.id, position: s.position });
    }
  }

  return { hunt, codes, paths };
}

/** Problems that block going live (errors) and things worth a second look (warnings). */
export function validateHunt(bundle) {
  const { hunt, codes, paths } = bundle;
  const errors = [];
  const warnings = [];
  const codeById = new Map(codes.map((c) => [c.id, c]));

  if (paths.length === 0) errors.push({ message: 'Create at least one path.' });

  for (const p of paths) {
    const at = { path_id: p.id };
    if (!p.start_clue.trim()) errors.push({ ...at, message: `${p.name}: the starting clue (shown when a team registers) is empty.` });
    const seen = new Set();
    for (const s of p.steps) {
      const where = `${p.name}, milestone ${s.position}`;
      const code = s.code_id ? codeById.get(s.code_id) : null;
      if (!code) errors.push({ ...at, position: s.position, message: `${where}: choose a checkpoint QR.` });
      else if (code.kind !== 'checkpoint') errors.push({ ...at, position: s.position, message: `${where}: only checkpoint QRs can be milestones.` });
      if (!s.clue.trim()) {
        const target = s.position === hunt.milestones ? 'the final destination' : `milestone ${s.position + 1}`;
        errors.push({ ...at, position: s.position, message: `${where}: write the clue that leads to ${target}.` });
      }
      if (s.code_id) {
        if (seen.has(s.code_id)) errors.push({ ...at, position: s.position, message: `${where}: this QR is already used earlier in the same path.` });
        seen.add(s.code_id);
      }
    }
  }

  const signatures = new Map();
  for (const p of paths) {
    const sig = p.steps.map((s) => s.code_id ?? '-').join(',');
    if (!sig.includes('-')) {
      if (signatures.has(sig)) warnings.push({ path_id: p.id, message: `${p.name} visits the same checkpoints in the same order as ${signatures.get(sig)}.` });
      else signatures.set(sig, p.name);
    }
  }
  const firstStops = new Map();
  for (const p of paths) {
    const first = p.steps[0]?.code_id;
    if (!first) continue;
    if (firstStops.has(first)) warnings.push({ path_id: p.id, message: `${p.name} and ${firstStops.get(first)} share their first milestone, so teams may bunch up at the start.` });
    else firstStops.set(first, p.name);
  }
  for (const c of codes) {
    if (c.kind === 'checkpoint' && c.usage.length === 0) warnings.push({ code_id: c.id, message: `Checkpoint "${c.label || c.token}" is not in any path. Scanning it will just say "not your next stop".` });
    if (c.kind === 'decoy' && !c.message.trim()) warnings.push({ code_id: c.id, message: `Decoy "${c.label || c.token}" has no message.` });
  }

  return { errors, warnings };
}

/* ---------------------------------------------------------------- codes */

function insertCode(db, huntId, kind, label = '', message = '') {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const { lastInsertRowid } = db
        .prepare('INSERT INTO codes (hunt_id, token, kind, label, message) VALUES (?, ?, ?, ?, ?)')
        .run(huntId, randomCode(10), kind, label, message);
      return Number(lastInsertRowid);
    } catch (err) {
      if (!String(err.message).includes('UNIQUE')) throw err;
    }
  }
  throw new Error('Could not generate a unique QR token.');
}

export function createCodes(db, huntId, kind, items) {
  if (!['checkpoint', 'decoy'].includes(kind)) throw new UserError('You can only add checkpoint or decoy QRs.');
  if (!getHunt(db, huntId)) throw new UserError('Hunt not found.', 404);
  if (!Array.isArray(items) || items.length === 0) throw new UserError('Nothing to add.');
  if (items.length > 200) throw new UserError('Add at most 200 QRs at a time.');
  return tx(db, () => items.map((it) => insertCode(db, huntId, kind, String(it.label ?? '').trim(), String(it.message ?? ''))));
}

export function getCode(db, id) {
  return db.prepare('SELECT * FROM codes WHERE id = ?').get(id) ?? null;
}

export function getCodeByToken(db, token) {
  return db.prepare('SELECT * FROM codes WHERE token = ?').get(String(token).toUpperCase()) ?? null;
}

export function updateCode(db, id, { label, message }) {
  const code = getCode(db, id);
  if (!code) throw new UserError('QR not found.', 404);
  db.prepare('UPDATE codes SET label = ?, message = ? WHERE id = ?').run(
    label !== undefined ? String(label).trim() : code.label,
    message !== undefined ? String(message) : code.message,
    id,
  );
  return getCode(db, id);
}

export function deleteCode(db, id) {
  const code = getCode(db, id);
  if (!code) throw new UserError('QR not found.', 404);
  if (code.kind === 'start' || code.kind === 'finish') throw new UserError('The start and finish QRs cannot be deleted.');
  const used = db.prepare('SELECT COUNT(*) AS n FROM path_steps WHERE code_id = ?').get(id).n;
  if (used) throw new UserError('This QR is used in a path. Remove it from the path first.');
  db.prepare('DELETE FROM codes WHERE id = ?').run(id);
}

/* ---------------------------------------------------------------- paths */

export function createPath(db, huntId, { name, color } = {}) {
  if (!getHunt(db, huntId)) throw new UserError('Hunt not found.', 404);
  const count = db.prepare('SELECT COUNT(*) AS n FROM paths WHERE hunt_id = ?').get(huntId).n;
  const { lastInsertRowid } = db
    .prepare('INSERT INTO paths (hunt_id, name, color) VALUES (?, ?, ?)')
    .run(huntId, String(name ?? '').trim() || pathName(count), color || PATH_COLORS[count % PATH_COLORS.length]);
  return Number(lastInsertRowid);
}

function pathName(index) {
  let s = '';
  let n = index;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return `Path ${s}`;
}

export function savePath(db, pathId, { name, color, start_clue, steps }) {
  const path = db.prepare('SELECT * FROM paths WHERE id = ?').get(pathId);
  if (!path) throw new UserError('Path not found.', 404);
  const hunt = getHunt(db, path.hunt_id);

  const cleanName = name !== undefined ? String(name).trim() : path.name;
  if (!cleanName) throw new UserError('Give the path a name.');
  if (color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(color)) throw new UserError('Colour must look like #rrggbb.');

  let cleanSteps = null;
  if (steps !== undefined) {
    if (!Array.isArray(steps) || steps.length > hunt.milestones) throw new UserError(`A path has exactly ${hunt.milestones} milestones.`);
    const checkpoints = new Set(
      db.prepare("SELECT id FROM codes WHERE hunt_id = ? AND kind = 'checkpoint'").all(hunt.id).map((r) => r.id),
    );
    const seen = new Set();
    cleanSteps = steps.map((s, i) => {
      const codeId = s?.code_id ? Number(s.code_id) : null;
      if (codeId !== null) {
        if (!checkpoints.has(codeId)) throw new UserError(`Milestone ${i + 1}: pick one of this hunt's checkpoint QRs.`);
        if (seen.has(codeId)) throw new UserError(`Milestone ${i + 1}: a path cannot visit the same checkpoint twice.`);
        seen.add(codeId);
      }
      return { position: i + 1, code_id: codeId, clue: String(s?.clue ?? '') };
    });
  }

  tx(db, () => {
    db.prepare('UPDATE paths SET name = ?, color = ?, start_clue = ? WHERE id = ?').run(
      cleanName,
      color ?? path.color,
      start_clue !== undefined ? String(start_clue) : path.start_clue,
      pathId,
    );
    if (cleanSteps) {
      db.prepare('DELETE FROM path_steps WHERE path_id = ?').run(pathId);
      const insert = db.prepare('INSERT INTO path_steps (path_id, position, code_id, clue) VALUES (?, ?, ?, ?)');
      for (const s of cleanSteps) {
        if (s.code_id || s.clue) insert.run(pathId, s.position, s.code_id, s.clue);
      }
    }
  });
}

export function deletePath(db, pathId) {
  const teams = db.prepare('SELECT COUNT(*) AS n FROM teams WHERE path_id = ?').get(pathId).n;
  if (teams) throw new UserError(`${teams} team(s) are following this path. Move or delete them first.`);
  db.prepare('DELETE FROM paths WHERE id = ?').run(pathId);
}

/**
 * Create `count` new paths from the hunt's checkpoint pool. Every path gets
 * exactly `milestones` distinct checkpoints. Checkpoints are spread as evenly
 * as possible (so some end up exclusive when the pool is large, and shared when
 * it is small) and each path gets a different first stop where possible.
 * Clues are left blank for the organisers to write.
 */
export function generatePaths(db, huntId, count, { replace = false } = {}) {
  const bundle = getBundle(db, huntId);
  if (!bundle) throw new UserError('Hunt not found.', 404);
  count = Number(count);
  if (!Number.isInteger(count) || count < 1 || count > 50) throw new UserError('Generate between 1 and 50 paths.');
  const n = bundle.hunt.milestones;
  const pool = bundle.codes.filter((c) => c.kind === 'checkpoint').map((c) => c.id);
  if (pool.length < n) throw new UserError(`Each path needs ${n} different checkpoints, but only ${pool.length} exist. Add more checkpoint QRs first.`);
  if (replace && bundle.paths.some((p) => p.team_count > 0)) throw new UserError('Teams are already following these paths, so they cannot be replaced.');

  const usage = new Map(pool.map((id) => [id, 0]));
  const firstUsage = new Map(pool.map((id) => [id, 0]));
  if (!replace) {
    for (const p of bundle.paths) {
      for (const s of p.steps) if (usage.has(s.code_id)) usage.set(s.code_id, usage.get(s.code_id) + 1);
      if (firstUsage.has(p.steps[0]?.code_id)) firstUsage.set(p.steps[0].code_id, firstUsage.get(p.steps[0].code_id) + 1);
    }
  }
  const leastUsed = (candidates, counts) =>
    shuffle(candidates).sort((a, b) => counts.get(a) - counts.get(b));

  return tx(db, () => {
    if (replace) db.prepare('DELETE FROM paths WHERE hunt_id = ?').run(huntId);
    const created = [];
    for (let i = 0; i < count; i++) {
      const first = leastUsed(pool, new Map(pool.map((id) => [id, firstUsage.get(id) * 1000 + usage.get(id)])))[0];
      const rest = shuffle(leastUsed(pool.filter((id) => id !== first), usage).slice(0, n - 1));
      const steps = [first, ...rest];
      firstUsage.set(first, firstUsage.get(first) + 1);
      for (const id of steps) usage.set(id, usage.get(id) + 1);

      const pathId = createPath(db, huntId);
      const insert = db.prepare('INSERT INTO path_steps (path_id, position, code_id, clue) VALUES (?, ?, ?, ?)');
      steps.forEach((codeId, idx) => insert.run(pathId, idx + 1, codeId, ''));
      created.push(pathId);
    }
    return created;
  });
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ---------------------------------------------------------------- teams */

export function getTeamByToken(db, huntId, token) {
  if (!token) return null;
  return db.prepare('SELECT * FROM teams WHERE hunt_id = ? AND token = ?').get(huntId, token) ?? null;
}

export function getTeamByJoinCode(db, huntId, joinCode) {
  const code = String(joinCode ?? '').trim().toUpperCase();
  if (!code) return null;
  return db.prepare('SELECT * FROM teams WHERE hunt_id = ? AND join_code = ?').get(huntId, code) ?? null;
}

/** Pick the complete path with the fewest teams, so teams spread across all paths. */
function choosePath(db, huntId) {
  const bundle = getBundle(db, huntId);
  const { errors } = validateHunt(bundle);
  const broken = new Set(errors.map((e) => e.path_id).filter(Boolean));
  const ready = bundle.paths.filter((p) => !broken.has(p.id));
  if (ready.length === 0) throw new UserError('This hunt has no ready paths yet. Please find an organiser.', 503);
  const fewest = Math.min(...ready.map((p) => p.team_count));
  const candidates = ready.filter((p) => p.team_count === fewest);
  return candidates[crypto.randomInt(candidates.length)];
}

export function registerTeam(db, huntId, rawName, startCodeId) {
  const name = String(rawName ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new UserError('Enter a team name.');
  if (name.length > 40) throw new UserError('Keep the team name under 40 characters.');

  return tx(db, () => {
    const taken = db.prepare('SELECT 1 FROM teams WHERE hunt_id = ? AND lower(name) = lower(?)').get(huntId, name);
    if (taken) throw new UserError('That team name is already taken. Try another one.');
    const path = choosePath(db, huntId);
    let joinCode;
    do joinCode = randomCode(6);
    while (db.prepare('SELECT 1 FROM teams WHERE hunt_id = ? AND join_code = ?').get(huntId, joinCode));

    const token = crypto.randomBytes(24).toString('base64url');
    const { lastInsertRowid } = db
      .prepare('INSERT INTO teams (hunt_id, path_id, name, token, join_code) VALUES (?, ?, ?, ?, ?)')
      .run(huntId, path.id, name, token, joinCode);
    const teamId = Number(lastInsertRowid);
    db.prepare('INSERT INTO scans (hunt_id, team_id, code_id, result) VALUES (?, ?, ?, ?)').run(huntId, teamId, startCodeId, 'registered');
    return db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
  });
}

function pathSteps(db, pathId) {
  return db.prepare('SELECT * FROM path_steps WHERE path_id = ? ORDER BY position').all(pathId);
}

function finishRank(db, team) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM teams
    WHERE hunt_id = ? AND finished_at IS NOT NULL AND (finished_at < ? OR (finished_at = ? AND id <= ?))
  `).get(team.hunt_id, team.finished_at, team.finished_at, team.id).n;
}

/**
 * Everything a team's phone needs to show: progress, and the clue they are
 * currently following (or the finish message).
 */
export function teamView(db, team) {
  const hunt = getHunt(db, team.hunt_id);
  const path = team.path_id ? db.prepare('SELECT * FROM paths WHERE id = ?').get(team.path_id) : null;
  const steps = path ? pathSteps(db, path.id) : [];
  const clue = team.progress === 0 ? path?.start_clue ?? '' : steps.find((s) => s.position === team.progress)?.clue ?? '';
  return {
    hunt,
    team,
    path,
    total: hunt.milestones,
    progress: team.progress,
    clue,
    finished: Boolean(team.finished_at),
    rank: team.finished_at ? finishRank(db, team) : null,
  };
}

/**
 * Apply a QR scan. `team` may be null when the phone has no team yet.
 * Returns { type, ... } describing what to show:
 *   join      - start QR, no team yet: ask for a team name
 *   resume    - start QR, team already registered
 *   decoy     - decoy QR: show its message
 *   no-team   - any other QR on a phone with no team
 *   found     - the team's next milestone (progress advanced)
 *   again     - a milestone the team already found
 *   off-path  - not this team's next stop (wrong path, or too far ahead)
 *   early     - finish QR before all milestones were found
 *   finished  - finish QR after all milestones (first time: justFinished)
 */
export function scanCode(db, code, team) {
  const log = (result) =>
    db.prepare('INSERT INTO scans (hunt_id, team_id, code_id, result) VALUES (?, ?, ?, ?)').run(code.hunt_id, team?.id ?? null, code.id, result);
  const touch = () => team && db.prepare("UPDATE teams SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(team.id);

  if (code.kind === 'decoy') {
    log('decoy');
    touch();
    return { type: 'decoy', message: code.message };
  }
  if (code.kind === 'start') return { type: team ? 'resume' : 'join' };
  if (!team) {
    log('no-team');
    return { type: 'no-team' };
  }

  return tx(db, () => {
    touch();
    const hunt = getHunt(db, code.hunt_id);
    const fresh = db.prepare('SELECT * FROM teams WHERE id = ?').get(team.id);

    if (code.kind === 'finish') {
      if (fresh.finished_at) {
        log('repeat');
        return { type: 'finished' };
      }
      if (fresh.progress >= hunt.milestones) {
        db.prepare("UPDATE teams SET finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(team.id);
        log('finish');
        return { type: 'finished', justFinished: true };
      }
      log('early');
      return { type: 'early', progress: fresh.progress, total: hunt.milestones };
    }

    const step = fresh.path_id ? pathSteps(db, fresh.path_id).find((s) => s.code_id === code.id) : null;
    if (!step) {
      log('wrong');
      return { type: 'off-path' };
    }
    if (step.position <= fresh.progress) {
      log('repeat');
      return { type: 'again', position: step.position, total: hunt.milestones };
    }
    if (step.position === fresh.progress + 1 && !fresh.finished_at) {
      db.prepare('UPDATE teams SET progress = ? WHERE id = ?').run(step.position, team.id);
      log('advance');
      return { type: 'found', position: step.position, total: hunt.milestones };
    }
    log('ahead');
    return { type: 'off-path' };
  });
}

/* ---------------------------------------------------------------- admin views */

export function liveData(db, huntId) {
  const bundle = getBundle(db, huntId);
  if (!bundle) return null;
  const codeById = new Map(bundle.codes.map((c) => [c.id, c]));
  const pathById = new Map(bundle.paths.map((p) => [p.id, p]));
  const n = bundle.hunt.milestones;

  const teams = db.prepare(`
    SELECT t.id, t.name, t.path_id, t.join_code, t.progress, t.started_at, t.last_seen_at, t.finished_at,
      (SELECT COUNT(*) FROM scans s WHERE s.team_id = t.id AND s.result IN ('wrong', 'ahead', 'early')) AS wrong_scans,
      (SELECT COUNT(*) FROM scans s WHERE s.team_id = t.id AND s.result = 'decoy') AS decoy_scans,
      (SELECT s.code_id FROM scans s WHERE s.team_id = t.id ORDER BY s.id DESC LIMIT 1) AS last_code_id,
      (SELECT s.result FROM scans s WHERE s.team_id = t.id ORDER BY s.id DESC LIMIT 1) AS last_result
    FROM teams t WHERE t.hunt_id = ?
    ORDER BY (t.finished_at IS NULL), t.finished_at, t.progress DESC, t.last_seen_at
  `).all(huntId);

  let rank = 0;
  for (const t of teams) {
    const path = pathById.get(t.path_id);
    t.rank = t.finished_at ? ++rank : null;
    t.path_name = path?.name ?? '(no path)';
    t.path_color = path?.color ?? '#94a3b8';
    t.last_label = describeCode(codeById.get(t.last_code_id));
    if (t.finished_at) t.heading_to = null;
    else if (t.progress >= n) t.heading_to = 'Final destination';
    else t.heading_to = describeCode(codeById.get(path?.steps[t.progress]?.code_id)) || '?';
  }

  const activity = db.prepare(`
    SELECT s.id, s.team_id, s.code_id, s.result, s.at, t.name AS team_name
    FROM scans s LEFT JOIN teams t ON t.id = s.team_id
    WHERE s.hunt_id = ? ORDER BY s.id DESC LIMIT 80
  `).all(huntId);
  for (const a of activity) {
    const c = codeById.get(a.code_id);
    a.code_label = describeCode(c);
    a.code_kind = c?.kind ?? null;
  }

  const totals = db.prepare(`
    SELECT COUNT(*) AS scans,
      SUM(result = 'decoy') AS decoys,
      SUM(result IN ('wrong', 'ahead', 'early')) AS wrong
    FROM scans WHERE hunt_id = ?
  `).get(huntId);

  return {
    hunt: bundle.hunt,
    paths: bundle.paths.map((p) => ({ id: p.id, name: p.name, color: p.color, team_count: p.team_count })),
    teams,
    activity,
    stats: {
      teams: teams.length,
      finished: rank,
      scans: totals.scans ?? 0,
      decoys: totals.decoys ?? 0,
      wrong: totals.wrong ?? 0,
    },
  };
}

function describeCode(code) {
  if (!code) return '';
  if (code.label) return code.label;
  return `${code.kind[0].toUpperCase()}${code.kind.slice(1)} ${code.token}`;
}

export function teamDetail(db, teamId) {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
  if (!team) return null;
  const bundle = getBundle(db, team.hunt_id);
  const codeById = new Map(bundle.codes.map((c) => [c.id, c]));
  const path = bundle.paths.find((p) => p.id === team.path_id) ?? null;
  const scans = db.prepare('SELECT * FROM scans WHERE team_id = ? ORDER BY id').all(teamId);
  const reachedAt = new Map(scans.filter((s) => s.result === 'advance').map((s) => [s.code_id, s.at]));

  const route = (path?.steps ?? []).map((s) => ({
    position: s.position,
    label: describeCode(codeById.get(s.code_id)),
    reached: s.position <= team.progress,
    at: reachedAt.get(s.code_id) ?? null,
  }));
  route.push({ position: null, label: 'Final destination', reached: Boolean(team.finished_at), at: team.finished_at });

  return {
    team: { ...team, token: undefined },
    path: path && { id: path.id, name: path.name, color: path.color },
    route,
    scans: scans.map((s) => ({ ...s, code_label: describeCode(codeById.get(s.code_id)), code_kind: codeById.get(s.code_id)?.kind ?? null })),
  };
}

export function updateTeam(db, teamId, { name, path_id, progress }) {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
  if (!team) throw new UserError('Team not found.', 404);
  const hunt = getHunt(db, team.hunt_id);
  const next = { ...team };

  if (name !== undefined) {
    next.name = String(name).trim().replace(/\s+/g, ' ');
    if (!next.name) throw new UserError('Team name cannot be empty.');
    const taken = db.prepare('SELECT 1 FROM teams WHERE hunt_id = ? AND lower(name) = lower(?) AND id != ?').get(team.hunt_id, next.name, teamId);
    if (taken) throw new UserError('Another team already has that name.');
  }
  if (path_id !== undefined && Number(path_id) !== team.path_id) {
    const path = db.prepare('SELECT * FROM paths WHERE id = ? AND hunt_id = ?').get(path_id, team.hunt_id);
    if (!path) throw new UserError('Pick a path from this hunt.');
    next.path_id = path.id;
  }
  if (progress !== undefined) {
    const p = Number(progress);
    if (!Number.isInteger(p) || p < 0 || p > hunt.milestones) throw new UserError(`Progress must be between 0 and ${hunt.milestones}.`);
    next.progress = p;
    if (p < hunt.milestones) next.finished_at = null;
  }

  db.prepare('UPDATE teams SET name = ?, path_id = ?, progress = ?, finished_at = ? WHERE id = ?')
    .run(next.name, next.path_id, next.progress, next.finished_at, teamId);
}
