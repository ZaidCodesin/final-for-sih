'use strict';
/* ProtecT — AI-Based Predictive Personnel Stress & Welfare Monitoring System
 * SIH 26186 · MHA / CRPF · Role-based access, privacy-first design.
 */
const express = require('express');
const crypto = require('crypto');
const path = require('path');
const db = require('./lib/db');
const { computeRisk, computeEarlyIndicator } = require('./lib/risk');
const { recommend } = require('./lib/recommend');
const { analyze: analyzeJournal, speedStats } = require('./lib/journal-analyze');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' https://fonts.googleapis.com 'unsafe-inline'; font-src https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; connect-src 'self'");
  next();
});

const PORT = process.env.PORT || 4400;
const APP_VERSION = process.env.RENDER_GIT_COMMIT || process.env.APP_VERSION || 'local-dev';
const DEMO_MODE = process.env.DEMO_ACCOUNTS !== 'false';
const todayStr = () => new Date().toISOString().slice(0, 10);

// auto-seed demo data on fresh deploys (e.g. Render free tier with empty disk)
if (db.prepare('SELECT COUNT(*) c FROM personnel').get().c === 0) {
  console.log('Empty database detected — seeding demo data...');
  require('./lib/seed');
  console.log('Running initial risk pipeline...');
  runPipeline();
}

