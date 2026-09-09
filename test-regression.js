'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-regression-'));
process.env.SENTINEL_DB_PATH = path.join(testDir, 'sentinel.db');
const db = require('./lib/db');

function runSeed() {
  delete require.cache[require.resolve('./lib/seed')];
  require('./lib/seed');
}
runSeed();

// Prove a second destructive demo reset cannot rebind retained sensitive rows
// to newly reused person/user/unit IDs.
const beforeReset = db.prepare("SELECT id FROM personnel WHERE force_id='CRPF100001'").get();
const welfareUser = db.prepare("SELECT id FROM users WHERE username='welfare'").get();
const staleCase = Number(db.prepare(`INSERT INTO support_cases
  (personnel_id,source,reason,details,priority,status,next_action,created_at,assigned_officer_id,shared_context)
  VALUES (?,?,?,?,?,?,?,?,?,?)`).run(beforeReset.id,'personnel_request','other','MUST-BE-REMOVED','Routine','New','Test',new Date().toISOString(),welfareUser.id,'{}').lastInsertRowid);
db.prepare('INSERT INTO case_notes(case_id,author_id,note,at) VALUES (?,?,?,?)').run(staleCase,welfareUser.id,'MUST-BE-REMOVED',new Date().toISOString());
runSeed();

const { computeRisk } = require('./lib/risk');
const PORT = 4496;
const BASE = `http://127.0.0.1:${PORT}`;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const child = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT), APP_VERSION: 'regression' },
  stdio: ['ignore', 'ignore', 'pipe']
});
let childError = '';
child.stderr.on('data', chunk => { childError += chunk.toString(); });
let failures = 0;
function ok(value, label) {
  console.log(value ? 'PASS' : 'FAIL', label);
  if (!value) failures++;
}
async function login(username) {
  const response = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'demo123' })
  });
  ok(response.status === 200, `${username} login`);
  return response.headers.get('set-cookie').split(';')[0];
}
async function request(url, cookie, method = 'GET', body, headers = {}) {
  return fetch(BASE + url, {
    method,
    headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
}
async function json(response) { return response.json(); }
async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try { const response = await fetch(`${BASE}/api/health`); if (response.ok) return; } catch {}
    await wait(200);
  }
  throw new Error(`Regression server did not start. ${childError.trim()}`);
}

