'use strict';
/* SENTINEL — database schema and additive migrations (node:sqlite, zero deps). */
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = process.env.SENTINEL_DB_PATH
  ? path.resolve(process.env.SENTINEL_DB_PATH)
  : path.join(DEFAULT_DATA_DIR, 'sentinel.db');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');

// These definitions are the complete schema for a fresh database. Migrations
// below add the same fields to existing installations without rebuilding a
// table or changing the meaning of a legacy column.
db.exec(`
CREATE TABLE IF NOT EXISTS units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  region TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS personnel (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  force_id TEXT UNIQUE NOT NULL,
  rank TEXT NOT NULL,
  name TEXT NOT NULL,
  unit_id INTEGER NOT NULL REFERENCES units(id),
  years_service INTEGER NOT NULL DEFAULT 0,
  family_status TEXT NOT NULL DEFAULT 'single',
  join_date TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  aggregate_consent INTEGER NOT NULL DEFAULT 0 CHECK (aggregate_consent IN (0, 1)),
  welfare_share INTEGER NOT NULL DEFAULT 0 CHECK (welfare_share IN (0, 1))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('personnel','welfare','commander')),
  name TEXT NOT NULL,
  unit_id INTEGER REFERENCES units(id) ON DELETE SET NULL,
  personnel_id INTEGER REFERENCES personnel(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hr_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  personnel_id INTEGER NOT NULL REFERENCES personnel(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  date TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'personnel_record',
  updated_at TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  personnel_id INTEGER NOT NULL REFERENCES personnel(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  stress INTEGER NOT NULL,
  sleep_hours REAL NOT NULL,
  mood TEXT NOT NULL DEFAULT '',
  physical_symptoms INTEGER NOT NULL DEFAULT 0,
  feeling_supported INTEGER NOT NULL DEFAULT 3,
  anonymous INTEGER NOT NULL DEFAULT 0,
  energy INTEGER NOT NULL DEFAULT 3,
  UNIQUE (personnel_id, date)
);

CREATE TABLE IF NOT EXISTS assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  personnel_id INTEGER NOT NULL REFERENCES personnel(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  type TEXT NOT NULL,
  score INTEGER NOT NULL,
  answers TEXT NOT NULL DEFAULT '[]',
  raw_score INTEGER,
  display_score INTEGER,
  level TEXT NOT NULL DEFAULT '',
  urgent INTEGER NOT NULL DEFAULT 0 CHECK (urgent IN (0, 1)),
  instrument_version TEXT NOT NULL DEFAULT 'prototype-v1'
);

CREATE TABLE IF NOT EXISTS risk_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  personnel_id INTEGER NOT NULL REFERENCES personnel(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  score INTEGER NOT NULL,
  band TEXT NOT NULL,
  factors TEXT NOT NULL DEFAULT '[]',
  UNIQUE (personnel_id, date)
);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  personnel_id INTEGER NOT NULL REFERENCES personnel(id) ON DELETE CASCADE,
  level TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  acted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action_note TEXT NOT NULL DEFAULT '',
  resolved_at TEXT,
  cleared_at TEXT,
  risk_signature TEXT NOT NULL DEFAULT '',
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS interventions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  personnel_id INTEGER NOT NULL REFERENCES personnel(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  recommended_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'recommended',
  completed_at TEXT,
  outcome_note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  personnel_id INTEGER NOT NULL REFERENCES personnel(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  words INTEGER NOT NULL DEFAULT 0,
  time_sec INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  timeline TEXT NOT NULL DEFAULT '[]',
  started_at TEXT NOT NULL DEFAULT '',
  UNIQUE (personnel_id, date)
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  target_personnel INTEGER REFERENCES personnel(id) ON DELETE SET NULL,
  justification TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS data_corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  personnel_id INTEGER NOT NULL REFERENCES personnel(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted',
  resolved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resolution_note TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS support_cases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  personnel_id INTEGER NOT NULL REFERENCES personnel(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  priority TEXT NOT NULL DEFAULT 'Routine',
  status TEXT NOT NULL DEFAULT 'New',
  next_action TEXT NOT NULL DEFAULT '',
  follow_up_due TEXT,
  last_contact_at TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  shared_context TEXT NOT NULL DEFAULT '{}',
  assigned_officer_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  first_response_at TEXT
);

CREATE TABLE IF NOT EXISTS case_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  author_id INTEGER NOT NULL REFERENCES users(id),
  note TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS case_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id INTEGER NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS org_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  unit_id INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  evidence TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'Planned',
  baseline_overtime REAL NOT NULL DEFAULT 0,
  baseline_sleep REAL,
  baseline_recovery REAL,
  baseline_condition TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  reviewed_at TEXT,
  suggested_response TEXT NOT NULL DEFAULT '',
  review_date TEXT,
  after_overtime REAL,
  after_recovery REAL,
  after_condition TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT,
  simulated INTEGER NOT NULL DEFAULT 0 CHECK (simulated IN (0, 1))
);

CREATE TABLE IF NOT EXISTS org_action_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id INTEGER NOT NULL REFERENCES org_actions(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`);

