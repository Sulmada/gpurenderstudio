// execution_profiles.js
// Phase 1.1 – Fixed execution contracts
// Price represents risk & capacity reservation, not guaranteed runtime.
// Runtime may be extended automatically during idle capacity.
// Price and snapshot are locked at submission.

module.exports = {
  STRICT: {
    id: "STRICT",
    label: "Strict",
    base_runtime_ms: 90 * 60 * 1000, // 1.5 h
    entry_price_usd: 0.50,
    floor_usd: 0.50,
    description: "Tight execution window for small or well-bounded scenes.",
    tooltip: [
      "Base runtime: 1.5 hours",
      "Lowest risk contract",
      "Idle capacity may extend runtime automatically",
      "Fixed per-job price. Failed jobs are not charged."
    ]
  },

  EXTENDED: {
    id: "EXTENDED",
    label: "Extended",
    base_runtime_ms: 4 * 60 * 60 * 1000, // 4 h
    entry_price_usd: 2.00,
    floor_usd: 2.00,
    description: "Extended execution window for larger or more complex projects.",
    tooltip: [
      "Base runtime: 4 hours",
      "Moderate risk contract",
      "Idle capacity may extend runtime automatically",
      "Higher capacity reservation"
    ]
  },

  FLEXIBLE: {
    id: "FLEXIBLE",
    label: "Flexible",
    base_runtime_ms: 8 * 60 * 60 * 1000, // 8 h
    entry_price_usd: 4.00,
    floor_usd: 4.00,
    description: "Flexible window for long-running or complex renders.",
    tooltip: [
      "Base runtime: 8 hours",
      "High tolerance for long renders",
      "Idle capacity may extend runtime automatically",
      "Fixed per-job price"
    ]
  },

  OPEN: {
    id: "OPEN",
    label: "Open",
    base_runtime_ms: 12 * 60 * 60 * 1000, // 12 h
    entry_price_usd: 5.00,
    floor_usd: 5.00,
    description: "Open execution window with minimal constraints.",
    tooltip: [
      "Base runtime: 12 hours",
      "Highest risk contract",
      "For heavy or unpredictable workloads",
      "Idle capacity may extend runtime automatically"
    ]
  }
};
