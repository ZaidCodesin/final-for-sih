'use strict';
/* ProtecT — deterministic, story-driven demo data.
 * Run: npm run seed   (atomically replaces demo content in the selected DB)
 * Set ProtecT_SEED_DATE=YYYY-MM-DD to reproduce dates as well as values.
 */
const db = require('./db');
const crypto = require('crypto');

const RANKS = ['Sepoy', 'Constable', 'Naik', 'Havildar', 'Naib Subedar', 'Subedar', 'Inspector', 'Sub-Inspector'];
const MOODS = ['okay', 'tired', 'good', 'stressed', 'low', 'motivated', 'anxious'];
const UNIT_DEFINITIONS = [
  { name: '1 Bn OP Dtk', region: 'North', demand: 1.35,
    profiles: ['stressed', 'moderate', 'healthy', 'stressed', 'healthy', 'critical', 'moderate', 'healthy'] },
  { name: '2 Bn Ops', region: 'South', demand: 1.15,
    profiles: ['moderate', 'healthy', 'stressed', 'healthy', 'moderate', 'healthy', 'critical', 'healthy'] },
  { name: '3 Bn Trg Ctr', region: 'East', demand: 0.75,
    profiles: ['healthy', 'healthy', 'moderate', 'healthy', 'stressed', 'healthy', 'moderate', 'healthy'] },
  { name: '5 Bn Ops', region: 'West', demand: 1.25,
    profiles: ['stressed', 'moderate', 'healthy', 'critical', 'stressed', 'healthy', 'moderate', 'healthy'] },
  { name: '7 Bn Ops', region: 'NE', demand: 1.1,
    profiles: ['moderate', 'healthy', 'stressed', 'moderate', 'healthy', 'healthy', 'critical', 'healthy'] },
  { name: '91 Bn COBRA', region: 'Central', demand: 1.45,
    profiles: ['stressed', 'critical', 'moderate', 'stressed', 'healthy', 'moderate', 'healthy', 'stressed'] },
  { name: '148 Bn', region: 'North', demand: 0.95,
    profiles: ['healthy', 'moderate', 'healthy', 'stressed', 'healthy', 'moderate', 'healthy', 'critical'] }
];

const requestedDate = String(process.env.ProtecT_SEED_DATE || '');
const SEED_DATE = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)
  ? requestedDate
  : new Date().toISOString().slice(0, 10);
const ANCHOR = new Date(`${SEED_DATE}T12:00:00.000Z`);
const SEED_KEY = String(process.env.ProtecT_SEED || '26186');
let random = makePrng(seedNumber(SEED_KEY));