/* ---------------- helpers ---------------- */
function send(res, code, obj) { res.status(code).json(obj); }
function hash(pass, salt) { return crypto.scryptSync(pass, salt, 32).toString('hex'); }
function sameSecret(a, b) {
  const left = Buffer.from(String(a || '')), right = Buffer.from(String(b || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function parseCookies(req) {
  const h = req.headers.cookie || '';
  try {
    return Object.fromEntries(h.split(';').map(p => p.trim().split('=').map(decodeURIComponent)).filter(a => a[0]));
  } catch { return {}; }
}
function getUser(req) {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE sid = ?').get(sid);
  if (!s) return null;
  if (s.expires_at < new Date().toISOString()) {
    db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
    return null;
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id) || null;
  if (!user) return null;
  if (user.role === 'personnel') {
    const person = user.personnel_id
      ? db.prepare('SELECT active FROM personnel WHERE id = ?').get(user.personnel_id)
      : null;
    if (!person || !person.active) {
      db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      return null;
    }
  }
  return user;
}
function requireAuth(roles) {
  return (req, res, next) => {
    const u = getUser(req);
    if (!u) return send(res, 401, { error: 'Not logged in' });
    if (roles && !roles.includes(u.role)) return send(res, 403, { error: 'Not permitted for your role' });
    req.user = u;
    next();
  };
}
function audit(actor, action, target, justification) {
  db.prepare('INSERT INTO audit_log (actor_id, action, target_personnel, justification, at) VALUES (?,?,?,?,?)')
    .run(actor.id || actor, action, target || null, justification || '', new Date().toISOString());
}

// Expired bearer sessions should not accumulate indefinitely. The interval is
// unref'd so it never keeps a test process or graceful shutdown alive.
function pruneSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
}
pruneSessions();
const sessionPruner = setInterval(() => { try { pruneSessions(); } catch {} }, 60 * 60 * 1000);
if (sessionPruner.unref) sessionPruner.unref();

function requestSourceIsSameOrigin(req) {
  const source = req.get('origin') || req.get('referer');
  // CLI/local regression clients generally do not send browser origin headers.
  // In production, authenticated browser mutations must provide one.
  if (!source) return process.env.NODE_ENV !== 'production';
  try {
    const actual = new URL(source);
    return actual.host === req.get('host');
  } catch { return false; }
}

app.use((req, res, next) => {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (!getUser(req)) return next(); // public login/registration are not cookie-authenticated mutations
  if (!requestSourceIsSameOrigin(req)) return send(res, 403, { error: 'Cross-origin request blocked' });
  next();
});

const sinceDate = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);
function avgNum(rows, key) {
  const values = rows.map(r => Number(r[key])).filter(Number.isFinite);
  return values.length ? +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(1) : null;
}
function workloadFor(pid, windowDays = 90) {
  const events = db.prepare('SELECT * FROM hr_events WHERE personnel_id = ? AND date >= ? ORDER BY date DESC').all(pid, sinceDate(windowDays));
  const sum = type => events.filter(e => e.type === type).reduce((n, e) => n + Number(e.value || 0), 0);
  const count = type => events.filter(e => e.type === type).length;
  return {
    window_days: windowDays,
    overtime_hours: Math.round(sum('duty_overtime')),
    deployment_starts: count('deployment'), leave_denials: count('leave_denied'), leave_approved: count('leave_approved'),
    incident_exposures: count('incident_exposure'), transfers: count('transfer'),
    training_days: Math.round(sum('training')),
    recovery_events: count('return_from_deployment') + count('recovery_rest'),
    last_updated: events.length ? String(events[0].updated_at || events[0].date) : null,
    records: events.filter(e => !['disciplinary'].includes(e.type)).slice(0, 50)
  };
}

/* ---------------- auth ---------------- */
const loginAttempts = new Map();
app.post('/api/login', (req, res) => {
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  const attempt = loginAttempts.get(key) || { count: 0, reset: Date.now() + 10 * 60000 };
  if (Date.now() > attempt.reset) { attempt.count = 0; attempt.reset = Date.now() + 10 * 60000; }
  if (attempt.count >= 10) return send(res, 429, { error: 'Too many sign-in attempts. Try again in a few minutes.' });
  const { username, password } = req.body || {};
  const identifier = String(username || '').trim();
  const suppliedPassword = String(password || '');
  if (!identifier || identifier.length > 100 || suppliedPassword.length > 256) {
    attempt.count++; loginAttempts.set(key, attempt);
    return send(res, 401, { error: 'Invalid credentials' });
  }
  const matchedUsers = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').all(identifier);
  let u = matchedUsers.length === 1 ? matchedUsers[0] : null;

  // Prototype personnel may sign in with their service ID. Provisioning is
  // lazy so existing databases gain access without a destructive re-seed.
  const demoAccess = DEMO_MODE;
  const demoPassword = process.env.DEMO_PERSONNEL_PASSWORD || 'demo123';
  if (!u && matchedUsers.length === 0 && demoAccess && sameSecret(suppliedPassword, demoPassword)) {
    const p = db.prepare('SELECT * FROM personnel WHERE force_id = ? COLLATE NOCASE AND active = 1').get(identifier);
    if (p) {
      const salt = crypto.randomBytes(16).toString('hex');
      db.prepare(`INSERT OR IGNORE INTO users
        (username, pass_hash, salt, role, name, unit_id, personnel_id, created_at)
        VALUES (?,?,?,?,?,?,?,?)`)
        .run(p.force_id, hash(demoPassword, salt), salt, 'personnel', p.name, p.unit_id, p.id, new Date().toISOString());
      u = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(p.force_id);
    }
  }
  if (!u || hash(suppliedPassword, u.salt) !== u.pass_hash) {
    attempt.count++; loginAttempts.set(key, attempt);
    return send(res, 401, { error: 'Invalid credentials' });
  }
  loginAttempts.delete(key);
  const sid = crypto.randomBytes(24).toString('hex');
  const exp = new Date(Date.now() + 7 * 86400000).toISOString();
  db.prepare('INSERT INTO sessions (sid, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(sid, u.id, new Date().toISOString(), exp);
  const secure = process.env.NODE_ENV === 'production' || req.get('x-forwarded-proto') === 'https';
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax${secure ? '; Secure' : ''}`);
  send(res, 200, { ok: true, role: u.role, name: u.name });
});

const RANKS = ['Sepoy', 'Constable', 'Naik', 'Havildar', 'Naib Subedar', 'Subedar', 'Inspector', 'Sub-Inspector'];

app.get('/api/units', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  send(res, 200, { units: db.prepare('SELECT id, name FROM units ORDER BY name').all() });
});

app.post('/api/register', (req, res) => {
  const key = (req.socket.remoteAddress || 'unknown') + ':register';
  const attempt = loginAttempts.get(key) || { count: 0, reset: Date.now() + 10 * 60000 };
  if (Date.now() > attempt.reset) { attempt.count = 0; attempt.reset = Date.now() + 10 * 60000; }
  if (attempt.count >= 20) return send(res, 429, { error: 'Too many attempts. Try again shortly.' });

  const b = req.body || {};
  const name = String(b.name || '').trim();
  const forceId = String(b.service_id || '').trim();
  const rank = String(b.rank || '').trim();
  const unitId = Number(b.unit_id);
  const newUnit = String(b.new_unit || '').trim();
  const password = String(b.password || '');
  const fail = m => { attempt.count++; loginAttempts.set(key, attempt); return send(res, 400, { error: m }); };

  if (name.length < 2 || name.length > 80) return fail('Enter your full name (2–80 characters).');
  if (!/^[A-Za-z0-9-]{4,20}$/.test(forceId)) return fail('Service ID must be 4–20 letters, numbers or dashes.');
  if (!RANKS.includes(rank)) return fail('Select a valid rank.');
  if (password.length < 8 || password.length > 128 || !/[A-Za-z]/.test(password) || !/\d/.test(password))
    return fail('Password must be 8+ characters and include letters and numbers.');

  let finalUnitId = null;
  if (newUnit) {
    if (newUnit.length < 2 || newUnit.length > 60) return fail('Unit name must be 2–60 characters.');
    if (db.prepare('SELECT id FROM units WHERE name = ? COLLATE NOCASE').get(newUnit))
      return fail('That unit already exists — select it from the list instead.');
    finalUnitId = Number(db.prepare('INSERT INTO units (name, region) VALUES (?,?)').run(newUnit, '').lastInsertRowid);
  } else {
    if (!Number.isInteger(unitId) || !db.prepare('SELECT id FROM units WHERE id = ?').get(unitId))
      return fail('Select your unit, or enter a new unit name.');
    finalUnitId = unitId;
  }

  if (db.prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE').get(forceId) ||
      db.prepare('SELECT id FROM personnel WHERE force_id = ? COLLATE NOCASE').get(forceId))
    return fail('An account with this Service ID already exists.');

  const joinDate = todayStr();
  const pid = Number(db.prepare(`INSERT INTO personnel (force_id, rank, name, unit_id, years_service, family_status, join_date, active)
    VALUES (?,?,?,?,0,'single',?,1)`).run(forceId, rank, name, finalUnitId, joinDate).lastInsertRowid);
  const salt = crypto.randomBytes(16).toString('hex');
  const userId = Number(db.prepare(`INSERT INTO users (username, pass_hash, salt, role, name, unit_id, personnel_id, created_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(forceId, hash(password, salt), salt, 'personnel', name, finalUnitId, pid, new Date().toISOString()).lastInsertRowid);
  runPipeline();
  audit({ id: userId }, 'account_registered', pid, 'Self-registration');

  loginAttempts.delete(key);
  const sid = crypto.randomBytes(24).toString('hex');
  const exp = new Date(Date.now() + 7 * 86400000).toISOString();
  db.prepare('INSERT INTO sessions (sid, user_id, created_at, expires_at) VALUES (?,?,?,?)').run(sid, userId, new Date().toISOString(), exp);
  const secure = process.env.NODE_ENV === 'production' || req.get('x-forwarded-proto') === 'https';
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax${secure ? '; Secure' : ''}`);
  send(res, 200, { ok: true, role: 'personnel', name });
});

app.post('/api/logout', (req, res) => {
  const sid = parseCookies(req).sid;
  if (sid) db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; Path=/; Max-Age=0');
  send(res, 200, { ok: true });
});
app.get('/api/me', (req, res) => {
  const u = getUser(req);
  if (!u) return send(res, 401, { error: 'Not logged in' });
  send(res, 200, { user: { id: u.id, username: u.username, role: u.role, name: u.name, unit_id: u.unit_id } });
});
app.get('/api/version', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  send(res, 200, {
    version: APP_VERSION,
    demo_mode: DEMO_MODE,
    data_label: 'Prototype demonstration using simulated data',
    features: ['WHO5', 'journal-insights-v1', 'consent-scoped-support', 'organizational-early-indicators']
  });
});
app.get('/api/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  send(res, 200, { status: 'ok', version: APP_VERSION, demo_mode: DEMO_MODE,
    label: 'ProtecT prototype service' });
});

/* ==== risk pipeline & API routes appended below ==== */

/* ---------------- risk pipeline ---------------- */
function gatherData(pid, today) {
  const personnel = db.prepare('SELECT * FROM personnel WHERE id = ?').get(pid);
  if (!personnel) return null;
  const hr = db.prepare(`SELECT * FROM hr_events WHERE personnel_id = ? AND date >= ?
    ORDER BY date ASC`).all(pid, new Date(Date.now() - 370 * 86400000).toISOString().slice(0, 10));
  const checkins = db.prepare(`SELECT * FROM checkins WHERE personnel_id = ? AND date >= ?
    ORDER BY date ASC`).all(pid, new Date(Date.now() - 65 * 86400000).toISOString().slice(0, 10));
  const assessments = db.prepare(`SELECT * FROM assessments WHERE personnel_id = ? AND date >= ?
    ORDER BY date ASC`).all(pid, new Date(Date.now() - 95 * 86400000).toISOString().slice(0, 10));
  return { personnel, hr, checkins, assessments, today };
}

/** Recompute today's risk for everyone active; raise alerts for Elevated/Critical. */
function runPipeline() {
  const today = todayStr();
  const now = new Date().toISOString();
  const active = db.prepare('SELECT id FROM personnel WHERE active = 1').all();
  const counts = { Critical: 0, Elevated: 0, Watch: 0, Low: 0 };
  for (const { id } of active) {
    const d = gatherData(id, today);
    if (!d) continue;
    const r = computeRisk(d);
    db.prepare(`INSERT INTO risk_scores (personnel_id, date, score, band, factors) VALUES (?,?,?,?,?)
      ON CONFLICT(personnel_id, date) DO UPDATE SET score=excluded.score, band=excluded.band, factors=excluded.factors`)
      .run(id, today, r.score, r.band, JSON.stringify(r.factors));
    counts[r.band]++;
    if (r.band === 'Elevated' || r.band === 'Critical') {
      const top = r.factors.slice(0, 3).map(f => f.label).join('; ');
      const reason = `${r.band} support priority: ${top || 'current welfare indicators'}`;
      const signature = `${r.band}:${r.factors.slice(0, 3).map(f => f.key).sort().join(',')}`;
      const open = db.prepare(`SELECT * FROM alerts WHERE personnel_id=? AND status IN ('new','acknowledged')
        ORDER BY created_at DESC, id DESC LIMIT 1`).get(id);
      const latest = db.prepare('SELECT * FROM alerts WHERE personnel_id = ? ORDER BY created_at DESC, id DESC LIMIT 1').get(id);
      if (open) {
        db.prepare('UPDATE alerts SET level=?, reason=?, risk_signature=?, last_seen_at=? WHERE id=?')
          .run(r.band, reason, signature, now, open.id);
        db.prepare(`UPDATE alerts SET status='dismissed', resolved_at=COALESCE(resolved_at, ?),
          action_note='Superseded by the current open case' WHERE personnel_id=? AND id<>?
          AND status IN ('new','acknowledged')`).run(now, id, open.id);
      } else if (!latest || latest.cleared_at || latest.risk_signature !== signature) {
        db.prepare(`INSERT INTO alerts
          (personnel_id, level, reason, created_at, status, risk_signature, last_seen_at)
          VALUES (?,?,?,?,?,?,?)`).run(id, r.band, reason, now, 'new', signature, now);
      } else {
        db.prepare('UPDATE alerts SET level=?, reason=?, risk_signature=?, last_seen_at=? WHERE id=?')
          .run(r.band, reason, signature, now, latest.id);
      }
    }
  }
  db.prepare(`UPDATE alerts SET status='dismissed', resolved_at=COALESCE(resolved_at, ?), cleared_at=?,
    action_note='Automatically closed: current indicators are below alert threshold'
    WHERE cleared_at IS NULL AND status IN ('new','acknowledged') AND personnel_id IN
    (SELECT personnel_id FROM risk_scores WHERE date=? AND band NOT IN ('Elevated','Critical'))`).run(now, now, today);
  db.prepare(`UPDATE alerts SET cleared_at=? WHERE cleared_at IS NULL AND status IN ('actioned','dismissed')
    AND personnel_id IN (SELECT personnel_id FROM risk_scores WHERE date=?
    AND band NOT IN ('Elevated','Critical'))`).run(now, today);
  return counts;
}
// Reconcile stored snapshots and open alerts whenever scoring rules change or the
// service restarts. This avoids showing decisions produced by an older model.
setImmediate(() => {
  try { runPipeline(); } catch (e) { console.error('Initial model refresh failed:', e.message); }
});

/* ---------------- personnel self-service ---------------- */
app.post('/api/checkin', requireAuth(['personnel']), (req, res) => {
  const { stress, sleep_hours, mood, energy, physical_symptoms, feeling_supported } = req.body || {};
  if (!req.user.personnel_id) return send(res, 400, { error: 'No personnel record linked to this account' });
  const s = Number(stress), sl = Number(sleep_hours), en = Number(energy == null ? 3 : energy);
  if (!(s >= 1 && s <= 10)) return send(res, 400, { error: 'stress must be 1-10' });
  if (!(sl >= 0 && sl <= 14)) return send(res, 400, { error: 'sleep_hours must be 0-14' });
  if (!Number.isInteger(en) || en < 1 || en > 5) return send(res, 400, { error: 'energy must be 1-5' });
  const moodValue = String(mood || '').trim().slice(0, 40);
  db.prepare(`INSERT INTO checkins (personnel_id, date, stress, sleep_hours, mood, energy, physical_symptoms, feeling_supported, anonymous)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(personnel_id, date) DO UPDATE SET stress=excluded.stress, sleep_hours=excluded.sleep_hours,
      mood=excluded.mood, energy=excluded.energy, physical_symptoms=excluded.physical_symptoms, feeling_supported=excluded.feeling_supported,
      anonymous=0`)
    .run(req.user.personnel_id, todayStr(), s, sl, moodValue, en, physical_symptoms ? 1 : 0,
      Math.min(5, Math.max(1, Number(feeling_supported) || 3)), 0);
  runPipeline();
  send(res, 200, { ok: true });
});

const ASSESSMENT_SPECS = {
  WHO5: { count: 5, maxAnswer: 5, maxScore: 100, label: 'WHO-5 Well-Being Index' },
  PSS10: { count: 10, maxAnswer: 4, maxScore: 40, label: 'Perceived Stress Scale (PSS-10)' },
  GAD7: { count: 7, maxAnswer: 3, maxScore: 21, label: 'GAD-7' },
  PHQ9: { count: 9, maxAnswer: 3, maxScore: 27, label: 'PHQ-9' }
};

function assessmentView(row, includeAnswers = false) {
  const spec = ASSESSMENT_SPECS[row.type] || { maxScore: 100, label: row.type };
  let display = row.display_score;
  let raw = row.raw_score;
  // Legacy rows stored only a normalized support-direction value. Reconstruct a
  // display value conservatively while preserving newly stored exact results.
  if (display == null) display = row.type === 'WHO5'
    ? 100 - Number(row.score || 0)
    : Math.round(Number(row.score || 0) / 100 * spec.maxScore);
  if (raw == null) raw = row.type === 'WHO5' ? Math.round(display / 4) : display;
  const out = {
    id: row.id, date: row.date, type: row.type, label: spec.label,
    raw_score: Number(raw), display_score: Number(display), max_score: spec.maxScore,
    level: row.level || '', urgent: !!row.urgent,
    instrument_version: row.instrument_version || 'legacy-prototype',
    disclaimer: 'Screening tool — not a diagnosis.'
  };
  if (includeAnswers) {
    try { out.answers = JSON.parse(row.answers || '[]'); } catch { out.answers = []; }
  }
  return out;
}

app.post('/api/assessment', requireAuth(['personnel']), (req, res) => {
  const { type, answers } = req.body || {};
  if (!req.user.personnel_id) return send(res, 400, { error: 'No personnel record linked to this account' });
  const spec = ASSESSMENT_SPECS[type];
  if (!spec) return send(res, 400, { error: 'Unknown assessment type' });
  if (!Array.isArray(answers) || answers.length !== spec.count ||
      answers.some(a => !Number.isInteger(Number(a)) || a < 0 || a > spec.maxAnswer))
    return send(res, 400, { error: `${spec.count} answers with values 0-${spec.maxAnswer} required` });
  const values = answers.map(Number);
  let raw, displayScore, score, level, guidance, urgent = false;
  if (type === 'WHO5') {
    raw = values.reduce((s, a) => s + a, 0);             // 0..25
    displayScore = raw * 4;                               // official 0..100 wellbeing score
    score = 100 - displayScore;                           // normalized support-need direction
    level = displayScore > 50 ? 'Good wellbeing' : displayScore >= 29 ? 'Low wellbeing' : 'Very low wellbeing';
    guidance = displayScore <= 50
      ? 'Your result suggests it may help to speak with a qualified health professional for a fuller assessment.'
      : 'Your answers suggest positive current wellbeing. Continue checking in over time to notice changes.';
  } else if (type === 'PSS10') {
    // Official scoring reverses the four positively stated items (4, 5, 7, 8; zero-based 3,4,6,7).
    raw = values.reduce((s, a, i) => s + ([3,4,6,7].includes(i) ? 4 - a : a), 0);
    displayScore = raw; score = Math.round(raw / 40 * 100);
    level = raw <= 13 ? 'Low perceived stress' : raw <= 26 ? 'Moderate perceived stress' : 'High perceived stress';
    guidance = raw >= 27 ? 'High perceived stress can be worth discussing with a qualified professional.' : 'Use this result as a personal baseline and look for changes over time.';
  } else if (type === 'GAD7') {
    raw = values.reduce((s, a) => s + a, 0); displayScore = raw; score = Math.round(raw / 21 * 100);
    level = raw <= 4 ? 'Minimal anxiety' : raw <= 9 ? 'Mild anxiety' : raw <= 14 ? 'Moderate anxiety' : 'Severe anxiety';
    guidance = raw >= 10 ? 'This screening result supports considering a conversation with a qualified health professional.' : 'Track how these feelings change; seek support whenever they interfere with daily life.';
  } else {
    raw = values.reduce((s, a) => s + a, 0); displayScore = raw; score = Math.round(raw / 27 * 100);
    level = raw <= 4 ? 'Minimal symptoms' : raw <= 9 ? 'Mild symptoms' : raw <= 14 ? 'Moderate symptoms' : raw <= 19 ? 'Moderately severe symptoms' : 'Severe symptoms';
    urgent = values[8] > 0;
    if (urgent) score = Math.max(60, score); // safety signal; displayed PHQ-9 total remains unchanged
    guidance = urgent ? 'You indicated thoughts of self-harm or being better off dead. Please contact immediate support now and do not stay alone.'
      : raw >= 10 ? 'This screening result supports considering a conversation with a qualified health professional.' : 'Track changes over time and reach out if symptoms persist or worsen.';
  }
  db.prepare(`INSERT INTO assessments
    (personnel_id, date, type, score, answers, raw_score, display_score, level, urgent, instrument_version)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(req.user.personnel_id, todayStr(), type, score, JSON.stringify(values), raw,
      displayScore, level, urgent ? 1 : 0, 'prototype-v1');
  runPipeline();
  send(res, 200, { ok: true, type, raw, display_score: displayScore, risk_score: score, level, guidance, urgent });
});

app.get('/api/my-status', requireAuth(['personnel']), (req, res) => {
  const pid = req.user.personnel_id;
  if (!pid) return send(res, 400, { error: 'No personnel record linked' });
  const today = todayStr();
  const d = gatherData(pid, today);
  const r = d ? computeRisk(d) : { score: 0, band: 'Low', factors: [] };
  const mine = db.prepare(`SELECT date, stress, sleep_hours, mood, energy, feeling_supported FROM checkins WHERE personnel_id = ? ORDER BY date DESC LIMIT 30`).all(pid);
  const accessed = db.prepare(`SELECT a.action, a.at, u.name AS actor, u.role FROM audit_log a
    JOIN users u ON u.id = a.actor_id WHERE a.target_personnel = ? ORDER BY a.at DESC LIMIT 10`).all(pid);
  const asmts = db.prepare(`SELECT * FROM assessments WHERE personnel_id = ? ORDER BY date DESC, id DESC LIMIT 20`).all(pid)
    .map(row => assessmentView(row));
  const corrections = db.prepare(`SELECT id, category, message, created_at, status, resolution_note FROM data_corrections
    WHERE personnel_id = ? ORDER BY created_at DESC LIMIT 10`).all(pid);
  const workload = workloadFor(pid);
  const recent = mine.slice(0, 7);
  const selfReport = { responses: recent.length, stress: avgNum(recent, 'stress'), sleep: avgNum(recent, 'sleep_hours'), supported: avgNum(recent, 'feeling_supported') };
  const orgPressure = workload.overtime_hours >= 40 || workload.deployment_starts >= 2 || workload.incident_exposures > 0 || workload.leave_denials >= 2;
  const feltPressure = selfReport.stress !== null && selfReport.stress >= 6;
  const comparison = !recent.length ? 'No recent self-report to compare' : orgPressure === feltPressure
    ? (orgPressure ? 'Recorded workload and your check-ins both indicate pressure' : 'Recorded workload and your check-ins are currently aligned')
    : orgPressure ? 'Work records show pressure, while your check-ins are steadier' : 'Your check-ins show more pressure than work records alone suggest';
  send(res, 200, { risk: { ...r, model: 'transparent rules prototype', updated_at: new Date().toISOString(), evidence_count: r.factors.length },
    checkins: mine.reverse(), accessed, assessments: asmts, workload, self_report: selfReport, comparison, corrections });
});

function periodDays(value) {
  if (value === 'all') return null;
  const n = Number(value);
  return [7, 30, 90].includes(n) ? n : 30;
}

function numericSummary(rows, key, favorableHigh = false) {
  const values = rows.map(row => Number(row[key])).filter(Number.isFinite);
  if (!values.length) return { current: null, previous: null, change: null, direction: 'Not enough data' };
  const split = Math.max(1, Math.floor(values.length / 2));
  const older = values.slice(0, split), newer = values.slice(split);
  const mean = list => list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
  const current = +(mean(newer.length ? newer : older)).toFixed(1);
  const previous = +(mean(older)).toFixed(1);
  const change = +(current - previous).toFixed(1);
  const threshold = key === 'sleep_hours' ? .25 : .2;
  const improving = favorableHigh ? change > threshold : change < -threshold;
  const worsening = favorableHigh ? change < -threshold : change > threshold;
  return { current, previous, change, direction: improving ? 'Improving' : worsening ? 'Worth noticing' : 'Steady' };
}

function moodSummary(rows) {
  const counts = new Map();
  for (const row of rows) {
    const mood = String(row.mood || '').trim();
    if (mood) counts.set(mood, (counts.get(mood) || 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return { current: rows.length ? rows[rows.length - 1].mood || null : null, most_common: top ? top[0] : null };
}

function checkinSummaries(rows) {
  return {
    stress: numericSummary(rows, 'stress'),
    sleep: numericSummary(rows, 'sleep_hours', true),
    mood: moodSummary(rows),
    energy: numericSummary(rows, 'energy', true)
  };
}

function latestSupportFor(pid) {
  const row = db.prepare(`SELECT id, source, reason, priority, status, next_action, follow_up_due, created_at
    FROM support_cases WHERE personnel_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`).get(pid);
  return row ? { active: row.status !== 'Resolved', case_id: row.id, source: row.source, reason: row.reason,
    priority: row.priority, status: row.status, next_action: row.next_action,
    follow_up_due: row.follow_up_due, created_at: row.created_at } : { active: false };
}

function personalInsight(checkins, workload) {
  const sleep = numericSummary(checkins, 'sleep_hours', true);
  const stress = numericSummary(checkins, 'stress');
  let text = 'Continue checking in to build a personal pattern over time.';
  if (sleep.current != null && sleep.current < 6.5 && workload.overtime_hours >= 35)
    text = 'Your recent sleep has been lower during a period with elevated recorded overtime.';
  else if (stress.direction === 'Improving') text = 'Your recent stress check-ins are trending lower.';
  else if (stress.direction === 'Worth noticing') text = 'Your recent stress check-ins have moved upward.';
  else if (sleep.direction === 'Improving') text = 'Your recent sleep check-ins are trending upward.';
  return {
    text,
    basis: [`${checkins.length} voluntary check-in${checkins.length === 1 ? '' : 's'}`, `${workload.records.length} recent work record${workload.records.length === 1 ? '' : 's'}`],
    disclaimer: 'Personal observed pattern — not a diagnosis or proof of causation.'
  };
}

app.get('/api/personnel/home', requireAuth(['personnel']), (req, res) => {
  const pid = req.user.personnel_id;
  const profile = db.prepare(`SELECT p.id,p.name,p.rank,p.force_id,u.name unit
    FROM personnel p JOIN units u ON u.id=p.unit_id WHERE p.id=?`).get(pid);
  if (!profile) return send(res, 404, { error: 'Personnel profile not found' });
  const week = db.prepare(`SELECT date,stress,sleep_hours,mood,energy FROM checkins
    WHERE personnel_id=? AND date>=? ORDER BY date`).all(pid, sinceDate(6));
  const todayCheckin = week.find(row => row.date === todayStr()) || null;
  const workload = workloadFor(pid);
  const journals = db.prepare(`SELECT date,content,words,updated_at FROM journal_entries
    WHERE personnel_id=? AND words>0 ORDER BY date DESC LIMIT 2`).all(pid)
    .map(row => ({ date: row.date, words: row.words, updated_at: row.updated_at,
      preview: String(row.content || '').replace(/\s+/g, ' ').trim().slice(0, 180) }));
  const whoRow = db.prepare(`SELECT * FROM assessments WHERE personnel_id=? AND type='WHO5'
    ORDER BY date DESC,id DESC LIMIT 1`).get(pid);
  send(res, 200, {
    profile,
    privacy: { private_by_default: true, journal: 'Only you', promise: 'Your journal and journal insights are never shared with Welfare or Commander.' },
    today_checkin: todayCheckin,
    week: { series: week, summaries: checkinSummaries(week) },
    insight: personalInsight(week, workload),
    journal_preview: journals,
    assessment: { recommended: { type: 'WHO5', label: 'Weekly wellbeing check', minutes: 1 },
      latest_who5: whoRow ? assessmentView(whoRow) : null },
    work_preview: { window_days: workload.window_days, overtime_hours: workload.overtime_hours,
      deployment_starts: workload.deployment_starts, leave_denials: workload.leave_denials,
      last_updated: workload.last_updated || null },
    support: latestSupportFor(pid)
  });
});

app.get('/api/personnel/assessments', requireAuth(['personnel']), (req, res) => {
  const rows = db.prepare(`SELECT * FROM assessments WHERE personnel_id=? ORDER BY date DESC,id DESC`).all(req.user.personnel_id)
    .map(row => assessmentView(row, true));
  const byType = {};
  for (const row of rows) (byType[row.type] ||= []).push(row);
  send(res, 200, { history: rows, by_type: byType, disclaimer: 'Screening tools support reflection; they are not diagnoses.' });
});

app.get('/api/personnel/work-context', requireAuth(['personnel']), (req, res) => {
  const pid = req.user.personnel_id;
  const metrics = workloadFor(pid);
  const corrections = db.prepare(`SELECT id,category,message,created_at,status,resolution_note FROM data_corrections
    WHERE personnel_id=? ORDER BY created_at DESC`).all(pid);
  send(res, 200, {
    metrics,
    records: metrics.records,
    source: 'Simulated organizational HR and duty records',
    last_updated: metrics.last_updated || null,
    why: 'Used to identify workload, recovery and resourcing conditions and to give you visibility into the records held about you.',
    corrections,
    prototype: true
  });
});

app.get('/api/personnel/progress', requireAuth(['personnel']), (req, res) => {
  const pid = req.user.personnel_id;
  const days = periodDays(req.query.days);
  const start = days == null ? null : sinceDate(days - 1);
  const where = start ? ' AND date>=?' : '';
  const params = start ? [pid, start] : [pid];
  const series = db.prepare(`SELECT date,stress,sleep_hours,mood,energy FROM checkins
    WHERE personnel_id=?${where} ORDER BY date`).all(...params);
  const assessmentRows = db.prepare(`SELECT * FROM assessments WHERE personnel_id=?${where} ORDER BY date,id`).all(...params)
    .map(row => assessmentView(row));
  const journalRows = db.prepare(`SELECT date,content,words,time_sec FROM journal_entries
    WHERE personnel_id=?${where} AND words>0 ORDER BY date`).all(...params);
  const topicCounts = new Map(), feelingCounts = new Map(), timeCounts = new Map();
  for (const row of journalRows) {
    const analysis = analyzeJournal(row.content);
    for (const item of analysis.topics) topicCounts.set(item.label, (topicCounts.get(item.label) || 0) + item.count);
    for (const item of analysis.feelings) feelingCounts.set(item.label, (feelingCounts.get(item.label) || 0) + item.count);
    for (const item of analysis.time) timeCounts.set(item.label, (timeCounts.get(item.label) || 0) + item.count);
  }
  const ranked = map => [...map.entries()].filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1]).map(([label, count]) => ({ label, count }));
  const overtimeDates = new Set(db.prepare(`SELECT date FROM hr_events WHERE personnel_id=? AND type='duty_overtime'${where}`).all(...params).map(r => r.date));
  const onLongDuty = series.filter(row => overtimeDates.has(row.date));
  const otherDays = series.filter(row => !overtimeDates.has(row.date));
  let relationshipText = 'Not enough overlapping check-in and duty data to estimate a work relationship yet.';
  if (onLongDuty.length && otherDays.length >= 2) {
    const dutySleep = avgNum(onLongDuty, 'sleep_hours'), otherSleep = avgNum(otherDays, 'sleep_hours');
    relationshipText = dutySleep < otherSleep
      ? `Recorded overtime days coincided with ${+(otherSleep - dutySleep).toFixed(1)} fewer hours of reported sleep on average.`
      : 'Reported sleep was not lower on the recorded overtime days in this period.';
  }
  send(res, 200, {
    days: days == null ? 'all' : days,
    series,
    summaries: checkinSummaries(series),
    assessments: assessmentRows,
    journal: {
      entries: journalRows.length,
      total_words: journalRows.reduce((sum, row) => sum + Number(row.words || 0), 0),
      frequency: days && days > 0 ? +(journalRows.length / days * 7).toFixed(1) : null,
      recurring_themes: ranked(topicCounts).slice(0, 5),
      emotional_tone: ranked(feelingCounts).slice(0, 5),
      time_orientation: ranked(timeCounts).slice(0, 3),
      experimental: true
    },
    work_relationship: {
      text: relationshipText,
      basis: { overtime_days: onLongDuty.length, comparison_days: otherDays.length },
      disclaimer: 'Observed association — not proof of causation.'
    }
  });
});

app.post('/api/my-data/correction', requireAuth(['personnel']), (req, res) => {
  const pid = req.user.personnel_id;
  const category = String(req.body && req.body.category || '').trim();
  const message = String(req.body && req.body.message || '').trim();
  if (!pid) return send(res, 400, { error: 'No personnel record linked' });
  if (!['workload', 'leave', 'deployment', 'profile', 'other'].includes(category) || message.length < 10 || message.length > 1000)
    return send(res, 400, { error: 'Choose a category and provide 10–1000 characters' });
  db.prepare('INSERT INTO data_corrections (personnel_id, category, message, created_at) VALUES (?,?,?,?)')
    .run(pid, category, message, new Date().toISOString());
  audit(req.user, 'request_data_correction', pid, category);
  send(res, 200, { ok: true });
});

/* ---------------- welfare officer: flagged roster ---------------- */
app.get('/api/dashboard/roster', requireAuth(['welfare']), (req, res) => {
  send(res, 410, { error: 'The support-priority roster was replaced by the sourced support queue' });
});

app.get('/api/welfare/overview', requireAuth(['welfare']), (req, res) => {
  const rows = welfareCaseRows(req.user.id);
  const payload = welfareQueuePayload(rows);
  send(res, 200, { metrics: payload.metrics, queue: payload.cases.slice(0, 8),
    prototype: { simulated_data: true, label: 'Prototype demonstration using simulated data' } });
});

app.post('/api/data-corrections/:id', requireAuth(['welfare']), (req, res) => {
  const row = db.prepare('SELECT * FROM data_corrections WHERE id=?').get(req.params.id);
  if (!row) return send(res, 404, { error: 'Request not found' });
  const status = req.body && req.body.status;
  const transitions = { submitted: ['reviewing','resolved','declined'], reviewing: ['resolved','declined'] };
  if (!(transitions[row.status] || []).includes(status)) return send(res, 409, { error: `Cannot move a ${row.status} request to ${status || 'that status'}` });
  const note = String(req.body && req.body.resolution_note || '').trim().slice(0, 1000);
  if (['resolved','declined'].includes(status) && note.length < 3) return send(res, 400, { error: 'Add a short resolution note' });
  db.prepare('UPDATE data_corrections SET status=?,resolved_by=?,resolution_note=? WHERE id=?').run(status, req.user.id, note, row.id);
  audit(req.user, 'data_correction_' + status, row.personnel_id, note);
  send(res, 200, { ok: true });
});

app.get('/api/personnel/:id/journal', requireAuth(), (_req, res) => {
  send(res, 403, { error: 'Private journals are available only through the owner-scoped journal API' });
});

// Retired because it exposed a whole person record without proving an active,
// assigned support purpose. Welfare clients must use the scoped case endpoint.
app.get('/api/personnel/:id', requireAuth(['welfare']), (_req, res) => {
  send(res, 410, { error: 'Use /api/welfare/cases/:id for consent-scoped case context' });
});

/* ---------------- private reflective journal (merged from seven50) ----------------
 * STRICTLY PRIVATE: readable/writable only by the owning personnel account.
 * Journal content is NEVER returned to welfare/commander roles and is NOT an
 * input to the risk engine — this is the personnel's own space. */
const J_GOAL = 150, J_BLUE = 100, J_STREAK_MIN = 100;
function jWords(t) { t = String(t || '').trim(); return t ? t.split(/\s+/).length : 0; }

const JOURNAL_LEVELS = [
  [0, 'Blank Page'], [3, 'Inkling'], [7, 'Steady Hand'], [14, 'Momentum'],
  [30, 'Habit Builder'], [60, 'Wordsmith'], [100, 'Marathoner'], [180, 'Devoted'], [365, 'Legend of the Page']
];
function journalLevel(points) {
  let name = JOURNAL_LEVELS[0][1];
  for (const [at, n] of JOURNAL_LEVELS) if (points >= at) name = n;
  const next = JOURNAL_LEVELS.find(([at]) => at > points);
  return { name, points, nextAt: next ? next[0] : null };
}
function journalStats(pid) {
  const rows = db.prepare('SELECT date, words, time_sec FROM journal_entries WHERE personnel_id = ? ORDER BY date').all(pid);
  const goalDates = new Set(rows.filter(r => r.words >= J_GOAL).map(r => r.date));
  const totalWords = rows.reduce((n, r) => n + r.words, 0);
  const totalTime = rows.reduce((n, r) => n + (r.time_sec || 0), 0);
  let current = 0, d = new Date();
  if (!goalDates.has(d.toISOString().slice(0, 10))) d.setUTCDate(d.getUTCDate() - 1);
  while (goalDates.has(d.toISOString().slice(0, 10))) { current++; d.setUTCDate(d.getUTCDate() - 1); }
  let longest = 0, run = 0, previous = null;
  for (const date of [...goalDates].sort()) {
    run = previous && (new Date(date) - new Date(previous)) / 86400000 === 1 ? run + 1 : 1;
    previous = date; longest = Math.max(longest, run);
  }
  const badges = [];
  for (const n of [3, 7, 14, 30, 60, 100, 365]) if (longest >= n) badges.push({ type: 'streak', label: `${n}-day streak` });
  for (const n of [1000, 10000, 25000, 50000, 100000, 250000]) if (totalWords >= n) badges.push({ type: 'words', label: `${n.toLocaleString()} total words` });
  const byDate = Object.fromEntries(rows.map(r => [r.date, r.words]));
  const last30 = [];
  for (let i = 29; i >= 0; i--) {
    const dt = new Date(); dt.setUTCDate(dt.getUTCDate() - i);
    const date = dt.toISOString().slice(0, 10);
    last30.push({ date, words: byDate[date] || 0 });
  }
  const writingDays = rows.filter(r => r.words > 0).length;
  return {
    total_words: totalWords, total_days: writingDays,
    current_streak: current, longest_streak: longest, avg_words: rows.length ? Math.round(totalWords / rows.length) : 0,
    green_days: goalDates.size, total_time_min: Math.round(totalTime / 60), points: writingDays,
    level: journalLevel(writingDays), badges, last30
  };
}

app.get('/api/journal/overview', requireAuth(['personnel']), (req, res) => {
  const pid = req.user.personnel_id;
  if (!pid) return send(res, 400, { error: 'No personnel record linked' });
  const days = db.prepare(`SELECT date, words, time_sec FROM journal_entries
    WHERE personnel_id = ? AND date >= ? ORDER BY date ASC`)
    .all(pid, new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10));
  const map = new Map(days.map(d => [d.date, d.words]));
  let streak = 0;
  for (let i = 0; i < 365; i++) {
    const dt = new Date(); dt.setUTCDate(dt.getUTCDate() - i);
    const w = map.get(dt.toISOString().slice(0, 10));
    if (w !== undefined && w >= J_STREAK_MIN) streak++;
    else if (i === 0) continue; // today not written yet — don't break the streak view
    else break;
  }
  const totals = db.prepare('SELECT COUNT(*) days, COALESCE(SUM(words),0) tw FROM journal_entries WHERE personnel_id = ?').get(pid);
  send(res, 200, { days, streak, total_days: totals.days, total_words: totals.tw });
});

app.get('/api/journal/stats', requireAuth(['personnel']), (req, res) => {
  if (!req.user.personnel_id) return send(res, 400, { error: 'No personnel record linked' });
  send(res, 200, journalStats(req.user.personnel_id));
});

app.get('/api/journal/analysis/list', requireAuth(['personnel']), (req, res) => {
  const pid = req.user.personnel_id;
  if (!pid) return send(res, 400, { error: 'No personnel record linked' });
  const days = db.prepare(`SELECT date, words, started_at, updated_at FROM journal_entries
    WHERE personnel_id = ? AND words > 0 ORDER BY date DESC LIMIT 500`).all(pid);
  send(res, 200, { days });
});

app.get('/api/journal/analysis/:date', requireAuth(['personnel']), (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) return send(res, 400, { error: 'Bad date format' });
  const pid = req.user.personnel_id;
  if (!pid) return send(res, 400, { error: 'No personnel record linked' });
  const row = db.prepare(`SELECT date, content, words, time_sec, timeline, started_at, updated_at
    FROM journal_entries WHERE personnel_id = ? AND date = ?`).get(pid, req.params.date);
  if (!row) return send(res, 404, { error: 'No journal entry for that date' });
  let timeline = [];
  try { timeline = JSON.parse(row.timeline || '[]'); } catch {}
  send(res, 200, {
    date: row.date, words: row.words, time_sec: row.time_sec, started_at: row.started_at,
    updated_at: row.updated_at, analysis: analyzeJournal(row.content), timeline,
    speed: speedStats(timeline, row.words, row.time_sec)
  });
});

app.get('/api/journal/:date', requireAuth(['personnel']), (req, res) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(req.params.date)) return send(res, 400, { error: 'Bad date format' });
  const pid = req.user.personnel_id;
  if (!pid) return send(res, 400, { error: 'No personnel record linked' });
  const e = db.prepare(`SELECT date, content, words, time_sec, timeline, started_at, updated_at FROM journal_entries
    WHERE personnel_id = ? AND date = ?`).get(pid, req.params.date) || null;
  send(res, 200, { entry: e });
});

