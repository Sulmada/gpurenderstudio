// cancel_active_jobs.js
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "queue_store.json");
const now = new Date().toISOString();

const data = JSON.parse(fs.readFileSync(FILE, "utf8"));

for (const job of data.jobs) {
  if (job.status === "running" || job.status === "queued") {
    job.status = "cancelled";
    job.fail_class = "OWNER_NOTIFY";
    job.fail_code = "MANUAL_ABORT";
    job.customer_action = null;
    job.owner_notify = true;
    job.timestamps.ended = now;
  }
}

fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
console.log("All running/queued jobs cancelled cleanly.");
