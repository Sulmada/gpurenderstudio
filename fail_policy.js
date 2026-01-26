// backend/fail_policy.js
// GPU RENDER STUDIO – PHASE 1.3
//
// Viktigt i Phase 1.3:
// - TIME_LIMIT och BUDGET/CAP är INTE fail, utan partial_success.
// - Endast hårda renderfel, startfel eller valideringsfel ska hit.
// - CUSTOMER_ACTION används endast för precheck/scene-fel som användaren kan fixa.

"use strict";

module.exports = {
  // ============================================================
  // RENDER / ENGINE FAILS (hårda backend-fel)
  // ============================================================

  BLENDER_CRASH: {
    fail_class: "OWNER_NOTIFY",
    owner_notify: true,
    customer_action: null
  },

  BLENDER_START_FAILED: {
    fail_class: "OWNER_NOTIFY",
    owner_notify: true,
    customer_action: null
  },

  NO_OUTPUT_PRODUCED: {
    fail_class: "OWNER_NOTIFY",
    owner_notify: true,
    customer_action: null
  },

  INTERNAL_CONTRACT_VIOLATION: {
    fail_class: "OWNER_NOTIFY",
    owner_notify: true,
    customer_action: null
  },

  // ============================================================
  // PRECHECK / SCENE VALIDATION FAILS (kunden kan åtgärda)
  // ============================================================

  SCENE_UNSUPPORTED: {
    fail_class: "CUSTOMER_ACTION",
    owner_notify: false,
    customer_action: "Scene uses unsupported engine or missing camera"
  },

  INVALID_SCENE: {
    fail_class: "CUSTOMER_ACTION",
    owner_notify: false,
    customer_action: "Scene cannot be validated (corrupt blend or invalid settings)"
  },

  MISSING_CAMERA: {
    fail_class: "CUSTOMER_ACTION",
    owner_notify: false,
    customer_action: "No active camera in scene"
  },

  INVALID_ENGINE: {
    fail_class: "CUSTOMER_ACTION",
    owner_notify: false,
    customer_action: "Unsupported render engine (only Cycles supported)"
  },

  // ============================================================
  // PHASE 1 LEGACY (fortfarande kund-fixbara)
  // ============================================================

  PRESET_VIOLATION: {
    fail_class: "CUSTOMER_ACTION",
    owner_notify: false,
    customer_action: "Project exceeds Phase requirements"
  },

  MISSING_TEXTURES: {
    fail_class: "CUSTOMER_ACTION",
    owner_notify: false,
    customer_action: "Missing textures or external assets"
  },

  MISSING_OUTPUT_NODE: {
    fail_class: "CUSTOMER_ACTION",
    owner_notify: false,
    customer_action: "No output node configured"
  },

  EMPTY_TIMELINE: {
    fail_class: "CUSTOMER_ACTION",
    owner_notify: false,
    customer_action: "Timeline contains no renderable frames"
  }
};
