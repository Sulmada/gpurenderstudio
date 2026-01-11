// backend/reason/policy_reason_map.js
//
// Detta mappar backend "fail_code" och Phase1-policyfel
// till Reason-klasser. Worker-koder hanteras i internal_reason_map.

module.exports = {
  PRESET_VIOLATION: {
    class: "PHASE1_PRESET_VIOLATION",
    details: "Project exceeds Phase 1 preset limits",
    actions: null // sätts av mapper baserat på profil-val
  },

  MISSING_TEXTURES: {
    class: "MISSING_ASSETS",
    details: "Missing textures or external assets",
    actions: ["FIX_TEXTURE_PATHS"]
  },

  MISSING_OUTPUT_NODE: {
    class: "INVALID_PROJECT_STRUCTURE",
    details: "No output node configured",
    actions: ["ADD_OUTPUT_NODE"]
  },

  EMPTY_TIMELINE: {
    class: "INVALID_PROJECT_STRUCTURE",
    details: "Timeline contains no renderable frames",
    actions: ["FIX_TIMELINE"]
  },

  BLENDER_START_FAILED: {
    class: "RENDER_FAILURE",
    details: "Blender could not start",
    actions: ["RETRY"]
  },

  TIMEOUT: {
    class: "RUNTIME_WINDOW_EXCEEDED",
    details: "Render exceeded allowed window",
    actions: ["UPGRADE_PROFILE"] // mappas senare till nästa profil
  },

  // Fallback: Phase1 använder detta om inget matchar
  __DEFAULT__: {
    class: "UNKNOWN_FAILURE",
    details: null,
    actions: ["NONE"]
  }
};
