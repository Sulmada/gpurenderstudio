// backend/pricing_logger.js
const fs = require("fs");
const path = require("path");

const LOG_FILE = path.join(__dirname, "pricing_log.jsonl");

function logPricingSnapshot(snapshot) {
  try {
    fs.appendFileSync(
      LOG_FILE,
      JSON.stringify(snapshot) + "\n",
      "utf8"
    );
  } catch (err) {
    console.error("PRICING LOG ERROR:", err);
  }
}

module.exports = { logPricingSnapshot };
