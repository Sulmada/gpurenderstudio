// pricing_engine.js
// Phase 1 – Time multiplier engine (LOCKED)

let state = {
  state: "NORMAL",
  time_multiplier: 1.0,
  since: new Date().toISOString(),
  last_evaluated: new Date().toISOString()
};

function evaluatePricing({ queueLength, hasRunningJob }) {
  let next;

  if (queueLength === 0 && !hasRunningJob) {
    next = { state: "IDLE", time_multiplier: 1.42 };
  } else if (queueLength <= 1) {
    next = { state: "NORMAL", time_multiplier: 1.0 };
  } else if (queueLength <= 3) {
    next = { state: "BUSY", time_multiplier: 0.83 };
  } else {
    next = { state: "SATURATED", time_multiplier: 0.5 };
  }

  if (next.state !== state.state) {
    state = {
      ...next,
      since: new Date().toISOString(),
      last_evaluated: new Date().toISOString()
    };
  } else {
    state.last_evaluated = new Date().toISOString();
  }
}

function getCurrentPricingState() {
  return state;
}

module.exports = {
  evaluatePricing,
  getCurrentPricingState
};
