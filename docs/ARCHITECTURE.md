# SENTINEL architecture and trust model

SENTINEL is a privacy-preserving welfare decision-support prototype for SIH PS26186. It connects personal reflection, voluntary wellbeing, authorized Welfare casework, and aggregate organizational action without treating them as one unrestricted dataset.

## What is implemented in the demo

The demo is a dependency-light Express application backed by SQLite and a vanilla responsive web client. The database is the source of record; role-specific API serializers decide which subset of that record each workspace can receive.

The demo supports:

- role-authenticated Personnel, Welfare Officer, and Commander workspaces;
- server-side role guards and deny-by-default sensitive routes;
- owner-only private journal storage and personal journal analytics;
- voluntary check-ins and standard screening histories;
- case-scoped sharing choices for a Personnel support request;
- a sourced Welfare support queue, case timeline, notes, follow-ups, and record reviews;
- aggregate Commander unit conditions with small-group suppression and consent-aware voluntary signals;
- transparent seven-day early indicators based on organizational conditions;
- organizational action tracking with baseline, follow-up, and outcome states;
- an audit trail for sensitive reads and material workflow changes;
- deterministic simulated data for a repeatable judging story.

This is a prototype demonstration using simulated data. The early indicator is a transparent decision rule, not a clinically validated model, medical diagnosis, or probability of harm.

## Four data classes

| Data class | Examples | Personnel | Welfare Officer | Commander |
| --- | --- | --- | --- | --- |
| Private journal | text, dictation transcript, topics, tone, time orientation, writing patterns | owner only | never | never |
| Voluntary wellbeing | mood, stress, sleep, energy, WHO-5/PSS-10/GAD-7/PHQ-9 | private by default | only fields deliberately shared for an authorized case | consented aggregate only, suppressed for small groups |
| Organizational/work | duty, overtime, leave, deployment, recovery, staffing, incidents, training | own records | minimum case-relevant context permitted by policy or explicitly shared | unit aggregate only |
| Support case | case source, selected context, assignment, timeline, notes, next action, due date | own status and sharing choices | authorized casework | never |

The schema deliberately has no journal-sharing field. Journal content and journal-derived analytics are not inputs to Welfare prioritization, Commander trends, or organizational prediction.

## Connected information flow

```text
PERSONNEL                          ORGANIZATIONAL RECORDS
Journal (private)                  Duty / overtime / leave /
Check-in / assessment             recovery / deployment / incidents
        |                                      |
        v                                      v
Personal insight                         Unit condition model
        |                                      |
optional, field-level share              +----+------------------+
        |                                 |                       |
        v                                 v                       v
Sourced Welfare case              Early indicator        Commander aggregate
        |                                                     |
contact / follow-up                                      organizational action
        |                                                     |
        +---------------- outcome / status -------------------+
```

## Authorization boundaries

Authentication alone is not treated as authorization. The server applies role checks before handlers run, resolves the current account from an HTTP-only session cookie, and returns role-specific data-transfer objects.

Important boundaries:

- Personnel journal APIs always scope by the authenticated account's `personnel_id`.
- There is no cross-person journal endpoint; explicit probes are rejected.
- Welfare case detail is reached through a case ID, not an unrestricted personnel profile.
- Shared voluntary context is selected and stored per case. A request cannot include a journal field.
- Commander endpoints contain unit identifiers and aggregates, never person or case identifiers.
- Voluntary Commander aggregates require affirmative aggregate consent and a minimum group size.
- Support-case reads and changes, consent changes, record-review changes, and action changes are audited.

Role guards are a useful prototype control, not a complete production authorization system. Production must also enforce officer assignment, unit/region scope, purpose of use, separation of duties, break-glass approval, and periodic entitlement review through the institutional identity provider.

## Explainable early indicators

The demo derives broad `Normal`, `Monitor`, or `High` organizational condition labels and seven-day early indicators from explainable inputs such as:

- overtime relative to the unit baseline;
- consecutive or extended duty load;
- recovery opportunity;
- leave pressure;
- deployment intensity;
- incident exposure;
- voluntary wellbeing aggregate only where consent and coverage thresholds are satisfied.

Every indicator includes its horizon, leading contributors, data availability, quality limitations, and a non-diagnostic notice. The UI must not turn the internal calculation into a precise personal risk percentage.

