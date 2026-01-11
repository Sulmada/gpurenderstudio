const internalMap = require("./internal_reason_map");
const policyMap = require("./policy_reason_map");

// compute preset classes
const computeClasses = new Set([
  "MEMORY_BUDGET_EXCEEDED",
  "GEOMETRY_TOO_LARGE",
  "SAMPLE_BUDGET_EXCEEDED",
  "TIMELINE_TOO_LONG",
  "PHASE1_PRESET_VIOLATION"
]);

// next-profile map
function nextProfile(cur) {
  if (cur === "STRICT") return "EXTENDED";
  if (cur === "EXTENDED") return "FLEXIBLE";
  if (cur === "FLEXIBLE") return "OPEN";
  return null;
}

// Reason builder
function buildReason(entry, internalCode, context) {
  const reason = {
    class: entry.class,
    details: entry.details || null,
    actions: entry.actions || null,
    internal: internalCode,
    timestamp: new Date().toISOString()
  };

  // post-process compute presets
  if (computeClasses.has(reason.class)) {
    const cur = context?.pricing_snapshot?.execution_profile || null;
    const nxt = nextProfile(cur);

    if (nxt) {
      reason.actions = [`UPGRADE_TO_${nxt}`];
    } else {
      // ex: already OPEN
      reason.actions = ["NONE"];
    }
  }

  return reason;
}

// Main mapper
function mapInternalToReason(internalCode, context = {}) {

  // 1) Worker/internal reason (full qualified keys)
  if (internalCode in internalMap) {
    return buildReason(internalMap[internalCode], internalCode, context);
  }

  // 2) Phase1/Policy reasons (fallback to backend)
  if (internalCode in policyMap) {
    return buildReason(policyMap[internalCode], internalCode, context);
  }

  // 3) Fallback
  const fallback = policyMap.__DEFAULT__ || {
    class: "UNKNOWN_FAILURE",
    details: null,
    actions: ["NONE"]
  };

  return buildReason(fallback, internalCode, context);
}

module.exports = { mapInternalToReason };
