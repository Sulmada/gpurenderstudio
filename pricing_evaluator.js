function determinePricingState({ queueLength, hasRunningJob }) {

  // Absolut idle
  if (!hasRunningJob && queueLength === 0) {
    return "IDLE";
  }

  // GPU idle men jobb på väg in
  if (!hasRunningJob) {
    if (queueLength <= 1) return "LIGHT";
    if (queueLength <= 3) return "NORMAL";
    return "BUSY";
  }

  // GPU busy
  if (hasRunningJob) {
    if (queueLength === 0) return "NORMAL";
    if (queueLength <= 2) return "BUSY";
    return "SATURATED";
  }
}

module.exports = determinePricingState;
