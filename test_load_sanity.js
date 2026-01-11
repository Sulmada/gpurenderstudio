const axios = require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");

const API = "http://localhost:3001/api/upload";

// Viktigt: detta ska vara din korta testfil (1–20 frames, 64 samples)
const TEST_FILE = path.join(__dirname, "test_20f.blend");

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function submitJob(label) {
  const form = new FormData();
  form.append("file", fs.createReadStream(TEST_FILE));
  form.append("project_type", "blender");
  form.append("email", "sanity@test.com");
  form.append("name", label);
  form.append("description", "phase1-sanity");

  const res = await axios.post(API, form, {
    headers: form.getHeaders()
  });

  console.log(`Submitted: ${label} → ${res.data.job_id}`);
}

// ------------------------------------------------------------
// SANITY RUN
// ------------------------------------------------------------
async function run() {

  // -----------------------------
  // Phase A – Idle → Light
  // -----------------------------
  console.log("Phase A: wake system");
  await submitJob("sanity-A1");
  await sleep(3000);

  // -----------------------------
  // Phase B – Normal → Busy
  // -----------------------------
  console.log("Phase B: apply gentle pressure");
  await submitJob("sanity-B1");
  await sleep(1500);
  await submitJob("sanity-B2");

  // -----------------------------
  // Phase C – release
  // -----------------------------
  console.log("Phase C: release and observe recovery");
  console.log("No more jobs submitted.");

  console.log("Sanity test complete.");
}

run().catch(err => {
  console.error("Sanity test failed:", err.message);
});
