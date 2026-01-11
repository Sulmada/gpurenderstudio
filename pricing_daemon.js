const { getQueueLength, hasRunningJob } = require("./queue");
const { evaluatePricing } = require("./pricing_engine");

console.log("Pricing daemon started");

setInterval(() => {
  evaluatePricing({
    queueLength: getQueueLength(),
    hasRunningJob: hasRunningJob()
  });
}, 10 * 60 * 1000); // var 10:e minut