The transparent baseline is intentionally replaceable. A validated institutional model can later implement the same domain interface after representative-data validation, bias review, calibration, drift monitoring, and independent governance approval.

## Proposed production architecture

The following is a target architecture, not a claim about the public demo.

```text
Force SSO + MFA
       |
Policy enforcement gateway ---- centralized RBAC/ABAC policy
       |
Role-scoped application services
  |         |          |          |
Journal   Wellbeing   Casework   Org conditions
vault     service     service    + prediction
  |         |          |          |
  +---------+----------+----------+
            encrypted data platform
         /         |          \
HR/duty adapter  append-only   governed analytics
                 audit store   and model registry
```

### Hosting profiles

1. **Force-controlled intranet/on premises.** Containerized services run inside the force network, with internal DNS, institutional certificates, hardware-backed keys, restricted administration, and no dependency on public browser services.
2. **Approved government cloud.** Use an accredited region and services, private networking, customer-managed keys, centralized security monitoring, approved backup locations, and explicit data-residency controls.
3. **Disconnected or low-connectivity post.** A local encrypted client queue stores only the minimum pending write, shows device/sync state, and reconciles through authenticated, idempotent events when a trusted link returns. Policy and revocation bundles must have bounded offline lifetimes.

### Production controls required

- Force SSO, phishing-resistant MFA, device posture, short sessions, rotation, and central revocation.
- Fine-grained RBAC/ABAC for assignment, unit, region, purpose, and case state.
- TLS in transit; field- or service-level encryption for journals, assessment answers, notes, and identity mappings; keys held outside the application database.
- CSRF protection, restrictive CSP, input validation, rate limiting, malware-safe attachments if introduced, and an API gateway/WAF.
- An append-only, tamper-evident audit stream separated from operational administrators, with alerts for bulk or unusual access.
- Approved retention schedules, legal holds, correction processes, consent receipts, deletion/archival rules, and backup expiry.
- Encrypted, tested backups; point-in-time recovery; documented RPO/RTO; periodic restoration exercises.
- HR/duty-system adapters with source identifiers, effective timestamps, validation, reconciliation, and an owner for corrections.
- Monitoring for availability, queue lag, authorization denials, audit delivery, data coverage, indicator drift, and model/service versions.
- Independent penetration testing, privacy impact assessment, threat modelling, clinical/occupational oversight, and incident-response exercises.

## Threat and misuse considerations

| Risk | Required response |
| --- | --- |
| Commander attempts to inspect a person or case | reject server-side; log repeated probes; do not merely hide UI |
| Welfare user browses without a legitimate case | require assignment/purpose; audit view; alert on bulk access |
| Journal data leaks into analytics | keep separate data product and interface; automated contract tests forbid journal fields downstream |
| Small group reveals contributors | minimum-group suppression, interval/coverage disclosure, complementary suppression where needed |
| Demo credentials reach production | production startup must fail when demo mode or shared credentials are enabled |
| HR record is stale or wrong | show provenance/update time and offer a tracked Record Review workflow |
| Prediction is treated as diagnosis | broad labels, contributor evidence, limitations, human decision, no fake probability |
| Offline device is lost | encrypted local store, device binding, minimum cache, remote revocation, short offline lifetime |

## Model governance path

Before a learned model is used operationally, define the target and intervention decision, establish a lawful data basis, assess label quality, document missingness, split data by time/unit to prevent leakage, compare against the transparent baseline, report calibration and subgroup performance, and run a prospective silent evaluation. Deployment requires a model card, versioned feature contract, approval owner, monitoring thresholds, rollback path, and scheduled review. Accuracy must never be fabricated from simulated demo data.

## Verification expectations

- API regression tests cover role denials, journal isolation, consent filtering, field-level support sharing, case transitions, Personnel status reflection, organizational actions, and outcomes.
- Syntax checks run for server and client JavaScript.
- Responsive browser tests cover 360, 390, 430, 768, and desktop widths with no document overflow.
- Keyboard and accessibility checks cover page focus, form labels, visible focus, tab semantics, status announcements, and text alternatives for charts.
- Seed tests run destructive reset twice and verify that no case, note, or action is rebound to a reused identity.

