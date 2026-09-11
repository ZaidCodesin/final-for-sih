'use strict';

/* ProtecT frontend â€” role-aware, privacy-first vanilla SPA */
const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
}[char]));
const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
const asArray = value => Array.isArray(value) ? value : [];
const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const numberOrNull = value => value === null || value === undefined || value === '' || Number.isNaN(Number(value)) ? null : Number(value);
const titleCase = value => String(value ?? '').replace(/[_-]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
const localDateKey = date => {
  const d = date || new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};
const formatDate = (value, options = {}) => {
  if (!value) return 'Not set';
  const raw = /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? `${value}T00:00:00` : value;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString([], { day: '2-digit', month: 'short', year: options.year ? 'numeric' : undefined });
};
const formatDateTime = value => {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const relativeAge = value => {
  if (!value) return 'Unknown age';
  const milliseconds = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) return 'Unknown age';
  const hours = Math.max(0, Math.floor(milliseconds / 3600000));
  if (hours < 1) return 'Under 1 hour';
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
};
const slug = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const parseMaybeJson = value => {
  if (!value || typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return value; }
};

let me = null;
let currentRoute = '';
let toastTimer = null;
let sessionEnding = false;

async function api(url, options = {}) {
  const { silentAuth = false, ...fetchOptions } = options;
  const headers = { 'Content-Type': 'application/json', ...(fetchOptions.headers || {}) };
  let response;
  try {
    response = await fetch(url, { credentials: 'same-origin', ...fetchOptions, headers });
  } catch (cause) {
    const error = new Error('Cannot reach the ProtecT service. Restart the local server and reload this page.');
    error.cause = cause;
    error.status = 0;
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401 && me && !silentAuth && !sessionEnding) {
      sessionEnding = true;
      toast('Your session ended. Please sign in again.');
      setTimeout(() => window.location.reload(), 900);
    }
    const error = new Error(payload.error || response.statusText || 'Request failed');
    error.status = response.status;
    throw error;
  }
  return payload;
}

async function apiWithFallback(primary, fallback) {
  try { return await api(primary); }
  catch (error) {
    if (typeof fallback === 'function' && [404, 405, 501].includes(error.status)) return fallback(error);
    throw error;
  }
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.add('hidden'), 3200);
}

function loadingMarkup(count = 3) {
  return `<div class="loading-grid" aria-label="Loading"><span class="skeleton"></span>${'<span class="skeleton"></span>'.repeat(Math.max(0, count - 1))}</div>`;
}

function emptyMarkup(title, detail, action = '') {
  return `<div class="empty-state"><h3>${esc(title)}</h3><p>${esc(detail)}</p>${action}</div>`;
}

function errorMarkup(message, retryAction) {
  return `<div class="error-state" role="alert"><h3>We could not load this view</h3><p>${esc(message || 'Please try again.')}</p><button class="button" type="button" data-retry="${esc(retryAction)}">Try again</button></div>`;
}

function statusChip(value, fallback = 'Not set') {
  const text = value || fallback;
  return `<span class="status-chip ${slug(text)}">${esc(text)}</span>`;
}

function metricCard(label, value, detail = '') {
  return `<div class="metric-card"><span>${esc(label)}</span><strong>${esc(value ?? 'â€”')}</strong><small>${esc(detail)}</small></div>`;
}

function sparkline(values, label, trendText = '') {
  const clean = asArray(values).map(numberOrNull).filter(value => value !== null);
  if (clean.length < 2) return `<div class="subtle-note">Not enough data for a trend.</div>`;
  const min = Math.min(...clean), max = Math.max(...clean), range = Math.max(1, max - min);
  const points = clean.map((value, index) => {
    const x = clean.length === 1 ? 50 : index / (clean.length - 1) * 100;
    const y = 38 - ((value - min) / range) * 30;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const summary = `${label}: ${clean[0]} to ${clean[clean.length - 1]}${trendText ? `, ${trendText}` : ''}`;
  return `<svg class="sparkline" viewBox="0 0 100 44" preserveAspectRatio="none" role="img" aria-label="${esc(summary)}"><polyline points="${points}"></polyline></svg>`;
}

function trendDescriptor(values, lowerIsBetter = false) {
  const clean = asArray(values).map(numberOrNull).filter(value => value !== null);
  if (clean.length < 2) return 'Building your baseline';
  const change = clean[clean.length - 1] - clean[0];
  if (Math.abs(change) < .35) return 'Steady';
  const favorable = lowerIsBetter ? change < 0 : change > 0;
  return favorable ? 'Improving' : 'Worth noticing';
}

function distributionRows(data, emptyText = 'Not enough data yet.') {
  const entries = Array.isArray(data)
    ? data.map(item => [item.label || item.name || item.source || item.status, Number(item.count ?? item.value ?? 0)])
    : Object.entries(asObject(data)).map(([key, value]) => [titleCase(key), Number(value) || 0]);
  const usable = entries.filter(([label]) => label);
  if (!usable.length) return `<p class="muted">${esc(emptyText)}</p>`;
  const max = Math.max(1, ...usable.map(([, value]) => value));
  return `<div class="distribution-list">${usable.map(([label, value]) => `<div class="distribution-row"><span>${esc(label)}</span><div class="distribution-track" aria-hidden="true"><i style="width:${Math.round(value / max * 100)}%"></i></div><strong>${esc(value)}</strong></div>`).join('')}</div>`;
}

function sourceLabel(value) {
  const labels = {
    self_request: 'Personnel requested support',
    personnel_request: 'Personnel requested support',
    predictive_indicator: 'Predictive early indicator',
    post_incident: 'Post-incident follow-up',
    scheduled_review: 'Scheduled welfare review',
    referral: 'Referral',
    data_review: 'Data-review escalation'
  };
  return labels[value] || titleCase(value || 'Source not recorded');
}

function sharedContextLabels(value) {
  const parsed = asObject(parseMaybeJson(value));
  const labels = {
    stress_trend: 'Stress trend', sleep_trend: 'Sleep trend', who5: 'WHO-5 result',
    assessment_history: 'Assessment history', work_context: 'Work-context summary',
    voluntary_checkins: 'Voluntary check-ins'
  };
  return Object.entries(parsed)
    .filter(([, included]) => included === true || included !== false && included !== null && included !== undefined)
    .map(([key]) => labels[key] || titleCase(key));
}

function renderTagList(labels, empty = 'No voluntary context shared') {
  const items = asArray(labels).filter(Boolean);
  return items.length ? `<div class="tag-list">${items.map(label => `<span class="tag">${esc(label)}</span>`).join('')}</div>` : `<span class="subtle-note">${esc(empty)}</span>`;
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function askNote({ title, help = '', label = 'Note', confirm = 'Confirm', required = false, initial = '' }) {
  const dialog = $('#confirm-dialog');
  const note = $('#dialog-note');
  $('#dialog-title').textContent = title;
  $('#dialog-help').textContent = help;
  $('#dialog-note-label').textContent = label;
  $('#dialog-confirm').textContent = confirm;
  note.value = initial;
  dialog.returnValue = '';
  dialog.showModal();
  note.focus();
  return new Promise(resolve => {
    dialog.onclose = () => {
      const accepted = dialog.returnValue === 'default';
      const value = note.value.trim();
      resolve(accepted && (!required || value) ? value : null);
    };
  });
}

/* Theme */
(function initializeTheme() {
  const saved = localStorage.getItem('sentinel-theme');
  const preferred = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = saved || preferred;
  $$('[data-theme-toggle]').forEach(button => button.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('sentinel-theme', next);
    if (currentRoute.includes('/journal/insights') && jrLastAnalysis) jrRenderAnalysis(jrLastAnalysis.date);
    if (currentRoute.includes('/journal/progress') && jrLastStats) jrDrawStats(jrLastStats.last30 || []);
    if (currentRoute.startsWith('/commander/') && commanderData?.trend) drawCommanderTrend(currentRoute==='/commander/trends'?asArray(commanderData.trend):asArray(commanderData.trend).slice(-14));
  }));
})();

const PORTALS = {
  personnel: { label: 'Personnel Demo', user: 'sepoy.demo' },
  welfare: { label: 'Welfare Officer Demo', user: 'welfare' },
  commander: { label: 'Commander Demo', user: 'commander' }
};
let chosenPortal = null;

$$('[data-portal]').forEach(button => button.addEventListener('click', () => {
  chosenPortal = button.dataset.portal;
  const portal = PORTALS[chosenPortal];
  $('#portal-choice').classList.add('hidden');
  $('#signin-form').classList.remove('hidden');
  $('#portal-label').textContent = portal.label;
  $('#li-user').value = '';
  $('#li-pass').value = '';
  $('#demo-options').innerHTML = `<button type="button" id="fill-demo">Fill ${esc(portal.label)} credentials</button>`;
  $('#fill-demo').addEventListener('click', () => {
    $('#li-user').value = portal.user;
    $('#li-pass').value = 'demo123';
    $('#li-pass').focus();
  });
  $('#li-user').focus();
}));

$('#portal-back').addEventListener('click', () => {
  $('#signin-form').classList.add('hidden');
  $('#portal-choice').classList.remove('hidden');
});

const SIGNUP_RANKS = ['Sepoy', 'Constable', 'Naik', 'Havildar', 'Naib Subedar', 'Subedar', 'Inspector', 'Sub-Inspector'];
$('#su-rank').innerHTML = '<option value="">Select rank</option>' + SIGNUP_RANKS.map(rank => `<option>${rank}</option>`).join('');
let unitsLoaded = false;

async function loadUnits() {
  if (unitsLoaded) return;
  try {
    const payload = await api('/api/units', { silentAuth: true });
    $('#su-unit').innerHTML = '<option value="">Select unit</option>' + asArray(payload.units).map(unit => `<option value="${Number(unit.id)}">${esc(unit.name)}</option>`).join('');
    unitsLoaded = true;
  } catch { /* The user can create a demo unit instead. */ }
}

$('#show-signup').addEventListener('click', () => {
  $('#signin-form').classList.add('hidden');
  $('#signup-form').classList.remove('hidden');
  loadUnits();
  $('#su-name').focus();
});
$('#signup-back').addEventListener('click', () => {
  $('#signup-form').classList.add('hidden');
  $('#signin-form').classList.remove('hidden');
  $('#li-user').focus();
});

async function login(username, password) {
  me = await api('/api/login', { method: 'POST', body: JSON.stringify({ username, password }), silentAuth: true });
  if (chosenPortal && me.role !== chosenPortal) {
    const actualRole = me.role;
    await api('/api/logout', { method: 'POST', silentAuth: true });
    me = null;
    throw new Error(`This account belongs to the ${titleCase(actualRole)} workspace. Choose the matching demo.`);
  }
  boot();
}

$('#signin-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#li-btn');
  $('#li-err').classList.add('hidden');
  button.disabled = true;
  button.textContent = 'Signing inâ€¦';
  try { await login($('#li-user').value.trim(), $('#li-pass').value); }
  catch (error) {
    $('#li-err').textContent = error.message;
    $('#li-err').classList.remove('hidden');
  } finally {
    button.disabled = false;
    button.textContent = 'Sign in';
  }
});

$('#signup-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('#su-btn');
  $('#su-err').classList.add('hidden');
  const payload = {
    name: $('#su-name').value.trim(), service_id: $('#su-id').value.trim(), rank: $('#su-rank').value,
    unit_id: $('#su-unit').value ? Number($('#su-unit').value) : 0,
    new_unit: $('#su-newunit').value.trim(), password: $('#su-pass').value
  };
  button.disabled = true;
  try {
    await api('/api/register', { method: 'POST', body: JSON.stringify(payload), silentAuth: true });
    chosenPortal = 'personnel';
    await login(payload.service_id, payload.password);
  } catch (error) {
    $('#su-err').textContent = error.message;
    $('#su-err').classList.remove('hidden');
  } finally { button.disabled = false; }
});

const NAVIGATION = {
  personnel: [
    ['/personnel/home', 'Home', 'âŒ‚'], ['/personnel/journal/write', 'Journal', 'âœŽ'],
    ['/personnel/assessments', 'Assessments', 'â—‡'], ['/personnel/insights', 'Insights', 'â—Œ'],
    ['/personnel/work-context', 'Work Context', 'â–¤'], ['/personnel/privacy-support', 'Privacy & Support', 'â–£']
  ],
  welfare: [
    ['/welfare/overview', 'Overview', 'âŒ‚'], ['/welfare/cases', 'Cases', 'â–¤'],
    ['/welfare/followups', 'Follow-ups', 'â†»'], ['/welfare/record-reviews', 'Record Reviews', 'âœ“'],
    ['/welfare/insights', 'Insights', 'â—Œ']
  ],
  commander: [
    ['/commander/overview', 'Overview', 'âŒ‚'], ['/commander/units', 'Units', 'â–¦'],
    ['/commander/early-indicators', 'Early Indicators', 'â–³'], ['/commander/actions', 'Actions', 'âœ“'],
    ['/commander/trends', 'Trends', 'â†—']
  ]
};

const ROLE_META = {
  personnel: { label: 'Personnel workspace', promise: 'Your private space. You choose what to share.' },
  welfare: { label: 'Welfare operations', promise: 'Authorized context only. Support, never discipline.' },
  commander: { label: 'Command conditions', promise: 'Conditions, never case files.' }
};

const ROUTE_META = {
  '/personnel/home': ['Personal workspace', 'Home'],
  '/personnel/journal': ['Private reflection', 'Journal'],
  '/personnel/assessments': ['Private screening', 'Assessments'],
  '/personnel/insights': ['Personal patterns', 'Insights'],
  '/personnel/work-context': ['Official records', 'Work Context'],
  '/personnel/privacy-support': ['Your control', 'Privacy & Support'],
  '/welfare/overview': ['Welfare operations', 'Overview'],
  '/welfare/cases': ['Support workflow', 'Cases'],
  '/welfare/case': ['Authorized support', 'Case detail'],
  '/welfare/followups': ['Time-sensitive work', 'Follow-ups'],
  '/welfare/record-reviews': ['Data quality', 'Record Reviews'],
  '/welfare/insights': ['Operational learning', 'Insights'],
  '/commander/overview': ['Command workspace', 'Overview'],
  '/commander/units': ['Aggregate conditions', 'Units'],
  '/commander/early-indicators': ['7-day outlook', 'Early Indicators'],
  '/commander/actions': ['Organizational response', 'Actions'],
  '/commander/trends': ['Conditions over time', 'Trends']
};

