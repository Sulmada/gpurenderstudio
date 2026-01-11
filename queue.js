// backend/queue.js

var fs   = require("fs");
var path = require("path");

var STORE_PATH = path.resolve(__dirname, "queue_store.json");

// --------------------------------------------------
// INTERNAL HELPERS
// --------------------------------------------------
function loadStore() {
  if (!fs.existsSync(STORE_PATH)) {
    var empty = { jobs: [] };
    fs.writeFileSync(STORE_PATH, JSON.stringify(empty, null, 2));
    return empty;
  }

  try {
    var raw  = fs.readFileSync(STORE_PATH, "utf8");
    var data = JSON.parse(raw);
    if (!data || !Array.isArray(data.jobs)) return { jobs: [] };
    return data;
  } catch (err) {
    console.error("[QUEUE] Corrupt store, resetting:", err.message);
    return { jobs: [] };
  }
}

function saveStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

// --------------------------------------------------
// CORE QUEUE OPERATIONS
// --------------------------------------------------
function addProject(job) {
  var store = loadStore();
  store.jobs.push(job);
  saveStore(store);
  return job;
}

function getNextQueued() {
  var store = loadStore();
  return store.jobs.find(j => j.status === "queued") || null;
}

function updateJob(updatedJob) {
  var store = loadStore();
  var idx = store.jobs.findIndex(j => j.job_id === updatedJob.job_id);
  if (idx === -1) return null;

  store.jobs[idx] = updatedJob;
  saveStore(store);
  return updatedJob;
}

function getJob(id) {
  var store = loadStore();
  return store.jobs.find(j => j.job_id === id) || null;
}

function listJobs() {
  var store = loadStore();
  return store.jobs.slice();
}

// --------------------------------------------------
// ACCOUNT / PRICING HELPERS
// --------------------------------------------------
function getJobsByEmail(email) {
  if (!email) return [];
  var store = loadStore();
  return store.jobs.filter(j => j.meta && j.meta.email === email);
}

// --------------------------------------------------
// QUEUE STATE HELPERS
// --------------------------------------------------
function getQueueLength() {
  var store = loadStore();
  return store.jobs.filter(j => j.status === "queued").length;
}

function hasRunningJob() {
  var store = loadStore();
  return store.jobs.some(j => j.status === "running");
}

module.exports = {
  addProject,
  getNextQueued,
  updateJob,
  getJob,
  listJobs,
  getJobsByEmail,
  getQueueLength,
  hasRunningJob
};
