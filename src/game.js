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

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export const PATH_COLORS = ['#00629b', '#e87722', '#78be20', '#ba0c2f', '#00b5e2', '#002855', '#ffc72c', '#4f7f2a', '#8b5e3c', '#5b6770'];

const DEFAULT_WELCOME = 'Pick a team name to get your first clue. Use this same phone for every code you scan.';
const DEFAULT_FINISH = 'You found the final destination. Congratulations!';
const DEFAULT_DECOY = 'The real code is hiding close by. Keep looking.';
export const MAX_CARDS = 12;

/* ---------------------------------------------------------------- input */

function wholeNumber(value, min, max, message) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new UserError(message);
  return n;
}

const MAX_TEAM_NAME = 40;

/** Team names: single spaces, 1 to 40 characters. Used for registration and admin renames. */
function cleanTeamName(raw) {
  const name = String(raw ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new UserError('Enter a team name.');
  if (name.length > MAX_TEAM_NAME) throw new UserError(`Keep the team name to ${MAX_TEAM_NAME} characters or fewer.`);
  return name;
}

/* ---------------------------------------------------------------- hunts */

export function createHunt(db, { name, milestones }) {
  name = String(name ?? '').trim();
  if (!name) throw new UserError('Give the hunt a name.');
  milestones = wholeNumber(milestones, 1, 50, 'Milestones per team must be a whole number between 1 and 50.');
  return tx(db, () => {
    const { lastInsertRowid } = db
      .prepare('INSERT INTO hunts (name, milestones, welcome, finish_message, decoy_message) VALUES (?, ?, ?, ?, ?)')
      .run(name, milestones, DEFAULT_WELCOME, DEFAULT_FINISH, DEFAULT_DECOY);
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
  if (changes.decoy_message !== undefined) next.decoy_message = String(changes.decoy_message);
  if (changes.decoys_per_location !== undefined) {
    next.decoys_per_location = wholeNumber(changes.decoys_per_location, 0, MAX_CARDS - 1, `Decoys per location must be between 0 and ${MAX_CARDS - 1}.`);
  }
  for (const key of ['shuffle_min', 'shuffle_max']) {
    if (changes[key] !== undefined) next[key] = wholeNumber(changes[key], 1, 240, 'Shuffle times must be between 1 and 240 minutes.');
  }
  if (next.shuffle_min > next.shuffle_max) throw new UserError('The shortest shuffle time cannot be longer than the longest.');

  if (changes.milestones !== undefined && Number(changes.milestones) !== hunt.milestones) {
    const n = wholeNumber(changes.milestones, 1, 50, 'Milestones per team must be between 1 and 50.');
    const teams = db.prepare('SELECT COUNT(*) AS n FROM teams WHERE hunt_id = ?').get(id).n;
    if (teams > 0) throw new UserError('Milestone count cannot change once teams have started. Reset the teams first.');
    next.milestones = n;
  }

  if (changes.status !== undefined && changes.status !== hunt.status) {
    if (!['draft', 'live', 'ended'].includes(changes.status)) throw new UserError('Unknown status.');
    next.status = changes.status;
  }

  // A live hunt must stay playable: check when going live, and when the
  // milestone count changes under a hunt that is already live.
  if (next.status === 'live' && (hunt.status !== 'live' || next.milestones !== hunt.milestones)) {
    const { errors } = validateHunt(getBundle(db, id, { overrides: { milestones: next.milestones }, cards: false }));
    if (errors.length) {
      const lead = hunt.status === 'live' ? 'That change would leave the live hunt unplayable' : `Fix ${errors.length} problem(s) before going live`;
      throw new UserError(`${lead}: ${errors[0].message}`);
    }
  }

  tx(db, () => {
    db.prepare(`UPDATE hunts SET name = ?, welcome = ?, finish_message = ?, milestones = ?, status = ?,
        decoy_message = ?, decoys_per_location = ?, shuffle_min = ?, shuffle_max = ? WHERE id = ?`)
      .run(next.name, next.welcome, next.finish_message, next.milestones, next.status,
        next.decoy_message, next.decoys_per_location, next.shuffle_min, next.shuffle_max, id);
    if (next.milestones < hunt.milestones) {
      db.prepare('DELETE FROM path_steps WHERE position > ? AND path_id IN (SELECT id FROM paths WHERE hunt_id = ?)')
        .run(next.milestones, id);
    }
  });
  return getHunt(db, id);
}

/**
 * Hunt plus all of its codes and paths (each path padded to exactly `milestones` steps).
 * With `cards: false` it skips the printed cards, scan counts and the real-card
 * rotation: enough for validation, path choice and the live board.
 */
export function getBundle(db, huntId, { overrides = {}, cards = true } = {}) {
  const found = getHunt(db, huntId);
  if (!found) return null;
  const hunt = { ...found, ...overrides };

  const codes = db.prepare(`
    SELECT c.*${cards ? ', (SELECT COUNT(*) FROM scans s WHERE s.code_id = c.id) AS scan_count' : ''}
    FROM codes c WHERE c.hunt_id = ?
    ORDER BY CASE c.kind WHEN 'start' THEN 0 WHEN 'checkpoint' THEN 1 WHEN 'decoy' THEN 2 ELSE 3 END, c.id
  `).all(huntId);

  if (cards) {
    const rows = db.prepare(`
      SELECT k.id, k.code_id, k.token, k.slot, (SELECT COUNT(*) FROM scans s WHERE s.card_id = k.id) AS scan_count
      FROM cards k JOIN codes c ON c.id = k.code_id
      WHERE c.hunt_id = ? ORDER BY k.code_id, k.slot
    `).all(huntId);
    const cardsByCode = Map.groupBy(rows, (k) => k.code_id);
    for (const c of codes) {
      c.cards = cardsByCode.get(c.id) ?? [];
      if (c.kind !== 'decoy' && c.cards.length > 1) {
        // Bring the rotation up to date so the dashboard shows the card that is real right now.
        const current = currentRealCard(db, c.id);
        c.real_card_id = current.real_card_id;
        c.next_shuffle_at = current.next_shuffle_at;
      }
    }
  }

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
    if (c.kind === 'checkpoint' && c.usage.length === 0) warnings.push({ code_id: c.id, message: `Checkpoint "${c.label || `#${c.id}`}" is not in any path. Scanning it will just say "not your next stop".` });
    if (c.kind === 'decoy' && !c.message.trim()) warnings.push({ code_id: c.id, message: `Decoy "${c.label || `#${c.id}`}" has no message.` });
  }

  return { errors, warnings };
}

/* ---------------------------------------------------------------- codes */

function insertCode(db, huntId, kind, label = '', message = '', cardCount = 1) {
  const { lastInsertRowid } = db
    .prepare('INSERT INTO codes (hunt_id, kind, label, message) VALUES (?, ?, ?, ?)')
    .run(huntId, kind, label, message);
  const id = Number(lastInsertRowid);
  for (let slot = 1; slot <= cardCount; slot++) insertCard(db, id, slot);
  if (kind !== 'decoy') shuffleRealCard(db, id);
  return id;
}

function insertCard(db, codeId, slot) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return Number(db.prepare('INSERT INTO cards (code_id, token, slot) VALUES (?, ?, ?)').run(codeId, randomCode(10), slot).lastInsertRowid);
    } catch (err) {
      if (!String(err.message).includes('UNIQUE')) throw err;
    }
  }
  throw new Error('Could not generate a unique QR token.');
}

/**
 * Add checkpoint or standalone decoy locations. Each checkpoint gets one real
 * card plus `decoys` decoy cards (default: the hunt's decoys_per_location).
 */
export function createCodes(db, huntId, kind, items) {
  if (!['checkpoint', 'decoy'].includes(kind)) throw new UserError('You can only add checkpoint or decoy QRs.');
  const hunt = getHunt(db, huntId);
  if (!hunt) throw new UserError('Hunt not found.', 404);
  if (!Array.isArray(items) || items.length === 0) throw new UserError('Nothing to add.');
  if (items.length > 200) throw new UserError('Add at most 200 QRs at a time.');
  if (items.some((it) => !it || typeof it !== 'object')) throw new UserError('Each QR must be given as an object with a label.');
  return tx(db, () => items.map((it) => {
    const cards = kind === 'checkpoint' ? clampCards(1 + Number(it.decoys ?? hunt.decoys_per_location)) : 1;
    return insertCode(db, huntId, kind, String(it.label ?? '').trim(), String(it.message ?? ''), cards);
  }));
}

function clampCards(n) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_CARDS) throw new UserError(`A location can have between 1 and ${MAX_CARDS} QR cards.`);
  return n;
}

export function getCode(db, id) {
  return db.prepare('SELECT * FROM codes WHERE id = ?').get(id) ?? null;
}

export function getCardByToken(db, token) {
  return db.prepare('SELECT * FROM cards WHERE token = ?').get(String(token).toUpperCase()) ?? null;
}

export function getCard(db, id) {
  return db.prepare('SELECT * FROM cards WHERE id = ?').get(id) ?? null;
}

export function updateCode(db, id, { label, message, cards }) {
  const code = getCode(db, id);
  if (!code) throw new UserError('QR not found.', 404);
  tx(db, () => {
    db.prepare('UPDATE codes SET label = ?, message = ? WHERE id = ?').run(
      label !== undefined ? String(label).trim() : code.label,
      message !== undefined ? String(message) : code.message,
      id,
    );
    if (cards !== undefined) setCardCount(db, id, Number(cards));
  });
  return getCode(db, id);
}

/** Add or remove printed cards at a location (cards are removed from the highest slot down). */
export function setCardCount(db, codeId, total) {
  const code = getCode(db, codeId);
  if (!code) throw new UserError('QR not found.', 404);
  if (!['checkpoint', 'finish'].includes(code.kind)) throw new UserError('Only checkpoints and the finish can have decoy cards.');
  clampCards(total);
  const existing = db.prepare('SELECT COUNT(*) AS n FROM cards WHERE code_id = ?').get(codeId).n;
  for (let slot = existing + 1; slot <= total; slot++) insertCard(db, codeId, slot);
  if (total < existing) db.prepare('DELETE FROM cards WHERE code_id = ? AND slot > ?').run(codeId, total);
  const realStillThere = db.prepare('SELECT 1 FROM cards WHERE id = ?').get(code.real_card_id);
  if (!realStillThere) shuffleRealCard(db, codeId);
}

/* ---------------------------------------------------------------- shuffling */

function shuffleDelay(hunt) {
  const min = hunt.shuffle_min * 60_000;
  const max = hunt.shuffle_max * 60_000;
  return min + crypto.randomInt(max - min + 1);
}

/** Make a different card (picked at random) the real one, and schedule the next shuffle. */
export function shuffleRealCard(db, codeId, now = Date.now()) {
  const code = getCode(db, codeId);
  const cards = db.prepare('SELECT id FROM cards WHERE code_id = ?').all(codeId);
  if (cards.length === 0) return null;
  const others = cards.filter((c) => c.id !== code.real_card_id);
  const pool = others.length ? others : cards;
  const pick = pool[crypto.randomInt(pool.length)].id;
  const next = new Date(now + shuffleDelay(getHunt(db, code.hunt_id))).toISOString();
  db.prepare('UPDATE codes SET real_card_id = ?, next_shuffle_at = ? WHERE id = ?').run(pick, next, codeId);
  return pick;
}

/**
 * The card that is real at this location right now. The timed shuffle is
 * applied lazily: nobody can tell the difference until a card is scanned.
 */
export function realCardId(db, code, now = Date.now()) {
  if (code.kind === 'decoy') return null;
  return currentRealCard(db, code.id, now).real_card_id;
}

/** The location's row with its rotation brought up to date (shuffled if the timer is due). */
function currentRealCard(db, codeId, now = Date.now()) {
  const fresh = getCode(db, codeId);
  const valid = fresh.real_card_id && db.prepare('SELECT 1 FROM cards WHERE id = ? AND code_id = ?').get(fresh.real_card_id, fresh.id);
  const cardCount = db.prepare('SELECT COUNT(*) AS n FROM cards WHERE code_id = ?').get(fresh.id).n;
  if (!valid || (cardCount > 1 && (!fresh.next_shuffle_at || now >= Date.parse(fresh.next_shuffle_at)))) {
    shuffleRealCard(db, fresh.id, now);
    return getCode(db, codeId);
  }
  return fresh;
}

export function shuffleAll(db, huntId) {
  const codes = db.prepare("SELECT id FROM codes WHERE hunt_id = ? AND kind != 'decoy'").all(huntId);
  tx(db, () => codes.forEach((c) => shuffleRealCard(db, c.id)));
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
  if (color !== undefined && color !== null && color !== '' && !COLOR_RE.test(color)) throw new UserError('Colour must look like #rrggbb.');
  const existing = db.prepare('SELECT name, color FROM paths WHERE hunt_id = ?').all(huntId);
  // Default to the first unused "Path X" name and the least-used colour, so deleting
  // a path never makes the next one share a name or colour with a live path.
  const names = new Set(existing.map((p) => p.name));
  let index = 0;
  while (names.has(pathName(index))) index++;
  const uses = (c) => existing.filter((p) => p.color.toLowerCase() === c).length;
  const nextColor = PATH_COLORS.reduce((best, c) => (uses(c) < uses(best) ? c : best));
  const { lastInsertRowid } = db
    .prepare('INSERT INTO paths (hunt_id, name, color) VALUES (?, ?, ?)')
    .run(huntId, String(name ?? '').trim() || pathName(index), color || nextColor);
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
  if (color !== undefined && !COLOR_RE.test(color)) throw new UserError('Colour must look like #rrggbb.');

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
  const bundle = getBundle(db, huntId, { cards: false });
  if (!bundle) throw new UserError('Hunt not found.', 404);
  count = wholeNumber(count, 1, 50, 'Generate between 1 and 50 paths.');
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
  const bundle = getBundle(db, huntId, { cards: false });
  const { errors } = validateHunt(bundle);
  const broken = new Set(errors.map((e) => e.path_id).filter(Boolean));
  const ready = bundle.paths.filter((p) => !broken.has(p.id));
  if (ready.length === 0) throw new UserError('This hunt has no ready paths yet. Please find an organiser.', 503);
  const fewest = Math.min(...ready.map((p) => p.team_count));
  const candidates = ready.filter((p) => p.team_count === fewest);
  return candidates[crypto.randomInt(candidates.length)];
}

export function registerTeam(db, huntId, rawName, startCard) {
  const name = cleanTeamName(rawName);

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
    db.prepare('INSERT INTO scans (hunt_id, team_id, code_id, card_id, result) VALUES (?, ?, ?, ?, ?)')
      .run(huntId, teamId, startCard?.code_id ?? null, startCard?.id ?? null, 'registered');
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
 * Apply a scan of one printed card. `team` may be null when the phone has no
 * team yet. Returns { type, ... } describing what to show:
 *   join      - start QR, no team yet: ask for a team name
 *   resume    - start QR, team already registered
 *   decoy     - a standalone decoy, or a card that is not the real one right now
 *   no-team   - the real card of a location, on a phone with no team
 *   found     - the team's next milestone (progress advanced)
 *   again     - a milestone the team already found
 *   off-path  - not this team's next stop (other path, or too far ahead)
 *   early     - finish QR before all milestones were found
 *   finished  - finish QR after all milestones (first time: justFinished)
 * Scanning the real card of a multi-card location moves the real QR to
 * another card, so the next team cannot just copy which card was scanned.
 */
export function scanCard(db, card, team, now = Date.now()) {
  const code = getCode(db, card.code_id);
  const hunt = getHunt(db, code.hunt_id);
  const log = (result) =>
    db.prepare('INSERT INTO scans (hunt_id, team_id, code_id, card_id, result) VALUES (?, ?, ?, ?, ?)')
      .run(hunt.id, team?.id ?? null, code.id, card.id, result);
  const touch = () => team && db.prepare("UPDATE teams SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(team.id);

  if (code.kind === 'start') return { type: team ? 'resume' : 'join' };

  if (realCardId(db, code, now) !== card.id) {
    log('decoy');
    touch();
    return { type: 'decoy', message: code.kind === 'decoy' ? code.message : hunt.decoy_message };
  }

  return tx(db, () => {
    const result = scanRealCard(db, hunt, code, team, log);
    touch();
    if (db.prepare('SELECT COUNT(*) AS n FROM cards WHERE code_id = ?').get(code.id).n > 1) shuffleRealCard(db, code.id, now);
    return result;
  });
}

function scanRealCard(db, hunt, code, team, log) {
  if (!team) {
    log('no-team');
    return { type: 'no-team' };
  }
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
}

/* ---------------------------------------------------------------- admin views */

export function liveData(db, huntId) {
  const bundle = getBundle(db, huntId, { cards: false });
  if (!bundle) return null;
  const codeById = new Map(bundle.codes.map((c) => [c.id, c]));
  const pathById = new Map(bundle.paths.map((p) => [p.id, p]));
  const n = bundle.hunt.milestones;

  const teams = db.prepare(`
    SELECT t.id, t.name, t.path_id, t.join_code, t.progress, t.started_at, t.last_seen_at, t.finished_at,
      (SELECT COUNT(*) FROM scans s WHERE s.team_id = t.id AND s.result IN ('wrong', 'ahead', 'early')) AS wrong_scans,
      (SELECT COUNT(*) FROM scans s WHERE s.team_id = t.id AND s.result = 'decoy') AS decoy_scans,
      (SELECT s.code_id FROM scans s WHERE s.team_id = t.id ORDER BY s.id DESC LIMIT 1) AS last_code_id,
      (SELECT s.result FROM scans s WHERE s.team_id = t.id ORDER BY s.id DESC LIMIT 1) AS last_result,
      COALESCE((SELECT MAX(s.at) FROM scans s WHERE s.team_id = t.id AND s.result = 'advance'), t.started_at) AS progress_at
    FROM teams t WHERE t.hunt_id = ?
    -- finished teams by finishing time; the rest by progress, then by who reached it first
    ORDER BY (t.finished_at IS NULL), t.finished_at, t.progress DESC, progress_at, t.id
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
    SELECT s.id, s.team_id, s.code_id, s.result, s.at, t.name AS team_name, k.slot AS card_slot,
      (SELECT COUNT(*) FROM cards x WHERE x.code_id = s.code_id) AS card_total
    FROM scans s LEFT JOIN teams t ON t.id = s.team_id LEFT JOIN cards k ON k.id = s.card_id
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
  return `${code.kind[0].toUpperCase()}${code.kind.slice(1)} #${code.id}`;
}

export function teamDetail(db, teamId) {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
  if (!team) return null;
  const bundle = getBundle(db, team.hunt_id, { cards: false });
  const codeById = new Map(bundle.codes.map((c) => [c.id, c]));
  const path = bundle.paths.find((p) => p.id === team.path_id) ?? null;
  const scans = db.prepare(`
    SELECT s.*, k.slot AS card_slot, (SELECT COUNT(*) FROM cards x WHERE x.code_id = s.code_id) AS card_total
    FROM scans s LEFT JOIN cards k ON k.id = s.card_id WHERE s.team_id = ? ORDER BY s.id
  `).all(teamId);
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
    next.name = cleanTeamName(name);
    const taken = db.prepare('SELECT 1 FROM teams WHERE hunt_id = ? AND lower(name) = lower(?) AND id != ?').get(team.hunt_id, next.name, teamId);
    if (taken) throw new UserError('Another team already has that name.');
  }
  if (path_id !== undefined && Number(path_id) !== team.path_id) {
    const path = db.prepare('SELECT * FROM paths WHERE id = ? AND hunt_id = ?').get(path_id, team.hunt_id);
    if (!path) throw new UserError('Pick a path from this hunt.');
    next.path_id = path.id;
  }
  if (progress !== undefined) {
    const p = wholeNumber(progress, 0, hunt.milestones, `Progress must be between 0 and ${hunt.milestones}.`);
    next.progress = p;
    if (p < hunt.milestones) next.finished_at = null;
  }

  db.prepare('UPDATE teams SET name = ?, path_id = ?, progress = ?, finished_at = ? WHERE id = ?')
    .run(next.name, next.path_id, next.progress, next.finished_at, teamId);
}