function defaultRoute(role) { return `/${role}/${role === 'personnel' ? 'home' : 'overview'}`; }
function hashRoute() {
  let route = decodeURIComponent(window.location.hash.replace(/^#/, ''));
  if (!route.startsWith('/')) route = `/${route}`;
  const legacy = { '/dashboard': '/personnel/home', '/journal': '/personnel/journal/write', '/assessments': '/personnel/assessments', '/welfare': '/welfare/overview', '/commander': '/commander/overview' };
  return legacy[route] || route;
}
function routeBelongsToRole(route, role) { return route === `/${role}` || route.startsWith(`/${role}/`); }
function navRouteActive(navRoute, route) {
  if (navRoute.includes('/journal/')) return route.startsWith('/personnel/journal/');
  if (navRoute === '/welfare/cases') return route === navRoute || route.startsWith('/welfare/cases/');
  return navRoute === route;
}

function renderNavigation() {
  const links = asArray(NAVIGATION[me.role]).map(([route, label, icon]) => `<a class="nav-link" href="#${route}" data-nav-route="${route}"><span class="nav-icon" aria-hidden="true">${icon}</span><span>${esc(label)}</span></a>`).join('');
  $('#nav').innerHTML = links;
  $('#mobile-nav').innerHTML = links;
}

function updateNavigationState(route) {
  $$('[data-nav-route]').forEach(link => {
    if (navRouteActive(link.dataset.navRoute, route)) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function setRouteMeta(key) {
  const meta = ROUTE_META[key] || ['ProtecT', 'Workspace'];
  $('#route-eyebrow').textContent = meta[0];
  $('#route-title').textContent = meta[1];
  document.title = `${meta[1]} â€” ProtecT`;
}

function routeTarget(route) {
  if (route.startsWith('/personnel/journal/')) return { view: 'journal', meta: '/personnel/journal', load: () => loadJournalRoute(route.split('/')[3] || 'write') };
  if (route === '/personnel/home') return { view: 'personnel-home', meta: route, load: loadPersonnelHome };
  if (route === '/personnel/assessments') return { view: 'assessments', meta: route, load: renderAssessments };
  if (route === '/personnel/insights') return { view: 'personnel-insights', meta: route, load: loadPersonnelInsights };
  if (route === '/personnel/work-context') return { view: 'work-context', meta: route, load: loadWorkContext };
  if (route === '/personnel/privacy-support') return { view: 'privacy-support', meta: route, load: loadPrivacySupport };
  if (/^\/welfare\/cases\/\d+$/.test(route)) return { view: 'welfare-case', meta: '/welfare/case', load: () => loadWelfareCase(Number(route.split('/').pop())) };
  if (route === '/welfare/overview') return { view: 'welfare-overview', meta: route, load: loadWelfareOverview };
  if (route === '/welfare/cases') return { view: 'welfare-cases', meta: route, load: loadWelfareCases };
  if (route === '/welfare/followups') return { view: 'welfare-followups', meta: route, load: loadWelfareFollowups };
  if (route === '/welfare/record-reviews') return { view: 'record-reviews', meta: route, load: loadRecordReviews };
  if (route === '/welfare/insights') return { view: 'welfare-insights', meta: route, load: loadWelfareInsights };
  if (route === '/commander/overview') return { view: 'commander-overview', meta: route, load: loadCommanderOverview };
  if (route === '/commander/units') return { view: 'commander-units', meta: route, load: loadCommanderUnits };
  if (route === '/commander/early-indicators') return { view: 'commander-indicators', meta: route, load: loadCommanderIndicators };
  if (route === '/commander/actions') return { view: 'commander-actions', meta: route, load: loadCommanderActions };
  if (route === '/commander/trends') return { view: 'commander-trends', meta: route, load: loadCommanderTrends };
  return null;
}

async function renderRoute() {
  if (!me) return;
  let route = hashRoute();
  if (!routeBelongsToRole(route, me.role) || !routeTarget(route)) {
    window.location.replace(`#${defaultRoute(me.role)}`);
    return;
  }
  const target = routeTarget(route);
  const leavingJournal = currentRoute.startsWith('/personnel/journal/') && !route.startsWith('/personnel/journal/');
  if (leavingJournal && jrDirty) await saveJournal(false);
  if (leavingJournal && jrListening) jrStopMic();
  currentRoute = route;
  $$('.view').forEach(view => view.classList.add('hidden'));
  $(`#view-${target.view}`).classList.remove('hidden');
  setRouteMeta(target.meta);
  updateNavigationState(route);
  $('#mobile-nav').classList.add('hidden');
  $('#mobile-menu').setAttribute('aria-expanded', 'false');
  try { await target.load(); }
  catch (error) {
    const container = $(`#view-${target.view} > div`);
    if (container) container.innerHTML = errorMarkup(error.message, route);
    else toast(error.message);
  }
  if (!route.startsWith('/personnel/journal/')) $('#main-content').focus({ preventScroll: true });
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function boot() {
  sessionEnding = false;
  document.body.dataset.role = me.role;
  $('#login-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#who').textContent = `${me.name} Â· ${titleCase(me.role)}`;
  const role = ROLE_META[me.role] || ROLE_META.personnel;
  $('#role-label').textContent = role.label;
  $('#sidebar-promise').textContent = role.promise;
  renderNavigation();
  if (!routeBelongsToRole(hashRoute(), me.role) || !routeTarget(hashRoute())) window.location.replace(`#${defaultRoute(me.role)}`);
  else renderRoute();
}

window.addEventListener('hashchange', renderRoute);
$('#mobile-menu').addEventListener('click', () => {
  const nav = $('#mobile-nav');
  const willOpen = nav.classList.contains('hidden');
  nav.classList.toggle('hidden', !willOpen);
  $('#mobile-menu').setAttribute('aria-expanded', String(willOpen));
});
$('#logout').addEventListener('click', async () => {
  sessionEnding = true;
  try { await api('/api/logout', { method: 'POST', silentAuth: true }); } finally { window.location.hash = ''; window.location.reload(); }
});

document.addEventListener('click', event => {
  const routeButton = event.target.closest('[data-route]');
  if (routeButton) window.location.hash = routeButton.dataset.route;
  const retry = event.target.closest('[data-retry]');
  if (retry) {
    if (retry.dataset.retry.startsWith('/')) window.location.hash = retry.dataset.retry;
    renderRoute();
  }
});

/* Personnel workspace */
let personnelHomeData = null;
let progressDays = 30;

function summaryValue(summary, suffix = '') {
  return summary && summary.current != null ? `${summary.current}${suffix}` : 'â€”';
}

async function loadPersonnelHome() {
  const container = $('#personnel-home-content');
  container.innerHTML = loadingMarkup(5);
  const data = await api('/api/personnel/home');
  personnelHomeData = data;
  const profile = asObject(data.profile), week = asObject(data.week), summaries = asObject(week.summaries);
  const firstName = String(profile.name || me.name || 'there').split(/\s+/)[0];
  const journal = asArray(data.journal_preview);
  const support = asObject(data.support);
  const stressSeries = asArray(week.series).map(row => row.stress);
  const sleepSeries = asArray(week.series).map(row => row.sleep_hours);
  const energySeries = asArray(week.series).map(row => row.energy);
  const current = asObject(data.today_checkin);
  container.innerHTML = `
    <div class="page-heading"><div><p class="eyebrow">${greeting()}, ${esc(firstName)}</p><h1 id="personnel-home-title">Your private wellbeing space</h1><p>A calm place to reflect, notice patterns, and choose support on your terms.</p></div><span class="privacy-chip">â–£ Private by default</span></div>
    <section class="private-hero">
      <div><p class="eyebrow">Start where you are</p><h2>Whatâ€™s on your mind?</h2><p>Speak or write in Hindi, English, or Hinglish. Your journal stays outside Welfare, Command, and prediction.</p></div>
      <div class="private-actions"><button class="button primary" type="button" data-route="/personnel/journal/write" data-start-speaking="true">â— Speak privately</button><button class="button quiet" type="button" data-route="/personnel/journal/write">âœŽ Write privately</button></div>
    </section>
    <div class="home-grid">
      <section class="surface checkin-card"><div class="card-heading"><div><p class="eyebrow">30-second check-in</p><h2>How are you today?</h2></div><span class="subtle-note">Optional Â· personal</span></div>
        <form id="quick-checkin" class="checkin-grid">
          <label>Mood<select name="mood"><option value="good" ${current.mood==='good'?'selected':''}>Good</option><option value="okay" ${current.mood==='okay'?'selected':''}>Okay</option><option value="tired" ${current.mood==='tired'?'selected':''}>Tired</option><option value="stressed" ${current.mood==='stressed'?'selected':''}>Stressed</option><option value="low" ${current.mood==='low'?'selected':''}>Low</option><option value="motivated" ${current.mood==='motivated'?'selected':''}>Motivated</option></select></label>
          <label>Stress <span id="quick-stress-value">${esc(current.stress || 5)}/10</span><input name="stress" id="quick-stress" type="range" min="1" max="10" value="${esc(current.stress || 5)}"></label>
          <label>Sleep<input name="sleep_hours" type="number" min="0" max="14" step="0.5" value="${esc(current.sleep_hours ?? 7)}"><span class="subtle-note">hours last night</span></label>
          <label>Energy<select name="energy"><option value="1">Very low</option><option value="2">Low</option><option value="3" ${!current.energy||current.energy===3?'selected':''}>Okay</option><option value="4" ${current.energy===4?'selected':''}>Good</option><option value="5" ${current.energy===5?'selected':''}>High</option></select></label>
          <button class="button primary" type="submit">${data.today_checkin ? 'Update check-in' : 'Save check-in'}</button>
        </form>
      </section>
      <section class="surface insight-card"><div class="card-heading"><div><p class="eyebrow">Something worth noticing</p><h2>A personal pattern</h2></div><span class="association-label">Observed pattern</span></div><p class="insight-lead">${esc(data.insight?.text)}</p><details class="explanation"><summary>Why am I seeing this?</summary><p>${esc(data.insight?.disclaimer)}</p><ul class="basis-list">${asArray(data.insight?.basis).map(item => `<li>${esc(item)}</li>`).join('')}</ul></details></section>
    </div>
    <section class="surface section-block"><div class="card-heading"><div><p class="eyebrow">Your week</p><h2>A small view of what you reported</h2></div><button class="text-button" type="button" data-route="/personnel/journal/progress">See Progress â†’</button></div>
      <div class="week-grid">
        <div class="trend-tile"><span>Mood</span><strong>${esc(titleCase(summaries.mood?.current || 'No check-in'))}</strong><small>${esc(summaries.mood?.most_common ? `Mostly ${summaries.mood.most_common}` : 'Building your baseline')}</small></div>
        <div class="trend-tile"><span>Stress</span><strong>${summaryValue(summaries.stress, '/10')}</strong><small>${esc(summaries.stress?.direction || 'Building your baseline')}</small>${sparkline(stressSeries,'Stress',summaries.stress?.direction)}</div>
        <div class="trend-tile"><span>Sleep</span><strong>${summaryValue(summaries.sleep, 'h')}</strong><small>${esc(summaries.sleep?.direction || 'Building your baseline')}</small>${sparkline(sleepSeries,'Sleep',summaries.sleep?.direction)}</div>
        <div class="trend-tile"><span>Energy</span><strong>${summaryValue(summaries.energy, '/5')}</strong><small>${esc(summaries.energy?.direction || 'Building your baseline')}</small>${sparkline(energySeries,'Energy',summaries.energy?.direction)}</div>
      </div>
    </section>
    <div class="grid-3">
      <section class="surface section-block"><div class="card-heading"><div><p class="eyebrow">Recent reflection</p><h2>Your Journal</h2></div></div>${journal.length ? `<div class="preview-list">${journal.map(entry => `<button class="preview-item" type="button" data-journal-date="${esc(entry.date)}"><span class="preview-icon">${entry.words > 0 ? 'âœŽ' : 'â—‹'}</span><span><strong>${formatDate(entry.date)}</strong><small>${esc(entry.preview || `${entry.words} words`)}</small></span></button>`).join('')}</div>` : emptyMarkup('No journal entries yet','Start with a one-minute reflection.')}<button class="text-button" type="button" data-route="/personnel/journal/write">Continue Journal â†’</button></section>
      <section class="surface section-block home-action-card"><div class="card-heading"><div><p class="eyebrow">Weekly wellbeing check</p><h2>WHO-5</h2></div><span class="subtle-note">About 1 minute</span></div><p>${data.assessment?.latest_who5 ? `Last result: ${esc(data.assessment.latest_who5.display_score)}/100 on ${formatDate(data.assessment.latest_who5.date)}.` : 'Five gentle questions about the last two weeks.'}</p><button class="button" type="button" data-start-asmt-home="WHO5">Start â†’</button></section>
      <section class="surface section-block"><div class="card-heading"><div><p class="eyebrow">Work Context</p><h2>${esc(data.work_preview?.overtime_hours ?? 0)}h overtime</h2></div><span class="subtle-note">Last ${esc(data.work_preview?.window_days || 90)} days</span></div><p>See the official records used to explain workload conditions and correct anything inaccurate.</p><button class="text-button" type="button" data-route="/personnel/work-context">See Work Context â†’</button></section>
    </div>
    <section class="support-preview"><div><p class="eyebrow">Need support?</p><h2>${support.active ? `Support request Â· ${esc(support.status)}` : 'Explore confidential support options'}</h2><p>${support.active ? esc(support.next_action || 'Your Welfare officer will update the case here.') : 'You decide what, if anything, to share. Your Journal stays locked.'}</p></div><button class="button quiet" type="button" data-route="/personnel/privacy-support">${support.active ? 'View status' : 'Explore options'} â†’</button></section>`;
  $('#quick-stress').addEventListener('input', event => { $('#quick-stress-value').textContent = `${event.target.value}/10`; });
  $('#quick-checkin').addEventListener('submit', submitQuickCheckin);
}

async function submitQuickCheckin(event) {
  event.preventDefault();
  const form = event.currentTarget, button = form.querySelector('button[type=submit]');
  const values = new FormData(form);
  button.disabled = true; button.textContent = 'Savingâ€¦';
  try {
    await api('/api/checkin', { method: 'POST', body: JSON.stringify({ mood: values.get('mood'), stress: Number(values.get('stress')), sleep_hours: Number(values.get('sleep_hours')), energy: Number(values.get('energy')) }) });
    toast('Check-in saved. Your personal trends are updated.');
    await loadPersonnelHome();
  } catch (error) { toast(error.message); button.disabled = false; button.textContent = 'Try again'; }
}

function progressSummaryMarkup(data) {
  const summaries = asObject(data.summaries), series = asArray(data.series);
  const cards = [
    ['Stress', summaryValue(summaries.stress, '/10'), summaries.stress?.direction, series.map(x=>x.stress), true],
    ['Sleep', summaryValue(summaries.sleep, 'h'), summaries.sleep?.direction, series.map(x=>x.sleep_hours), false],
    ['Energy', summaryValue(summaries.energy, '/5'), summaries.energy?.direction, series.map(x=>x.energy), false],
    ['Journal entries', data.journal?.entries ?? 0, `${Number(data.journal?.total_words||0).toLocaleString()} words`, [], false]
  ];
  return `<div class="metric-grid">${cards.map(([label,value,detail,values]) => `<div class="metric-card"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(detail || 'Building your baseline')}</small>${values.length?sparkline(values,label,detail):''}</div>`).join('')}</div>`;
}

async function loadPersonnelInsights() {
  const container = $('#personnel-insights-content'); container.innerHTML = loadingMarkup(4);
  const data = await api('/api/personnel/progress?days=30');
  container.innerHTML = `<div class="page-heading"><div><p class="eyebrow">Personal patterns</p><h1 id="personnel-insights-title">Insights that stay with you</h1><p>Connections across your voluntary check-ins, assessments, reflection activity, and your own Work Context.</p></div><span class="privacy-chip">â–£ Only you</span></div>
    ${progressSummaryMarkup(data)}
    <div class="grid-2">
      <section class="surface section-block"><div class="card-heading"><div><p class="eyebrow">Recurring themes</p><h2>What has occupied your writing?</h2></div><span class="experimental-label">Experimental</span></div>${renderTagList(asArray(data.journal?.recurring_themes).map(item => `${item.label} Â· ${item.count}`),'Write a few reflections to build a theme view.')}<p class="source-note">Private keyword counts; context can be missed. Not a clinical interpretation.</p><button class="text-button" type="button" data-route="/personnel/journal/insights">Open Daily Insights â†’</button></section>
      <section class="surface relationship-card"><p class="eyebrow">Work relationship</p><h2>Something worth noticing</h2><p class="insight-lead">${esc(data.work_relationship?.text)}</p><span class="association-label">${esc(data.work_relationship?.disclaimer)}</span><p class="source-note">Based on ${esc(data.work_relationship?.basis?.overtime_days || 0)} overtime day(s) and ${esc(data.work_relationship?.basis?.comparison_days || 0)} comparison day(s).</p></section>
    </div>`;
}

async function loadWorkContext() {
  const container = $('#work-context-content'); container.innerHTML = loadingMarkup(5);
  const data = await api('/api/personnel/work-context'), m = asObject(data.metrics);
  const records = asArray(data.records), corrections = asArray(data.corrections);
  container.innerHTML = `<div class="page-heading"><div><p class="eyebrow">Official organizational information</p><h1 id="work-context-title">Your Work Context</h1><p>See where these records came from, why they are used, and ask for a correction.</p></div><span class="subtle-note">Updated ${formatDate(data.last_updated)}</span></div>
    <section class="notice-card"><strong>Where did this come from?</strong><p>${esc(data.source)}</p><strong>Why is ProtecT using it?</strong><p>${esc(data.why)}</p></section>
    <div class="metric-grid">${metricCard('Overtime',`${m.overtime_hours||0}h`,`${m.window_days||90} days`)}${metricCard('Deployments',m.deployment_starts||0,'recorded starts')}${metricCard('Leave pressure',m.leave_denials||0,'denied requests')}${metricCard('Recovery',m.recovery_events||0,'recorded opportunities')}${metricCard('Incidents',m.incident_exposures||0,'recorded exposures')}${metricCard('Transfers',m.transfers||0,'recorded moves')}</div>
    <div class="grid-2">
      <section class="surface section-block"><div class="card-heading"><div><p class="eyebrow">Official records</p><h2>Recent activity</h2></div></div>${records.length ? `<div class="preview-list">${records.map(row=>`<div class="record-item"><time>${formatDate(row.date)}</time><div><strong>${esc(titleCase(row.type))}</strong><p>${row.value?`${esc(row.value)}${row.type==='duty_overtime'?' hours':''}`:''}${row.note?` Â· ${esc(row.note)}`:''}</p></div></div>`).join('')}</div>` : emptyMarkup('No recent work records','Nothing has been recorded in this period.')}</section>
      <section class="surface section-block"><div class="card-heading"><div><p class="eyebrow">Data control</p><h2>Report an incorrect record</h2></div></div><p>Requests are tracked separately from Welfare support cases.</p><form id="record-correction"><label>Record type<select name="category"><option value="workload">Duty workload</option><option value="leave">Leave record</option><option value="deployment">Deployment record</option><option value="profile">Profile information</option><option value="other">Other</option></select></label><label>What should be checked?<textarea name="message" minlength="10" maxlength="1000" required></textarea></label><button class="button" type="submit">Submit review request</button></form><div class="preview-list">${corrections.map(row=>`<div class="history-row"><div><strong>${esc(titleCase(row.category))}</strong><small>${esc(row.message)}</small></div>${statusChip(row.status)}</div>`).join('')}</div></section>
    </div>`;
  $('#record-correction').addEventListener('submit', async event => {
    event.preventDefault(); const form=event.currentTarget, fd=new FormData(form), button=form.querySelector('button'); button.disabled=true;
    try { await api('/api/my-data/correction',{method:'POST',body:JSON.stringify({category:fd.get('category'),message:fd.get('message')})}); toast('Record review request submitted.'); await loadWorkContext(); }
    catch(error){toast(error.message);button.disabled=false;}
  });
}

function accessLabel(action) {
  const labels={view_support_case:'Welfare Officer viewed a support case',support_case_opened:'Support request shared by you',support_sharing_withdrawn:'Optional case sharing withdrawn',consent_aggregate_on:'Anonymous aggregate contribution enabled',consent_aggregate_off:'Anonymous aggregate contribution disabled',request_data_correction:'Record review requested',update_support_case:'Welfare Officer updated a support case'};
  return labels[action] || titleCase(action);
}

async function loadPrivacySupport() {
  const container=$('#privacy-support-content');container.innerHTML=loadingMarkup(5);
  const [privacy,support]=await Promise.all([api('/api/my-privacy'),api('/api/my-support')]);
  const cases=asArray(support.cases), active=cases.find(item=>item.status!=='Resolved');
  const classes=[['Private Journal','Journal text, voice-approved transcripts, Daily Insights and Progress writing analytics','Only you'],['Voluntary Wellbeing','Mood, stress, sleep, energy and assessments','Private by default'],['Organizational / Work','Duty, overtime, leave, deployment, recovery and incidents','Role-minimized'],['Support Case','Source, selected context, timeline, notes and follow-up','You + assigned Welfare officer']];
  const matrix=asObject(privacy.matrix);
  container.innerHTML=`<div class="page-heading"><div><p class="eyebrow">Your control</p><h1 id="privacy-support-title">Privacy & Support</h1><p>Understand every boundary, manage consent, and request support without opening your private Journal.</p></div><span class="privacy-chip">â–£ Minimum necessary access</span></div>
    <section class="privacy-class-grid">${classes.map(([title,detail,visibility])=>`<article class="privacy-class"><span>${esc(visibility)}</span><h2>${esc(title)}</h2><p>${esc(detail)}</p></article>`).join('')}</section>
    <section class="surface section-block"><div class="card-heading"><div><p class="eyebrow">Who can see what?</p><h2>Visibility by role</h2></div></div><div class="visibility-grid"><div class="visibility-row header"><b>Data</b><b>Personnel</b><b>Welfare</b><b>Commander</b></div>${Object.entries(matrix).map(([key,row])=>`<div class="visibility-row"><strong>${esc(titleCase(key))}</strong><span>${esc(row.personnel)}</span><span>${esc(row.welfare)}</span><span>${esc(row.commander)}</span></div>`).join('')}</div></section>
    <section class="surface toggle-row"><div><p class="eyebrow">Anonymous aggregate contribution</p><h2>Help improve unit conditions</h2><p>When on, voluntary check-ins may contribute only to a unit aggregate with at least five consenting responses. Command never receives your individual record.</p></div><label class="toggle"><input id="aggregate-consent" type="checkbox" ${privacy.aggregate_consent?'checked':''}><span aria-hidden="true"></span><b>${privacy.aggregate_consent?'On':'Off'}</b></label></section>
    <div class="grid-2">
      <section class="surface section-block"><div class="card-heading"><div><p class="eyebrow">Confidential support</p><h2>${active?`Support request Â· ${esc(active.status)}`:'Request Welfare support'}</h2></div>${active?statusChip(active.status):''}</div>
        ${active?`<div class="info-grid"><div class="info-pair"><span>Case</span><strong>CASE #${esc(active.id)}</strong></div><div class="info-pair"><span>Next action</span><strong>${esc(active.next_action||'Awaiting update')}</strong></div><div class="info-pair"><span>Follow-up</span><strong>${formatDate(active.follow_up_due)}</strong></div></div>${renderTagList(active.shared_fields,'No optional wellbeing fields shared')}<div class="locked-callout"><strong>â–£ PRIVATE JOURNAL â€” LOCKED</strong><p>Not shared with Welfare or Command.</p></div>${active.shared_fields?.length?`<button class="text-button" id="withdraw-sharing" data-case-id="${active.id}" type="button">Withdraw optional shared context</button>`:''}`:`<form id="support-request"><label>What kind of support would help?<select name="reason"><option value="work_pressure">Work pressure</option><option value="personal_difficulty">Personal difficulty</option><option value="family">Family</option><option value="health">Health</option><option value="post_incident">Post-incident support</option><option value="other">Other</option></select></label><label>Anything you want to add? <span class="muted">Optional</span><textarea name="details" maxlength="2000"></textarea></label><fieldset class="share-options"><legend>What would you like Welfare to see?</legend>${[['stress_trend','Stress trend',true],['sleep_trend','Sleep trend',true],['who5','WHO-5 result',true],['assessment_history','Assessment history',true],['work_context','Work-context summary',true]].map(([key,label,checked])=>`<label class="check-row"><input type="checkbox" name="${key}" ${checked?'checked':''}><span><strong>${label}</strong><small>You can leave this unselected.</small></span></label>`).join('')}</fieldset><div class="locked-callout"><strong>â–£ PRIVATE JOURNAL â€” LOCKED</strong><p>Journal entries, transcripts and Journal analytics cannot be included.</p></div><button class="button primary" type="submit">Send support request</button></form>`}
      </section>
      <section class="surface section-block"><div class="card-heading"><div><p class="eyebrow">Data access</p><h2>Recent activity</h2></div><span class="subtle-note">Private Journal: no external access</span></div>${asArray(privacy.accesses).length?`<div class="preview-list">${asArray(privacy.accesses).map(row=>`<div class="history-row"><div><strong>${esc(accessLabel(row.action))}</strong><small>${esc(row.actor)} Â· ${formatDateTime(row.at)}</small></div><span>${esc(titleCase(row.role))}</span></div>`).join('')}</div>`:emptyMarkup('No external case access recorded','Your private Journal is never part of this log because no other role can open it.')}</section>
    </div>`;
  $('#aggregate-consent').addEventListener('change',async event=>{const input=event.currentTarget;input.disabled=true;try{await api('/api/my-consent',{method:'POST',body:JSON.stringify({aggregate_consent:input.checked})});toast(`Anonymous aggregate contribution ${input.checked?'enabled':'disabled'}.`);await loadPrivacySupport();}catch(error){toast(error.message);input.disabled=false;}});
  if($('#support-request')) $('#support-request').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,fd=new FormData(form),button=form.querySelector('button[type=submit]');const shared_context={};['stress_trend','sleep_trend','who5','assessment_history','work_context'].forEach(key=>shared_context[key]=fd.has(key));button.disabled=true;button.textContent='Sendingâ€¦';try{const result=await api('/api/support/request',{method:'POST',body:JSON.stringify({reason:fd.get('reason'),details:fd.get('details'),shared_context})});toast(`Support request received as CASE #${result.case_id}.`);await loadPrivacySupport();}catch(error){toast(error.message);button.disabled=false;button.textContent='Send support request';}});
  if($('#withdraw-sharing')) $('#withdraw-sharing').addEventListener('click',async event=>{const id=event.currentTarget.dataset.caseId;const note=await askNote({title:'Withdraw optional shared context?',help:'The case stays open, but Welfare will no longer receive the optional snapshot you selected.',label:'Type WITHDRAW to continue',confirm:'Withdraw',required:true});if(note===null)return;try{await api(`/api/support/${id}/withdraw-sharing`,{method:'POST',body:'{}'});toast('Optional shared context withdrawn.');await loadPrivacySupport();}catch(error){toast(error.message);}});
}

/* Assessments */
const ASSESSMENTS={
  WHO5:{name:'WHO-5 Well-Being Index',short:'Wellbeing check',icon:'â˜€',period:'Over the last two weeks, how oftenâ€¦',questions:['I have felt cheerful and in good spirits.','I have felt calm and relaxed.','I have felt active and vigorous.','I woke up feeling fresh and rested.','My daily life has been filled with things that interest me.'],options:[[5,'All of the time'],[4,'Most of the time'],[3,'More than half of the time'],[2,'Less than half of the time'],[1,'Some of the time'],[0,'At no time']],source:'World Health Organization Â· WHO-5',sourceUrl:'https://www.who.int/publications/m/item/WHO-UCN-MSD-MHE-2024.01'},
  PSS10:{name:'Perceived Stress Scale (PSS-10)',short:'Stress check',icon:'â—’',period:'In the last month, how often have youâ€¦',questions:['been upset because of something unexpected?','felt unable to control important things?','felt nervous and stressed?','felt confident handling personal problems?','felt that things were going your way?','felt unable to cope with everything you had to do?','been able to control irritations?','felt on top of things?','been angered by things outside your control?','felt difficulties were piling too high?'],options:[[0,'Never'],[1,'Almost never'],[2,'Sometimes'],[3,'Fairly often'],[4,'Very often']],source:'Cohen, Kamarck & Mermelstein Â· PSS-10',sourceUrl:'https://www.cmu.edu/dietrich/psychology/stress-immunity-disease-lab/scales/index.html'},
  GAD7:{name:'Generalized Anxiety Disorder (GAD-7)',short:'Anxiety check',icon:'â‰ˆ',period:'Over the last two weeks, how often have you been bothered byâ€¦',questions:['Feeling nervous, anxious, or on edge.','Not being able to stop or control worrying.','Worrying too much about different things.','Trouble relaxing.','Being so restless it is hard to sit still.','Becoming easily annoyed or irritable.','Feeling afraid, as if something awful might happen.'],options:[[0,'Not at all'],[1,'Several days'],[2,'More than half the days'],[3,'Nearly every day']],source:'Spitzer et al. Â· GAD-7',sourceUrl:'https://www.phqscreeners.com/select-screener'},
  PHQ9:{name:'Patient Health Questionnaire (PHQ-9)',short:'Mood check',icon:'â—‹',period:'Over the last two weeks, how often have you been bothered byâ€¦',questions:['Little interest or pleasure in doing things.','Feeling down, depressed, or hopeless.','Trouble falling or staying asleep, or sleeping too much.','Feeling tired or having little energy.','Poor appetite or overeating.','Feeling bad about yourself.','Trouble concentrating.','Moving or speaking slowly, or being unusually restless.','Thoughts that you would be better off dead, or of hurting yourself.'],options:[[0,'Not at all'],[1,'Several days'],[2,'More than half the days'],[3,'Nearly every day']],source:'Kroenke, Spitzer & Williams Â· PHQ-9',sourceUrl:'https://www.phqscreeners.com/select-screener'}
};
const ASSESSMENT_LIBRARY=[['WHO5','Wellbeing','A gentle overview of current wellbeing.','5 questions Â· 1 min'],['PSS10','Stress','How unpredictable or overloaded life has felt.','10 questions Â· 3 min'],['GAD7','Anxiety','Patterns of worry, tension, restlessness and fear.','7 questions Â· 2 min'],['PHQ9','Mood','Changes in mood, interest, sleep, energy and concentration.','9 questions Â· 3 min']];
let activeAssessment=null,assessmentIndex=0,assessmentAnswers=[],assessmentHistory=[];

async function renderAssessments(){
  const data=await api('/api/personnel/assessments');assessmentHistory=asArray(data.history);assessmentHome();
  const who=assessmentHistory.find(row=>row.type==='WHO5');$('#who-last').textContent=who?`Last completed ${formatDate(who.date)} Â· ${who.display_score}/100`:'A gentle place to begin';
  $('#asmt-grid').innerHTML=ASSESSMENT_LIBRARY.map(([id,label,desc,meta])=>{const s=ASSESSMENTS[id],mine=assessmentHistory.find(row=>row.type===id);return `<article class="assessment-card"><div class="card-heading"><span class="preview-icon">${s.icon}</span><span class="subtle-note">${esc(label)}</span></div><h2>${esc(s.name)}</h2><p>${esc(desc)}</p><div class="form-actions split"><span class="subtle-note">${esc(meta)}${mine?` Â· Last ${formatDate(mine.date)}`:''}</span><button class="text-button" type="button" data-start-asmt="${id}">Start â†’</button></div></article>`;}).join('');
  $('#asmt-history').innerHTML=assessmentHistory.length?`<div class="assessment-history">${assessmentHistory.slice(0,12).map(row=>`<div class="history-row"><div><strong>${esc(row.label||ASSESSMENTS[row.type]?.name||row.type)}</strong><small>${formatDate(row.date)} Â· ${esc(row.level||'Saved result')}</small></div><span class="score-value">${esc(row.display_score)}/${esc(row.max_score)}</span></div>`).join('')}</div>`:emptyMarkup('No assessment history','Complete your first wellbeing check.');
  $$('[data-start-asmt]').forEach(button=>button.onclick=()=>startAssessment(button.dataset.startAsmt));
  const pendingAssessment=sessionStorage.getItem('sentinel-start-assessment');
  if(pendingAssessment){sessionStorage.removeItem('sentinel-start-assessment');startAssessment(pendingAssessment);}
}
function startAssessment(id){activeAssessment=id;assessmentIndex=0;assessmentAnswers=Array(ASSESSMENTS[id].questions.length).fill(null);$('#asmt-home').classList.add('hidden');$('#asmt-result').classList.add('hidden');$('#asmt-runner').classList.remove('hidden');renderAssessmentQuestion();window.scrollTo({top:0});}
function renderAssessmentQuestion(){const a=ASSESSMENTS[activeAssessment],answer=assessmentAnswers[assessmentIndex],total=a.questions.length;$('#asmt-kind').textContent=a.short;$('#asmt-title').textContent=a.name;$('#asmt-step').textContent=`${assessmentIndex+1} of ${total}`;$('#asmt-progress-bar').style.width=`${(assessmentIndex+1)/total*100}%`;$('#asmt-period').textContent=a.period;$('#asmt-question').textContent=a.questions[assessmentIndex];$('#asmt-attribution').innerHTML=`Source: <a href="${a.sourceUrl}" target="_blank" rel="noopener">${esc(a.source)}</a>`;$('#asmt-options').innerHTML=a.options.map(([value,label])=>`<button class="assessment-option ${answer===value?'selected':''}" type="button" data-value="${value}" aria-pressed="${answer===value}"><span class="option-marker">${answer===value?'âœ“':''}</span><span>${esc(label)}</span></button>`).join('');$$('#asmt-options .assessment-option').forEach(button=>button.onclick=()=>{assessmentAnswers[assessmentIndex]=Number(button.dataset.value);renderAssessmentQuestion();});$('#asmt-prev').disabled=assessmentIndex===0;$('#asmt-next').disabled=answer===null;$('#asmt-next').textContent=assessmentIndex===total-1?'See my result â†’':'Next â†’';}
function assessmentHome(){$('#asmt-runner').classList.add('hidden');$('#asmt-result').classList.add('hidden');$('#asmt-home').classList.remove('hidden');}
$('#asmt-exit').onclick=assessmentHome;$('#asmt-prev').onclick=()=>{if(assessmentIndex>0){assessmentIndex--;renderAssessmentQuestion();}};
$('#asmt-next').onclick=async()=>{if(assessmentAnswers[assessmentIndex]===null)return;if(assessmentIndex<ASSESSMENTS[activeAssessment].questions.length-1){assessmentIndex++;renderAssessmentQuestion();return;}const button=$('#asmt-next');button.disabled=true;button.textContent='Savingâ€¦';try{const result=await api('/api/assessment',{method:'POST',body:JSON.stringify({type:activeAssessment,answers:assessmentAnswers})});showAssessmentResult(result);}catch(error){toast(error.message);renderAssessmentQuestion();}};
function showAssessmentResult(result){const a=ASSESSMENTS[result.type],max={WHO5:100,PSS10:40,GAD7:21,PHQ9:27}[result.type];$('#asmt-runner').classList.add('hidden');$('#asmt-result').classList.remove('hidden');$('#asmt-result').innerHTML=`<article class="assessment-result-card ${result.urgent?'urgent':''}"><p class="eyebrow">Assessment complete</p><h1>${esc(result.level)}</h1><p class="insight-lead">${esc(result.guidance)}</p><div class="score-panel"><div class="score-value"><strong>${esc(result.display_score)}</strong><span>out of ${max}</span></div></div>${result.urgent?`<div class="urgent-box"><strong>Get immediate support</strong><p>Call emergency services (112), Tele-MANAS at 14416, or KIRAN at 1800-599-0019. If possible, stay with someone you trust.</p></div>`:''}<div class="result-explanations"><div><h2>What this may indicate</h2><p>${esc(result.guidance)}</p></div><div><h2>What this does not mean</h2><p>This screening result is not a diagnosis and does not define you. A qualified professional can interpret it with your circumstances.</p></div></div><div class="form-actions"><button class="button" type="button" data-route="/personnel/journal/write">Journal</button><button class="button" id="assessment-done" type="button">Repeat later</button><button class="button" type="button" data-route="/personnel/journal/progress">View Progress</button><button class="button primary" type="button" data-route="/personnel/privacy-support">Support options</button></div></article>`;$('#assessment-done').onclick=()=>{assessmentHome();renderAssessments();};window.scrollTo({top:0});}

document.addEventListener('click',event=>{const start=event.target.closest('[data-start-asmt-home]');if(start){sessionStorage.setItem('sentinel-start-assessment',start.dataset.startAsmtHome);window.location.hash='/personnel/assessments';}const speak=event.target.closest('[data-start-speaking]');if(speak)sessionStorage.setItem('sentinel-start-voice','1');const dated=event.target.closest('[data-journal-date]');if(dated){sessionStorage.setItem('sentinel-journal-date',dated.dataset.journalDate);window.location.hash='/personnel/journal/write';}});

/* Protected private Journal */
const JOURNAL_GOAL=150,JOURNAL_BLUE=100;
let jrDate=localDateKey(),jrBaseSeconds=0,jrStartedAt='',jrStartedTick=0,jrDirty=false,jrSaveTimer=null,jrTimeline=[];
let jrActivePane='write',jrLastAnalysis=null,jrLastStats=null,jrListening=false,jrVoiceSession=0;
const SpeechRecognition=window.SpeechRecognition||window.webkitSpeechRecognition;
const journalDraftKey=date=>`sentinel-journal-draft:${me?.id||'self'}:${date}`;
const journalWordCount=text=>{const value=String(text||'').trim();return value?value.split(/\s+/).length:0;};

function journalElapsed(){return Math.round(jrBaseSeconds+(jrStartedTick?(Date.now()-jrStartedTick)/1000:0));}
function updateJournalCounters(){const words=journalWordCount($('#jr-editor').value),pct=Math.min(100,words/JOURNAL_GOAL*100);$('#jr-bar').style.width=`${pct}%`;$('#jr-count').textContent=`${words.toLocaleString()} word${words===1?'':'s'}${words>=JOURNAL_GOAL?' Â· enough for today':''}`;$('#jr-meta').textContent=`${Math.max(0,Math.round(journalElapsed()/60))} min with this reflection`;if(!jrTimeline.length||Date.now()-jrTimeline[jrTimeline.length-1][0]*1000>25000)jrTimeline.push([journalElapsed(),words]);}
function saveJournalOnDevice(){localStorage.setItem(journalDraftKey(jrDate),JSON.stringify({content:$('#jr-editor').value,time_sec:journalElapsed(),timeline:jrTimeline,started_at:jrStartedAt,at:new Date().toISOString()}));$('#jr-save').textContent=navigator.onLine?'Saved on device Â· syncingâ€¦':'Saved on device Â· offline';}
async function saveJournal(showStatus=true){if(!$('#jr-editor'))return;const body={date:jrDate,content:$('#jr-editor').value,time_sec:journalElapsed(),timeline:jrTimeline,started_at:jrStartedAt};saveJournalOnDevice();try{const result=await api('/api/journal',{method:'POST',body:JSON.stringify(body)});jrDirty=false;jrBaseSeconds=body.time_sec;jrStartedTick=Date.now();localStorage.removeItem(journalDraftKey(jrDate));if(showStatus)$('#jr-save').textContent=`Synced Â· ${new Date(result.saved_at).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}`;return result;}catch(error){if(showStatus)$('#jr-save').textContent='Saved on device Â· sync pending';if(navigator.onLine&&showStatus)toast('Journal saved on this device; sync will retry.');return null;}}
async function openJournalDate(date){if(jrDirty)await saveJournal(false);jrDate=date;jrDirty=false;const payload=await api(`/api/journal/${date}`),entry=payload.entry;const local=parseMaybeJson(localStorage.getItem(journalDraftKey(date)));const localNewer=local&&(!entry||new Date(local.at)>new Date(entry.updated_at));const chosen=localNewer?local:entry;$('#jr-editor').value=chosen?.content||'';jrBaseSeconds=Number(chosen?.time_sec||0);jrTimeline=asArray(parseMaybeJson(chosen?.timeline));jrStartedAt=chosen?.started_at||new Date().toISOString();jrStartedTick=Date.now();$('#jr-entry-heading').textContent=date===localDateKey()?'Write privately':`Reflection Â· ${formatDate(date,{year:true})}`;$('#jr-today').classList.toggle('hidden',date===localDateKey());$('#jr-save').textContent=localNewer?'Recovered from this device':entry?'Synced':'Not saved yet';updateJournalCounters();await loadJournalHistory();}
async function loadJournalHistory(){const payload=await api('/api/journal/overview');const query=$('#jr-search').value.trim().toLowerCase();const days=asArray(payload.days).slice().reverse().filter(row=>!query||row.date.toLowerCase().includes(query));$('#jr-days').innerHTML=days.length?days.map(row=>`<button type="button" class="journal-day ${row.date===jrDate?'on':''}" data-open-journal="${esc(row.date)}"><span>${formatDate(row.date,{year:true})}</span><strong>${Number(row.words||0).toLocaleString()} words</strong></button>`).join(''):emptyMarkup('No matching reflections','Try another date or begin today.');$('#jr-totals').textContent=`${Number(payload.total_days||0)} reflections Â· ${Number(payload.total_words||0).toLocaleString()} words in your private archive`;}
async function loadJournalRoute(pane='write'){jrActivePane=['write','insights','progress'].includes(pane)?pane:'write';$$('.journal-tab').forEach(tab=>{const active=tab.dataset.jrPane===jrActivePane;tab.classList.toggle('on',active);tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;});$$('.journal-pane').forEach(panel=>panel.classList.add('hidden'));$(`#jr-pane-${jrActivePane}`).classList.remove('hidden');if(jrActivePane==='write'){const selected=sessionStorage.getItem('sentinel-journal-date')||jrDate||localDateKey();sessionStorage.removeItem('sentinel-journal-date');await openJournalDate(selected);if(sessionStorage.getItem('sentinel-start-voice')){sessionStorage.removeItem('sentinel-start-voice');startVoice();}}if(jrActivePane==='insights')await loadJournalInsights();if(jrActivePane==='progress')await loadJournalProgress(progressDays);}

$('#jr-editor').addEventListener('input',()=>{jrDirty=true;updateJournalCounters();saveJournalOnDevice();clearTimeout(jrSaveTimer);jrSaveTimer=setTimeout(()=>saveJournal(true),1300);});
$('#jr-search').addEventListener('input',()=>loadJournalHistory().catch(()=>{}));
$('#jr-today').addEventListener('click',()=>openJournalDate(localDateKey()).catch(error=>toast(error.message)));
document.addEventListener('click',event=>{const open=event.target.closest('[data-open-journal]');if(open)openJournalDate(open.dataset.openJournal).catch(error=>toast(error.message));const prompt=event.target.closest('[data-journal-prompt]');if(prompt){const editor=$('#jr-editor'),prefix=editor.value.trim()?`\n\n`:'';editor.value+=`${prefix}${prompt.dataset.journalPrompt}\n`;editor.focus();editor.dispatchEvent(new Event('input'));}});
$$('.journal-tab').forEach(tab=>tab.addEventListener('click',()=>{window.location.hash=`/personnel/journal/${tab.dataset.jrPane}`;}));
$('.journal-tabs').addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;const tabs=$$('.journal-tab'),index=tabs.indexOf(document.activeElement),next=(index+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[next].focus();tabs[next].click();});

/* On-device AI voice engine (free, offline, private) â€” chunked Whisper via a worker.
 * Primary path: real neural transcription on this device. Fallback: the browser
 * voice-typing feature; last resort: typed writing. Only approved text reaches
 * the journal; raw audio is transcribed in memory and never stored or uploaded. */
const VOICE_MODEL_ID = 'Xenova/whisper-base';
const VOICE_CHUNK_SECONDS = 6, VOICE_OVERLAP_SECONDS = 1.5;
const VOICE_ACCEPT_SECONDS = 2.2, VOICE_MAX_TEXT = 4000;
let jrVoiceMode = 'ai', jrVoiceWorker = null, jrVoiceWorkerReady = false, jrVoiceLoading = false, jrVoiceAiError = '';
let jrVoiceStream = null, jrVoiceCtx = null, jrVoiceSource = null, jrVoiceProc = null;
let jrVoicePcm = [], jrVoicePcmSeconds = 0, jrVoiceSampleRate = 16000, jrVoiceChunkId = 0;
let jrVoiceSessionText = '', jrVoiceRecent = [], jrVoicePending = new Map(), jrVoiceSilenceMs = 0;
let jrVoiceLevelTimer = 0, jrVoiceSeenAudio = false, jrRecognition = null;
function normalizeVoice(text){let value=String(text||'').trim().replace(/\b(\w+)(\s+\1\b)+/gi,'$1').replace(/\bi\b/g,'I').replace(/\s+([,.!?;:])/g,'$1').replace(/([,.!?;:])(?=[^\s\d])/g,'$1 ').replace(/\s{2,}/g,' ');if(value&&!/[.!?â€¦]$/.test(value))value+='.';return value.charAt(0).toUpperCase()+value.slice(1);}
function voiceOverlap(prev,next){const a=String(prev||'').trim().split(/\s+/).filter(Boolean),b=String(next||'').trim().split(/\s+/).filter(Boolean);if(!a.length||!b.length)return 0;const limit=Math.min(a.length,b.length,40);for(let size=limit;size>0;size--){let match=true;for(let i=0;i<size;i++){if(a[a.length-size+i].toLocaleLowerCase()!==b[i].toLocaleLowerCase()){match=false;break;}}if(match)return size;}return 0;}
function voiceMergeChunk(prevText,chunkText){const prev=String(prevText||'').trim(),chunk=String(chunkText||'').trim();if(!prev)return chunk;if(!chunk)return prev;const overlap=voiceOverlap(prev,chunk);if(overlap>0){const tail=chunk.split(/\s+/).slice(overlap).join(' ').trim();return tail?`${prev} ${tail}`:prev;}return `${prev} ${chunk}`;}
function voiceFingerprint(text){return String(text||'').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();}
function voiceNearDuplicate(candidate){const fp=voiceFingerprint(candidate);if(!fp)return true;const words=new Set(fp.split(' ').filter(Boolean));for(const item of jrVoiceRecent){const other=item.fp;if(!other)continue;if(other===fp||other.includes(fp)||fp.includes(other))return true;const otherWords=other.split(' ').filter(Boolean);if(words.size>=3&&otherWords.length>=3){const otherSet=new Set(otherWords);let shared=0;for(const word of words)if(otherSet.has(word))shared++;if(shared/Math.max(words.size,otherSet.size)>=0.8)return true;}}return false;}
function voiceWorkerUrl(){try{const script=document.currentScript&&document.currentScript.src;if(script)return new URL('voice-worker.js',script).href;}catch{}return 'voice-worker.js';}
function voiceEnsureWorker(){if(jrVoiceWorker)return jrVoiceWorker;let worker=null;try{worker=new Worker(voiceWorkerUrl());}catch(error){jrVoiceWorker=null;jrVoiceAiError=String((error&&error.message)||error||'worker blocked');voiceUseBrowserFallback('On-device AI unavailable in this browser. Using browser voice typing.');return null;}jrVoiceWorker=worker;jrVoiceWorker.onmessage=voiceOnWorkerMessage;jrVoiceWorker.onerror=event=>{jrVoiceAiError=String((event&&event.message)||'worker error');voiceUseBrowserFallback(`On-device AI failed to start (${jrVoiceAiError}). Using browser voice typing.`);};return jrVoiceWorker;}
function voiceOnWorkerMessage(event){const msg=event.data||{};if(msg.type==='diag'){if(msg.session!==jrVoiceSession)return;setVoiceUi(true,`Voice check: ${msg.runtime} Â· ${msg.threaded} Â· model file HTTP ${msg.encoder}`);return;}if(msg.type==='progress'){if(msg.session!==jrVoiceSession)return;const pct=typeof msg.progress==='number'&&msg.progress<=1?Math.round(msg.progress*100):(msg.loaded&&msg.total?Math.round(msg.loaded/msg.total*100):null);setVoiceUi(true,pct==null?`Loading private voice AIâ€¦ ${msg.file||''}`.trim():`Loading private voice AIâ€¦ ${pct}%`);return;}if(msg.type==='ready'){if(msg.session!==jrVoiceSession)return;jrVoiceWorkerReady=true;jrVoiceLoading=false;if(!jrListening)return;voiceBeginCapture();return;}if(msg.type==='transcript'){const pending=jrVoicePending.get(msg.id);jrVoicePending.delete(msg.id);if(!jrListening||!pending||pending.session!==jrVoiceSession)return;voiceHandleTranscript(pending.session,msg.text,pending.seconds);return;}if(msg.type==='error'&&msg.id==null){if(msg.session!==jrVoiceSession)return;jrVoiceLoading=false;jrVoiceAiError=String(msg.message||'model failed');voiceUseBrowserFallback(`On-device AI failed to start (${jrVoiceAiError}). Using browser voice typing.`);return;}if(msg.type==='error'){jrVoicePending.delete(msg.id);if(jrListening)setVoiceUi(true,'Heard something unclear Â· still listening');}}
async function voiceLoadModel(){if(jrVoiceWorkerReady)return true;if(jrVoiceLoading)return 'loading';const worker=voiceEnsureWorker();if(!worker)return false;jrVoiceLoading=true;setVoiceUi(true,'Loading private voice AI (one-time download)â€¦');try{worker.postMessage({type:'load',session:jrVoiceSession});}catch{jrVoiceLoading=false;return false;}return 'loading';}
function voiceMicErrorMessage(error){const name=(error&&(error.name||error.code))||'';if(name==='NotAllowedError'||name==='SecurityError')return 'Microphone blocked. Allow microphone access for this site, then tap Speak again â€” or continue by writing.';if(name==='NotFoundError'||name==='OverconstrainedError')return 'No microphone found. Connect a microphone and tap Speak again â€” or continue by writing.';if(name==='NotReadableError'||name==='AbortError')return 'Microphone is busy (another app may be using it). Close it and tap Speak again.';if(!window.isSecureContext)return 'Microphone needs a secure page. Open this app at http://localhost:4400 (not a network address over plain http), or continue by writing.';return 'Could not open the microphone. Check the browser permission and tap Speak again.';}
function setVoiceUi(active,status=''){const button=$('#jr-mic');if(!button)return;button.classList.toggle('recording',active);button.setAttribute('aria-pressed',String(active));button.innerHTML=active?'<span aria-hidden="true">â– </span> Stop speaking':'<span aria-hidden="true">â—</span> Speak privately';const label=$('#jr-mic-status');if(label)label.textContent=status;}
function voiceRemember(text){jrVoiceRecent.push({fp:voiceFingerprint(text),at:Date.now()});const cutoff=Date.now()-15000;jrVoiceRecent=jrVoiceRecent.filter(item=>item.at>cutoff).slice(-12);}
function voiceCollapseRepeats(text,maxRun=2){const words=String(text||'').trim().split(/\s+/).filter(Boolean);if(!words.length)return '';const out=[words[0]];let run=1;for(let i=1;i<words.length;i++){if(words[i].toLocaleLowerCase()===words[i-1].toLocaleLowerCase()){run++;if(run<=maxRun)out.push(words[i]);}else{run=1;out.push(words[i]);}}return out.join(' ');}
function voiceWhisperLanguage(){const value=String(($('#jr-lang')||{}).value||'auto').toLowerCase();if(value==='auto')return undefined;const code=value.split('-')[0];return ['en','hi','bn','ta','te','mr','gu','kn','ml','pa','or','ur'].includes(code)?code:undefined;}
function appendVoice(text){const clean=normalizeVoice(text);if(!clean)return;const editor=$('#jr-editor'),separator=editor.value&&!/\s$/.test(editor.value)?' ':'';editor.value+=separator+clean+' ';editor.dispatchEvent(new Event('input'));editor.scrollTop=editor.scrollHeight;}
function voiceBeginCapture(){if(!jrListening)return;if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){voiceUseBrowserFallback('This browser cannot open the microphone. Using browser voice typing.');return;}voiceFinishBeginCapture().catch(()=>voiceUseBrowserFallback('Could not start on-device listening. Using browser voice typing.'));}
function voiceLevelHint(){const wrap=$('#jr-voice-level');if(!wrap)return;const heard=jrVoiceSeenAudio?100:0;wrap.classList.remove('hidden');wrap.title=jrVoiceSeenAudio?'Microphone is receiving sound':'Microphone open â€” no sound detected yet';const bar=$('#jr-voice-level-bar');if(bar)bar.style.width=`${heard}%`;}
async function startVoice(){if(jrListening){stopVoice();return;}jrVoiceSession++;jrListening=true;jrVoiceMode='ai';jrVoiceAiError='';jrVoiceSessionText='';jrVoiceRecent=[];jrVoicePending=new Map();jrVoiceChunkId=0;jrVoiceSilenceMs=0;jrVoiceSeenAudio=false;if(jrVoiceWorkerReady){voiceBeginCapture();return;}const worker=voiceEnsureWorker();if(!worker)return;const ready=await voiceLoadModel();if(ready===true&&jrVoiceWorkerReady&&jrListening){voiceBeginCapture();return;}if(jrListening&&!jrVoiceWorkerReady&&jrVoiceMode==='ai'){setVoiceUi(true,'Loading private voice AI (one-time download)â€¦');return;}}
async function voiceFinishBeginCapture(){try{jrVoiceStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});}catch(error){jrListening=false;setVoiceUi(false);toast(voiceMicErrorMessage(error));return;}try{const Ctx=window.AudioContext||window.webkitAudioContext;if(!Ctx)throw new Error('no-audio');jrVoiceCtx=new Ctx({sampleRate:16000});if(jrVoiceCtx.state==='suspended')await jrVoiceCtx.resume();jrVoiceSampleRate=jrVoiceCtx.sampleRate||16000;jrVoiceSource=jrVoiceCtx.createMediaStreamSource(jrVoiceStream);jrVoiceProc=jrVoiceCtx.createScriptProcessor(4096,1,1);jrVoiceProc.onaudioprocess=voiceOnAudio;const silent=jrVoiceCtx.createGain();silent.gain.value=0;jrVoiceSource.connect(jrVoiceProc);jrVoiceProc.connect(silent);silent.connect(jrVoiceCtx.destination);}catch{voiceTeardownCapture();voiceUseBrowserFallback('Could not start on-device listening. Using browser voice typing.');return;}jrVoicePcm=[];jrVoicePcmSeconds=0;setVoiceUi(true,'Listeningâ€¦ speak naturally');voiceLevelHint();clearInterval(jrVoiceLevelTimer);jrVoiceLevelTimer=setInterval(()=>{if(!jrListening)return;jrVoiceSilenceMs+=500;if(jrVoicePcmSeconds>=VOICE_ACCEPT_SECONDS)voiceFlushChunk(false);},500);}
function voiceOnAudio(event){if(!jrListening)return;const input=event.inputBuffer.getChannelData(0);let peak=0;for(let i=0;i<input.length;i++){const v=Math.abs(input[i]);if(v>peak)peak=v;}if(peak>0.015){jrVoiceSeenAudio=true;jrVoiceSilenceMs=0;voiceLevelHint();}const target=16000,step=Math.max(1,Math.round(jrVoiceSampleRate/target)),chunk=new Float32Array(Math.ceil(input.length/step));for(let i=0,j=0;i<input.length;i+=step,j++)chunk[j]=Math.max(-1,Math.min(1,input[i]));const prev=jrVoicePcm;let total=chunk.length;for(const part of prev)total+=part.length;const merged=new Float32Array(total);let offset=0;for(const part of prev){merged.set(part,offset);offset+=part.length;}merged.set(chunk,offset);const keep=Math.floor((VOICE_CHUNK_SECONDS+VOICE_OVERLAP_SECONDS)*target);jrVoicePcm=[merged.subarray(Math.max(0,total-keep))];jrVoicePcmSeconds=jrVoicePcm[0].length/target;if(jrVoicePcmSeconds>=VOICE_CHUNK_SECONDS+VOICE_OVERLAP_SECONDS)voiceFlushChunk(false);}
function voiceFlushChunk(isFinal){if(!jrListening||!jrVoiceWorkerReady||!jrVoiceWorker)return;const target=16000,windowSeconds=isFinal?Math.max(0,jrVoicePcmSeconds):VOICE_CHUNK_SECONDS;if(!isFinal&&jrVoicePcmSeconds<VOICE_ACCEPT_SECONDS)return;if(windowSeconds<1.2&&!isFinal)return;const pcm=jrVoicePcm[0]||new Float32Array(0);const want=Math.min(pcm.length,Math.floor(windowSeconds*target));if(want<Math.floor(1.2*target))return;const slice=pcm.slice(pcm.length-want);const id=++jrVoiceChunkId;jrVoicePending.set(id,{session:jrVoiceSession,seconds:want/target});try{jrVoiceWorker.postMessage({type:'transcribe',id,audio:slice,language:voiceWhisperLanguage()});}catch{jrVoicePending.delete(id);}setVoiceUi(true,isFinal?'Finishing your last wordsâ€¦':'Listeningâ€¦ transcribing');}
function voiceHandleTranscript(session,text,seconds){if(!jrListening||session!==jrVoiceSession)return;const cleaned=voiceCollapseRepeats(String(text||'').trim().replace(/\s+/g,' '));if(!cleaned||cleaned.length<2){setVoiceUi(true,'Listeningâ€¦ speak naturally');return;}jrVoiceSessionText=voiceMergeChunk(jrVoiceSessionText,cleaned);if(voiceNearDuplicate(cleaned)){setVoiceUi(true,'Listeningâ€¦ (skipped a repeated phrase)');return;}voiceRemember(cleaned);if(jrVoiceSessionText.length>VOICE_MAX_TEXT)jrVoiceSessionText=jrVoiceSessionText.slice(-VOICE_MAX_TEXT);if(seconds<VOICE_ACCEPT_SECONDS||cleaned.split(/\s+/).length<=2){const draft=$('#jr-draft');if(draft){draft.value=normalizeVoice(cleaned);$('#jr-draft-wrap').classList.remove('hidden');}setVoiceUi(true,'Review this phrase Â· still listening');}else{appendVoice(cleaned);setVoiceUi(true,`Added Â· listening (${journalWordCount(jrVoiceSessionText)} words heard)`);}}
function voiceTeardownCapture(){clearInterval(jrVoiceLevelTimer);jrVoiceLevelTimer=0;try{if(jrVoiceProc)jrVoiceProc.onaudioprocess=null;}catch{}try{if(jrVoiceProc)jrVoiceProc.disconnect();}catch{}try{if(jrVoiceSource)jrVoiceSource.disconnect();}catch{}try{if(jrVoiceCtx)jrVoiceCtx.close();}catch{}jrVoiceProc=null;jrVoiceSource=null;jrVoiceCtx=null;try{if(jrVoiceStream)jrVoiceStream.getTracks().forEach(track=>track.stop());}catch{}jrVoiceStream=null;jrVoicePcm=[];jrVoicePcmSeconds=0;const wrap=$('#jr-voice-level');if(wrap)wrap.classList.add('hidden');}
function stopVoice(status=''){const session=jrVoiceSession;const hadAi=jrVoiceMode==='ai'&&jrListening&&jrVoicePcmSeconds>=1.2&&jrVoiceWorkerReady;if(hadAi){try{voiceFlushChunk(true);}catch{}}voiceTeardownCapture();jrListening=false;jrVoiceSession++;jrVoicePending=new Map();jrVoiceLoading=false;const rec=jrRecognition;jrRecognition=null;try{if(rec)rec.onend=null;}catch{}try{if(rec)rec.onerror=null;}catch{}try{if(rec)rec.onresult=null;}catch{}try{if(rec)rec.abort();}catch{}try{if(rec)rec.stop();}catch{}if(jrVoiceMode==='browser'){jrVoiceMode='ai';setVoiceUi(false,status||'Browser voice typing stopped.');}else{setVoiceUi(false,status||(jrVoiceSessionText&&session===jrVoiceSession-1?`Heard ${journalWordCount(jrVoiceSessionText)} words. Review the text above.`:'Stopped. Nothing heard â€” try again or continue by writing.'));}}
/* Legacy browser voice-typing fallback (phone mic feature, kept only as backup). */
function voiceUseBrowserFallback(note=''){jrVoiceMode='browser';voiceTeardownCapture();if(!SpeechRecognition){jrListening=false;jrVoiceSession++;setVoiceUi(false);toast('Voice input is unavailable here. Writing remains available.');return;}if(note)setVoiceUi(true,note);try{if(jrRecognition){jrRecognition.onend=null;jrRecognition.onerror=null;jrRecognition.onresult=null;try{jrRecognition.abort();}catch{}try{jrRecognition.stop();}catch{}}}catch{}const recognition=new SpeechRecognition();jrRecognition=recognition;recognition.continuous=true;recognition.interimResults=false;try{recognition.lang=journalLanguage();}catch{}const session=jrVoiceSession;recognition.onstart=()=>{if(session===jrVoiceSession)setVoiceUi(true,'Listening (browser voice typing)â€¦');};recognition.onresult=event=>{if(!jrListening||session!==jrVoiceSession||jrVoiceMode!=='browser')return;for(let i=event.resultIndex;i<event.results.length;i++){const result=event.results[i];if(!result.isFinal)continue;const said=String(result[0].transcript||'').trim();if(!said)continue;if(voiceNearDuplicate(said))continue;voiceRemember(said);appendVoice(said);setVoiceUi(true,'Added Â· listening (browser voice typing)');}};recognition.onerror=event=>{if(session!==jrVoiceSession||jrVoiceMode!=='browser')return;if(['not-allowed','service-not-allowed'].includes(event.error)){const s=jrVoiceSession;jrListening=false;jrVoiceSession++;try{recognition.stop();}catch{}setVoiceUi(false);if(session===s)toast(voiceMicErrorMessage({name:'NotAllowedError'}));}else if(event.error==='audio-capture'){const s=jrVoiceSession;jrListening=false;jrVoiceSession++;try{recognition.stop();}catch{}setVoiceUi(false);if(session===s)toast(voiceMicErrorMessage({name:'NotFoundError'}));}else if(event.error!=='no-speech'&&event.error!=='aborted'&&jrListening)setVoiceUi(true,'Voice paused. Tap to retry.');};recognition.onend=()=>{if(jrListening&&jrVoiceMode==='browser'&&session===jrVoiceSession&&currentRoute.startsWith('/personnel/journal/')){try{recognition.start();}catch{if(jrListening&&session===jrVoiceSession)setVoiceUi(true,'Voice paused. Tap to continue.');}}};try{recognition.start();}catch{jrListening=false;setVoiceUi(false,'Could not start voice. Tap to retry.');}}
function journalLanguage(){const selected=($('#jr-lang')||{}).value||'auto';if(selected!=='auto')return selected;const nav=(navigator.language||'en-IN').toLowerCase();return nav.startsWith('hi')?'hi-IN':'en-IN';}
$('#jr-mic').addEventListener('click',()=>jrListening?stopVoice():startVoice());
$('#jr-draft-ok').addEventListener('click',()=>{appendVoice($('#jr-draft').value);$('#jr-draft').value='';$('#jr-draft-wrap').classList.add('hidden');});
$('#jr-draft-no').addEventListener('click',()=>{$('#jr-draft').value='';$('#jr-draft-wrap').classList.add('hidden');});
if(!SpeechRecognition){$('#jr-mic').title='Voice recognition is unavailable in this browser';$('#jr-mic-status').textContent='Writing is always available.';}
window.addEventListener('online',()=>{if(jrDirty&&currentRoute.startsWith('/personnel/journal/'))saveJournal(true);});
window.addEventListener('offline',()=>{if(currentRoute.startsWith('/personnel/journal/')){$('#jr-save').textContent='Saved on device Â· offline';saveJournalOnDevice();}});
window.addEventListener('beforeunload',()=>{if(!jrDirty)return;saveJournalOnDevice();const body=JSON.stringify({date:jrDate,content:$('#jr-editor').value,time_sec:journalElapsed(),timeline:jrTimeline,started_at:jrStartedAt});try{navigator.sendBeacon('/api/journal',new Blob([body],{type:'application/json'}));}catch{}});

function themeColor(name){return getComputedStyle(document.documentElement).getPropertyValue(name).trim();}
function sizeCanvas(canvas,cssHeight){const rect=canvas.getBoundingClientRect(),dpr=Math.min(2,window.devicePixelRatio||1),width=Math.max(300,Math.round(rect.width||700));canvas.width=Math.round(width*dpr);canvas.height=Math.round(cssHeight*dpr);canvas.style.height=`${cssHeight}px`;const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);return{ctx,width,height:cssHeight};}
function journalBars(element,data){const shown=asArray(data).filter(item=>item.count>0).slice(0,7);if(!shown.length){element.innerHTML='<p class="muted">Not enough matching words yet.</p>';return;}const max=Math.max(...shown.map(item=>item.count));element.innerHTML=shown.map(item=>`<div class="word-bar" title="${esc(item.label)}: ${item.count}"><strong>${item.count}</strong><i style="height:${Math.max(8,item.count/max*100)}%;background:${esc(item.color)}"></i><span>${esc(item.emoji||'â—')}</span><small>${esc(item.label)}</small></div>`).join('');}
function drawDonut(canvas){const pct=Number(canvas.dataset.pct),dpr=Math.min(2,window.devicePixelRatio||1),side=Math.max(96,Math.min(150,Math.round(canvas.getBoundingClientRect().width||116)));canvas.width=Math.round(side*dpr);canvas.height=Math.round(side*dpr);canvas.style.width=`${side}px`;canvas.style.height=`${side}px`;const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);const center=side/2,r=side/2-12;ctx.lineCap='round';ctx.lineWidth=Math.max(11,side/9);ctx.strokeStyle=canvas.dataset.c2;ctx.beginPath();ctx.arc(center,center,r,0,Math.PI*2);ctx.stroke();ctx.strokeStyle=canvas.dataset.c1;ctx.beginPath();ctx.arc(center,center,r,-Math.PI/2,-Math.PI/2+pct/100*Math.PI*2);ctx.stroke();ctx.fillStyle=themeColor('--ink');ctx.font=`700 ${Math.max(13,Math.round(side/7))}px system-ui`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(`${pct}%`,center,center);}
function drawWritingSpeed(timeline,words,timeSec){const canvas=$('#jr-an-speed'),{ctx,width:W,height:H}=sizeCanvas(canvas,220),data=asArray(timeline).length>=2?timeline:[[0,0],[Math.max(timeSec,1),words]],left=42,right=14,top=16,bottom=30,maxT=Math.max(60,data.at(-1)[0]),maxW=Math.max(JOURNAL_GOAL,...data.map(point=>point[1]));const X=s=>left+s/maxT*(W-left-right),Y=w=>H-bottom-w/maxW*(H-bottom-top);ctx.strokeStyle=themeColor('--line');ctx.fillStyle=themeColor('--muted');ctx.font='11px system-ui';[JOURNAL_BLUE,JOURNAL_GOAL].filter(x=>x<=maxW).forEach(goal=>{const y=Y(goal);ctx.setLineDash([5,5]);ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(W-right,y);ctx.stroke();ctx.fillText(goal,4,y+4);});ctx.setLineDash([]);ctx.strokeStyle=themeColor('--accent');ctx.lineWidth=3;ctx.beginPath();data.forEach(([s,w],i)=>i?ctx.lineTo(X(s),Y(w)):ctx.moveTo(X(s),Y(w)));ctx.stroke();}
async function loadJournalInsights(){const list=await api('/api/journal/analysis/list'),days=asArray(list.days);$('#jr-an-empty').classList.toggle('hidden',days.length>0);$('#jr-an-content').classList.toggle('hidden',!days.length);if(!days.length)return;const select=$('#jr-an-date'),previous=select.value;select.innerHTML=days.map(day=>`<option value="${esc(day.date)}">${formatDate(day.date,{year:true})} Â· ${day.words} words</option>`).join('');if(days.some(day=>day.date===previous))select.value=previous;await jrRenderAnalysis(select.value);}
async function jrRenderAnalysis(date){const data=await api(`/api/journal/analysis/${date}`);jrLastAnalysis=data;const speed=data.speed||{},analysis=data.analysis||{};$('#jr-an-summary').innerHTML=`<strong>You wrote ${Number(data.words||0).toLocaleString()} words</strong><span>${esc(`${speed.wpm||0} words/min Â· ${speed.minutes||0} minutes`)}</span>`;const topFeeling=asArray(analysis.feelings).find(x=>x.count>0),topTopic=asArray(analysis.topics).find(x=>x.count>0),topTime=asArray(analysis.time).find(x=>x.count>0);$('#jr-an-story').innerHTML=[['Feeling mostly',topFeeling?.label||'Not enough words'],['Thinking about',topTopic?.label||'Not enough words'],['Time orientation',topTime?.label||'Not enough words'],['Writing activity',`${data.words||0} words`]].map(([label,value])=>`<div class="story-item"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('');drawWritingSpeed(data.timeline,data.words,data.time_sec);$('#jr-an-speed-note').textContent=asArray(data.timeline).length<2?'Older entry: shown from total time and words.':'Your private word-count samples during this entry.';const m=analysis.mindset||{};const donuts=[['Introvert','Extrovert',m.introvert,'#b57a3d','#748092'],['Positive','Negative',m.positive,'#288a76','#748092'],['Certain','Uncertain',m.certain,'#a77c20','#748092'],['Thinking','Feeling',m.thinking,'#4279a9','#b56c62']];$('#jr-an-mindset').innerHTML=donuts.map(([a,b,p,c1,c2])=>`<div class="donut"><strong>${a}</strong><small>vs ${b}</small><canvas width="140" height="120" data-pct="${Number(p)||50}" data-c1="${c1}" data-c2="${c2}" role="img" aria-label="${a} ${Number(p)||50} percent versus ${b}"></canvas></div>`).join('');$$('#jr-an-mindset canvas').forEach(drawDonut);journalBars($('#jr-an-feelings'),analysis.feelings);journalBars($('#jr-an-topics'),analysis.topics);journalBars($('#jr-an-time'),analysis.time);journalBars($('#jr-an-senses'),analysis.senses);journalBars($('#jr-an-pronouns'),analysis.pronouns);}
$('#jr-an-date').addEventListener('change',event=>jrRenderAnalysis(event.target.value).catch(error=>toast(error.message)));

async function loadJournalProgress(days=30){progressDays=days;$$('[data-progress-days]').forEach(button=>button.classList.toggle('on',String(button.dataset.progressDays)===String(days)));const [progress,stats]=await Promise.all([api(`/api/personnel/progress?days=${days}`),api('/api/journal/stats')]);jrLastStats=stats;$('#jr-progress-content').innerHTML=`${progressSummaryMarkup(progress)}<div class="grid-2"><section class="surface section-block"><div class="card-heading"><div><p class="eyebrow">Assessment history</p><h2>Saved wellbeing checks</h2></div></div>${asArray(progress.assessments).length?asArray(progress.assessments).slice(-8).reverse().map(row=>`<div class="history-row"><div><strong>${esc(row.label||row.type)}</strong><small>${formatDate(row.date)} Â· ${esc(row.level||'Saved')}</small></div><span>${row.display_score}/${row.max_score}</span></div>`).join(''):emptyMarkup('No assessment history','Complete your first wellbeing check.')}</section><section class="surface relationship-card"><p class="eyebrow">Work relationship</p><h2>Observed association</h2><p class="insight-lead">${esc(progress.work_relationship?.text)}</p><span class="association-label">${esc(progress.work_relationship?.disclaimer)}</span></section></div><section class="surface section-block"><div class="card-heading"><div><p class="eyebrow">Private reflection patterns</p><h2>Your recurring themes</h2></div><span class="experimental-label">Experimental</span></div>${renderTagList(asArray(progress.journal?.recurring_themes).map(item=>`${item.label} Â· ${item.count}`),'Continue reflecting to build this view.')}<p class="source-note">Private keyword patterns. They stay personal and are not clinical findings.</p></section>`;const cards=[['Total words',Number(stats.total_words||0).toLocaleString()],['Days reflected',stats.total_days||0],['This week',`${stats.last30?.slice(-7).filter(x=>x.words>0).length||0} reflections`],['Average length',`${stats.avg_words||0} words`],['Time spent',`${stats.total_time_min||0} min`],['750+ days',stats.green_days||0]];$('#jr-stat-cards').innerHTML=cards.map(([label,value])=>metricCard(label,value)).join('');$('#jr-badges').innerHTML=asArray(stats.badges).length?asArray(stats.badges).map(badge=>`<span class="journal-badge">${esc(badge.label)}</span>`).join(''):'<p class="muted">Your reflections do not need a streak. Milestones will appear naturally over time.</p>';jrDrawStats(stats.last30||[]);}
function jrDrawStats(days){const canvas=$('#jr-stat-chart'),{ctx,width:W,height:H}=sizeCanvas(canvas,230),data=asArray(days),left=38,right=10,top=15,bottom=30,max=Math.max(JOURNAL_GOAL,...data.map(day=>Number(day.words)||0)),bar=(W-left-right)/Math.max(1,data.length);ctx.strokeStyle=themeColor('--line');ctx.fillStyle=themeColor('--muted');ctx.font='11px system-ui';[JOURNAL_BLUE,JOURNAL_GOAL].forEach(goal=>{const y=H-bottom-goal/max*(H-bottom-top);ctx.setLineDash([5,5]);ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(W-right,y);ctx.stroke();ctx.fillText(goal,3,y+4);});ctx.setLineDash([]);data.forEach((day,index)=>{const h=(Number(day.words)||0)/max*(H-bottom-top);ctx.fillStyle=day.words>=JOURNAL_GOAL?themeColor('--accent'):day.words>=JOURNAL_BLUE?themeColor('--blue'):themeColor('--muted');ctx.fillRect(left+index*bar+2,H-bottom-h,Math.max(2,bar-4),h);});if(data.length){ctx.fillText(String(data[0].date).slice(5),left,H-8);ctx.fillText('today',W-right-34,H-8);}}
$$('[data-progress-days]').forEach(button=>button.addEventListener('click',()=>loadJournalProgress(button.dataset.progressDays).catch(error=>toast(error.message))));

/* Welfare workspace */
let welfareCases=[];
function caseCard(item){return `<article class="case-card"><div class="case-card-header"><div><p class="eyebrow">CASE #${esc(item.id)}</p><h2>${esc(item.rank||'')} ${esc(item.name||'')}</h2><p>${esc(item.unit||'Unit not recorded')} Â· ${esc(item.force_id||'')}</p></div>${statusChip(item.priority)}</div><div class="case-meta"><span><b>Source</b>${esc(item.source||sourceLabel(item.source_key))}</span><span><b>Status</b>${esc(item.status)}</span><span><b>Case age</b>${relativeAge(item.created_at)}</span></div><div><b>Shared</b>${renderTagList(asArray(item.shared_fields),'No optional voluntary context')}</div><div class="case-meta"><span><b>Last contact</b>${item.last_contact_at?formatDateTime(item.last_contact_at):'Not yet'}</span><span><b>Next action</b>${esc(item.next_action||'Review case')}</span><span><b>Due</b>${item.follow_up_due?formatDate(item.follow_up_due):'Not scheduled'}</span></div><button class="button" type="button" data-open-case="${Number(item.id)}">Open case â†’</button></article>`;}
function queueMetrics(metrics){return `<div class="metric-grid">${metricCard('Open cases',metrics.open||0,'active support cases')}${metricCard('Needs attention',metrics.needs_attention||0,'urgent or high')}${metricCard('Overdue follow-ups',metrics.overdue_follow_ups||0,'action required')}${metricCard('Awaiting response',metrics.awaiting_response||0,'contacted')}</div>`;}
async function loadWelfareOverview(){const container=$('#welfare-overview-content');container.innerHTML=loadingMarkup(5);const data=await api('/api/welfare/overview');welfareCases=asArray(data.queue);container.innerHTML=`<div class="page-heading"><div><p class="eyebrow">Welfare operations</p><h1>Support that moves forward</h1><p>See who needs an appropriate response, why the case exists, and what should happen next.</p></div><span class="subtle-note">Authorized cases only</span></div>${queueMetrics(asObject(data.metrics))}<section class="surface section-block"><div class="card-heading"><div><p class="eyebrow">Support Queue</p><h2>Cases needing your attention</h2></div><button class="text-button" type="button" data-route="/welfare/cases">View all cases â†’</button></div>${welfareCases.length?`<div class="grid-2">${welfareCases.slice(0,4).map(caseCard).join('')}</div>`:emptyMarkup('No urgent support cases right now','Scheduled follow-ups and new requests will appear here.')}</section>`;}
async function loadWelfareCases(){const container=$('#welfare-cases-content');container.innerHTML=loadingMarkup(5);const data=await api('/api/welfare/cases');welfareCases=asArray(data.cases);const sources=[...new Set(welfareCases.map(item=>item.source_key))],units=[...new Set(welfareCases.map(item=>item.unit))];container.innerHTML=`<div class="page-heading"><div><p class="eyebrow">One connected workflow</p><h1>Support Queue</h1><p>Every case has a source, a responsible officer, a next action, and a follow-up state.</p></div></div>${queueMetrics(asObject(data.metrics))}<section class="surface section-block"><form id="case-filters" class="filter-panel"><label>Search<input type="search" name="query" placeholder="Case, person, unit"></label><label>Priority<select name="priority"><option value="">All</option>${['Urgent','High','Routine'].map(x=>`<option>${x}</option>`).join('')}</select></label><label>Source<select name="source"><option value="">All</option>${sources.map(x=>`<option value="${esc(x)}">${esc(sourceLabel(x))}</option>`).join('')}</select></label><label>Unit<select name="unit"><option value="">All</option>${units.map(x=>`<option>${esc(x)}</option>`).join('')}</select></label><label>Status<select name="status"><option value="">All</option>${['New','Contacted','In support','Monitoring','Resolved'].map(x=>`<option>${x}</option>`).join('')}</select></label><label>Due<select name="due"><option value="">Any</option><option value="overdue">Overdue</option></select></label></form><div id="case-list" class="grid-2"></div></section>`;const render=()=>{const fd=new FormData($('#case-filters')),q=String(fd.get('query')||'').toLowerCase(),today=localDateKey();const rows=welfareCases.filter(item=>(!q||`${item.id} ${item.name} ${item.force_id} ${item.unit}`.toLowerCase().includes(q))&&(!fd.get('priority')||item.priority===fd.get('priority'))&&(!fd.get('source')||item.source_key===fd.get('source'))&&(!fd.get('unit')||item.unit===fd.get('unit'))&&(!fd.get('status')||item.status===fd.get('status'))&&(!fd.get('due')||(item.follow_up_due&&item.follow_up_due<today&&item.status!=='Resolved')));$('#case-list').innerHTML=rows.length?rows.map(caseCard).join(''):emptyMarkup('No cases match','Adjust the filters or clear the search.');};$('#case-filters').addEventListener('input',render);render();}
document.addEventListener('click',event=>{const button=event.target.closest('[data-open-case]');if(button)window.location.hash=`/welfare/cases/${button.dataset.openCase}`;});
function snapshotMarkup(shared){const snapshot=asObject(shared.snapshot),blocks=[];if(snapshot.stress_trend)blocks.push(metricCard('Shared stress',summaryValue(snapshot.stress_trend.summary,'/10'),snapshot.stress_trend.summary?.direction));if(snapshot.sleep_trend)blocks.push(metricCard('Shared sleep',summaryValue(snapshot.sleep_trend.summary,'h'),snapshot.sleep_trend.summary?.direction));if(snapshot.who5)blocks.push(metricCard('Shared WHO-5',`${snapshot.who5.display_score}/${snapshot.who5.max_score}`,snapshot.who5.level));if(snapshot.assessment_history)blocks.push(metricCard('Assessment history',snapshot.assessment_history.length,'results shared'));if(snapshot.work_context)blocks.push(metricCard('Work context',`${snapshot.work_context.overtime_hours||0}h overtime`,`${snapshot.work_context.window_days||90} days`));return blocks.length?`<div class="metric-grid">${blocks.join('')}</div>`:emptyMarkup('No optional context shared','Continue using the case source, reason and timeline. Do not infer private wellbeing data.');}
async function loadWelfareCase(id){const container=$('#welfare-case-content');container.innerHTML=loadingMarkup(5);const data=await api(`/api/welfare/cases/${id}`),item=data.case,person=data.person,shared=asObject(data.shared_context);container.innerHTML=`<button class="text-button" type="button" data-route="/welfare/cases">â† Back to Support Queue</button><div class="page-heading"><div><p class="eyebrow">${esc(item.case_id)}</p><h1>${esc(person.rank)} ${esc(person.name)}</h1><p>${esc(person.unit)} Â· ${esc(person.force_id)}</p></div><div>${statusChip(item.priority)} ${statusChip(item.status)}</div></div><div class="case-detail-grid"><section class="surface section-block"><div class="card-heading"><div><p class="eyebrow">Why this case exists</p><h2>${esc(item.source)}</h2></div></div><div class="info-grid"><div class="info-pair"><span>Reason</span><strong>${esc(titleCase(item.reason))}</strong></div><div class="info-pair"><span>Assigned officer</span><strong>${esc(data.assigned_officer?.name||'Unassigned')}</strong></div><div class="info-pair"><span>Last contact</span><strong>${item.last_contact_at?formatDateTime(item.last_contact_at):'Not yet'}</strong></div><div class="info-pair"><span>Due</span><strong>${item.follow_up_due?formatDate(item.follow_up_due):'Not scheduled'}</strong></div></div>${item.details?`<p>${esc(item.details)}</p>`:''}<div class="locked-callout"><strong>â–£ PRIVATE JOURNAL â€” LOCKED</strong><p>No journal text, transcript or Journal analytics are available in this case.</p></div></section><section class="surface section-block"><div class="card-heading"><div><p class="eyebrow">Authorized context</p><h2>Shared for this case</h2></div><span class="subtle-note">Granted ${formatDateTime(shared.granted_at)}</span></div>${snapshotMarkup(shared)}</section></div><div class="grid-2"><section class="surface section-block"><div class="card-heading"><div><p class="eyebrow">Case timeline</p><h2>What has happened</h2></div></div>${asArray(data.timeline).length?asArray(data.timeline).map(event=>`<div class="timeline-item"><time>${formatDateTime(event.at)}</time><div><strong>${esc(titleCase(event.event_type))}</strong><p>${esc(event.detail||'')}</p><small>${esc(event.actor||'System')}</small></div></div>`).join(''):emptyMarkup('No timeline events','Updates will appear here.')}</section><section class="surface section-block"><div class="card-heading"><div><p class="eyebrow">Next step</p><h2>Update case</h2></div></div><form id="case-update"><label>Status<select name="status">${['New','Contacted','In support','Monitoring','Resolved'].map(x=>`<option ${item.status===x?'selected':''}>${x}</option>`).join('')}</select></label><label>Priority<select name="priority">${['Urgent','High','Routine'].map(x=>`<option ${item.priority===x?'selected':''}>${x}</option>`).join('')}</select></label><label>Next action<input name="next_action" value="${esc(item.next_action||'')}"></label><label>Follow-up due<input name="follow_up_due" type="date" value="${esc(item.follow_up_due||'')}"></label><label>Case note<textarea name="note" maxlength="1000" placeholder="Purpose-limited welfare note"></textarea></label><button class="button primary" type="submit">Save update</button></form>${asArray(data.notes).length?`<div class="preview-list">${asArray(data.notes).map(note=>`<div class="note-item"><strong>${esc(note.author)}</strong><p>${esc(note.note)}</p><small>${formatDateTime(note.at)}</small></div>`).join('')}</div>`:''}</section></div>`;$('#case-update').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,fd=new FormData(form),button=form.querySelector('button');button.disabled=true;try{await api(`/api/welfare/cases/${id}`,{method:'POST',body:JSON.stringify({status:fd.get('status'),priority:fd.get('priority'),next_action:fd.get('next_action'),follow_up_due:fd.get('follow_up_due'),note:fd.get('note')})});toast('Case updated. Personnel status is now current.');await loadWelfareCase(id);}catch(error){toast(error.message);button.disabled=false;}});}
async function loadWelfareFollowups(){const container=$('#welfare-followups-content');container.innerHTML=loadingMarkup(4);const data=await api('/api/welfare/followups'),rows=asArray(data.followups),today=data.as_of||localDateKey();container.innerHTML=`<div class="page-heading"><div><p class="eyebrow">Time-sensitive work</p><h1>Follow-ups</h1><p>Keep promised contacts and reviews visible.</p></div><span class="subtle-note">As of ${formatDate(today)}</span></div>${rows.length?`<div class="grid-2">${rows.map(item=>caseCard(item)).join('')}</div>`:emptyMarkup('No follow-ups scheduled','Schedule the next action from an open case.')}`;}
async function loadRecordReviews(){const container=$('#record-reviews-content');container.innerHTML=loadingMarkup(4);const data=await api('/api/welfare/record-reviews'),rows=asArray(data.reviews);container.innerHTML=`<div class="page-heading"><div><p class="eyebrow">Separate from support casework</p><h1>Record Reviews</h1><p>Resolve incorrect organizational record reports with an auditable outcome.</p></div></div><section class="surface section-block">${rows.length?`<div class="preview-list">${rows.map(row=>`<article class="record-item"><time>${formatDate(row.created_at)}</time><div><strong>${esc(row.rank)} ${esc(row.name)} Â· ${esc(titleCase(row.category))}</strong><p>${esc(row.message)}</p><small>${esc(row.unit||'')} Â· ${esc(row.force_id)}</small>${row.resolution_note?`<p>Resolution: ${esc(row.resolution_note)}</p>`:''}</div><div>${statusChip(row.status)}${['submitted','reviewing'].includes(row.status)?`<button class="text-button" type="button" data-review-id="${row.id}" data-review-status="${row.status==='submitted'?'reviewing':'resolved'}">${row.status==='submitted'?'Start review':'Resolve'}</button>`:''}</div></article>`).join('')}</div>`:emptyMarkup('No record reviews','New correction requests will appear here, outside the support queue.')}</section>`;$$('[data-review-id]').forEach(button=>button.onclick=async()=>{const terminal=button.dataset.reviewStatus==='resolved';const note=await askNote({title:terminal?'Resolve record review':'Start record review',help:terminal?'Add the verified outcome for the audit trail.':'Add an optional verification note.',label:'Resolution note',confirm:terminal?'Resolve':'Start review',required:terminal});if(note===null)return;try{await api(`/api/data-corrections/${button.dataset.reviewId}`,{method:'POST',body:JSON.stringify({status:button.dataset.reviewStatus,resolution_note:note})});toast('Record review updated.');await loadRecordReviews();}catch(error){toast(error.message);}});}
async function loadWelfareInsights(){const container=$('#welfare-insights-content');container.innerHTML=loadingMarkup(5);const data=await api('/api/welfare/insights');container.innerHTML=`<div class="page-heading"><div><p class="eyebrow">Operational learning</p><h1>Support Insights</h1><p>Only measures that help the team respond, follow up, and improve service.</p></div></div><div class="metric-grid">${metricCard('Median first response',data.median_first_response_hours==null?'â€”':`${data.median_first_response_hours}h`,'completed first contacts')}${metricCard('Completed follow-ups',data.follow_up?.completed||0,'resolved cases')}${metricCard('Due',data.follow_up?.due||0,'scheduled')}${metricCard('Overdue',data.follow_up?.overdue||0,'needs action')}</div><div class="grid-3"><section class="surface section-block"><h2>Case priority</h2>${distributionRows(data.priority)}</section><section class="surface section-block"><h2>Follow-up status</h2>${distributionRows(data.follow_up)}</section><section class="surface section-block"><h2>Case age</h2>${distributionRows(data.case_age)}</section></div><div class="grid-2"><section class="surface section-block"><h2>Support source distribution</h2>${distributionRows(data.source_distribution)}</section><section class="surface section-block"><h2>30-day case volume</h2>${distributionRows(asArray(data.volume_trend).map(item=>({label:formatDate(item.date),count:item.count})),'No new cases in this period.')}</section></div>`;}