app.post('/api/journal', requireAuth(['personnel']), (req, res) => {
  const { date, content, time_sec, timeline, started_at } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return send(res, 400, { error: 'Bad date format' });
  const pid = req.user.personnel_id;
  if (!pid) return send(res, 400, { error: 'No personnel record linked' });
  const words = jWords(content);
  const prev = db.prepare('SELECT time_sec FROM journal_entries WHERE personnel_id = ? AND date = ?').get(pid, date);
  const t = Math.max(Number(time_sec) || 0, prev ? prev.time_sec : 0);
  const safeTimeline = Array.isArray(timeline) ? timeline.slice(-2000).filter(p => Array.isArray(p) && p.length >= 2 && Number.isFinite(+p[0]) && Number.isFinite(+p[1]))
    .map(p => [Math.max(0, Math.round(+p[0])), Math.max(0, Math.round(+p[1]))]) : [];
  const prior = db.prepare('SELECT timeline, started_at FROM journal_entries WHERE personnel_id = ? AND date = ?').get(pid, date);
  const timelineJson = safeTimeline.length ? JSON.stringify(safeTimeline) : (prior ? prior.timeline : '[]');
  const started = String(started_at || (prior && prior.started_at) || '').slice(0, 40);
  db.prepare(`INSERT INTO journal_entries (personnel_id, date, content, words, time_sec, updated_at, timeline, started_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(personnel_id, date) DO UPDATE SET content = excluded.content, words = excluded.words,
      time_sec = excluded.time_sec, updated_at = excluded.updated_at,
      timeline = excluded.timeline, started_at = excluded.started_at`)
    .run(pid, date, String(content || ''), words, t, new Date().toISOString(), timelineJson, started);
  send(res, 200, { ok: true, words, saved_at: new Date().toISOString() });
});

