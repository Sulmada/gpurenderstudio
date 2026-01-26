// backend/queue.js – Phase 1.3 + STALE RECOVERY
"use strict";

const fs = require("fs");
const path = require("path");

const STORE_PATH = path.resolve(__dirname, "queue_store.json");

// --------------------------------------------------
// Internal helpers
// --------------------------------------------------
function loadStore() {
  if (!fs.existsSync(STORE_PATH)) {
    const empty = { jobs: [] };
    fs.writeFileSync(STORE_PATH, JSON.stringify(empty, null, 2));
    return empty;
  }

  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const data = JSON.parse(raw);
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
// Queue core (Phase 1.3)
// --------------------------------------------------
function addProject(job) {
  const store = loadStore();
  store.jobs.push(job);
  saveStore(store);
  return job;
}

// Returns next eligible job without modifying state
function getNextQueued() {
  const store = loadStore();
  return (
    store.jobs.find(j => j.status === "confirmed") ||
    store.jobs.find(j => j.status === "queued") ||
    null
  );
}

// Worker claims job (atomic transition → running)
function claimNextQueued() {
  const store = loadStore();

  let idx = store.jobs.findIndex(j => j.status === "confirmed");
  if (idx === -1) {
    idx = store.jobs.findIndex(j => j.status === "queued");
  }
  if (idx === -1) return null;

  const job = store.jobs[idx];

  job.status = "running";
  job.timestamps = job.timestamps || {};
  job.timestamps.started = new Date().toISOString();

  store.jobs[idx] = job;
  saveStore(store);
  return job;
}

// Update job after modification
function updateJob(updatedJob) {
  const store = loadStore();
  const idx = store.jobs.findIndex(j => j.job_id === updatedJob.job_id);
  if (idx === -1) return null;

  store.jobs[idx] = updatedJob;
  saveStore(store);
  return updatedJob;
}

function getJob(id) {
  const store = loadStore();
  return store.jobs.find(j => j.job_id === id) || null;
}

// --------------------------------------------------
// Query helpers
// --------------------------------------------------
function getJobsByStatus(status) {
  const store = loadStore();
  return store.jobs.filter(j => j.status === status);
}

function listJobs() {
  const store = loadStore();
  return store.jobs.slice();
}

function getJobsByEmail(email) {
  if (!email) return [];
  const store = loadStore();
  return store.jobs.filter(j => j.meta && j.meta.email === email);
}

// --------------------------------------------------
// Queue stats for pricing engine
// --------------------------------------------------
function getQueueLength() {
  const store = loadStore();
  return store.jobs.filter(
    j => j.status === "confirmed" || j.status === "queued"
  ).length;
}

function hasRunningJob() {
  const store = loadStore();
  return store.jobs.some(j => j.status === "running");
}

// --------------------------------------------------
// Phase 1.3 convenience
// --------------------------------------------------
function listActive() {
  const store = loadStore();
  return store.jobs.filter(j => j.status === "running");
}

function listCompleted() {
  const store = loadStore();
  return store.jobs.filter(j =>
    j.status === "success" ||
    j.status === "partial_success" ||
    j.status === "failed"
  );
}

// --------------------------------------------------
// STALE RECOVERY (Phase 1.3 Release Requirement)
// --------------------------------------------------
function markStaleRunning(maxAgeMs = 6 * 3600 * 1000) {
  const store = loadStore();
  const now = Date.now();
  let changed = false;

  for (const job of store.jobs) {
    if (job.status === "running" && job.timestamps?.started) {
      const started = new Date(job.timestamps.started).getTime();
      if (!Number.isNaN(started) && now - started > maxAgeMs) {
        job.status = "failed";
        job.stop_reason = "STALE_RECOVERY";
        job.timestamps.ended = new Date().toISOString();
        changed = true;
      }
    }
  }

  if (changed) saveStore(store);
}

// --------------------------------------------------
// EXPORT
// --------------------------------------------------
module.exports = {
  addProject,
  getNextQueued,
  claimNextQueued,
  updateJob,
  getJob,
  listJobs,
  listActive,
  listCompleted,
  getJobsByEmail,
  getJobsByStatus,
  getQueueLength,
  hasRunningJob,
  markStaleRunning
};