(async () => {
  try {
    ok(!db.prepare("SELECT id FROM support_cases WHERE details='MUST-BE-REMOVED'").get(), 'repeat seed removes old support cases before IDs are reused');
    ok(!db.prepare("SELECT id FROM case_notes WHERE note='MUST-BE-REMOVED'").get(), 'repeat seed removes old private case notes');
    ok(db.prepare('SELECT COUNT(*) c FROM support_cases').get().c === 6, 'deterministic seed restores the same connected case fixture count');
    ok(db.prepare("SELECT p.name,u.name unit FROM personnel p JOIN units u ON u.id=p.unit_id WHERE p.force_id='CRPF100001'").get().name === 'Rahul Verma', 'demo identity maps consistently to Rahul Verma');
    ok(db.prepare("SELECT aggregate_consent FROM personnel WHERE force_id='CRPF100001'").get().aggregate_consent === 1, 'demo Personnel aggregate contribution starts on and remains user-controllable');
    const seededJournal = db.prepare("SELECT COUNT(*) days,MAX(j.words) max_words FROM journal_entries j JOIN personnel p ON p.id=j.personnel_id WHERE p.force_id='CRPF100001'").get();
    ok(seededJournal.days === 60 && seededJournal.max_words >= 150, 'demo Personnel has 60 substantial private reflections including completed-goal days');

    await waitForServer();
    const publicResponse = await fetch(`${BASE}/api/version`);
    const version = await publicResponse.json();
    ok(publicResponse.headers.get('content-security-policy')?.includes("default-src 'self'"), 'content security policy is active');
    ok(publicResponse.headers.get('x-frame-options') === 'DENY', 'clickjacking protection is active');
    ok(version.demo?.enabled === true || version.demo_mode === true, 'API labels the prototype as a demo environment');

    const personnel = await login('sepoy.demo');
    const welfare = await login('welfare');
    const commander = await login('commander');
    const servicePersonnel = await login('crpf100002');

    let response = await request('/api/personnel/home', servicePersonnel);
    ok(response.status === 200, 'any seeded personnel can sign in with a case-insensitive service ID');
    response = await request('/api/personnel/home', personnel);
    const home = await json(response);
    ok(response.status === 200 && home.profile.name === 'Rahul Verma' && home.privacy.private_by_default && !('risk' in home), 'Personnel Home is private-first and does not expose a support-priority score');
    ok(home.profile.unit === '148 Bn' && home.work_preview && home.week && home.insight, 'Personnel Home uses connected profile, work, trend and insight data');

    response = await request('/api/checkin', personnel, 'POST', { mood: 'okay', stress: 6, sleep_hours: 6.25, energy: 4 });
    ok(response.status === 200, '30-second mood/stress/sleep/energy check-in saves');
    response = await request('/api/personnel/progress?days=30', personnel);
    const progress = await json(response);
    ok(response.status === 200 && progress.series.at(-1).energy === 4 && progress.work_relationship?.disclaimer.includes('not proof'), 'check-in event updates Progress and includes association limits');

    response = await request('/api/assessment', personnel, 'POST', { type: 'WHO5', answers: [5,4,3,4,5] });
    const assessmentResult = await json(response);
    ok(response.status === 200 && assessmentResult.display_score === 84, 'WHO-5 scoring works end to end');
    response = await request('/api/personnel/assessments', personnel);
    const assessmentHistory = await json(response);
    ok(response.status === 200 && assessmentHistory.by_type.WHO5[0].display_score === 84 && assessmentHistory.by_type.WHO5[0].max_score === 100, 'assessment history preserves correct display direction');

    const today = new Date().toISOString().slice(0, 10);
    response = await request('/api/journal', personnel, 'POST', {
      date: today,
      content: 'मैं आज ड्यूटी के बाद शांत और उम्मीद महसूस कर रहा हूं. Family and sleep are on my mind.',
      time_sec: 60, timeline: [[0,0],[60,17]], started_at: new Date().toISOString()
    });
    ok(response.status === 200, 'private multilingual journal entry saves');
    response = await request(`/api/journal/analysis/${today}`, personnel);
    const journalAnalysis = await json(response);
    ok(response.status === 200 && journalAnalysis.analysis.meta?.experimental && journalAnalysis.analysis.topics.some(item => item.label === 'Duty & work' && item.count > 0), 'private Hindi/Hinglish journal analysis is Unicode-aware and labelled experimental');

    response = await request('/api/support/request', personnel, 'POST', {
      reason: 'work_pressure', details: 'I would appreciate a confidential check-in.',
      shared_context: { stress_trend: true, sleep_trend: true, who5: false, assessment_history: false, work_context: true }
    });
    const supportCreated = await json(response);
    ok(response.status === 200 && supportCreated.case_id, 'Personnel can create a support request with field-level sharing');
    const caseId = supportCreated.case_id;
    response = await request('/api/my-support', personnel);
    const mySupport = await json(response);
    const myCase = mySupport.cases.find(item => item.id === caseId);
    ok(myCase && myCase.status === 'New' && myCase.shared_fields.join(',') === 'stress_trend,sleep_trend,work_context', 'Personnel receives connected case status and exact shared-field receipt');

    response = await request('/api/welfare/cases', welfare);
    const queue = await json(response);
    const queued = queue.cases.find(item => item.id === caseId);
    ok(response.status === 200 && queued?.source_key === 'personnel_request' && queued.shared_fields.length === 3, 'Welfare Support Queue receives the sourced Personnel request');
    response = await request(`/api/welfare/cases/${caseId}`, welfare);
    const caseDetail = await json(response);
    const detailText = JSON.stringify(caseDetail);
    ok(response.status === 200 && caseDetail.shared_context.snapshot.stress_trend && caseDetail.shared_context.snapshot.sleep_trend && caseDetail.shared_context.snapshot.work_context, 'Welfare receives selected authorized context');
    ok(!caseDetail.shared_context.snapshot.who5 && !caseDetail.shared_context.snapshot.assessment_history && !/journal entry|transcript/i.test(detailText), 'unselected assessments and private journal content do not cross the case boundary');

    const due = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    response = await request(`/api/welfare/cases/${caseId}`, welfare, 'POST', {
      status: 'Contacted', priority: 'High', next_action: 'Confidential follow-up call', follow_up_due: due,
      note: 'Initial contact completed; follow-up agreed.'
    });
    ok(response.status === 200, 'Welfare can contact Personnel and schedule follow-up');
    response = await request('/api/my-support', personnel);
    const updatedSupport = await json(response);
    ok(updatedSupport.cases.find(item => item.id === caseId)?.status === 'Contacted' && updatedSupport.cases.find(item => item.id === caseId)?.follow_up_due === due, 'Welfare update reflects back to Personnel');
    response = await request(`/api/welfare/cases/${caseId}`, welfare, 'POST', { status: 'New' });
    ok(response.status === 409, 'case workflow rejects an invalid backward transition');

    response = await request('/api/support/request', personnel, 'POST', {
      reason: 'other', shared_context: { journal: true }
    });
    ok(response.status === 400, 'server rejects every attempt to include private Journal data in a support request');

    response = await request('/api/my-data/correction', personnel, 'POST', { category: 'workload', message: 'Please verify the recorded duty overtime for this month.' });
    ok(response.status === 200, 'Personnel can submit a tracked record review');
    response = await request('/api/welfare/record-reviews', welfare);
    const reviews = await json(response);
    const review = reviews.reviews.find(item => item.message.includes('verify the recorded'));
    ok(response.status === 200 && review, 'record reviews remain separate from support cases');
    response = await request(`/api/data-corrections/${review.id}`, welfare, 'POST', { status: 'reviewing', resolution_note: '' });
    ok(response.status === 200, 'Welfare can begin a record review');

    response = await request('/api/my-consent', personnel, 'POST', { aggregate_consent: false });
    ok(response.status === 200, 'Personnel can turn aggregate contribution off');
    response = await request('/api/commander/overview', commander);
    const commandBefore = await json(response);
    const unitBefore = commandBefore.units.find(item => item.unit === '148 Bn');
    response = await request('/api/my-consent', personnel, 'POST', { aggregate_consent: true });
    response = await request('/api/commander/overview', commander);
    const commandAfter = await json(response);
    const unitAfter = commandAfter.units.find(item => item.unit === '148 Bn');
    ok(response.status === 200 && unitAfter.pulse.respondents === unitBefore.pulse.respondents + 1, 'Commander voluntary aggregate enforces and reflects affirmative consent');
    ok(commandAfter.early_indicators.every(item => item.horizon_days === 7 && item.data_availability && !('probability' in item)), 'Commander receives explainable seven-day indicators without fake probability');
    const commandText = JSON.stringify(commandAfter);
    ok(!/Rahul Verma|CASE #|journal_entries|assessment_history/.test(commandText), 'Commander payload contains conditions, never people or case files');
    const sourceUnit = commandAfter.units.find(item => item.unit === '148 Bn');
    const heatUnit = commandAfter.heatmap.find(item => item.unit === '148 Bn');
    ok(sourceUnit.heatmap.overtime.value === heatUnit.cells.overtime.value, 'Commander Overview and heatmap share one server-derived unit condition');

    response = await request('/api/commander/actions', commander, 'POST', {
      unit_id: sourceUnit.unit_id, title: 'Protect roster recovery', evidence: sourceUnit.heatmap.overtime.explanation,
      suggested_response: 'Review rotation and protect recovery intervals.', owner: 'Operations', review_date: due
    });
    const actionCreated = await json(response);
    ok(response.status === 201 && actionCreated.action.before.overtime_per_person === sourceUnit.workload.overtime_per_person, 'organizational action stores the same unit baseline shown in Units');
    response = await request(`/api/commander/actions/${actionCreated.action.id}`, commander, 'POST', { status: 'In progress' });
    ok(response.status === 200, 'Commander can move an organizational action into progress');
    response = await request(`/api/commander/actions/${actionCreated.action.id}/advance-demo`, commander, 'POST', {});
    const advanced = await json(response);
    ok(response.status === 200 && advanced.simulated && advanced.action.status === 'Improving' && advanced.action.after, 'intervention can record a clearly labelled simulated 14-day outcome');

    response = await request('/api/welfare/insights', welfare);
    const welfareInsights = await json(response);
    ok(response.status === 200 && welfareInsights.priority && welfareInsights.follow_up && welfareInsights.case_age && 'median_first_response_hours' in welfareInsights, 'Welfare insights are actionable workflow measures');
    response = await request('/api/welfare/followups', welfare);
    const followups = await json(response);
    ok(response.status === 200 && followups.followups.some(item => item.id === caseId), 'scheduled case appears in Follow-ups');

    for (const [label, cookie, url, expected] of [
      ['commander blocked from Welfare cases', commander, '/api/welfare/cases', 403],
      ['commander blocked from person records', commander, '/api/personnel/1', 403],
      ['commander explicit journal probe is forbidden', commander, '/api/personnel/1/journal', 403],
      ['welfare explicit journal probe is forbidden', welfare, '/api/personnel/1/journal', 403],
      ['welfare blocked from Commander aggregates', welfare, '/api/commander/overview', 403],
      ['personnel blocked from Welfare queue', personnel, '/api/welfare/cases', 403],
      ['personnel blocked from Commander aggregates', personnel, '/api/commander/overview', 403],
      ['legacy unrestricted Welfare person route is retired', welfare, '/api/personnel/1', 410]
    ]) {
      response = await request(url, cookie);
      ok(response.status === expected, label);
    }

    const basePerson = { id: 999, active: 1, family_status: 'single' };
    const disciplinaryOnly = computeRisk({ personnel: basePerson, hr: [{ type: 'disciplinary', date: today, value: 0 }], checkins: [], assessments: [], today });
    ok(disciplinaryOnly.score === 0 && disciplinaryOnly.factors.length === 0, 'disciplinary history never raises an indicator');
    const privateVoluntary = computeRisk({ personnel: basePerson, hr: [], checkins: Array(8).fill({ stress: 10, sleep_hours: 2 }), assessments: [{ date: today, score: 100 }], today });
    ok(privateVoluntary.score === 0, 'private voluntary data is excluded unless a caller explicitly authorizes it');

    // Voice transcript helpers: overlap merging, repetition guards, language hints.
    const voiceText = require('./lib/voice-text');
    ok(voiceText.mergeChunkText('main duty par gaya', 'duty par gaya tha aur thak gaya') === 'main duty par gaya tha aur thak gaya', 'voice chunk merge drops the overlapped tail instead of repeating it');
    ok(voiceText.mergeChunkText('I felt tired today', 'today was long') === 'I felt tired today was long', 'voice chunk merge keeps new words when tails differ');
    ok(voiceText.isNearDuplicate('main gaya tha', ['main gaya tha']) === true, 'voice guard drops exact repeats');
    ok(voiceText.isNearDuplicate('main gaya', ['main gaya tha']) === true, 'voice guard drops contained repeats (the 5x phone bug)');
    ok(voiceText.isNearDuplicate('I felt very tired today', ['i felt so tired today']) === true, 'voice guard drops near-identical re-hearings');
    ok(voiceText.isNearDuplicate('aaj neend poori hui', ['kal duty lambi thi']) === false, 'voice guard keeps genuinely new phrases');
    ok(voiceText.collapseRepeats('gaya gaya gaya gaya gaya') === 'gaya gaya', 'voice guard collapses in-chunk word loops');
    ok(voiceText.whisperHint('auto').language === undefined, 'voice auto language lets Whisper detect Hindi/English/Hinglish');
    ok(voiceText.whisperHint('hi-IN').language === 'hi', 'voice Hindi selector maps to the Whisper Hindi hint');
    ok(voiceText.whisperHint('en-IN').language === 'en', 'voice English selector maps to the Whisper English hint');
    ok(voiceText.micErrorKind({ name: 'NotAllowedError' }) === 'denied', 'voice mic denial is classified for guided recovery');
    ok(voiceText.micErrorKind({ name: 'NotFoundError' }) === 'missing', 'voice missing mic is classified for guided recovery');
    ok(voiceText.micErrorKind({ name: 'NotReadableError' }) === 'busy', 'voice busy mic is classified for guided recovery');

    // Negation-aware journal analysis: "not angry" must not count as anger.
    const analyzeText = require('./lib/journal-analyze').analyze;
    const englishNegation = analyzeText('I am not angry but I am very happy and grateful today.');
    ok(englishNegation.feelings.find(item => item.label === 'Angry').count === 0, 'negated emotion ("not angry") is never counted as anger');
    ok(englishNegation.feelings.find(item => item.label === 'Happy').count >= 1, 'affirmed positive emotion ("very happy") is counted');
    ok(englishNegation.mindset.positive >= 50, 'mindset positive side reflects the affirmed happy mood');
    const hindiNegation = analyzeText('मैं नहीं गुस्सा हूं, मैं खुश हूं और शांत हूं।');
    ok(hindiNegation.feelings.find(item => item.label === 'Angry').count === 0, 'Hindi negation (nahi gussa) is never counted as anger');
    ok(hindiNegation.feelings.find(item => item.label === 'Happy').count >= 1, 'Hindi affirmed emotion (khush) is counted');
    const hinglishPostfixNegation = analyzeText('main gussa nahi hoon, main bahut khush hoon');
    ok(hinglishPostfixNegation.feelings.find(item => item.label === 'Angry').count === 0, 'Hinglish postfix negation (gussa nahi) is never counted as anger');
    ok(hinglishPostfixNegation.feelings.find(item => item.label === 'Happy').count >= 1, 'Hinglish positive clause after negation is still counted');
    ok(analyzeText('main gussa bilkul nahi hoon').feelings.find(item => item.label === 'Angry').count === 0, 'Hinglish postfix negation handles one intervening emphasis word');
    const plainNegative = analyzeText('I am so angry and upset today, everything went wrong.');
    ok(plainNegative.feelings.find(item => item.label === 'Angry').count >= 1, 'non-negated anger is still counted normally');
  } catch (error) {
    console.error(error);
    failures++;
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), wait(1500)]);
    }
    try { db.close(); } catch {}
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch {}
    console.log(failures ? `FAILED ${failures}` : 'ALL REGRESSIONS PASSED');
    process.exitCode = failures ? 1 : 0;
  }
})();
