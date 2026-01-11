// backend/fail_policy.js
module.exports = {
  TIMEOUT: {
    fail_class: "OWNER_NOTIFY",
    owner_notify: true,
    customer_action: null
  },

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

  PRESET_VIOLATION: {
    fail_class: "CUSTOMER_ACTION",
    owner_notify: false,
    customer_action: "Project exceeds Phase 1 limits"
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
