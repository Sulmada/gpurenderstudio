var fs = require("fs");
var path = require("path");

var METRICS_PATH = path.join(__dirname, "..", "metrics", "jobs.jsonl");

function logJobMetrics(entry) {
  try {
    var line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(METRICS_PATH, line, "utf8");
  } catch (err) {
    // Metrics får aldrig påverka drift
    console.error("METRICS_WRITE_FAILED", err.message);
  }
}

module.exports = {
  logJobMetrics
};
