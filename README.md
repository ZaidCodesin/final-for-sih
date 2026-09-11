# ProtecT â€” PS26186

ProtecT is a connected, privacy-preserving welfare decision-support prototype for Smart India Hackathon Problem Statement **26186**: â€œAI-Based Predictive Personnel Stress and Welfare Monitoring System for Uniformed Forces.â€

It is designed around one loop:

```text
DATA â†’ INSIGHT â†’ DECISION â†’ ACTION â†’ FOLLOW-UP â†’ OUTCOME
```

The product gives Personnel a private space for reflection and self-understanding, gives Welfare Officers a sourced and actionable support workflow, and gives Commanders aggregate organizational conditions they can improve. Private journal content never enters Welfare cases, Commander analytics, or prediction.

> **Prototype demonstration using simulated data.** The public demo is not a production force system, and its early indicators are transparent decision rulesâ€”not diagnoses, probabilities, or clinically validated predictions.

## Connected role experiences

### Personnel

- Calm Home focused on a private wellbeing space, private Write/Speak actions, a 30-second mood/stress/sleep/energy check-in, personal patterns, weekly trends, recent reflections, WHO-5, compact Work Context, and support status.
- Protected **Private Journal â†’ Write â†’ Daily Insights â†’ Progress** experience with autosave, voice dictation review, Hindi/English/Hinglish direction, entry history, and personal reflective analytics.
- WHO-5, PSS-10, GAD-7, and PHQ-9 screening tools with history, direction-aware trends, non-diagnostic explanations, and Progress integration.
- Detailed Work Context with source, purpose, update time, official records, and tracked correction requests.
- Privacy & Support center with four data classes, a â€œwho can see whatâ€ matrix, aggregate-consent control, data-access history, and case-scoped sharing choices.
- Voluntary support request whose status is reflected back after Welfare contact/follow-up. Journal data is permanently excluded.

### Welfare Officer

- One canonical **Support Queue** instead of separate algorithmic roster/alert lists.
- Every case shows its source, priority, assigned officer, shared context, last contact, next action, due date, and age.
- Case detail with minimum authorized context, a timeline, notes, strict lifecycle transitions, and scheduled follow-up.
- Separate Follow-ups and Record Reviews workspaces so HR correction is not mixed with personal support priority.
- Actionable operational insights: case priority, follow-up state, age, response time, volume, and source distribution.

### Commander

- â€œ**Conditions, never case files**â€ boundary across all screens.
- Concise Operational Conditions overview with units needing attention, explainable drivers, priority organizational actions, recent outcomes, and a 30-day trend.
- Unit heatmap/comparison covering overtime, leave pressure, recovery, deployment, incidents, consented voluntary aggregate, and data coverage.
- Transparent seven-day Early Indicators with contributors, data availability, quality limitations, and no fake precision.
- Organizational Actions with issue, evidence, affected unit, suggested response, owner, status, review date, baseline, follow-up, and outcome.
- No individual identity, private assessment answers, Welfare cases/notes, Journal text, or journal analytics.

## Privacy model

| Class | Default and allowed use |
| --- | --- |
| Private Journal | Personnel owner only. No sharing field exists; excluded from every operational model and role payload. |
| Voluntary Wellbeing | Private by default; selected fields can be shared for a support case, and affirmative consent is required for sufficiently large Commander aggregates. |
| Organizational / Work | Personnel sees their own records; Welfare receives only legitimate case-relevant context; Commander receives unit aggregates. |
| Support Case | Personnel sees their own request/status; authorized Welfare casework receives the case; Commander never receives it. |

Safeguards include server-side role guards, owner-scoped journal routes, deny-by-default probes for private resources, case-scoped sharing snapshots, small-group suppression, consent-aware voluntary aggregates, audit events, input validation, HTTP-only sessions, same-origin write checks, CSP/security headers, and deterministic privacy regression tests.

## Predictive and explainable baseline

The demoâ€™s seven-day early indicator starts with an explainable organizational baseline. It considers trends such as overtime, recovery opportunity, leave pressure, deployment intensity, and incident exposure; a voluntary wellbeing aggregate is considered only when consent and coverage rules permit it.