/* Commander workspace */
let commanderData=null;
async function getCommanderData(force=false){if(force||!commanderData)commanderData=await api('/api/commander/overview');return commanderData;}
function conditionClass(value){return slug(String(value||'normal').replace(' load',''));}
function unitAttentionCard(unit){const contributors=asArray(unit.early_indicator?.contributors);return `<article class="unit-attention-card"><div class="unit-card-header"><div><p class="eyebrow">${esc(unit.region)}</p><h2>${esc(unit.unit)}</h2></div>${statusChip(unit.condition)}</div><div class="driver-list">${contributors.length?contributors.slice(0,3).map(item=>`<div class="driver"><span>${esc(item.label)}</span><strong>${esc(item.detail)}</strong></div>`).join(''):'<p>No elevated drivers.</p>'}</div><button class="text-button" type="button" data-route="/commander/units">View unit â†’</button></article>`;}
function actionCard(action){return `<article class="action-card"><div class="card-heading"><div><p class="eyebrow">${esc(action.unit)}</p><h2>${esc(action.title)}</h2></div>${statusChip(action.status)}</div><div class="info-grid"><div class="info-pair"><span>Issue</span><strong>${esc(action.issue||action.title)}</strong></div><div class="info-pair"><span>Owner</span><strong>${esc(action.owner||'Not assigned')}</strong></div><div class="info-pair"><span>Review</span><strong>${action.review_date?formatDate(action.review_date):'Not set'}</strong></div></div><p><b>Evidence:</b> ${esc(action.evidence)}</p><p><b>Suggested response:</b> ${esc(action.suggested_response)}</p>${action.before?`<div class="before-after"><div><span>Before</span><strong>${esc(action.before.condition||'Baseline')}</strong><small>${esc(action.before.overtime_per_person??'â€”')}h/person overtime Â· recovery ${esc(action.before.recovery??'â€”')}</small></div><div><span>After</span><strong>${esc(action.after?.condition||'Awaiting review')}</strong><small>${action.after?`${esc(action.after.overtime_per_person)}h/person overtime Â· recovery ${esc(action.after.recovery)}`:'Follow-up not recorded'}</small></div></div>`:''}${action.outcome?`<p class="decision-note"><b>Outcome:</b> ${esc(action.outcome)}</p>`:''}${action.id?`<div class="form-actions"><button class="text-button" type="button" data-action-status="${action.id}" data-current-status="${esc(action.status)}">Update status</button>${!action.after&&action.status!=='Completed'?`<button class="button quiet" type="button" data-advance-action="${action.id}">Simulate 14-day review</button>`:''}</div>`:''}</article>`;}
async function loadCommanderOverview(){const container=$('#commander-overview-content');container.innerHTML=loadingMarkup(5);const data=await getCommanderData(true),units=asArray(data.units),attention=units.filter(unit=>unit.condition!=='Normal').slice(0,3),actions=asArray(data.priority_actions).slice(0,3),outcomes=asArray(data.outcomes).slice(0,3);container.innerHTML=`<div class="page-heading"><div><p class="eyebrow">Operational Conditions</p><h1>Spot pressure early. Improve the conditions.</h1><p>Use workload, recovery and resourcing evidence to choose organizational action.</p></div></div><section class="guardrail"><span class="guardrail-icon">â—‡</span><div><p class="eyebrow">Privacy guardrail</p><h2>Conditions, never case files</h2><p>Command receives unit aggregates only. No journals, people, assessments, Welfare cases, or support notes.</p></div></section><div class="metric-grid">${metricCard('Units needing attention',attention.length,'aggregate conditions')}${metricCard('Overtime',Number(data.totals?.overtime_hours||0).toLocaleString(),'hours Â· 90 days')}${metricCard('Incident exposures',data.totals?.incidents||0,'aggregate records')}${metricCard('Actions in view',asArray(data.actions).length,'organizational responses')}</div><section class="surface section-block"><div class="card-heading"><div><p class="eyebrow">Units needing attention</p><h2>Where pressure is building</h2></div><button class="text-button" type="button" data-route="/commander/units">Open Units â†’</button></div>${attention.length?`<div class="grid-3">${attention.map(unitAttentionCard).join('')}</div>`:emptyMarkup('No units need immediate attention','Continue monitoring coverage and recovery conditions.')}</section><div class="grid-2"><section class="surface section-block"><div class="card-heading"><div><p class="eyebrow">Priority Organizational Actions</p><h2>What leadership can change</h2></div><button class="text-button" type="button" data-route="/commander/actions">Open Actions â†’</button></div>${actions.length?actions.map(actionCard).join(''):emptyMarkup('No priority action suggested','Early Indicators will add evidence when conditions change.')}</section><section class="surface section-block"><div class="card-heading"><div><p class="eyebrow">Recent intervention outcomes</p><h2>Did conditions improve?</h2></div></div>${outcomes.length?outcomes.map(actionCard).join(''):emptyMarkup('No reviewed outcomes yet','Create an action and record a follow-up measurement.')}</section></div><section class="surface section-block"><div class="card-heading"><div><p class="eyebrow">30-day organizational trend</p><h2>Unit Conditions Trend</h2></div><button class="text-button" type="button" data-route="/commander/trends">Explore trend â†’</button></div>${commanderTrendMarkup(asArray(data.trend).slice(-14))}</section>`;bindCommanderActions();drawCommanderTrend(asArray(data.trend).slice(-14));}
function conditionCellMarkup(cell,label){return `<div class="condition-cell ${conditionClass(cell.status)}" title="${esc(cell.explanation)}"><span>${esc(label)}</span><strong>${esc(cell.display??cell.value??'â€”')}</strong><small>${esc(cell.status)}</small><details><summary>Why?</summary><p>${esc(cell.explanation)}</p></details></div>`;}
async function loadCommanderUnits(){const container=$('#commander-units-content');container.innerHTML=loadingMarkup(6);const data=await getCommanderData(),units=asArray(data.units);container.innerHTML=`<div class="page-heading"><div><p class="eyebrow">Aggregate comparison</p><h1>Unit Conditions Heatmap</h1><p>Every status explains its source and meaning. Voluntary data appears only with consent and safe coverage.</p></div><span class="subtle-note">Normal Â· Monitor Â· High</span></div><div class="unit-board">${units.map(unit=>`<article class="unit-card"><div class="unit-card-header"><div><p class="eyebrow">${esc(unit.region)}</p><h2>${esc(unit.unit)}</h2><p>${esc(unit.strength)} active personnel</p></div>${statusChip(unit.condition)}</div><div class="unit-metrics">${conditionCellMarkup(unit.heatmap.overtime,'Overtime')}${conditionCellMarkup(unit.heatmap.leave_pressure,'Leave pressure')}${conditionCellMarkup(unit.heatmap.recovery,'Recovery')}${conditionCellMarkup(unit.heatmap.deployment,'Deployment')}${conditionCellMarkup(unit.heatmap.incidents,'Incidents')}${conditionCellMarkup(unit.heatmap.voluntary_wellbeing,'Voluntary wellbeing')}${conditionCellMarkup(unit.heatmap.data_coverage,'Data coverage')}</div><details class="explanation"><summary>Why flagged?</summary><div class="contributor-list">${asArray(unit.early_indicator?.contributors).map(c=>`<div class="contributor"><strong>${esc(c.label)}</strong><span>${esc(c.detail)}</span></div>`).join('')||'<p>No elevated contributor.</p>'}</div></details></article>`).join('')}</div>`;}
async function loadCommanderIndicators(){const container=$('#commander-indicators-content');container.innerHTML=loadingMarkup(5);const data=await getCommanderData(),indicators=asArray(data.early_indicators);container.innerHTML=`<div class="page-heading"><div><p class="eyebrow">Predictive decision support</p><h1>Early Indicators</h1><p>A transparent seven-day outlook for organizational conditionsâ€”not a personal or medical prediction.</p></div></div><div class="notice-card"><strong>${esc(data.prototype?.method||'Transparent rules baseline')}</strong><p>Prototype demonstration using simulated data. No clinical accuracy or probability is claimed.</p></div><div class="grid-2">${indicators.map(item=>`<article class="indicator-card"><div class="card-heading"><div><p class="eyebrow">Next ${esc(item.horizon_days||7)} days Â· ${esc(item.unit)}</p><h2>${esc(item.label)}</h2></div>${statusChip(item.level)}</div><div class="contributor-list">${asArray(item.contributors).map(c=>`<div class="contributor"><strong>${esc(c.label)}</strong><span>${esc(c.detail)}</span></div>`).join('')||'<p>No elevated contributor.</p>'}</div><div class="case-meta"><span><b>Data availability</b>${esc(item.data_availability?.available||0)}/${esc(item.data_availability?.possible||0)} signals</span><span><b>Data quality</b>${esc(item.data_quality)}</span></div><p class="decision-note">${esc(item.disclaimer)}</p></article>`).join('')}</div>`;}
async function loadCommanderActions(){const container=$('#commander-actions-content');container.innerHTML=loadingMarkup(5);const data=await getCommanderData(true),actions=asArray(data.actions),units=asArray(data.units);container.innerHTML=`<div class="page-heading"><div><p class="eyebrow">Detect â†’ Explain â†’ Act â†’ Measure</p><h1>Priority Organizational Actions</h1><p>Give every response an owner, review date, baseline and measurable outcome.</p></div></div><div class="grid-2"><section class="surface section-block"><div class="card-heading"><div><p class="eyebrow">New organizational response</p><h2>Record an action</h2></div></div><form id="org-action-form"><label>Affected unit<select name="unit_id">${units.map(unit=>`<option value="${unit.unit_id}">${esc(unit.unit)}</option>`).join('')}</select></label><label>Issue / action title<input name="title" value="Review duty roster" minlength="3" required></label><label>Evidence<textarea name="evidence" minlength="3" required>Overtime and recovery conditions remain elevated.</textarea></label><label>Suggested organizational response<textarea name="suggested_response" minlength="3" required>Review rotation, staffing and protected recovery time.</textarea></label><label>Owner<input name="owner" value="Operations" required></label><label>Review date<input name="review_date" type="date" value="${futureDate(14)}" required></label><button class="button primary" type="submit">Create action</button></form></section><section><div class="grid-1">${actions.length?actions.map(actionCard).join(''):emptyMarkup('No actions yet','Record the first organizational response.')}</div></section></div>`;$('#org-action-form').addEventListener('submit',async event=>{event.preventDefault();const form=event.currentTarget,fd=new FormData(form),button=form.querySelector('button');button.disabled=true;try{await api('/api/commander/actions',{method:'POST',body:JSON.stringify({unit_id:Number(fd.get('unit_id')),title:fd.get('title'),evidence:fd.get('evidence'),suggested_response:fd.get('suggested_response'),owner:fd.get('owner'),review_date:fd.get('review_date')})});commanderData=null;toast('Organizational action created with the current unit baseline.');await loadCommanderActions();}catch(error){toast(error.message);button.disabled=false;}});bindCommanderActions();}
function futureDate(days){const date=new Date();date.setDate(date.getDate()+days);return localDateKey(date);}
function commanderTrendMarkup(rows){if(!rows.length)return emptyMarkup('No trend yet','Organizational records will build the trend.');const totalHigh=rows.reduce((n,r)=>n+(r.high_load_units||0),0),totalMonitor=rows.reduce((n,r)=>n+(r.monitor_units||0),0);return `<canvas id="cmd-trend-chart" width="1000" height="280" role="img" aria-label="Organizational pressure trend across ${rows.length} days: ${totalHigh} high-load unit-days and ${totalMonitor} monitor unit-days"></canvas><div class="trend-legend" aria-hidden="true"><span><i class="high"></i>High load units</span><span><i class="monitor"></i>Monitor units</span><span><i class="overtime"></i>Total overtime hours</span></div><p class="source-note">Last 30 days, aggregated across all units. First day: ${rows[0].high_load_units||0} high Â· ${rows[0].monitor_units||0} monitor. Latest: ${rows[rows.length-1].high_load_units||0} high Â· ${rows[rows.length-1].monitor_units||0} monitor.</p>`;}
function drawCommanderTrend(rows){const canvas=$('#cmd-trend-chart');if(!canvas)return;const {ctx,width:W,height:H}=sizeCanvas(canvas,240),data=asArray(rows),left=34,right=12,top=14,bottom=28,maxY=Math.max(2,...data.map(r=>Math.max(r.high_load_units||0,r.monitor_units||0))),maxOT=Math.max(1,...data.map(r=>r.overtime_hours||0));const X=i=>left+i/Math.max(1,data.length-1)*(W-left-right),Y=v=>H-bottom-v/maxY*(H-bottom-top),YO=v=>H-bottom-v/maxOT*(H-bottom-top)*.5;ctx.strokeStyle=themeColor('--line');ctx.fillStyle=themeColor('--muted');ctx.font='11px system-ui';for(let tick=0;tick<=maxY;tick+=Math.max(1,Math.ceil(maxY/4))){const y=Y(tick);ctx.setLineDash([4,4]);ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(W-right,y);ctx.stroke();ctx.fillText(String(tick),4,y+4);}ctx.setLineDash([]);ctx.fillText(String(data[0].date).slice(5),left,H-8);ctx.fillText('today',W-right-32,H-8);ctx.strokeStyle=themeColor('--blue');ctx.lineWidth=2;ctx.beginPath();data.forEach((r,i)=>i?ctx.lineTo(X(i),YO(r.overtime_hours||0)):ctx.moveTo(X(0),YO(r.overtime_hours||0)));ctx.stroke();ctx.strokeStyle='#c0392b';ctx.lineWidth=2.5;ctx.beginPath();data.forEach((r,i)=>i?ctx.lineTo(X(i),Y(r.high_load_units||0)):ctx.moveTo(X(0),Y(r.high_load_units||0)));ctx.stroke();ctx.strokeStyle='#f39c12';ctx.lineWidth=2.5;ctx.beginPath();data.forEach((r,i)=>i?ctx.lineTo(X(i),Y(r.monitor_units||0)):ctx.moveTo(X(0),Y(r.monitor_units||0)));ctx.stroke();}
async function loadCommanderTrends(){const container=$('#commander-trends-content');container.innerHTML=loadingMarkup(5);const data=await getCommanderData();container.innerHTML=`<div class="page-heading"><div><p class="eyebrow">30-day aggregate view</p><h1>Organizational Pressure Trend</h1><p>Follow conditions and intervention outcomes over timeâ€”never individual wellbeing or case activity.</p></div></div><section class="surface section-block">${commanderTrendMarkup(asArray(data.trend))}</section><section class="surface section-block"><div class="card-heading"><div><p class="eyebrow">Intervention outcomes</p><h2>What changed after action?</h2></div></div>${asArray(data.outcomes).length?`<div class="grid-2">${asArray(data.outcomes).map(actionCard).join('')}</div>`:emptyMarkup('No outcomes reviewed yet','Actions will appear here after a follow-up measurement.')}</section>`;bindCommanderActions();drawCommanderTrend(asArray(data.trend));}
function bindCommanderActions(){$$('[data-advance-action]').forEach(button=>button.onclick=async()=>{const note=await askNote({title:'Simulate a 14-day follow-up?',help:'This changes only simulated demo outcome data and will be labelled as a prototype.',label:'Optional presenter note',confirm:'Advance demo'});if(note===null)return;try{await api(`/api/commander/actions/${button.dataset.advanceAction}/advance-demo`,{method:'POST',body:'{}'});commanderData=null;toast('Simulated 14-day outcome recorded.');await renderRoute();}catch(error){toast(error.message);}});$$('[data-action-status]').forEach(button=>button.onclick=async()=>{const current=button.dataset.currentStatus,choices={'Planned':'In progress','In progress':'Review due','Review due':'Completed','Improving':'Completed','No improvement':'In progress'};const next=choices[current];if(!next){toast('This action is already complete.');return;}const note=await askNote({title:`Move action to ${next}?`,help:'The change is added to the organizational action timeline.',label:'Optional note',confirm:'Update'});if(note===null)return;try{await api(`/api/commander/actions/${button.dataset.actionStatus}`,{method:'POST',body:JSON.stringify({status:next})});commanderData=null;toast(`Action updated to ${next}.`);await renderRoute();}catch(error){toast(error.message);}});}

api('/api/me', { silentAuth: true }).then(payload => { me = payload.user; boot(); }).catch(() => {});