/* ---------------- alerts & interventions ---------------- */
const INTERVENTION_TYPES = new Set(['counseling','rest_rotation','workload_rebalance','family_leave','peer_support','medical_check']);
function recommendationsFor(pid) {
  const data = gatherData(pid, todayStr());
  return data ? recommend(computeRisk(data).factors).filter(r => INTERVENTION_TYPES.has(r.type)) : [];
}
function insertRecommendations(pid, requestedTypes) {
  const allowed = recommendationsFor(pid);
  const wanted = new Set((requestedTypes || []).filter(x => typeof x === 'string'));
  const selected = wanted.size ? allowed.filter(r => wanted.has(r.type)) : allowed;
  const inserted = [];
  for (const r of selected.slice(0, 4)) {
    const duplicate = db.prepare(`SELECT id FROM interventions WHERE personnel_id=? AND type=?
      AND status IN ('recommended','accepted') LIMIT 1`).get(pid, r.type);
    if (!duplicate) {
      db.prepare('INSERT INTO interventions (personnel_id, type, reason, recommended_at, status) VALUES (?,?,?,?,?)')
        .run(pid, r.type, r.reason, new Date().toISOString(), 'recommended');
      inserted.push(r);
    }
  }
  return inserted;
}

app.get('/api/alerts', requireAuth(['welfare']), (req, res) => {
  const rows = db.prepare(`SELECT a.*, p.name, p.rank, p.force_id, u.name AS unit FROM alerts a
    JOIN personnel p ON p.id = a.personnel_id JOIN units u ON u.id = p.unit_id
    ORDER BY CASE a.level WHEN 'Critical' THEN 0 ELSE 1 END, a.created_at DESC LIMIT 100`).all();
  send(res, 200, { alerts: rows });
});