function seedNumber(value) {
  let hash = 2166136261;
  for (const char of value) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function makePrng(seed) {
  return function next() {
    seed |= 0;
    seed = seed + 0x6D2B79F5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function rnd(n) { return Math.floor(random() * n); }
function pick(values) { return values[rnd(values.length)]; }
function chance(probability) { return random() < probability; }
function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function dstr(date) { return date.toISOString().slice(0, 10); }
function daysAgo(days) { return new Date(ANCHOR.getTime() - days * 86400000); }
function dateOffset(daysFromAnchor) { return dstr(new Date(ANCHOR.getTime() + daysFromAnchor * 86400000)); }
function isoDaysAgo(days, hour = 10) {
  const date = daysAgo(days);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
}
function hash(pass, salt) { return crypto.scryptSync(pass, salt, 32).toString('hex'); }

function mkUser(username, pass, role, name, unitId, personnelId) {
  // These are published demo credentials. A deterministic salt makes a seed
  // reproducible; production provisioning must continue using random salts.
  const salt = crypto.createHash('sha256').update(`sentinel-demo:${username}`).digest('hex').slice(0, 32);
  return Number(db.prepare(`INSERT INTO users
    (username, pass_hash, salt, role, name, unit_id, personnel_id, created_at)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(username, hash(pass, salt), salt, role, name, unitId, personnelId, isoDaysAgo(180)).lastInsertRowid);
}

function main() {
  random = makePrng(seedNumber(SEED_KEY));
  console.log(`Wiping existing demo data atomically (seed ${SEED_KEY}, anchor ${SEED_DATE})...`);
  db.exec('BEGIN IMMEDIATE');
  try {
    clearDemoTables();

    const units = UNIT_DEFINITIONS.map(definition => ({
      ...definition,
      id: Number(db.prepare('INSERT INTO units (name, region) VALUES (?, ?)')
        .run(definition.name, definition.region).lastInsertRowid)
    }));
    const unitByName = Object.fromEntries(units.map(unit => [unit.name, unit]));

    const commanderId = mkUser('commander', 'demo123', 'commander', 'Commander Sharma', null, null);
    const welfareId = mkUser('welfare', 'demo123', 'welfare', 'Welfare Officer Kaur', null, null);

    const insertHR = db.prepare(`INSERT INTO hr_events
      (personnel_id, type, date, value, note, source, updated_at) VALUES (?,?,?,?,?,?,?)`);
    const insertCI = db.prepare(`INSERT INTO checkins
      (personnel_id, date, stress, sleep_hours, mood, physical_symptoms, feeling_supported, anonymous, energy)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    const insertAS = db.prepare(`INSERT INTO assessments
      (personnel_id, date, type, score, answers, raw_score, display_score, level, urgent, instrument_version)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    const personnelByForceId = new Map();
    const unitSlots = new Map(units.map(unit => [unit.id, 0]));
    const insertJE = db.prepare(`INSERT INTO journal_entries
      (personnel_id, date, content, words, time_sec, updated_at, timeline, started_at)
      VALUES (?,?,?,?,?,?,?,?)`);

    console.log('Generating 150 personnel with six months of simulated history...');
    for (let n = 1; n <= 150; n++) {
      // Rahul is the stable demo identity. Everyone else is balanced across all
      // units so every aggregate cohort remains above the privacy threshold.
      const unit = n === 1 ? unitByName['148 Bn'] : units[(n - 2) % units.length];
      const slot = unitSlots.get(unit.id) + 1;
      unitSlots.set(unit.id, slot);
      const profile = n === 1 ? 'moderate' : unit.profiles[(slot - 1) % unit.profiles.length];
      const rank = n === 1 ? 'Sepoy' : pick(RANKS);
      const name = n === 1 ? 'Rahul Verma' : `Personnel ${String(n).padStart(3, '0')}`;
      const forceId = `CRPF${100000 + n}`;
      const join = daysAgo(400 + rnd(4000));
      const family = chance(0.6) ? 'married' : 'single';
      // Aggregate contribution defaults ON for the demo personnel; the privacy
      // toggle in Privacy & Support turns it off at any time. At least eight
      // people per unit also opt in so every unit cohort clears the threshold.
      const aggregateConsent = n === 1 || slot <= (unit.name === '148 Bn' ? 9 : 8) ? 1 : 0;
      const pid = Number(db.prepare(`INSERT INTO personnel
        (force_id, rank, name, unit_id, years_service, family_status, join_date, active, aggregate_consent, welfare_share)
        VALUES (?,?,?,?,?,?,?,1,?,0)`)
        .run(forceId, rank, name, unit.id,
          Math.floor((ANCHOR.getTime() - join.getTime()) / 31557600000), family, dstr(join), aggregateConsent)
        .lastInsertRowid);
      personnelByForceId.set(forceId, pid);
      seedPerson(pid, n, family, profile, unit, { insertHR, insertCI, insertAS, insertJE });
    }

    const rahulPid = personnelByForceId.get('CRPF100001');
    mkUser('sepoy.demo', 'demo123', 'personnel', 'Rahul Verma', unitByName['148 Bn'].id, rahulPid);
    seedSupportCases(personnelByForceId, welfareId);
    seedOrganizationalActions(unitByName, commanderId);

    const fkProblems = db.prepare('PRAGMA foreign_key_check').all();
    if (fkProblems.length) throw new Error(`Seed produced ${fkProblems.length} foreign-key violation(s)`);
    const weakCohort = db.prepare(`SELECT u.name, SUM(p.aggregate_consent) consented FROM units u
      LEFT JOIN personnel p ON p.unit_id = u.id AND p.active = 1
      GROUP BY u.id HAVING consented < 5`).get();
    if (weakCohort) throw new Error(`Privacy cohort ${weakCohort.name} has fewer than five consenting members`);

    db.exec('COMMIT');
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }

  const counts = ['personnel', 'hr_events', 'checkins', 'assessments', 'support_cases', 'case_events', 'org_actions']
    .map(table => `${table}: ${db.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c}`).join('  ');
  console.log('Seed complete → ' + counts);
}

function clearDemoTables() {
  // Children come first. In particular, private case/journal records never
  // survive a personnel-ID reset and silently attach to a new demo identity.
  const tables = [
    'org_action_events', 'case_events', 'case_notes', 'support_cases', 'org_actions',
    'journal_entries', 'sessions', 'audit_log', 'data_corrections', 'alerts',
    'interventions', 'risk_scores', 'assessments', 'checkins', 'hr_events',
    'users', 'personnel', 'units'
  ];
  for (const table of tables) db.exec(`DELETE FROM ${table}`);
  try { db.exec('DELETE FROM sqlite_sequence'); } catch {}
}

function seedPerson(pid, personNumber, family, profile, unit, { insertHR, insertCI, insertAS, insertJE }) {
  const insertEvent = (type, date, value = 0, note = '') =>
    insertHR.run(pid, type, date, value, note, 'simulated_seed', `${date}T12:00:00.000Z`);

  const deployments = profile === 'healthy' ? 1 : profile === 'critical' ? 1 + rnd(3) : rnd(2);
  for (let index = 0; index < deployments; index++) {
    const start = 30 + rnd(330);
    const expected = 60 + rnd(90);
    insertEvent('deployment', dstr(daysAgo(start)), expected, 'Simulated deployment record');
    if (start > expected + 15) {
      insertEvent('return_from_deployment', dstr(daysAgo(Math.max(1, start - expected))), 0, 'Simulated return record');
    }
  }

  const denials = profile === 'critical' ? 2 + rnd(3) : profile === 'stressed' ? rnd(3) : rnd(2);
  for (let index = 0; index < denials; index++) {
    insertEvent('leave_denied', dstr(daysAgo(5 + rnd(85))), 0, 'Operational requirements');
  }
  if (family === 'married' && profile !== 'critical' && chance(0.7)) {
    insertEvent('family_visit', dstr(daysAgo(30 + rnd(200))), 0, 'Simulated family-contact record');
  }
  if (profile === 'critical' && family === 'married' && chance(0.5)) {
    insertEvent('family_visit', dstr(daysAgo(200 + rnd(160))), 0, 'Simulated family-contact record');
  }

  const baseOvertime = (profile === 'healthy' ? 2 : profile === 'moderate' ? 10 : 22) * unit.demand;
  for (let month = 0; month < 4; month++) {
    const trend = ['stressed', 'critical'].includes(profile) ? 1 + (3 - month) * 0.35 : 1;
    insertEvent('duty_overtime', dstr(daysAgo(month * 30 + 10)), Math.round(baseOvertime * trend + rnd(8)), 'Roster export');
  }

  const incidents = profile === 'critical' ? 1 + rnd(2) : profile === 'stressed' ? rnd(2) : 0;
  for (let index = 0; index < incidents; index++) {
    insertEvent('incident_exposure', dstr(daysAgo(3 + rnd(85))), 0,
      pick(['Operational incident', 'Post-operation briefing completed', 'Field incident', 'Site response']));
  }
  const transfers = profile === 'critical' && chance(0.5) ? 2 : chance(0.2) ? 1 : 0;
  for (let index = 0; index < transfers; index++) {
    insertEvent('transfer', dstr(daysAgo(60 + rnd(300))), 0, pick(['Srinagar', 'Raxaul', 'Chhattisgarh', 'Imphal']));
  }
  if (profile === 'critical' && chance(0.4)) insertEvent('disciplinary', dstr(daysAgo(10 + rnd(100))), 0, 'Minor');
  if (chance(0.3)) insertEvent('commendation', dstr(daysAgo(20 + rnd(200))), 0, 'DG commendation');
  if (chance(0.25)) insertEvent('training', dstr(daysAgo(30 + rnd(150))), 5 + rnd(15), 'Refresher training');

  // Voluntary check-ins: lower response frequency is part of the simulated
  // story, but non-participation itself is never converted into a risk signal.
  const stressBase = profile === 'healthy' ? 3 : profile === 'moderate' ? 5 : profile === 'stressed' ? 6.5 : 8;
  const sleepBase = profile === 'healthy' ? 7 : profile === 'moderate' ? 6.5 : 5.5;
  const frequency = profile === 'critical' ? 0.38 : 0.8;
  for (let day = 60; day >= 0; day--) {
    if (!chance(frequency)) continue;
    const drift = ['stressed', 'critical'].includes(profile) ? (60 - day) / 60 * 1.5 : 0;
    const stress = clamp(Math.round(stressBase + drift + (random() * 2 - 1)), 1, 10);
    const sleep = clamp(+(sleepBase - drift / 2 + (random() * 1.6 - 0.8)).toFixed(1), 3, 9);
    const moodPool = stress >= 8 ? ['stressed', 'low', 'anxious'] : stress >= 6 ? ['tired', 'okay', 'stressed'] : MOODS;
    const supportedBase = profile === 'critical' ? 2 : profile === 'stressed' ? 3 : 4;
    const energy = clamp(Math.round((sleep - 3) / 1.5 + 1 - (stress >= 8 ? 1 : 0)), 1, 5);
    insertCI.run(pid, dstr(daysAgo(day)), stress, sleep, pick(moodPool),
      stress > 6 && chance(0.5) ? 1 : 0, clamp(supportedBase + rnd(3) - 1, 1, 5), 0, energy);
  }

  if (['stressed', 'critical'].includes(profile) || chance(0.5)) {
    const assessment = simulatedAssessment(profile, personNumber);
    insertAS.run(pid, dstr(daysAgo(3 + rnd(30))), assessment.type, assessment.score, '[]',
      assessment.raw, assessment.display, assessment.level, assessment.urgent ? 1 : 0, 'prototype-v1');
  }

  // Private journal history. The demo identity gets a full 60-day arc so
  // Daily Insights and Progress show real long-range patterns; other seeded
  // personnel write occasionally so no journal view ever looks brand-new.
  // Content is generated locally from templates — private, simulated only.
  const days = personNumber === 1 ? 60 : chance(0.3) ? 4 + rnd(14) : 0;
  const pressure = profile === 'critical' ? 3 : profile === 'stressed' ? 2 : profile === 'moderate' ? 1 : 0;
  for (let day = days; day >= 1; day--) {
    if (personNumber !== 1 && !chance(0.5)) continue;
    const content = journalEntryTemplate(profile, pressure, day);
    const words = content.trim().split(/\s+/).length;
    const seconds = 180 + rnd(900);
    const updated = `${dstr(daysAgo(day))}T${String(6 + rnd(16)).padStart(2, '0')}:${String(rnd(60)).padStart(2, '0')}:00.000Z`;
    insertJE.run(pid, dstr(daysAgo(day)), content, words, seconds, updated,
      JSON.stringify([[0, Math.max(1, Math.round(words / 2))], [seconds, words]]), updated);
  }
}

// Deterministic reflective-entry templates. Negative-day entries lean on the
// seeded profile; positive days keep Progress trends varied and believable.
function journalEntryTemplate(profile, pressure, daysAgoCount) {
  const tough = ['critical', 'stressed'].includes(profile) ? (daysAgoCount % 3 !== 0) : daysAgoCount % 6 === 0;
  const openers = tough ? [
    'Duty se laut kar likh raha hoon. Body pain hai, neend poori nahi hui.',
    'Today felt heavier than usual. The roster gave no recovery window.',
    'Mann nahi lag raha. Sir yaad aa rahi hain, ghar bahut din baad milenge.'
  ] : [
    'Aaj din accha tha. Duty ke baad squad ke saath baith kar haansi mazaak kiya.',
    'Morning PT felt good today. I am grateful for a calm shift.',
    'Wrote letters home today. Feeling peaceful and hopeful about next leave.'
  ];
  const middles = tough ? [
    'Overtime phir badh gaya, schedule dekh kar man bore ho gaya. Sleep bhi adhoori hai aur thakan hai.',
    'Pressure is building before the movement. I am worried about the team and a little tired of the routine.',
    'Ek chhoti si galti par taunt sunna padta hai. Thoda frustration hai, par control mein hoon.'
  ] : [
    'Training mein nayi cheez seekhi. Fitness bhi track par hai aur energy theek thi.',
    'Called family in the evening. Small things like this keep me grounded and happy.',
    'Neend poori hui, wakt par khana khaya. Health ka dhyan rakhna aaj se aur zyada.'
  ];
  const closers = tough ? [
    'Phir bhi kal subah naya din hai. Main himmat rakhunga.',
    'Still, the squad stands together. That gives me hope.',
    'Sab difficult phase hai, shaant rehne ki koshish kar raha hoon.'
  ] : [
    'Aaj gratitude likhna chahta hoon — sehat, family, aur duty ka maan.',
    'Tomorrow I plan to finish the pending workout and read a few pages.',
    'Overall a positive day. Want to keep this streak of calm going.'
  ];
  const details = tough ? [
    'I took a short walk after dinner and spoke with a teammate instead of carrying everything alone. Writing this down makes the pressure feel more specific and manageable.',
    'Kal ke liye uniform aur kit taiyar kar di hai. Ab phone side mein rakh kar jaldi sone ki koshish karunga, kyunki recovery bhi duty ka hissa hai.',
    'The situation is difficult, but it is temporary. I can ask for help, protect a little recovery time, and focus on the next practical step instead of every problem at once.'
  ] : [
    'I noticed that a steady routine helped: water after PT, a proper meal, and ten quiet minutes before the shift. These small choices made the whole day feel more balanced.',
    'Ghar par baat karke accha laga. Humne agle leave ke simple plans banaye aur maine sabko bataya ki main theek hoon. Is connection se energy mili.',
    'I want to remember this ordinary good day, not because everything was perfect, but because I had enough patience to notice what was working and appreciate it.'
  ];
  const reflection = tough
    ? 'I am not giving up and I am not angry with the team; I am simply tired and need a better recovery plan. Tomorrow I will speak clearly, finish one task at a time, and check how I feel after proper sleep.'
    : 'I am not worried about doing everything perfectly. I feel happy, calm and supported, and I want to carry that approach into tomorrow without putting unnecessary pressure on myself.';
  const longerReflection = daysAgoCount % 3 === 0
    ? 'Before finishing, I want to record what helped today. I slowed my breathing, drank water, spoke honestly instead of pretending everything was fine, and separated the things I can change from the things I cannot. The most useful next step is simple: prepare for tomorrow, protect sleep, and speak to someone early if this feeling continues. Looking back at several days together may show whether this was one difficult moment or part of a longer pattern.'
    : '';
  return `${pick(openers)} ${pick(middles)} ${pick(details)} ${reflection} ${longerReflection} ${pick(closers)}`.replace(/\s+/g, ' ').trim();
}

function simulatedAssessment(profile, personNumber) {
  const type = ['PSS10', 'WHO5', 'GAD7', 'PHQ9'][personNumber % 4];
  if (type === 'WHO5') {
    const ranges = { healthy: [18, 8], moderate: [13, 6], stressed: [7, 7], critical: [2, 7] };
    const [base, span] = ranges[profile];
    const raw = clamp(base + rnd(span), 0, 25);
    const display = raw * 4;
    return { type, raw, display, score: 100 - display, urgent: false,
      level: display > 50 ? 'Good wellbeing' : display >= 29 ? 'Low wellbeing' : 'Very low wellbeing' };
  }
  if (type === 'PSS10') {
    const ranges = { healthy: [6, 8], moderate: [14, 12], stressed: [27, 7], critical: [34, 7] };
    const [base, span] = ranges[profile];
    const raw = clamp(base + rnd(span), 0, 40);
    return { type, raw, display: raw, score: Math.round(raw / 40 * 100), urgent: false,
      level: raw <= 13 ? 'Low perceived stress' : raw <= 26 ? 'Moderate perceived stress' : 'High perceived stress' };
  }
  if (type === 'GAD7') {
    const ranges = { healthy: [1, 4], moderate: [5, 5], stressed: [10, 6], critical: [15, 7] };
    const [base, span] = ranges[profile];
    const raw = clamp(base + rnd(span), 0, 21);
    return { type, raw, display: raw, score: Math.round(raw / 21 * 100), urgent: false,
      level: raw <= 4 ? 'Minimal anxiety' : raw <= 9 ? 'Mild anxiety' : raw <= 14 ? 'Moderate anxiety' : 'Severe anxiety' };
  }
  const ranges = { healthy: [1, 4], moderate: [5, 5], stressed: [10, 8], critical: [18, 8] };
  const [base, span] = ranges[profile];
  const raw = clamp(base + rnd(span), 0, 27);
  return { type, raw, display: raw, score: Math.round(raw / 27 * 100), urgent: false,
    level: raw <= 4 ? 'Minimal symptoms' : raw <= 9 ? 'Mild symptoms' : raw <= 14 ? 'Moderate symptoms' : raw <= 19 ? 'Moderately severe symptoms' : 'Severe symptoms' };
}

function sharedContext(pid, scopes, grantedDaysAgo) {
  if (!scopes.length) return '{}';
  const snapshot = {};
  if (scopes.includes('recent_checkins')) {
    const since = dstr(daysAgo(14));
    const summary = db.prepare(`SELECT COUNT(*) responses, AVG(stress) avg_stress,
      AVG(sleep_hours) avg_sleep, AVG(energy) avg_energy FROM checkins
      WHERE personnel_id = ? AND date >= ?`).get(pid, since);
    snapshot.recent_checkins = {
      window_days: 14,
      responses: Number(summary.responses),
      avg_stress: summary.avg_stress === null ? null : +Number(summary.avg_stress).toFixed(1),
      avg_sleep: summary.avg_sleep === null ? null : +Number(summary.avg_sleep).toFixed(1),
      avg_energy: summary.avg_energy === null ? null : +Number(summary.avg_energy).toFixed(1)
    };
  }
  if (scopes.includes('assessment_summary')) {
    const assessment = db.prepare(`SELECT type, date, display_score, level, urgent FROM assessments
      WHERE personnel_id = ? ORDER BY date DESC, id DESC LIMIT 1`).get(pid);
    snapshot.assessment_summary = assessment || null;
  }
  return JSON.stringify({
    version: 1,
    granted_by: 'personnel',
    granted_at: isoDaysAgo(grantedDaysAgo),
    scope: scopes,
    snapshot
  });
}

function seedSupportCases(personnelByForceId, welfareId) {
  const cases = [
    { forceId: 'CRPF100009', source: 'self_request', reason: 'work_pressure', priority: 'High',
      status: 'Contacted', details: 'Requested a confidential conversation about sustained duty pressure.',
      nextAction: 'Agree a suitable support plan', createdAgo: 8, responseAgo: 7, contactAgo: 7,
      followUp: 2, scopes: ['recent_checkins'], assigned: true },
    { forceId: 'CRPF100017', source: 'welfare_followup', reason: 'family', priority: 'Routine',
      status: 'Monitoring', details: 'Routine follow-up offered after an approved family-contact protocol.',
      nextAction: 'Check in after next roster cycle', createdAgo: 24, responseAgo: 22, contactAgo: 5,
      followUp: 5, scopes: [], assigned: true },
    { forceId: 'CRPF100025', source: 'post_incident', reason: 'post_incident', priority: 'High',
      status: 'In support', details: 'Standard post-incident welfare follow-up; no clinical inference recorded.',
      nextAction: 'Complete voluntary decompression follow-up', createdAgo: 12, responseAgo: 11, contactAgo: 3,
      followUp: 1, scopes: [], assigned: true },
    { forceId: 'CRPF100033', source: 'self_request', reason: 'health', priority: 'Urgent',
      status: 'In support', details: 'Asked for prompt help and consented to a limited wellbeing summary.',
      nextAction: 'Confirm same-day professional referral', createdAgo: 3, responseAgo: 3, contactAgo: 1,
      followUp: 0, scopes: ['recent_checkins', 'assessment_summary'], assigned: true },
    { forceId: 'CRPF100041', source: 'self_request', reason: 'personal_difficulty', priority: 'Routine',
      status: 'Resolved', details: 'Short-term confidential support request, now closed by agreement.',
      nextAction: 'None — person may reopen support', createdAgo: 50, responseAgo: 48, contactAgo: 31,
      resolvedAgo: 30, followUp: null, scopes: ['recent_checkins'], assigned: true },
    { forceId: 'CRPF100049', source: 'post_incident', reason: 'post_incident', priority: 'High',
      status: 'New', details: 'Automatic protocol entry after a recorded operational incident.',
      nextAction: 'Assign an officer and offer contact', createdAgo: 1, responseAgo: null, contactAgo: null,
      followUp: 0, scopes: [], assigned: false }
  ];
  const insertCase = db.prepare(`INSERT INTO support_cases
    (personnel_id, source, reason, details, priority, status, next_action, follow_up_due,
     last_contact_at, created_at, resolved_at, shared_context, assigned_officer_id, first_response_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertEvent = db.prepare(`INSERT INTO case_events
    (case_id, actor_id, event_type, detail, at) VALUES (?,?,?,?,?)`);
  const insertNote = db.prepare('INSERT INTO case_notes (case_id, author_id, note, at) VALUES (?,?,?,?)');

  for (const story of cases) {
    const pid = personnelByForceId.get(story.forceId);
    const context = sharedContext(pid, story.scopes, story.createdAgo);
    const followUpDue = story.followUp === null ? null : dateOffset(story.followUp);
    const lastContactAt = story.contactAgo === null ? null : isoDaysAgo(story.contactAgo, 14);
    const firstResponseAt = story.responseAgo === null ? null : isoDaysAgo(story.responseAgo, 11);
    const resolvedAt = story.resolvedAgo === undefined ? null : isoDaysAgo(story.resolvedAgo, 15);
    const assignedOfficer = story.assigned ? welfareId : null;
    const caseId = Number(insertCase.run(pid, story.source, story.reason, story.details, story.priority,
      story.status, story.nextAction, followUpDue, lastContactAt, isoDaysAgo(story.createdAgo, 9),
      resolvedAt, context, assignedOfficer, firstResponseAt).lastInsertRowid);

    insertEvent.run(caseId, null, 'case_created', `Source: ${story.source}`, isoDaysAgo(story.createdAgo, 9));
    if (story.assigned) {
      insertEvent.run(caseId, welfareId, 'officer_assigned', 'Assigned to Welfare Officer Kaur', isoDaysAgo(story.createdAgo, 10));
    }
    if (firstResponseAt) {
      insertEvent.run(caseId, welfareId, 'first_response', 'Initial confidential contact offered', firstResponseAt);
      insertNote.run(caseId, welfareId, 'Initial contact completed; preferences and next step recorded.', firstResponseAt);
    }
    if (!['New', 'Contacted'].includes(story.status)) {
      insertEvent.run(caseId, welfareId, 'status_changed', `Status changed to ${story.status}`,
        resolvedAt || lastContactAt || firstResponseAt);
    }
    if (resolvedAt) {
      insertEvent.run(caseId, welfareId, 'case_resolved', 'Closed by agreement after follow-up.', resolvedAt);
    }
    if (story.status !== 'Resolved' && story.scopes.length) {
      db.prepare('UPDATE personnel SET welfare_share = 1 WHERE id = ?').run(pid);
    }
  }
}

function seedOrganizationalActions(unitByName, commanderId) {
  const actions = [
    { unit: '1 Bn OP Dtk', title: 'Protected recovery after extended duty',
      evidence: 'Aggregate roster data showed sustained overtime above the unit baseline.',
      response: 'Cap consecutive extended-duty shifts and protect a recovery block after night duty.',
      owner: 'Operations Officer', status: 'Completed', baselineOvertime: 31.4, baselineSleep: 5.8,
      baselineRecovery: 61, baselineCondition: 'Sustained roster pressure',
      afterOvertime: 20.1, afterRecovery: 74, afterCondition: 'Pressure easing',
      outcome: 'Improving', startedAgo: 42, reviewOffset: -7, reviewedAgo: 5 },
    { unit: '91 Bn COBRA', title: 'Post-incident decompression rota',
      evidence: 'Aggregate records showed a cluster of recent incident exposures.',
      response: 'Schedule decompression windows and repeat the voluntary support briefing.',
      owner: 'Deputy Commandant', status: 'In progress', baselineOvertime: 28.7, baselineSleep: 5.6,
      baselineRecovery: 55, baselineCondition: 'Incident-response demand elevated',
      afterOvertime: null, afterRecovery: null, afterCondition: '', outcome: '', startedAgo: 14, reviewOffset: 10 },
    { unit: '5 Bn Ops', title: 'Review leave constraints',
      evidence: 'The 90-day unit aggregate showed a rising rate of leave denials.',
      response: 'Review staffing coverage and publish the next available family-contact windows.',
      owner: 'Adjutant', status: 'Review due', baselineOvertime: 24.2, baselineSleep: 6.0,
      baselineRecovery: 63, baselineCondition: 'Leave constraints rising',
      afterOvertime: 23.5, afterRecovery: 64, afterCondition: 'Stable; more observation needed',
      outcome: 'No clear change yet', startedAgo: 30, reviewOffset: -1, reviewedAgo: 1 },
    { unit: '3 Bn Trg Ctr', title: 'Preserve low-pressure training pattern',
      evidence: 'Aggregate recovery and overtime measures remain stable above the privacy threshold.',
      response: 'Keep protected recovery periods in the next training roster.',
      owner: 'Training Officer', status: 'Planned', baselineOvertime: 9.8, baselineSleep: 6.9,
      baselineRecovery: 78, baselineCondition: 'Stable training cadence',
      afterOvertime: null, afterRecovery: null, afterCondition: '', outcome: '', startedAgo: 2, reviewOffset: 28 }
  ];
  const insertAction = db.prepare(`INSERT INTO org_actions
    (unit_id, title, evidence, owner, status, baseline_overtime, baseline_sleep, started_at,
     reviewed_at, suggested_response, review_date, baseline_recovery, baseline_condition,
     after_overtime, after_recovery, after_condition, outcome, created_by, updated_at, simulated)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`);
  const insertEvent = db.prepare(`INSERT INTO org_action_events
    (action_id, actor_id, event_type, detail, at) VALUES (?,?,?,?,?)`);

  for (const action of actions) {
    const reviewedAt = action.reviewedAgo === undefined ? null : isoDaysAgo(action.reviewedAgo, 15);
    const updatedAt = reviewedAt || isoDaysAgo(Math.min(action.startedAgo, 1), 16);
    const actionId = Number(insertAction.run(unitByName[action.unit].id, action.title, action.evidence,
      action.owner, action.status, action.baselineOvertime, action.baselineSleep,
      dateOffset(-action.startedAgo), reviewedAt, action.response, dateOffset(action.reviewOffset),
      action.baselineRecovery, action.baselineCondition, action.afterOvertime, action.afterRecovery,
      action.afterCondition, action.outcome, commanderId, updatedAt).lastInsertRowid);
    insertEvent.run(actionId, commanderId, 'action_created', action.response, isoDaysAgo(action.startedAgo, 9));
    if (action.status !== 'Planned') {
      insertEvent.run(actionId, commanderId, 'status_changed', `Status changed to ${action.status}`,
        isoDaysAgo(Math.max(0, action.startedAgo - 1), 10));
    }
    if (reviewedAt) {
      insertEvent.run(actionId, commanderId, 'outcome_recorded', action.outcome, reviewedAt);
    }
  }
}

main();
