# SENTINEL connected SIH demo story

This runbook demonstrates one connected system rather than three unrelated dashboards. All names and records are simulated.

## Setup

Run the deterministic seed, start the server, and open the local URL shown in the terminal. Use the disclosed Personnel, Welfare Officer, and Commander demo accounts. Keep three browser profiles or sign out between roles so session state is unambiguous.

## Story

1. **Explore the Personnel Demo.** Point out the “Demo environment” label, then sign in as Rahul.
2. **Start from personal value.** The home screen opens with “Your private wellbeing space,” not an employer score.
3. **Use the protected Journal.** Open Write, show the optional prompt, type or use Speak privately, and demonstrate Hindi, English, or Hinglish input.
4. **Show the privacy boundary.** The Journal states that content and reflective analytics are owner-only and excluded from Welfare, Commander, and prediction.
5. **Open Daily Insights and Progress.** Show the preserved personal topics, emotional tone, time orientation, mindset, senses, pronouns, writing activity, and longer-term view. Explain that unusual text metrics are experimental personal insights, not diagnoses.
6. **Complete the 30-second check-in.** Enter mood, stress, sleep, and energy. The Home and Progress views update from the same saved event.
7. **Open Assessments.** Complete or inspect WHO-5 history. Show score direction, the non-diagnostic explanation, and the saved Progress trend.
8. **Explain the personal pattern.** Open “Something worth noticing” and its evidence, such as lower sleep alongside longer-duty days. State that this is an observed association, not causation.
9. **Open Work Context.** Show Rahul's official duty/overtime/leave/recovery records, their source and update time, why they are used, and the tracked “Report incorrect record” action.
10. **Request support voluntarily.** In Privacy & Support, choose a broad reason and select exactly which context Welfare may see. Leave at least one optional field unselected.
11. **Show the locked journal.** The request visibly says “PRIVATE JOURNAL — LOCKED — not shared.” Submit and note the received case ID/status.
12. **Switch to the Welfare Officer Demo.** The same new case appears in the single Support Queue with its explicit source: “Personnel requested support.” No second risk roster competes with it.
13. **Open the case.** Show only the selected voluntary fields, allowed work context, assigned officer, source, timeline, last contact, next action, due date, and notes. Point out the absent Journal.
14. **Contact Rahul.** Change status to Contacted, add a brief note/next action, and schedule a follow-up. The timeline records the event.
15. **Return to Personnel.** Rahul now sees “Contacted” or the scheduled follow-up in Privacy & Support. This closes the request-to-response loop.
16. **Switch to the Commander Demo.** Lead with “Conditions, never case files.” The Commander cannot see Rahul, the support case, assessments, or Journal.
17. **Open Units and Early Indicators.** Show the same unit metrics in Overview, heatmap, unit details, and the seven-day indicator. Expand “Why?” to show overtime, recovery, leave, deployment, incidents, consented voluntary coverage, and data-quality limitations.
18. **Act and measure.** Open Actions, record or inspect a roster/recovery intervention, then use the clearly labelled prototype follow-up control to advance 14 days. Compare the stored baseline with the follow-up and show `Improving`, `No improvement`, or `Review due` in Trends/Overview.

## Judge-facing summary

The story should land four distinctions:

- **Personal value without surveillance:** the Journal and assessments help the person first.
- **Consent and least privilege:** only selected context creates a Welfare connection; the Journal never crosses it.
- **Prediction that explains itself:** early indicators forecast unit conditions over a stated horizon using visible contributors and data coverage, not a black-box medical score.
- **Action with accountability:** Welfare follow-up and Commander organizational interventions have sources, owners, dates, timelines, and measurable outcomes.

## Questions to invite

- Ask the judge to try a Commander request for a private endpoint; the server should reject it.
- Ask why a unit trend is hidden; demonstrate minimum response thresholds and consent-aware coverage.
- Ask where a number came from; trace it to the shared domain payload and source/update explanation.
- Ask whether the model is clinically validated; answer no—the demo uses a transparent simulated baseline and documents the validation path required for production.