app.post('/api/alerts/:id', requireAuth(['welfare']), (req, res) => {
  const a = db.prepare('SELECT * FROM alerts WHERE id = ?').get(req.params.id);
  if (!a) return send(res, 404, { error: 'Alert not found' });
  const { status, action_note, interventions: recs } = req.body || {};
  const nextStatus = ['acknowledged', 'actioned', 'dismissed'].includes(status) ? status : null;
  if (!nextStatus) return send(res, 400, { error: 'Invalid alert status' });
  const transitions = { new: ['acknowledged','actioned','dismissed'], acknowledged: ['actioned','dismissed'] };
  if (!(transitions[a.status] || []).includes(nextStatus)) return send(res, 409, { error: `Cannot move a ${a.status} case to ${nextStatus}` });
  const note = String(action_note || '').trim().slice(0, 1000);
  if (nextStatus === 'actioned' && note.length < 3) return send(res, 400, { error: 'Add a short action note' });
  db.prepare('UPDATE alerts SET status = ?, acted_by = ?, action_note = ?, resolved_at = ? WHERE id = ?')
    .run(nextStatus,
      req.user.id, note, ['actioned','dismissed'].includes(nextStatus) ? new Date().toISOString() : null, a.id);
  if (Array.isArray(recs)) {
    insertRecommendations(a.personnel_id, recs.map(r => String(r && r.type || '')));
  }
  audit(req.user, 'alert_' + nextStatus, a.personnel_id, note);
  send(res, 200, { ok: true });
});

app.post('/api/interventions/recommend', requireAuth(['welfare']), (req, res) => {
  const { personnel_id, type, recs } = req.body || {};
  const p = db.prepare('SELECT id FROM personnel WHERE id = ?').get(personnel_id);
  if (!p) return send(res, 404, { error: 'Personnel not found' });
  const requested = type ? [String(type)] : (Array.isArray(recs) ? recs.map(r => String(r && r.type || '')) : []);
  if (!requested.length || requested.some(x => !INTERVENTION_TYPES.has(x))) return send(res, 400, { error: 'Choose a valid recommended intervention' });
  const selected = insertRecommendations(p.id, requested);
  if (!selected.length) return send(res, 409, { error: 'That support plan is already active or is not currently recommended' });
  audit(req.user, 'recommend_intervention', p.id, selected.map(r => r.type).join(','));
  send(res, 200, { ok: true, recommendations: selected });
});
app.post('/api/interventions/:id', requireAuth(['welfare']), (req, res) => {
  const iv = db.prepare('SELECT * FROM interventions WHERE id = ?').get(req.params.id);
  if (!iv) return send(res, 404, { error: 'Not found' });
  const { status, outcome_note } = req.body || {};
  const nextStatus = ['accepted', 'completed', 'declined'].includes(status) ? status : null;
  if (!nextStatus) return send(res, 400, { error: 'Invalid intervention status' });
  const transitions = { recommended: ['accepted','declined'], accepted: ['completed','declined'] };
  if (!(transitions[iv.status] || []).includes(nextStatus)) return send(res, 409, { error: `Cannot move a ${iv.status} plan to ${nextStatus}` });
  const note = String(outcome_note || '').trim().slice(0, 1000);
  if (['completed','declined'].includes(nextStatus) && note.length < 3) return send(res, 400, { error: 'Add a short outcome note' });
  db.prepare('UPDATE interventions SET status = ?, completed_at = ?, outcome_note = ? WHERE id = ?')
    .run(nextStatus,
      nextStatus === 'completed' ? new Date().toISOString() : iv.completed_at,
      note || iv.outcome_note, iv.id);
  audit(req.user, 'intervention_' + nextStatus, iv.personnel_id, note);
  send(res, 200, { ok: true });
});

/* ---------------- transparency: access log ---------------- */
app.get('/api/audit', requireAuth(['welfare']), (req, res) => {
  const rows = db.prepare(`SELECT a.action, a.at, a.justification, u.name AS actor, u.role,
    p.name AS target FROM audit_log a JOIN users u ON u.id = a.actor_id
    LEFT JOIN personnel p ON p.id = a.target_personnel ORDER BY a.at DESC LIMIT 50`).all();
  send(res, 200, { audit: rows });
});

/* ---------------- risk pipeline trigger ---------------- */
app.post('/api/recalculate', requireAuth(['welfare']), (req, res) => {
  const counts = runPipeline();
  audit(req.user, 'recalculate', null, 'manual pipeline run');
  send(res, 200, { ok: true, counts });
});

/* ---------------- commander dashboard (aggregated + k-anonymized) ---------------- */
const K_MIN = 5; // never expose a group smaller than 5 personnel

