# Feature decision register

This register records the repository audit performed before the connected-system redesign. It protects useful functionality while making deliberate changes to confusing or unsafe presentation.

| Existing area | Decision | Result |
| --- | --- | --- |
| Personnel Private Journal | KEEP + REDESIGN | Preserve the editor, voice review, multilingual direction, private storage, recent entries, and recognizable writing experience; improve hierarchy, prompts, accessibility, offline status, and history. |
| Journal Daily Insights | KEEP + REDESIGN | Preserve mindset, feeling, topics, time orientation, senses, pronouns, and speed; organize as a personal story and label experimental methods/limits. |
| Journal Progress | KEEP + MERGE | Preserve writing history and analytics; add personal wellbeing, assessment, theme, and work-association trends across time ranges. |
| Assessments | KEEP + CONNECT | Preserve WHO-5, PSS-10, GAD-7, PHQ-9 and the runner; add saved history, direction-aware trends, explanations, next actions, and Progress integration. |
| Personnel Support Priority card | REMOVE | Do not show an employer-style personal ranking on Home. Replace it with a private wellbeing space and autonomy-supportive insight. |
| Personnel check-in | KEEP + REDESIGN | Reduce Home to mood, stress, sleep, and energy; save once and update every personal downstream view. |
| Personnel HR records | MOVE | Put detailed records, provenance, purpose, and update time in Work Context. |
| Personnel correction form | MOVE | Keep it under Work Context as “Report incorrect record,” with tracked status. |
| Personnel access log | MOVE + EXPAND | Put it in Privacy & Support beside the visibility matrix and consent controls. |
| Personnel support request | ADD | Add field-level sharing, a permanently locked Journal, received/contacted/follow-up status, and Welfare hand-off. |
| Welfare alerts and priority roster | MERGE | Replace two competing person-risk lists with one sourced Support Queue. |
| Welfare person-risk detail | REMOVE + REDESIGN | Use a case detail scoped by source, assignment, authorized context, timeline, notes, next action, due date, and follow-up. |
| Welfare record corrections | KEEP + MOVE | Separate Record Reviews from support cases and preserve its audit trail. |
| Welfare charts | REDESIGN | Retain only priority, follow-up, age, response-time, volume, and source views that guide action. |
| Commander privacy guardrail | KEEP | Make “Conditions, never case files” a permanent, prominent boundary. |
| Commander Support Priority trend | RENAME + REDESIGN | Use Organizational Pressure Trend derived from organizational conditions, never individual support scoring. |
| Commander unit table | MOVE + REDESIGN | Create Units with an explained heatmap, desktop comparison, and mobile cards. |
| Priority Organizational Actions | KEEP + CONNECT | Add evidence, unit, suggested response, owner, status, review date, baseline, follow-up, and outcome. |
| Predictive requirement | ADD | Add transparent seven-day unit early indicators with leading contributors, data availability, limitations, and no fake probability. |
| Demo role selector | RENAME + REDESIGN | Use “Explore demo” and state that production access is role-authenticated. |
| Scattered UI formulas/numbers | REMOVE | Compute reusable role-safe domain payloads on the server and render them consistently. |
| Legacy placeholders/duplicate cards | REMOVE | Eliminate unused banner/UI selectors, redundant KPIs, and charts without a decision or action. |

## Preserved guarantees

- Journal content remains owner-only.
- Voice input remains available with human review for doubtful phrases.
- Hindi, English, and Hinglish remain first-class writing directions.
- Daily Insights and Progress remain named, visible Journal destinations.
- Record correction, assessment screening, Welfare follow-up, and organizational actions remain functional rather than decorative.
- No design simplification is allowed to remove a working user outcome.

