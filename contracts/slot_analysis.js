// backend/contracts/slot_analysis.js
// GPU RENDER STUDIO – PHASE 1.3
// Slot analysis for real_precheck (STRICT / EXTENDED / FLEXIBLE / OPEN_FIXED_MAX)

"use strict";

// Base slot limits (hours), ska matcha api_confirm.js
const SLOT_LIMITS = {
  STRICT: 1.5,
  EXTENDED: 4.0,
  FLEXIBLE: 8.0,
  OPEN_FIXED_MAX: 12.0
};

const ORDER = ["STRICT", "EXTENDED", "FLEXIBLE", "OPEN_FIXED_MAX"];

function analyzeSlots(effectiveHours) {
  const h = Number(effectiveHours || 0);
  if (!Number.isFinite(h) || h <= 0) {
    return {
      input_hours: h,
      slot_analysis: [],
      recommended_profile: null,
      safe_profile: null,
      guaranteed_profile: null,
      risk_flag: "INVALID_INPUT"
    };
  }

  const rows = ORDER.map(slot => {
    const limit = SLOT_LIMITS[slot];
    const fits_base = h <= limit;
    const near_limit = h > limit * 0.8 && h <= limit;
    const exceeds = h > limit;

    return {
      slot,
      base_hours_limit: limit,
      fits_base,
      near_limit,
      exceeds
    };
  });

  // minsta slot där h får plats inom base_limit
  const recommended =
    ORDER.find(slot => h <= SLOT_LIMITS[slot]) || null;

  // safe_profile: ett snäpp ovan recommended (om möjligt)
  let safe = recommended;
  if (recommended) {
    const idx = ORDER.indexOf(recommended);
    if (idx >= 0 && idx + 1 < ORDER.length) {
      safe = ORDER[idx + 1];
    }
  }

  // guaranteed_profile:
  //  - om h <= 12 => OPEN_FIXED_MAX
  //  - om h > 12 => null (överskrider Phase 1)
  let guaranteed = null;
  if (h <= SLOT_LIMITS.OPEN_FIXED_MAX) {
    guaranteed = "OPEN_FIXED_MAX";
  }

  // Risk-flaggar för UI:
  //  - FITS_RECOMMENDED: får plats i recommended utan overflow
  //  - NEAR_LIMIT_RECOMMENDED: väldigt nära gränsen
  //  - REQUIRES_OVERFLOW_OR_UPGRADE: går ej in i STRICT, kräver EXTENDED/FLEX/OPEN
  //  - EXCEEDS_PHASE1: > 12h
  let risk_flag = "FITS_RECOMMENDED";

  if (h > SLOT_LIMITS.OPEN_FIXED_MAX) {
    risk_flag = "EXCEEDS_PHASE1";
  } else if (recommended) {
    const limit = SLOT_LIMITS[recommended];
    if (h > limit * 0.8 && h <= limit) {
      risk_flag = "NEAR_LIMIT_RECOMMENDED";
    } else if (recommended !== "STRICT") {
      // Enkelt sätt att signalera att vi redan lämnat STRICT
      risk_flag = "REQUIRES_OVERFLOW_OR_UPGRADE";
    }
  }

  return {
    input_hours: h,
    slot_analysis: rows,
    recommended_profile: recommended,
    safe_profile: safe,
    guaranteed_profile: guaranteed,
    risk_flag
  };
}

module.exports = {
  analyzeSlots,
  slotAnalysis: analyzeSlots // för bakåtkompatibilitet
};