The output is a broad `Normal`, `Monitor`, or `High` condition label with:

- a stated seven-day horizon;
- leading contributors and plain-language evidence;
- available/possible signal count;
- a data-quality label and limitations;
- the statement â€œDecision-support indicator â€” not a diagnosis or probability.â€

No accuracy claim is made from simulated data. A validated institutional model can later replace this baseline through the same domain boundary after prospective validation, bias/calibration review, governance approval, monitoring, and rollback planning.

## Technology

- Node.js 22+
- Express 4
- built-in `node:sqlite`
- dependency-light vanilla HTML, CSS, and JavaScript client
- no external database, chart library, frontend framework, or build step

The database is the source of record, while centralized domain helpers build role-safe projections so the same unit value is reused in Commander Overview, Units, Early Indicators, Actions, Trends, and authorized contextual views.

## Run locally

```bash
npm ci
npm run seed
npm start
```

Open `http://localhost:4400`.

The sign-in page labels these accounts as an **Explore demo** environment. Unless overridden, seeded accounts use password `demo123`:

- Personnel Demo: `sepoy.demo`
- Welfare Officer Demo: `welfare`
- Commander Demo: `commander`
- Seeded service IDs: `CRPF100001` through `CRPF100150`

Do not enable demo credentials or public self-registration in a production deployment.

## Verify

```bash
npm run verify
```

The regression suite creates a temporary SQLite database, seeds it, launches an isolated server, tests authentication/RBAC/privacy and connected role workflows, and removes the temporary database. It does not modify the working demo database.

The required manual responsive/accessibility/offline matrix is documented in [docs/VERIFICATION.md](docs/VERIFICATION.md).

## Private on-device voice AI (Speak privately)

The journal Speak button uses a real on-device neural model (quantized Whisper),
not the phone's built-in voice typing: free, no API key, and no audio ever
leaves the device. One-time setup per machine or deploy (downloads ~163MB of
vendored runtime + model files into git-ignored `public/vendor/voice`):

```bash
npm run fetch-voice-model
npm start
```

Tap Speak privately in Personnel â†’ Journal â†’ Write. The first run shows a
one-time model-load progress; afterwards it works offline. If the model files
are missing, the app falls back to browser voice typing, then to writing.

## Repository map

```text
server.js                  Express APIs, sessions, authorization, role DTOs
lib/db.js                  SQLite schema and compatible migrations
lib/risk.js                Explainable current/early-indicator rules
lib/recommend.js           Non-disciplinary support-plan mapping
lib/journal-analyze.js     Private local reflective-writing statistics
lib/seed.js                Deterministic simulated connected-story dataset
lib/voice-text.js          Tested voice transcript merge/dedupe/language helpers
lib/fetch-voice-model.js   One-time fetch of vendored on-device voice AI assets
public/index.html          Role-aware application shell and semantic views
public/app.js              SPA routing, rendering, events, voice/autosave
public/voice-worker.js     Off-thread on-device Whisper transcription worker
public/style.css           Responsive design system and role presentation
test-regression.js         Privacy, workflow, consistency, and RBAC suite
docs/ARCHITECTURE.md       Demo trust model and proposed production design
docs/SIH_DEMO_STORY.md     Connected 18-step judging runbook
docs/FEATURE_DECISIONS.md  KEEP/MOVE/MERGE/RENAME/REDESIGN decision register
docs/VERIFICATION.md       Test, mobile, accessibility, and failure matrix
```

## Deployment realism

The included Render configuration is only for a disposable SIH demonstration. SQLite state on an ephemeral host must not be represented as durable or production-secure.

A proposed force-controlled production designâ€”on-premise/intranet, approved government cloud, SSO/MFA, scoped RBAC/ABAC, encryption and key management, append-only audit, retention, HR adapters, low-connectivity sync, backups, monitoring, threat controls, and model governanceâ€”is documented separately in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Non-goals

ProtecT is not an AI therapist, psychiatric diagnostic system, face/voice emotion detector, personnel leaderboard, disciplinary tool, or channel for Commander access to private reflection or Welfare case notes.

