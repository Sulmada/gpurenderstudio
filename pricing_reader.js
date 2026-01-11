// pricing_reader.js
const pricingEngine = require("./pricing_engine");
const queue = require("./queue");

setInterval(() => {
  pricingEngine.evaluatePricing({
    queueLength: queue.getQueueLength(),
    hasRunningJob: queue.hasRunningJob()
  });
}, 60000); // 60s

module.exports = {
  getCurrentPricingState: pricingEngine.getCurrentPricingState
};