function dateOffsetFrom(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

function conditionCell(value, status, explanation, display = null) {
  return { value, display: display == null ? value : display, status, explanation };
}

function unitCondition(unit, asOf = todayStr()) {
  const strength = db.prepare('SELECT COUNT(*) c FROM personnel WHERE unit_id=? AND active=1').get(unit.id).c;
  const since90 = dateOffsetFrom(asOf, 89), since30 = dateOffsetFrom(asOf, 29);
  const priorStart = dateOffsetFrom(asOf, 59), priorEnd = dateOffsetFrom(asOf, 30);
  const work = db.prepare(`SELECT e.type,COUNT(*) c,COALESCE(SUM(e.value),0) total FROM hr_events e
    JOIN personnel p ON p.id=e.personnel_id WHERE p.unit_id=? AND p.active=1 AND e.date BETWEEN ? AND ?
    AND e.type IN ('duty_overtime','deployment','return_from_deployment','recovery_rest','leave_denied','leave_approved','incident_exposure','transfer','training')
    GROUP BY e.type`).all(unit.id, since90, asOf);
  const wm = Object.fromEntries(work.map(row => [row.type, row]));
  const currentOt = db.prepare(`SELECT COALESCE(SUM(e.value),0) total FROM hr_events e JOIN personnel p ON p.id=e.personnel_id
    WHERE p.unit_id=? AND p.active=1 AND e.type='duty_overtime' AND e.date BETWEEN ? AND ?`).get(unit.id, since30, asOf).total;
  const priorOt = db.prepare(`SELECT COALESCE(SUM(e.value),0) total FROM hr_events e JOIN personnel p ON p.id=e.personnel_id
    WHERE p.unit_id=? AND p.active=1 AND e.type='duty_overtime' AND e.date BETWEEN ? AND ?`).get(unit.id, priorStart, priorEnd).total;
  const overtimeHours = Math.round(wm.duty_overtime?.total || 0);
  const overtimePerPerson = +(overtimeHours / Math.max(1, strength)).toFixed(1);
  const overtimeChange = priorOt > 0 ? +((currentOt - priorOt) / priorOt * 100).toFixed(1) : (currentOt > 0 ? 100 : 0);
  const deployments = wm.deployment?.c || 0;
  const recoveries = (wm.return_from_deployment?.c || 0) + (wm.recovery_rest?.c || 0);
  const leaveDenials = wm.leave_denied?.c || 0;
  const leavePressure = +(leaveDenials / Math.max(1, strength) * 100).toFixed(1);
  const deploymentIntensity = +(deployments / Math.max(1, strength) * 100).toFixed(1);
  const incidents = wm.incident_exposure?.c || 0;
  const incidentRate = +(incidents / Math.max(1, strength) * 100).toFixed(1);
  const recoveryScore = Math.max(0, Math.min(100, Math.round(88 - overtimePerPerson * .65 - Math.max(0, deployments - recoveries) * 3)));
  const pulse = db.prepare(`SELECT COUNT(DISTINCT c.personnel_id) respondents,AVG(c.stress) stress,
    AVG(c.sleep_hours) sleep,AVG(c.energy) energy FROM checkins c JOIN personnel p ON p.id=c.personnel_id
    WHERE p.unit_id=? AND p.active=1 AND p.aggregate_consent=1 AND c.date BETWEEN ? AND ?`)
    .get(unit.id, dateOffsetFrom(asOf, 13), asOf);
  const pulseVisible = pulse.respondents >= K_MIN;
  const voluntary = pulseVisible ? { respondents: pulse.respondents, avg_stress: +pulse.stress.toFixed(1),
    avg_sleep: +pulse.sleep.toFixed(1), avg_energy: +pulse.energy.toFixed(1) }
    : { respondents: pulse.respondents, avg_stress: null, avg_sleep: null, avg_energy: null, suppressed: true };
  const dataCoverage = strength ? +(pulse.respondents / strength * 100).toFixed(0) : 0;
  const metrics = {
    overtime_hours: overtimeHours, overtime_per_person: overtimePerPerson, overtime_change_pct: overtimeChange,
    leave_denials: leaveDenials, leave_pressure_pct: leavePressure,
    deployments, deployment_intensity: deploymentIntensity,
    incidents, incident_rate: incidentRate, transfers: wm.transfer?.c || 0,
    training_days: Math.round(wm.training?.total || 0), recoveries, recovery_score: recoveryScore,
    available_signals: 5 + (pulseVisible ? 1 : 0), possible_signals: 6
  };
  const early = computeEarlyIndicator(metrics);
  const heatmap = {
    overtime: conditionCell(overtimePerPerson, overtimePerPerson >= 40 ? 'High' : overtimePerPerson >= 25 ? 'Monitor' : 'Normal',
      `${overtimeHours} overtime hours across ${strength} active personnel`, `${overtimePerPerson}h/person`),
    leave_pressure: conditionCell(leavePressure, leavePressure >= 15 ? 'High' : leavePressure >= 8 ? 'Monitor' : 'Normal',
      `${leaveDenials} denied leave requests in 90 days`, `${leavePressure}%`),
    recovery: conditionCell(recoveryScore, recoveryScore < 55 ? 'High' : recoveryScore < 75 ? 'Monitor' : 'Normal',
      'Transparent proxy derived from overtime and recorded recovery opportunities', `${recoveryScore}/100`),
    deployment: conditionCell(deploymentIntensity, deploymentIntensity >= 20 ? 'High' : deploymentIntensity >= 10 ? 'Monitor' : 'Normal',
      `${deployments} deployment starts in 90 days`, `${deploymentIntensity}/100 personnel`),
    incidents: conditionCell(incidentRate, incidentRate >= 5 ? 'High' : incidentRate > 0 ? 'Monitor' : 'Normal',
      `${incidents} incident exposures in 90 days`, `${incidentRate}/100 personnel`),
    voluntary_wellbeing: pulseVisible
      ? conditionCell(voluntary.avg_stress, voluntary.avg_stress >= 7 ? 'High' : voluntary.avg_stress >= 5.5 ? 'Monitor' : 'Normal',
        `Aggregate of ${pulse.respondents} consenting contributors; no individual responses`, `${voluntary.avg_stress}/10 stress`)
      : conditionCell(null, 'Monitor', `Suppressed: ${pulse.respondents}/${K_MIN} minimum consenting contributors`, 'Not displayed'),
    data_coverage: conditionCell(dataCoverage, pulseVisible ? 'Normal' : 'Monitor',
      `${pulse.respondents}/${strength} personnel contributed consented voluntary data`, `${pulse.respondents}/${strength}`)
  };
  return {
    unit_id: unit.id, unit: unit.name, region: unit.region, strength,
    condition: early.level === 'High' ? 'High load' : early.level === 'Monitor' ? 'Monitor' : 'Normal',
    metrics, heatmap, early_indicator: early,
    workload: { overtime_hours: overtimeHours, overtime_per_person: overtimePerPerson,
      deployments, leave_denials: leaveDenials, incidents, transfers: metrics.transfers,
      training_days: metrics.training_days, recovery_score: recoveryScore },
    pulse: voluntary
  };
}

function actionView(row, unitMap) {
  const unit = unitMap.get(row.unit_id);
  return {
    id: row.id, unit_id: row.unit_id, unit: unit ? unit.unit : row.unit,
    title: row.title, issue: row.title, evidence: row.evidence,
    suggested_response: row.suggested_response || row.title, owner: row.owner,
    status: row.status, review_date: row.review_date || null,
    before: { overtime_per_person: row.baseline_overtime, recovery: row.baseline_recovery ?? null,
      condition: row.baseline_condition || null, avg_sleep: row.baseline_sleep ?? null },
    after: row.after_overtime == null && row.after_recovery == null ? null : {
      overtime_per_person: row.after_overtime, recovery: row.after_recovery,
      condition: row.after_condition || null
    },
    outcome: row.outcome || null, started_at: row.started_at,
    reviewed_at: row.reviewed_at || null, simulated: !!row.simulated
  };
}

function commanderOverview() {
  const units = db.prepare('SELECT * FROM units ORDER BY name').all().map(unit => unitCondition(unit));
  const unitMap = new Map(units.map(unit => [unit.unit_id, unit]));
  const actions = db.prepare(`SELECT a.*,u.name unit FROM org_actions a LEFT JOIN units u ON u.id=a.unit_id
    ORDER BY CASE a.status WHEN 'Review due' THEN 0 WHEN 'In progress' THEN 1 WHEN 'Planned' THEN 2 ELSE 3 END,a.started_at DESC`).all()
    .map(row => actionView(row, unitMap));
  const generated = [];
  if (!actions.length) for (const unit of units.filter(item => item.condition !== 'Normal').slice(0, 3)) {
    const contributor = unit.early_indicator.contributors[0];
    generated.push({ id: null, unit_id: unit.unit_id, unit: unit.unit,
      title: contributor?.key === 'leave_pressure' ? 'Review leave constraints' : 'Review duty roster and recovery time',
      issue: contributor?.label || 'Organizational pressure', evidence: contributor?.detail || 'Multiple workload signals',
      suggested_response: 'Review rotation, recovery opportunity and available staffing with local operations.',
      owner: 'Operations', status: 'Suggested', review_date: null, before: null, after: null, outcome: null });
  }
  const trend = [];
  for (let offset = 29; offset >= 0; offset--) {
    const date = dateOffsetFrom(todayStr(), offset);
    const dayUnits = db.prepare('SELECT * FROM units ORDER BY id').all().map(unit => unitCondition(unit, date));
    trend.push({ date, high_load_units: dayUnits.filter(unit => unit.condition === 'High load').length,
      monitor_units: dayUnits.filter(unit => unit.condition === 'Monitor').length,
      overtime_hours: dayUnits.reduce((sum, unit) => sum + unit.workload.overtime_hours, 0) });
  }
  const totals = units.reduce((out, unit) => {
    for (const key of ['overtime_hours', 'deployments', 'leave_denials', 'incidents', 'transfers', 'training_days'])
      out[key] += unit.workload[key] || 0;
    return out;
  }, { overtime_hours: 0, deployments: 0, leave_denials: 0, incidents: 0, transfers: 0, training_days: 0 });
  return {
    units,
    heatmap: units.map(unit => ({ unit_id: unit.unit_id, unit: unit.unit, region: unit.region,
      condition: unit.condition, cells: unit.heatmap })),
    early_indicators: units.map(unit => ({ unit_id: unit.unit_id, unit: unit.unit, ...unit.early_indicator }))
      .sort((a, b) => ({ High: 0, Monitor: 1, Normal: 2 })[a.level] - ({ High: 0, Monitor: 1, Normal: 2 })[b.level]),
    priority_actions: actions.length ? actions : generated,
    actions: actions.length ? actions : generated,
    outcomes: actions.filter(action => action.after || action.outcome),
    trend,
    totals,
    privacy: { k_min: K_MIN, consent_required: true,
      note: 'Voluntary wellbeing is included only for consenting groups of at least five. No names, journals, assessments, or case records are returned.' },
    prototype: { simulated_data: true, label: 'Prototype demonstration using simulated data',
      method: 'Transparent deterministic seven-day organizational indicator; no probability or accuracy claim.' }
  };
}

app.get('/api/dashboard/unit', requireAuth(['commander']), (req, res) => {
  send(res, 200, commanderOverview());
});

app.get('/api/commander/overview', requireAuth(['commander']), (_req, res) => {
  send(res, 200, commanderOverview());
});

const ORG_ACTION_STATUSES = ['Planned', 'In progress', 'Review due', 'Improving', 'No improvement', 'Completed'];
const ORG_ACTION_TRANSITIONS = {
  Planned: ['In progress'],
  'In progress': ['Review due', 'Completed'],
  'Review due': ['In progress', 'Improving', 'No improvement', 'Completed'],
  Improving: ['Completed', 'In progress'],
  'No improvement': ['In progress', 'Completed'],
  Completed: []
};

function addOrgActionEvent(actionId, actorId, eventType, detail) {
  db.prepare(`INSERT INTO org_action_events(action_id,actor_id,event_type,detail,at) VALUES (?,?,?,?,?)`)
    .run(actionId, actorId || null, eventType, String(detail || '').slice(0, 1000), new Date().toISOString());
}

function singleActionView(id) {
  const row = db.prepare(`SELECT a.*,u.name unit FROM org_actions a LEFT JOIN units u ON u.id=a.unit_id WHERE a.id=?`).get(id);
  if (!row) return null;
  const condition = unitCondition(db.prepare('SELECT * FROM units WHERE id=?').get(row.unit_id));
  const view = actionView(row, new Map([[row.unit_id, condition]]));
  view.timeline = db.prepare(`SELECT e.event_type,e.detail,e.at,u.name actor FROM org_action_events e
    LEFT JOIN users u ON u.id=e.actor_id WHERE e.action_id=? ORDER BY e.at,e.id`).all(id);
  return view;
}

app.post('/api/commander/actions', requireAuth(['commander']), (req, res) => {
  const b = req.body || {};
  const unit = db.prepare('SELECT * FROM units WHERE id=?').get(Number(b.unit_id));
  if (!unit) return send(res, 400, { error: 'Choose a valid unit' });
  const title = String(b.title || '').trim(), evidence = String(b.evidence || '').trim();
  const response = String(b.suggested_response || '').trim(), owner = String(b.owner || '').trim();
  const reviewDate = String(b.review_date || '').trim();
  if (title.length < 3 || title.length > 120) return send(res, 400, { error: 'Title must be 3–120 characters' });
  if (evidence.length < 3 || evidence.length > 1000) return send(res, 400, { error: 'Add concise supporting evidence' });
  if (response.length < 3 || response.length > 1000) return send(res, 400, { error: 'Add a suggested organizational response' });
  if (owner.length < 2 || owner.length > 100) return send(res, 400, { error: 'Add an action owner' });
  if (!validDate(reviewDate)) return send(res, 400, { error: 'Add a valid review date' });
  const baseline = unitCondition(unit);
  const now = new Date().toISOString();
  const id = inTransaction(() => {
    const actionId = Number(db.prepare(`INSERT INTO org_actions
      (unit_id,title,evidence,suggested_response,owner,status,baseline_overtime,baseline_sleep,
       baseline_recovery,baseline_condition,started_at,review_date,created_by,updated_at)
      VALUES (?,?,?,?,?,'Planned',?,?,?,?,?,?,?,?)`)
      .run(unit.id, title, evidence, response, owner, baseline.workload.overtime_per_person,
        baseline.pulse.avg_sleep, baseline.metrics.recovery_score, baseline.condition, now,
        reviewDate, req.user.id, now).lastInsertRowid);
    addOrgActionEvent(actionId, req.user.id, 'action_created', title);
    audit(req.user, 'org_action_created', null, `Action #${actionId}; ${unit.name}`);
    return actionId;
  });
  send(res, 201, { ok: true, action: singleActionView(id) });
});

function updateOrgAction(req, res) {
  const current = db.prepare('SELECT * FROM org_actions WHERE id=?').get(req.params.id);
  if (!current) return send(res, 404, { error: 'Organizational action not found' });
  const b = req.body || {}, updates = {};
  if (b.status !== undefined) {
    if (!ORG_ACTION_STATUSES.includes(b.status)) return send(res, 400, { error: 'Invalid action status' });
    if (b.status !== current.status && !(ORG_ACTION_TRANSITIONS[current.status] || []).includes(b.status))
      return send(res, 409, { error: `Cannot move a ${current.status} action to ${b.status}` });
    updates.status = b.status;
  }
  for (const [key, max] of [['title',120],['evidence',1000],['suggested_response',1000],['owner',100]]) {
    if (b[key] !== undefined) {
      const value = String(b[key] || '').trim();
      if (value.length < 2 || value.length > max) return send(res, 400, { error: `Invalid ${key.replace(/_/g, ' ')}` });
      updates[key] = value;
    }
  }
  if (b.review_date !== undefined) {
    if (!validDate(b.review_date)) return send(res, 400, { error: 'Invalid review date' });
    updates.review_date = b.review_date;
  }
  const keys = Object.keys(updates);
  if (!keys.length) return send(res, 400, { error: 'No action update supplied' });
  updates.updated_at = new Date().toISOString();
  inTransaction(() => {
    const allKeys = Object.keys(updates);
    db.prepare(`UPDATE org_actions SET ${allKeys.map(key => `${key}=?`).join(',')} WHERE id=?`)
      .run(...allKeys.map(key => updates[key]), current.id);
    if (updates.status && updates.status !== current.status)
      addOrgActionEvent(current.id, req.user.id, 'status_changed', `${current.status} → ${updates.status}`);
    else addOrgActionEvent(current.id, req.user.id, 'details_updated', 'Action details updated');
    audit(req.user, 'org_action_updated', null, `Action #${current.id}`);
  });
  send(res, 200, { ok: true, action: singleActionView(current.id) });
}

app.post('/api/commander/actions/:id', requireAuth(['commander']), updateOrgAction);
app.patch('/api/commander/actions/:id', requireAuth(['commander']), updateOrgAction);

app.post('/api/commander/actions/:id/advance-demo', requireAuth(['commander']), (req, res) => {
  const current = db.prepare('SELECT * FROM org_actions WHERE id=?').get(req.params.id);
  if (!current) return send(res, 404, { error: 'Organizational action not found' });
  if (current.status === 'Completed') return send(res, 409, { error: 'A completed action cannot be advanced' });
  const beforeOt = Number(current.baseline_overtime) || 0;
  const beforeRecovery = Number(current.baseline_recovery) || 60;
  const afterOt = +(beforeOt * .79).toFixed(1);
  const afterRecovery = Math.min(100, Math.round(beforeRecovery + 12));
  const afterCondition = current.baseline_condition === 'High load' ? 'Monitor' : 'Normal';
  const outcome = `After the simulated 14-day review, overtime decreased from ${beforeOt.toFixed(1)} to ${afterOt.toFixed(1)} hours per person and the recovery proxy improved.`;
  const now = new Date().toISOString();
  inTransaction(() => {
    db.prepare(`UPDATE org_actions SET status='Improving',after_overtime=?,after_recovery=?,after_condition=?,
      outcome=?,reviewed_at=?,updated_at=?,simulated=1 WHERE id=?`)
      .run(afterOt, afterRecovery, afterCondition, outcome, now, now, current.id);
    addOrgActionEvent(current.id, req.user.id, 'demo_outcome_recorded', 'Simulated 14-day follow-up measurement');
    audit(req.user, 'org_action_demo_advanced', null, `Action #${current.id}; simulated outcome`);
  });
  send(res, 200, { ok: true, simulated: true,
    label: 'Prototype demonstration using simulated follow-up data', action: singleActionView(current.id) });
});

/* ---------------- support cases: legitimate workflows only ---------------- */
const CASE_REASONS = ['work_pressure', 'personal_difficulty', 'family', 'health', 'post_incident', 'other'];
const CASE_STATUSES = ['New', 'Contacted', 'In support', 'Monitoring', 'Resolved'];
const CASE_PRIORITIES = ['Urgent', 'High', 'Routine'];
const CASE_TRANSITIONS = {
  New: ['Contacted', 'Resolved'],
  Contacted: ['In support', 'Monitoring', 'Resolved'],
  'In support': ['Monitoring', 'Resolved'],
  Monitoring: ['In support', 'Resolved'],
  Resolved: []
};
const SHARE_KEYS = ['stress_trend', 'sleep_trend', 'who5', 'assessment_history', 'work_context'];

function inTransaction(work) {
  db.exec('BEGIN IMMEDIATE');
  try { const value = work(); db.exec('COMMIT'); return value; }
  catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
}

function safeJson(textValue, fallback = {}) {
  try { return JSON.parse(textValue || ''); } catch { return fallback; }
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function selectedShareFields(raw) {
  if (raw == null) return Object.fromEntries(SHARE_KEYS.map(key => [key, false]));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('shared_context must be an object');
  const keys = Object.keys(raw);
  if (keys.some(key => !SHARE_KEYS.includes(key)) || keys.some(key => /journal|reflection|transcript|voice|content/i.test(key)))
    throw new Error('Only the listed share options are allowed; private journal data can never be shared');
  for (const key of keys) if (typeof raw[key] !== 'boolean') throw new Error(`${key} must be true or false`);
  return Object.fromEntries(SHARE_KEYS.map(key => [key, raw[key] === true]));
}

function buildSharedSnapshot(pid, selected, options = {}) {
  const snapshot = {};
  const recent = db.prepare(`SELECT date,stress,sleep_hours,mood,energy FROM checkins
    WHERE personnel_id=? ORDER BY date DESC LIMIT 30`).all(pid).reverse();
  if (selected.stress_trend) snapshot.stress_trend = {
    series: recent.map(row => ({ date: row.date, stress: row.stress })),
    summary: numericSummary(recent, 'stress')
  };
  if (selected.sleep_trend) snapshot.sleep_trend = {
    series: recent.map(row => ({ date: row.date, sleep_hours: row.sleep_hours })),
    summary: numericSummary(recent, 'sleep_hours', true)
  };
  if (selected.who5) {
    const row = db.prepare(`SELECT * FROM assessments WHERE personnel_id=? AND type='WHO5'
      ORDER BY date DESC,id DESC LIMIT 1`).get(pid);
    snapshot.who5 = row ? assessmentView(row) : null;
  }
  if (selected.assessment_history) {
    snapshot.assessment_history = db.prepare(`SELECT * FROM assessments WHERE personnel_id=?
      ORDER BY date DESC,id DESC LIMIT 20`).all(pid).map(row => assessmentView(row));
  }
  if (selected.work_context || options.policyWorkContext) {
    const work = workloadFor(pid);
    snapshot.work_context = {
      window_days: work.window_days, overtime_hours: work.overtime_hours,
      deployment_starts: work.deployment_starts, leave_denials: work.leave_denials,
      incident_exposures: work.incident_exposures, recovery_events: work.recovery_events,
      source: 'Simulated organizational HR and duty records',
      policy_authorized: !!options.policyWorkContext
    };
  }
  return {
    selected,
    granted_at: new Date().toISOString(),
    granted_by: options.policyWorkContext ? 'institutional_demo_policy' : 'personnel',
    snapshot,
    journal: { shared: false, reason: 'Private journal data is never shareable' }
  };
}

function assignedWelfareOfficer() {
  return db.prepare(`SELECT u.id FROM users u WHERE u.role='welfare' ORDER BY
    (SELECT COUNT(*) FROM support_cases c WHERE c.assigned_officer_id=u.id AND c.status<>'Resolved'),u.id LIMIT 1`).get();
}

function addCaseEvent(caseId, actorId, eventType, detail) {
  db.prepare(`INSERT INTO case_events(case_id,actor_id,event_type,detail,at) VALUES (?,?,?,?,?)`)
    .run(caseId, actorId || null, eventType, String(detail || '').slice(0, 1000), new Date().toISOString());
}

function canAccessCase(user, row) {
  return user && user.role === 'welfare' && (row.assigned_officer_id == null || Number(row.assigned_officer_id) === Number(user.id));
}

function supportSourceLabel(source) {
  const labels = {
    self_request: 'Personnel support request', personnel_request: 'Personnel support request',
    predictive_indicator: 'Predictive early indicator', post_incident: 'Post-incident follow-up',
    welfare_followup: 'Scheduled welfare review', referral: 'Referral', data_review: 'Data-review escalation'
  };
  return labels[source] || source || 'Authorized welfare workflow';
}

app.post('/api/support/request', requireAuth(['personnel']), (req, res) => {
  const pid = req.user.personnel_id;
  if (!pid) return send(res, 400, { error: 'No personnel record linked' });
  const b = req.body || {};
  const reason = String(b.reason || '').trim();
  const details = String(b.details || '').trim();
  if (!CASE_REASONS.includes(reason)) return send(res, 400, { error: 'Choose a reason for the request' });
  if (details.length > 2000) return send(res, 400, { error: 'Keep details under 2000 characters' });
  let selected;
  try { selected = selectedShareFields(b.shared_context); }
  catch (error) { return send(res, 400, { error: error.message }); }
  const priority = ['post_incident', 'health'].includes(reason) ? 'High' : 'Routine';
  const open = db.prepare(`SELECT id FROM support_cases WHERE personnel_id = ? AND status != 'Resolved'`).get(pid);
  if (open) return send(res, 409, { error: 'You already have an active support case', case_id: open.id });
  const officer = assignedWelfareOfficer();
  if (!officer) return send(res, 503, { error: 'No Welfare officer is currently configured' });
  const shared = buildSharedSnapshot(pid, selected);
  const id = inTransaction(() => {
    const caseId = Number(db.prepare(`INSERT INTO support_cases
      (personnel_id, source, reason, details, priority, status, next_action, created_at, shared_context, assigned_officer_id)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(pid, 'personnel_request', reason, details, priority, 'New', 'Welfare officer to make initial contact',
        new Date().toISOString(), JSON.stringify(shared), officer.id).lastInsertRowid);
    addCaseEvent(caseId, req.user.id, 'case_created', 'Personnel requested support');
    if (Object.values(selected).some(Boolean)) addCaseEvent(caseId, req.user.id, 'context_shared', SHARE_KEYS.filter(key => selected[key]).join(', '));
    db.prepare('UPDATE personnel SET welfare_share = ? WHERE id = ?').run(Object.values(selected).some(Boolean) ? 1 : 0, pid);
    audit(req.user, 'support_case_opened', pid, `Case #${caseId}; ${reason}`);
    return caseId;
  });
  send(res, 200, { ok: true, case_id: id });
});

app.get('/api/my-support', requireAuth(['personnel']), (req, res) => {
  const pid = req.user.personnel_id;
  if (!pid) return send(res, 400, { error: 'No personnel record linked' });
  const cases = db.prepare(`SELECT id,source,reason,priority,status,next_action,follow_up_due,created_at,resolved_at,shared_context
    FROM support_cases WHERE personnel_id = ? ORDER BY created_at DESC,id DESC LIMIT 10`).all(pid).map(row => {
      const share = safeJson(row.shared_context, {});
      const timeline = db.prepare(`SELECT event_type,detail,at FROM case_events WHERE case_id=? ORDER BY at,id`).all(row.id);
      return { ...row, source: supportSourceLabel(row.source), shared_context: undefined,
        shared_fields: SHARE_KEYS.filter(key => share.selected && share.selected[key]),
        sharing_withdrawn_at: share.withdrawn_at || null, timeline };
    });
  const share = db.prepare('SELECT welfare_share, aggregate_consent FROM personnel WHERE id = ?').get(pid);
  send(res, 200, { cases,
    welfare_share: cases.some(row => row.status !== 'Resolved' && row.shared_fields.length > 0),
    aggregate_consent: !!share.aggregate_consent });
});

app.post('/api/support/:id/withdraw-sharing', requireAuth(['personnel']), (req, res) => {
  const row = db.prepare(`SELECT * FROM support_cases WHERE id=? AND personnel_id=?`).get(req.params.id, req.user.personnel_id);
  if (!row) return send(res, 404, { error: 'Support case not found' });
  const share = safeJson(row.shared_context, {});
  share.selected = Object.fromEntries(SHARE_KEYS.map(key => [key, false]));
  share.snapshot = {};
  share.withdrawn_at = new Date().toISOString();
  inTransaction(() => {
    db.prepare('UPDATE support_cases SET shared_context=? WHERE id=?').run(JSON.stringify(share), row.id);
    db.prepare('UPDATE personnel SET welfare_share=0 WHERE id=?').run(row.personnel_id);
    addCaseEvent(row.id, req.user.id, 'sharing_withdrawn', 'Personnel withdrew optional shared context');
    audit(req.user, 'support_sharing_withdrawn', row.personnel_id, `Case #${row.id}`);
  });
  send(res, 200, { ok: true, case_id: row.id });
});

app.post('/api/my-consent', requireAuth(['personnel']), (req, res) => {
  const pid = req.user.personnel_id;
  if (!pid) return send(res, 400, { error: 'No personnel record linked' });
  const aggregate = req.body && req.body.aggregate_consent ? 1 : 0;
  db.prepare('UPDATE personnel SET aggregate_consent = ? WHERE id = ?').run(aggregate, pid);
  audit(req.user, aggregate ? 'consent_aggregate_on' : 'consent_aggregate_off', pid, 'Privacy center');
  send(res, 200, { ok: true, aggregate_consent: !!aggregate });
});

app.get('/api/my-privacy', requireAuth(['personnel']), (req, res) => {
  const pid = req.user.personnel_id;
  if (!pid) return send(res, 400, { error: 'No personnel record linked' });
  const accesses = db.prepare(`SELECT a.action, a.at, u.name AS actor, u.role FROM audit_log a
    JOIN users u ON u.id = a.actor_id WHERE a.target_personnel = ? ORDER BY a.at DESC LIMIT 20`).all(pid);
  const journalTouches = db.prepare(`SELECT COUNT(*) c FROM audit_log a WHERE a.target_personnel = ?
    AND (a.action LIKE '%journal%' OR a.action LIKE '%analysis%')`).get(pid).c;
  const share = db.prepare('SELECT welfare_share, aggregate_consent FROM personnel WHERE id = ?').get(pid);
  const activeShares = db.prepare(`SELECT id,shared_context FROM support_cases WHERE personnel_id=? AND status<>'Resolved'`).all(pid)
    .map(row => ({ case_id: row.id, fields: SHARE_KEYS.filter(key => safeJson(row.shared_context, {}).selected?.[key]) }));
  send(res, 200, {
    accesses, journal_touches: journalTouches,
    welfare_share: activeShares.some(item => item.fields.length), active_shares: activeShares,
    aggregate_consent: !!share.aggregate_consent,
    workload: workloadFor(pid),
    matrix: {
      journal: { personnel: 'only you', welfare: 'never', commander: 'never' },
      checkins: { personnel: 'only you', welfare: 'only fields selected for a case', commander: 'consented aggregate only when at least five respond' },
      assessments: { personnel: 'only you', welfare: 'only results selected for a case; never answers', commander: 'never individual' },
      support_case: { personnel: 'yours', welfare: 'assigned officer', commander: 'never' },
      work_records: { personnel: 'your own', welfare: 'selected or policy-authorized case summary', commander: 'unit aggregate' }
    },
    data_classes: [
      { key: 'private_journal', visibility: 'Personnel only' },
      { key: 'voluntary_wellbeing', visibility: 'Private by default; explicit case share or consented aggregate' },
      { key: 'organizational_work', visibility: 'Role-minimized official context' },
      { key: 'support_case', visibility: 'Personnel and assigned Welfare officer' }
    ]
  });
});

/* ---------------- welfare: support case queue & workflow ---------------- */
function welfareCaseRows(officerId) {
  return db.prepare(`SELECT c.*,p.rank,p.name,p.force_id,u.name unit,ao.name assigned_officer
    FROM support_cases c JOIN personnel p ON p.id=c.personnel_id
    LEFT JOIN units u ON u.id=p.unit_id LEFT JOIN users ao ON ao.id=c.assigned_officer_id
    WHERE c.assigned_officer_id=? OR c.assigned_officer_id IS NULL ORDER BY
    CASE c.priority WHEN 'Urgent' THEN 0 WHEN 'High' THEN 1 ELSE 2 END,
    CASE c.status WHEN 'New' THEN 0 WHEN 'Contacted' THEN 1 WHEN 'In support' THEN 2 WHEN 'Monitoring' THEN 3 ELSE 4 END,
    COALESCE(c.follow_up_due,'9999-12-31'),c.created_at`).all(officerId).map(row => {
      const share = safeJson(row.shared_context, {});
      return { id: row.id, personnel_id: row.personnel_id, case_id: `CASE #${row.id}`,
        rank: row.rank, name: row.name, force_id: row.force_id, unit: row.unit,
        source: supportSourceLabel(row.source), source_key: row.source, reason: row.reason,
        priority: row.priority, status: row.status, assigned_officer: row.assigned_officer,
        shared_fields: SHARE_KEYS.filter(key => share.selected?.[key]), last_contact_at: row.last_contact_at,
        first_response_at: row.first_response_at, next_action: row.next_action,
        follow_up_due: row.follow_up_due, created_at: row.created_at, resolved_at: row.resolved_at };
    });
}

function welfareQueuePayload(rows) {
  const today = todayStr();
  const open = rows.filter(row => row.status !== 'Resolved');
  return { cases: rows, metrics: {
    open: open.length,
    needs_attention: open.filter(row => row.priority === 'Urgent' || row.priority === 'High').length,
    overdue_follow_ups: open.filter(row => row.follow_up_due && row.follow_up_due < today).length,
    awaiting_response: open.filter(row => row.status === 'Contacted').length
  } };
}

app.get('/api/welfare/cases', requireAuth(['welfare']), (req, res) => {
  let rows = welfareCaseRows(req.user.id);
  const q = String(req.query.q || '').toLowerCase();
  if (q) rows = rows.filter(row => `${row.case_id} ${row.name} ${row.force_id} ${row.unit} ${row.source}`.toLowerCase().includes(q));
  for (const key of ['priority', 'status', 'source_key', 'unit']) if (req.query[key]) rows = rows.filter(row => row[key] === req.query[key]);
  if (req.query.due === 'overdue') rows = rows.filter(row => row.follow_up_due && row.follow_up_due < todayStr() && row.status !== 'Resolved');
  send(res, 200, welfareQueuePayload(rows));
});

app.get('/api/welfare/cases/:id', requireAuth(['welfare']), (req, res) => {
  const c = db.prepare(`SELECT c.*, p.rank, p.name, p.force_id, p.id AS pid, u.name AS unit
    FROM support_cases c JOIN personnel p ON p.id = c.personnel_id
    LEFT JOIN units u ON u.id = p.unit_id WHERE c.id = ?`).get(req.params.id);
  if (!c) return send(res, 404, { error: 'Case not found' });
  if (!canAccessCase(req.user, c)) return send(res, 403, { error: 'This case is assigned to another Welfare officer' });
  const notes = db.prepare(`SELECT n.note, n.at, u.name AS author FROM case_notes n
    JOIN users u ON u.id = n.author_id WHERE n.case_id = ? ORDER BY n.at DESC`).all(c.id);
  const share = safeJson(c.shared_context, {});
  const timeline = db.prepare(`SELECT e.event_type,e.detail,e.at,u.name actor,u.role actor_role
    FROM case_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.case_id=? ORDER BY e.at,e.id`).all(c.id);
  const assigned = c.assigned_officer_id ? db.prepare('SELECT id,name FROM users WHERE id=?').get(c.assigned_officer_id) : null;
  audit(req.user, 'view_support_case', c.pid, 'Case #' + c.id);
  send(res, 200, {
    case: { id: c.id, case_id: `CASE #${c.id}`, reason: c.reason, details: c.details,
      source: supportSourceLabel(c.source), source_key: c.source, priority: c.priority,
      status: c.status, next_action: c.next_action, follow_up_due: c.follow_up_due,
      last_contact_at: c.last_contact_at, first_response_at: c.first_response_at,
      created_at: c.created_at, resolved_at: c.resolved_at },
    person: { id: c.pid, rank: c.rank, name: c.name, force_id: c.force_id, unit: c.unit || '—' },
    assigned_officer: assigned,
    shared_context: { selected: share.selected || {}, snapshot: share.snapshot || {},
      granted_at: share.granted_at || null, withdrawn_at: share.withdrawn_at || null,
      journal: { shared: false, label: 'Locked — never shared' } },
    consented_context: share.snapshot || null,
    work_context: share.snapshot?.work_context || null,
    timeline,
    notes,
    privacy: 'No journal text, journal analytics, or assessment answers are returned by this endpoint.'
  });
});

app.post('/api/welfare/cases/:id', requireAuth(['welfare']), (req, res) => {
  const c = db.prepare('SELECT * FROM support_cases WHERE id = ?').get(req.params.id);
  if (!c) return send(res, 404, { error: 'Case not found' });
  if (!canAccessCase(req.user, c)) return send(res, 403, { error: 'This case is assigned to another Welfare officer' });
  const b = req.body || {};
  const updates = {};
  if (b.status !== undefined) {
    if (!CASE_STATUSES.includes(b.status)) return send(res, 400, { error: 'Invalid status' });
    if (b.status !== c.status && !(CASE_TRANSITIONS[c.status] || []).includes(b.status))
      return send(res, 409, { error: `Cannot move a ${c.status} case to ${b.status}` });
    if (b.status !== c.status) {
      updates.status = b.status;
      if (b.status === 'Resolved') {
        updates.resolved_at = new Date().toISOString();
      } else if (b.status === 'Contacted') {
        updates.last_contact_at = new Date().toISOString();
        if (!c.first_response_at) updates.first_response_at = updates.last_contact_at;
      }
    }
  }
  if (b.next_action !== undefined) updates.next_action = String(b.next_action).slice(0, 200);
  if (b.follow_up_due !== undefined) {
    if (b.follow_up_due && !validDate(b.follow_up_due)) return send(res, 400, { error: 'Bad date' });
    updates.follow_up_due = b.follow_up_due || null;
  }
  if (b.priority !== undefined) {
    if (!CASE_PRIORITIES.includes(b.priority)) return send(res, 400, { error: 'Invalid priority' });
    updates.priority = b.priority;
  }
  const note = String(b.note || '').trim();
  const keys = Object.keys(updates);
  if (!keys.length && !note) return send(res, 400, { error: 'No case update supplied' });
  inTransaction(() => {
    if (keys.length) db.prepare(`UPDATE support_cases SET ${keys.map(k => k + '=?').join(', ')} WHERE id = ?`)
      .run(...keys.map(k => updates[k]), c.id);
    if (b.status !== undefined && b.status !== c.status) addCaseEvent(c.id, req.user.id, 'status_changed', `${c.status} → ${b.status}`);
    if (b.next_action !== undefined) addCaseEvent(c.id, req.user.id, 'next_action_updated', updates.next_action);
    if (b.follow_up_due !== undefined) addCaseEvent(c.id, req.user.id, 'follow_up_scheduled', updates.follow_up_due || 'Cleared');
    if (b.priority !== undefined && b.priority !== c.priority) addCaseEvent(c.id, req.user.id, 'priority_changed', `${c.priority} → ${b.priority}`);
    if (note) {
      db.prepare('INSERT INTO case_notes (case_id, author_id, note, at) VALUES (?,?,?,?)')
        .run(c.id, req.user.id, note.slice(0, 1000), new Date().toISOString());
      addCaseEvent(c.id, req.user.id, 'note_added', 'Welfare note added');
    }
    audit(req.user, 'update_support_case', c.personnel_id, `Case #${c.id}`);
  });
  send(res, 200, { ok: true });
});

app.get('/api/welfare/followups', requireAuth(['welfare']), (req, res) => {
  const rows = welfareCaseRows(req.user.id).filter(row => row.status !== 'Resolved' && row.follow_up_due)
    .sort((a, b) => a.follow_up_due.localeCompare(b.follow_up_due));
  send(res, 200, { followups: rows, as_of: todayStr() });
});

app.get('/api/welfare/record-reviews', requireAuth(['welfare']), (_req, res) => {
  const reviews = db.prepare(`SELECT d.id,d.category,d.message,d.created_at,d.status,d.resolution_note,
    p.id personnel_id,p.rank,p.name,p.force_id,u.name unit,ru.name resolved_by
    FROM data_corrections d JOIN personnel p ON p.id=d.personnel_id LEFT JOIN units u ON u.id=p.unit_id
    LEFT JOIN users ru ON ru.id=d.resolved_by ORDER BY
    CASE d.status WHEN 'submitted' THEN 0 WHEN 'reviewing' THEN 1 ELSE 2 END,d.created_at DESC`).all();
  send(res, 200, { reviews });
});

app.get('/api/welfare/insights', requireAuth(['welfare']), (req, res) => {
  const rows = welfareCaseRows(req.user.id);
  const open = rows.filter(row => row.status !== 'Resolved');
  const countBy = (items, key) => Object.fromEntries([...new Set(items.map(item => item[key] || 'Unspecified'))]
    .map(value => [value, items.filter(item => (item[key] || 'Unspecified') === value).length]));
  const age = { '<24h': 0, '1–3 days': 0, '4–7 days': 0, '>7 days': 0 };
  for (const row of open) {
    const hours = Math.max(0, (Date.now() - new Date(row.created_at).getTime()) / 3600000);
    age[hours < 24 ? '<24h' : hours < 96 ? '1–3 days' : hours < 192 ? '4–7 days' : '>7 days']++;
  }
  const responseHours = rows.filter(row => row.first_response_at).map(row =>
    Math.max(0, (new Date(row.first_response_at) - new Date(row.created_at)) / 3600000)).sort((a, b) => a - b);
  const middle = Math.floor(responseHours.length / 2);
  const median = responseHours.length ? (responseHours.length % 2 ? responseHours[middle]
    : (responseHours[middle - 1] + responseHours[middle]) / 2) : null;
  const volumeMap = new Map();
  for (const row of rows.filter(row => row.created_at.slice(0, 10) >= sinceDate(29))) {
    const date = row.created_at.slice(0, 10); volumeMap.set(date, (volumeMap.get(date) || 0) + 1);
  }
  send(res, 200, {
    priority: countBy(open, 'priority'),
    follow_up: { completed: rows.filter(row => row.status === 'Resolved').length,
      due: open.filter(row => row.follow_up_due && row.follow_up_due >= todayStr()).length,
      overdue: open.filter(row => row.follow_up_due && row.follow_up_due < todayStr()).length },
    case_age: age,
    source_distribution: countBy(rows, 'source'),
    median_first_response_hours: median == null ? null : +median.toFixed(1),
    volume_trend: [...volumeMap.entries()].sort().map(([date, count]) => ({ date, count }))
  });
});

// Never let an old HTML/app.js stay paired with a newly deployed API. Assets such
// as CSS/images may still be revalidated by the browser, but application shells
// are always fetched fresh after a Render deployment.
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  setHeaders(res, filePath) {
    if (/\.(?:html|js)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-store, must-revalidate');
    else res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
  }
}));
app.listen(PORT, () => console.log(`ProtecT running → http://localhost:${PORT}`));
