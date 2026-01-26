// execution_profiles.js
// GPU Render Studio – Phase 1.3 Policy Profiles
//
// OBS: Detta beskriver inte tidsgränser eller priser.
// De hanteras av slot-limits + contract_type.
// Detta layer beskriver endast hur runtime-stopp hanteras.

module.exports = {
  BUDGET_STOP: {
    id: "BUDGET_STOP",
    display: "Budget Stop",
    description: "Stoppar rendering när kontraktsbudget nås. Partial output tillåten.",
    notes: "Används när kund vill begränsa kostnad eller tid.",
    type: "RUNTIME_POLICY"
  },

  HARD_RUN: {
    id: "HARD_RUN",
    display: "Hard Run",
    description: "Fortsätter rendering tills scenen är klar eller kap träffas.",
    notes: "Overflow tillåts. Kräver kundens explicita val vid risk.",
    type: "RUNTIME_POLICY"
  },

  TIMEBOXED: {
    id: "TIMEBOXED",
    display: "Timeboxed",
    description: "Stoppar rendering strikt vid slot-limit. Ingen overflow.",
    notes: "Bra för utveckling, demo eller strikt kontroll utan billing-risk.",
    type: "RUNTIME_POLICY"
  }
};
