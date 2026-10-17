import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const NOW = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hunts (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  milestones     INTEGER NOT NULL CHECK (milestones BETWEEN 1 AND 50),
  status         TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'live', 'ended')),
  welcome        TEXT NOT NULL DEFAULT '',
  finish_message TEXT NOT NULL DEFAULT '',
  -- Decoy cards: every checkpoint can have several printed QR cards in the
  -- same spot. Only one is real at a time; it moves to another card at a
  -- random moment between shuffle_min and shuffle_max minutes, and right
  -- after anyone scans it.
  decoy_message       TEXT NOT NULL DEFAULT '',
  decoys_per_location INTEGER NOT NULL DEFAULT 4,
  shuffle_min         INTEGER NOT NULL DEFAULT 5,
  shuffle_max         INTEGER NOT NULL DEFAULT 10,
  created_at     TEXT NOT NULL DEFAULT ${NOW}
);

-- A location in the hunt. 'start' and 'finish' are shared by all teams,
-- 'checkpoint' locations are used by paths, standalone 'decoy' locations only
-- show a message.
CREATE TABLE IF NOT EXISTS codes (
  id              INTEGER PRIMARY KEY,
  hunt_id         INTEGER NOT NULL REFERENCES hunts(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('start', 'checkpoint', 'decoy', 'finish')),
  label           TEXT NOT NULL DEFAULT '',
  message         TEXT NOT NULL DEFAULT '',
  real_card_id    INTEGER,
  next_shuffle_at TEXT,
  created_at      TEXT NOT NULL DEFAULT ${NOW}
);

-- The printed QR cards placed at a location. A location with more than one
-- card has exactly one real card at a time (codes.real_card_id); the rest
-- act as decoys.
CREATE TABLE IF NOT EXISTS cards (
  id      INTEGER PRIMARY KEY,
  code_id INTEGER NOT NULL REFERENCES codes(id) ON DELETE CASCADE,
  token   TEXT NOT NULL UNIQUE,
  slot    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS paths (
  id         INTEGER PRIMARY KEY,
  hunt_id    INTEGER NOT NULL REFERENCES hunts(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  color      TEXT NOT NULL DEFAULT '#64748b',
  start_clue TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT ${NOW}
);

-- Step N of a path: the checkpoint the team must find, and the clue that
-- checkpoint's QR shows to teams on this path (pointing to step N+1, or to
-- the final destination after the last step).
CREATE TABLE IF NOT EXISTS path_steps (
  path_id  INTEGER NOT NULL REFERENCES paths(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  code_id  INTEGER REFERENCES codes(id) ON DELETE SET NULL,
  clue     TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (path_id, position)
);

CREATE TABLE IF NOT EXISTS teams (
  id           INTEGER PRIMARY KEY,
  hunt_id      INTEGER NOT NULL REFERENCES hunts(id) ON DELETE CASCADE,
  path_id      INTEGER REFERENCES paths(id) ON DELETE SET NULL,
  name         TEXT NOT NULL,
  token        TEXT NOT NULL UNIQUE,
  join_code    TEXT NOT NULL,
  progress     INTEGER NOT NULL DEFAULT 0,
  started_at   TEXT NOT NULL DEFAULT ${NOW},
  last_seen_at TEXT NOT NULL DEFAULT ${NOW},
  finished_at  TEXT,
  UNIQUE (hunt_id, join_code)
);

CREATE TABLE IF NOT EXISTS scans (
  id      INTEGER PRIMARY KEY,
  hunt_id INTEGER NOT NULL REFERENCES hunts(id) ON DELETE CASCADE,
  team_id INTEGER REFERENCES teams(id) ON DELETE CASCADE,
  code_id INTEGER REFERENCES codes(id) ON DELETE SET NULL,
  card_id INTEGER REFERENCES cards(id) ON DELETE SET NULL,
  result  TEXT NOT NULL,
  at      TEXT NOT NULL DEFAULT ${NOW}
);

CREATE INDEX IF NOT EXISTS idx_codes_hunt ON codes(hunt_id);
CREATE INDEX IF NOT EXISTS idx_cards_code ON cards(code_id);
CREATE INDEX IF NOT EXISTS idx_paths_hunt ON paths(hunt_id);
CREATE INDEX IF NOT EXISTS idx_teams_hunt ON teams(hunt_id);
CREATE INDEX IF NOT EXISTS idx_scans_hunt ON scans(hunt_id, id);
CREATE INDEX IF NOT EXISTS idx_scans_team ON scans(team_id, id);
CREATE INDEX IF NOT EXISTS idx_scans_code ON scans(code_id);
CREATE INDEX IF NOT EXISTS idx_scans_card ON scans(card_id);
CREATE INDEX IF NOT EXISTS idx_teams_path ON teams(path_id);
CREATE INDEX IF NOT EXISTS idx_steps_code ON path_steps(code_id);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const legacy = db.prepare("SELECT 1 FROM pragma_table_info('codes') WHERE name = 'token'").get();
  if (legacy) throw new Error(`${file} was created by an older version without decoy cards. Delete it (or set DATABASE_FILE) and restart.`);
  db.exec(SCHEMA);
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

export function setSetting(db, key, value) {
  if (value === null || value === undefined || value === '') {
    db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  } else {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  }
}
