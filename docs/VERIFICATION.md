# Verification guide

Run these checks before presenting or deploying the prototype.

## Automated checks

With Node.js 22 or later:

```bash
npm ci
npm run verify
```

`npm run check` performs JavaScript syntax validation. `npm test` creates an isolated temporary SQLite database, seeds deterministic simulated data, starts a temporary server, exercises the role/privacy/workflow contracts, and removes the database afterward. It must never use the working demo database.

## Required API/privacy scenarios

- Personnel check-in persists mood, stress, sleep, and energy and appears in personal Progress.
- Assessment completion persists the correct display direction and appears in Assessment history and Progress.
- Personnel support request rejects any attempted Journal share, preserves selected/unselected fields, creates a sourced case and timeline, and appears in the Welfare queue.
- Welfare sees only case-authorized voluntary context, updates the case through a valid transition, and Personnel sees the new status/follow-up.
- Commander cannot read a person, support case, audit trail, assessment answer, Journal entry, or journal analysis.
- Commander voluntary aggregates include only opted-in contributors and suppress groups below the configured minimum.
- Seven-day early indicators have contributors, horizon, data availability, limitations, and no probability/diagnosis claim.
- An organizational action stores the same unit baseline shown in Commander Units, then records a review/outcome without changing case data.
- Re-seeding twice cannot retain or rebind old cases, notes, shares, sessions, audits, or actions.

## Responsive matrix

Test each role at 360, 390, 430, 768, and at least 1366 CSS pixels wide.

At every viewport verify:

- `document.documentElement.scrollWidth <= window.innerWidth`;
- every active navigation destination is reachable without clipped labels;
- no table forces horizontal document scrolling;
- mobile unit/case data appears as cards or stacked rows;
- controls are at least 44 by 44 CSS pixels where practical;
- charts remain readable and have a nearby text summary;
- long names, units, evidence, and notes wrap safely;
- the Journal editor, microphone, language selector, review box, and save state remain usable.

## Keyboard and screen-reader pass

For every workspace:

1. Navigate from the skip link through the full page using only Tab/Shift+Tab.
2. Confirm a visible focus indicator on every interactive element.
3. Confirm the current page is exposed with `aria-current` and focus moves to the page heading after navigation.
4. Confirm every input has a programmatic label and errors/status updates are announced.
5. Confirm Journal tabs expose tab/tab-panel semantics and respond to arrow keys.
6. Confirm urgency, status, and trends include text/icons in addition to color.
7. Confirm reduced-motion preference removes non-essential animation.

## Failure and offline pass

- Block each major API request and verify skeleton/loading state becomes an explicit error with Retry, without leaving stale data presented as current.
- Go offline while editing the Journal; verify the UI shows `Saved on device`, survives reload, and later shows `Synced` after reconnecting.
- Expire the session; verify the user returns to sign-in with an understandable message rather than a broken view.
- Deny microphone permission; verify writing remains available and the error explains how to continue.
- Voice AI pass: run `npm run fetch-voice-model` once, then in Personnel → Journal → Write tap Speak privately. Verify a one-time model-load progress appears, words are transcribed on-device phrase-by-phrase in Hindi/English/Hinglish, no phrase repeats, no audio file is stored, and approved text lands in the editor. Deny the mic and verify guided recovery; test in Chrome/Edge/Firefox on Windows and Android.

## Demo-data consistency pass

Choose 148 Bn and compare its displayed overtime, recovery, leave pressure, deployment, incident, voluntary-coverage, and status values across:

- Commander Overview;
- Units heatmap and unit detail;
- Early Indicators and contributor evidence;
- the baseline of a newly created organizational action;
- Trends/outcome cards;
- a related Personnel Work Context;
- a Welfare case only when that context is policy-authorized or deliberately shared.

Different roles may receive different fields, but the same field/window must not disagree.

