'use strict';
/* SENTINEL — Welfare Intervention Recommendation System
 * Maps risk factors -> prioritized, welfare-focused (never disciplinary) actions.
 */
const RULES = [
  { when: 'incidents',     rec: { type: 'counseling',         reason: 'Recent incident exposure — recommend voluntary trauma-informed counseling session' } },
  { when: 'stress_trend',  rec: { type: 'counseling',         reason: 'Sustained/rising self-reported stress — voluntary counseling recommended' } },
  { when: 'assessment',    rec: { type: 'counseling',         reason: 'Standardized wellness assessment above threshold — professional follow-up' } },
  { when: 'sleep',         rec: { type: 'medical_check',      reason: 'Sleep degradation pattern — medical/behavioural sleep evaluation' } },
  { when: 'overtime',      rec: { type: 'workload_rebalance', reason: 'Sustained overtime — rebalance duty roster' } },
  { when: 'deployment',    rec: { type: 'rest_rotation',      reason: 'Prolonged deployment — schedule rotation/rest cycle' } },
  { when: 'family_sep',    rec: { type: 'family_leave',       reason: 'Extended family separation — prioritize family travel leave' } },
  { when: 'leave_denials', rec: { type: 'family_leave',       reason: 'Multiple denied leave requests — review leave balance and welfare priority' } },
  { when: 'transfers',     rec: { type: 'peer_support',       reason: 'Frequent relocation — offer local orientation and peer-support contact' } }
];

function recommend(factors) {
  const keys = new Set(factors.map(f => f.key));
  const out = [];
  for (const r of RULES) if (keys.has(r.when)) out.push(r.rec);
  if (!out.length && factors.length) {
    out.push({ type: 'peer_support', reason: 'Early indicators present — preventive welfare check-in' });
  }
  return out.slice(0, 4);
}

module.exports = { recommend };