function tableColumns(table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name));
}

function ensureColumn(table, column, definition) {
  if (!tableColumns(table).has(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function migrate(version, apply) {
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(version)) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    apply();
    db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run(version, new Date().toISOString());
    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

migrate('001_existing_lifecycle_fields', () => {
  ensureColumn('journal_entries', 'timeline', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn('journal_entries', 'started_at', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('alerts', 'resolved_at', 'TEXT');
  ensureColumn('alerts', 'cleared_at', 'TEXT');
  ensureColumn('alerts', 'risk_signature', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('alerts', 'last_seen_at', 'TEXT');
  ensureColumn('personnel', 'aggregate_consent', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('personnel', 'welfare_share', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('checkins', 'energy', 'INTEGER NOT NULL DEFAULT 3');
});

migrate('002_assessment_result_metadata', () => {
  ensureColumn('assessments', 'raw_score', 'INTEGER');
  ensureColumn('assessments', 'display_score', 'INTEGER');
  ensureColumn('assessments', 'level', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('assessments', 'urgent', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn('assessments', 'instrument_version', "TEXT NOT NULL DEFAULT 'prototype-v1'");

  // Exact display metadata can be recovered only when a valid answer set was
  // retained. Legacy normalized scores without answers deliberately stay null.
  const rows = db.prepare(`SELECT id, type, answers FROM assessments
    WHERE raw_score IS NULL OR display_score IS NULL OR level = ''`).all();
  const update = db.prepare(`UPDATE assessments SET raw_score = ?, display_score = ?, level = ?, urgent = ?
    WHERE id = ?`);
  for (const row of rows) {
    const scored = scoreStoredAssessment(row.type, row.answers);
    if (scored) update.run(scored.raw, scored.display, scored.level, scored.urgent ? 1 : 0, row.id);
  }
});

migrate('003_case_assignment_and_timeline', () => {
  ensureColumn('support_cases', 'shared_context', "TEXT NOT NULL DEFAULT '{}'");
  ensureColumn('support_cases', 'assigned_officer_id', 'INTEGER');
  ensureColumn('support_cases', 'first_response_at', 'TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS case_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id INTEGER NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
    actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL
  )`);
  db.exec(`UPDATE support_cases SET first_response_at = last_contact_at
    WHERE first_response_at IS NULL AND last_contact_at IS NOT NULL`);
});

migrate('004_org_action_outcomes', () => {
  ensureColumn('org_actions', 'suggested_response', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('org_actions', 'review_date', 'TEXT');
  ensureColumn('org_actions', 'baseline_recovery', 'REAL');
  ensureColumn('org_actions', 'baseline_condition', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('org_actions', 'after_overtime', 'REAL');
  ensureColumn('org_actions', 'after_recovery', 'REAL');
  ensureColumn('org_actions', 'after_condition', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('org_actions', 'outcome', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('org_actions', 'created_by', 'INTEGER');
  ensureColumn('org_actions', 'updated_at', 'TEXT');
  ensureColumn('org_actions', 'simulated', 'INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE TABLE IF NOT EXISTS org_action_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_id INTEGER NOT NULL REFERENCES org_actions(id) ON DELETE CASCADE,
    actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL
  )`);
  db.exec(`UPDATE org_actions SET updated_at = COALESCE(reviewed_at, started_at)
    WHERE updated_at IS NULL`);
});

migrate('005_hr_event_provenance', () => {
  ensureColumn('hr_events', 'source', "TEXT NOT NULL DEFAULT 'personnel_record'");
  ensureColumn('hr_events', 'updated_at', "TEXT NOT NULL DEFAULT ''");
  db.exec(`UPDATE hr_events SET updated_at = date || 'T00:00:00.000Z'
    WHERE updated_at = ''`);
});

function scoreStoredAssessment(type, serializedAnswers) {
  let answers;
  try { answers = JSON.parse(serializedAnswers); } catch { return null; }
  if (!Array.isArray(answers)) return null;
  const specs = { WHO5: [5, 5], PSS10: [10, 4], GAD7: [7, 3], PHQ9: [9, 3] };
  const spec = specs[type];
  if (!spec || answers.length !== spec[0] || answers.some(value =>
    !Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > spec[1])) return null;
  const values = answers.map(Number);
  if (type === 'WHO5') {
    const raw = values.reduce((sum, value) => sum + value, 0);
    const display = raw * 4;
    return { raw, display, urgent: false, level: display > 50 ? 'Good wellbeing' : display >= 29 ? 'Low wellbeing' : 'Very low wellbeing' };
  }
  if (type === 'PSS10') {
    const raw = values.reduce((sum, value, index) => sum + ([3, 4, 6, 7].includes(index) ? 4 - value : value), 0);
    return { raw, display: raw, urgent: false, level: raw <= 13 ? 'Low perceived stress' : raw <= 26 ? 'Moderate perceived stress' : 'High perceived stress' };
  }
  const raw = values.reduce((sum, value) => sum + value, 0);
  if (type === 'GAD7') {
    return { raw, display: raw, urgent: false, level: raw <= 4 ? 'Minimal anxiety' : raw <= 9 ? 'Mild anxiety' : raw <= 14 ? 'Moderate anxiety' : 'Severe anxiety' };
  }
  return { raw, display: raw, urgent: values[8] > 0,
    level: raw <= 4 ? 'Minimal symptoms' : raw <= 9 ? 'Mild symptoms' : raw <= 14 ? 'Moderate symptoms' : raw <= 19 ? 'Moderately severe symptoms' : 'Severe symptoms' };
}

// Read/query indexes are intentionally outside the migration callbacks: each
// CREATE is idempotent and old databases immediately receive the useful plan.
db.exec(`
CREATE INDEX IF NOT EXISTS idx_hr_pid ON hr_events(personnel_id, date);
CREATE INDEX IF NOT EXISTS idx_hr_source_date ON hr_events(source, date);
CREATE INDEX IF NOT EXISTS idx_assessments_pid_date ON assessments(personnel_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_checkins_date_contributor ON checkins(date, personnel_id);
CREATE INDEX IF NOT EXISTS idx_support_cases_queue ON support_cases(status, priority, created_at);
CREATE INDEX IF NOT EXISTS idx_support_cases_personnel ON support_cases(personnel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_cases_officer ON support_cases(assigned_officer_id, status, follow_up_due);
CREATE INDEX IF NOT EXISTS idx_case_notes_case_at ON case_notes(case_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_case_events_case_at ON case_events(case_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_org_actions_unit_status ON org_actions(unit_id, status, review_date);
CREATE INDEX IF NOT EXISTS idx_org_action_events_action_at ON org_action_events(action_id, at DESC);
`);

// Existing installations used a case-sensitive UNIQUE constraint. Add a
// case-insensitive guard when legacy data is unambiguous; login separately
// rejects an ambiguous legacy duplicate.
const duplicateUsernames = db.prepare(`SELECT lower(trim(username)) username, COUNT(*) count
  FROM users GROUP BY lower(trim(username)) HAVING COUNT(*) > 1 LIMIT 1`).get();
if (!duplicateUsernames) {
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE)');
} else {
  console.warn('Case-insensitive username index not installed: ambiguous legacy usernames exist.');
}

// A race-safe one-active-case invariant is installed only when legacy content
// already satisfies it. This preserves access to databases with old duplicates.
const duplicateActiveCase = db.prepare(`SELECT personnel_id, COUNT(*) count FROM support_cases
  WHERE status != 'Resolved' GROUP BY personnel_id HAVING COUNT(*) > 1 LIMIT 1`).get();
if (!duplicateActiveCase) {
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_support_cases_one_active
    ON support_cases(personnel_id) WHERE status != 'Resolved'`);
} else {
  console.warn('One-active-case index not installed: legacy duplicate active cases exist.');
}

module.exports = db;
module.exports.path = DB_PATH;
