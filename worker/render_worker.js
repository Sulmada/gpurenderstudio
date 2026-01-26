// backend/worker/render_worker.js - Phase 1.3 hardening (worker meta, heartbeat, graceful stop)
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const queue = require("../queue");
const { logJobMetrics } = require("../metrics_writer");
const failPolicy = require("../fail_policy");
const { computeTimeLimits, computeBilling } = require("./runtime_budget");

require("../pricing_engine");

// -------------------------------------------------------------
// CONSTANTS
// -------------------------------------------------------------
const IDLE_SLEEP_MS = 3000;
const PAUSED_SLEEP_MS = 5000;

const RENDER_ROOT = "/mnt/c/gpu_render_service/renders";
const SYSTEM_CONTROL_PATH = path.join(__dirname, "..", "system_control.json");

// Direct WSL path to Blender.exe
const BLENDER_EXE =
  "/mnt/c/Program Files/Blender Foundation/Blender 5.0/blender.exe";

// -------------------------------------------------------------
// ENV CONSTANTS
// -------------------------------------------------------------
const NODE_ID = process.env.NODE_ID || "node-local-1";
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 15000);
const RENDER_KILL_GRACE_MS = Number(process.env.RENDER_KILL_GRACE_MS || 15000);

// -------------------------------------------------------------
// HELPERS
// -------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSystemControl() {
  try {
    return JSON.parse(fs.readFileSync(SYSTEM_CONTROL_PATH, "utf8"));
  } catch {
    return { ingest_enabled: false, worker_enabled: false };
  }
}

function wslToWindowsPath(p) {
  return p
    .replace(/^\/mnt\/([a-z])\//i, (_, d) => `${d.toUpperCase()}:\\`)
    .replace(/\//g, "\\");
}

function initJobMeta(job) {
  job.timestamps = job.timestamps || {};
  job.meta = job.meta || {};
  if (typeof job.meta.email !== "string") {
    job.meta.email = "";
  }
  job.payment = job.payment || { status: "UNPAID" };
}

function ensureContractShape(job) {
  if (!job) throw new Error("MISSING_JOB");
  if (!job.contract || typeof job.contract !== "object") {
    throw new Error("MISSING_CONTRACT");
  }
  if (!job.real_precheck || job.real_precheck.status !== "OK") {
    throw new Error("MISSING_REAL_PRECHECK");
  }

  const c = job.contract;
  if (!Number.isFinite(c.base_hours_limit) || c.base_hours_limit <= 0) {
    throw new Error("INVALID_CONTRACT_BASE_LIMIT");
  }
  if (!Number.isFinite(c.hourly_rate_usd) || c.hourly_rate_usd < 0) {
    throw new Error("INVALID_CONTRACT_RATE");
  }
  if (!Number.isFinite(c.base_price_usd) || c.base_price_usd < 0) {
    throw new Error("INVALID_CONTRACT_BASE_PRICE");
  }
}

function mapErrorToFailCode(err) {
  const msg = err && err.message ? String(err.message) : "";

  if (msg.startsWith("BLENDER_START_FAILED")) return "BLENDER_START_FAILED";
  if (msg.startsWith("BLENDER_EXIT_")) return "BLENDER_CRASH";
  if (msg === "NO_OUTPUT") return "NO_OUTPUT_PRODUCED";
  if (msg === "MISSING_CONTRACT" || msg === "MISSING_REAL_PRECHECK") {
    return "INTERNAL_CONTRACT_VIOLATION";
  }

  return "BLENDER_START_FAILED";
}

function nowIso() {
  return new Date().toISOString();
}

function validateOutput(job) {
  const outputDir = path.join(RENDER_ROOT, job.job_id);
  if (!fs.existsSync(outputDir)) return 0;
  return fs.readdirSync(outputDir).filter((f) => !f.startsWith(".")).length;
}

function setWorkerMeta(job, patch) {
  job.worker = job.worker || {};
  Object.assign(job.worker, patch);
  queue.updateJob(job);
}

// -------------------------------------------------------------
// runBlenderRender (timeboxed)
// - onSpawn(child) is called once with the spawned process
// returns { status, exit_code, signal, stop_mechanism }
// status: finished | time_limited | error
// stop_mechanism: null | SIGTERM | SIGTERM_THEN_SIGKILL | SIGKILL
// -------------------------------------------------------------
function runBlenderRender(job, maxRuntimeMs, onSpawn) {
  return new Promise((resolve, reject) => {
    ensureContractShape(job);

    const outputDir = path.join(RENDER_ROOT, job.job_id);
    fs.mkdirSync(outputDir, { recursive: true });

    const blendPath = wslToWindowsPath(job.file_path || job.blend_path);
    const outBase = wslToWindowsPath(path.join(outputDir, "frame_#####"));

    const args = [
      "-b",
      blendPath,
      "--factory-startup",
      "-E",
      "CYCLES",
      "-o",
      outBase,
      "-a"
    ];

    let finished = false;
    let timeLimited = false;
    let timeout = null;
    let stopMechanism = null;
    let termTimer = null;

    // -----------------------------------
    // PROGRESS INIT
    // -----------------------------------
    job.progress = job.progress || {};

    job.progress.frames_done = 0;
    job.progress.percent = 0;
    job.progress.eta_seconds = null;
    job.progress.last_update = new Date().toISOString();
    job.progress.source = "worker";

    // -----------------------------------
    // TOTAL FRAMES (from real_precheck)
    // -----------------------------------
    if (job.real_precheck?.timing?.total_frames) {
      job.progress.frames_total = Number(
        job.real_precheck.timing.total_frames
      );
    } else {
      job.progress.frames_total = null;
    }

    queue.updateJob(job);

    console.log(`[BLENDER] spawn job=${job.job_id}`);
    console.log(`[BLENDER] exe=${BLENDER_EXE}`);
    console.log(`[BLENDER] blend=${blendPath}`);
    console.log(`[BLENDER] outBase=${outBase}`);
    console.log(`[BLENDER] args=${JSON.stringify(args)}`);
    console.log(
      `[BLENDER] maxRuntimeMs=${
        Number.isFinite(maxRuntimeMs) ? maxRuntimeMs : "Infinity"
      }`
    );

    const blender = spawn(BLENDER_EXE, args, { windowsHide: true });

    if (typeof onSpawn === "function") {
      try {
        onSpawn(blender);
      } catch {}
    }

    // -----------------------------------
    // FRAME PARSER (Blender stdout)
    // -----------------------------------
    const FRAME_RE = /Fra(?:me)?\s+(\d+)/i;

    const startTs = Date.now();

    function updateProgress(frame) {
      // prevent regress
      if (
        typeof job.progress.frames_done === "number" &&
        frame <= job.progress.frames_done
      ) {
        return;
      }

      const total = job.progress.frames_total;

      job.progress.frames_done = frame;

      if (typeof total === "number" && total > 0) {
        job.progress.percent = Math.min(
          100,
          Math.round((frame / total) * 1000) / 10
        );

        const elapsed = (Date.now() - startTs) / 1000;
        const fps = frame / Math.max(elapsed, 1);

        if (fps > 0) {
          const remaining = total - frame;
          job.progress.eta_seconds = Math.round(remaining / fps);
        }
      }

      job.progress.last_update = new Date().toISOString();
      queue.updateJob(job);
    }

    if (blender.stdout) {
      blender.stdout.on("data", (buf) => {
        const s = String(buf || "").trim();
        if (!s) return;

        console.log(`[BLENDER:stdout] ${s}`);

        const m = s.match(FRAME_RE);
        if (m) {
          const frame = Number(m[1]);
          if (Number.isFinite(frame)) {
            updateProgress(frame);
          }
        }
      });
    }

    if (blender.stderr) {
      blender.stderr.on("data", (buf) => {
        const s = String(buf || "").trim();
        if (!s) return;
        console.error(`[BLENDER:stderr] ${s}`);
      });
    }

    // -----------------------------------
    // KILL HANDLING
    // -----------------------------------
    function killGracefully() {
      if (finished) return;

      timeLimited = true;

      try {
        console.warn(`[BLENDER] time limit reached, SIGTERM job=${job.job_id}`);
        blender.kill("SIGTERM");
        stopMechanism = "SIGTERM";
      } catch (e) {
        console.error(
          `[BLENDER] SIGTERM failed job=${job.job_id}: ${
            e && e.message ? e.message : e
          }`
        );
      }

      termTimer = setTimeout(() => {
        if (finished) return;
        try {
          console.warn(`[BLENDER] grace elapsed, SIGKILL job=${job.job_id}`);
          blender.kill("SIGKILL");
          stopMechanism = "SIGTERM_THEN_SIGKILL";
        } catch (e) {
          console.error(
            `[BLENDER] SIGKILL failed job=${job.job_id}: ${
              e && e.message ? e.message : e
            }`
          );
          if (!stopMechanism) stopMechanism = "SIGKILL";
        }
      }, RENDER_KILL_GRACE_MS);
    }

    if (Number.isFinite(maxRuntimeMs) && maxRuntimeMs > 0) {
      timeout = setTimeout(() => {
        if (!finished) killGracefully();
      }, maxRuntimeMs);
    }

    // -----------------------------------
    // PROCESS EVENTS
    // -----------------------------------
    blender.on("error", (err) => {
      if (timeout) clearTimeout(timeout);
      if (termTimer) clearTimeout(termTimer);

      console.error(
        `[BLENDER] spawn error job=${job.job_id}: ${
          err && err.message ? err.message : err
        }`
      );

      reject(
        new Error(
          `BLENDER_START_FAILED:${err && err.message ? err.message : "unknown"}`
        )
      );
    });

    blender.on("exit", (code, signal) => {
      console.log(
        `[BLENDER] exit event job=${job.job_id} code=${code} signal=${
          signal || "none"
        }`
      );
    });

    blender.on("close", (code, signal) => {
      finished = true;

      if (timeout) clearTimeout(timeout);
      if (termTimer) clearTimeout(termTimer);

      console.log(
        `[BLENDER] close event job=${job.job_id} code=${code} signal=${
          signal || "none"
        } timeLimited=${timeLimited}`
      );

      if (timeLimited) {
        return resolve({
          status: "time_limited",
          exit_code: null,
          signal: signal || null,
          stop_mechanism: stopMechanism || "SIGTERM_THEN_SIGKILL"
        });
      }

      if (code === 0) {
        return resolve({
          status: "finished",
          exit_code: 0,
          signal: signal || null,
          stop_mechanism: null
        });
      }

      return resolve({
        status: "error",
        exit_code: code,
        signal: signal || null,
        stop_mechanism: null
      });
    });
  });
}

// -------------------------------------------------------------
// MAIN LOOP
// -------------------------------------------------------------
async function run() {
  console.log("[WORKER] booting main loop");

  // Phase 1.3 legacy: mark running jobs stale on boot (orphaned after restart)
  if (typeof queue.markStaleRunning === "function") {
    try {
      queue.markStaleRunning();
    } catch (e) {
      console.error("[WORKER] markStaleRunning failed", e);
    }
  }

  for (;;) {
    const sys = getSystemControl();
    if (!sys.worker_enabled) {
      await sleep(PAUSED_SLEEP_MS);
      continue;
    }

    const job = queue.claimNextQueued();
    if (!job) {
      await sleep(IDLE_SLEEP_MS);
      continue;
    }

    initJobMeta(job);

    job.timestamps.started = nowIso();
    job.stop_reason = null;
    job.stop_mechanism = null;
    job.fail_code = null;
    job.fail_class = null;
    job.owner_notify = null;
    job.customer_action = null;

    job.worker = {
      node_id: NODE_ID,
      pid: null,
      last_seen: nowIso()
    };

    queue.updateJob(job);

    let heartbeatTimer = null;

    try {
      ensureContractShape(job);
      const contract = job.contract;

      const limits = computeTimeLimits(contract);
      const maxRuntimeMs = Number.isFinite(limits.maxRuntimeHours)
        ? limits.maxRuntimeHours * 3600000
        : Infinity;

      heartbeatTimer = setInterval(() => {
        try {
          setWorkerMeta(job, { last_seen: nowIso() });
        } catch (e) {
          console.error("[HEARTBEAT] update failed", e);
        }
      }, HEARTBEAT_INTERVAL_MS);

      const t0 = Date.now();

      const result = await runBlenderRender(job, maxRuntimeMs, (child) => {
        const pid = child && typeof child.pid === "number" ? child.pid : null;
        setWorkerMeta(job, { pid: pid, last_seen: nowIso() });
      });

      const t1 = Date.now();

      const runtimeSeconds = Math.max(0, (t1 - t0) / 1000);
      const runtimeHours = runtimeSeconds / 3600;

      if (result.status === "error") {
        throw new Error(`BLENDER_EXIT_${result.exit_code}`);
      }

      const fileCount = validateOutput(job);
      if (fileCount === 0) {
        throw new Error("NO_OUTPUT");
      }

      const billing = computeBilling(contract, runtimeHours, limits);
      job.billing = billing;

      const businessStop = billing.stop_reason || null;

      job.stop_reason = businessStop;
      job.stop_mechanism = result.stop_mechanism || null;

      const isTimeLimited = result.status === "time_limited";
      const isPartial = !!billing.completed_partial || isTimeLimited;

      if (businessStop === "CAP") {
        job.status = "paused_cap";
      } else {
        job.status = isPartial ? "partial_success" : "success";
      }

      job.timestamps.ended = nowIso();
      queue.updateJob(job);

      const ps = job.pricing_snapshot || {};
      const maxRuntimeLegacyMs =
        ps.base_runtime_ms ||
        ps.runtime_ms ||
        (Number.isFinite(limits.slotBudgetLimit)
          ? limits.slotBudgetLimit * 3600000
          : maxRuntimeMs);

      logJobMetrics({
        timestamp: nowIso(),
        job_id: job.job_id,
        trace_id: job.trace_id,
        email: job.meta.email,
        execution_profile:
          ps.execution_profile || contract.execution_mode || "UNKNOWN",
        execution_status:
          job.status === "paused_cap"
            ? "PAUSED_CAP"
            : isPartial
              ? "PARTIAL"
              : "SUCCESS",
        fail_class: null,
        runtime_seconds: Math.round(runtimeSeconds),
        pricing_state: ps.pricing_state || "UNKNOWN",
        price_usd: billing.billed_usd,
        max_runtime_ms: maxRuntimeLegacyMs,
        slot: contract.slot,
        base_hours_limit: contract.base_hours_limit,
        overflow_hours: billing.overflow_hours,
        cap_enabled: billing.cap_enabled,
        cap_usd: billing.cap_usd,
        stop_reason: job.stop_reason
      });

      console.log(
        `[WORKER] Job ${job.job_id} completed status=${job.status} billed=${billing.billed_usd} USD stop_reason=${job.stop_reason || "NONE"} stop_mechanism=${job.stop_mechanism || "NONE"}`
      );
    } catch (err) {
      const msg = err && err.message ? err.message : "unknown";
      console.error(`[WORKER] Job failed: ${msg}`);

      job.status = "failed";
      job.timestamps.ended = nowIso();

      const failCode = mapErrorToFailCode(err);
      job.fail_code = failCode;

      const policy = failPolicy[failCode] || {
        fail_class: "OWNER_NOTIFY",
        owner_notify: true,
        customer_action: null
      };

      job.fail_class = policy.fail_class;
      job.owner_notify = policy.owner_notify;
      job.customer_action = policy.customer_action;

      job.stop_reason = "FAILED";
      job.stop_mechanism = "EXCEPTION";

      queue.updateJob(job);

      const ps = job.pricing_snapshot || {};
      logJobMetrics({
        timestamp: nowIso(),
        job_id: job.job_id,
        trace_id: job.trace_id,
        email: job.meta.email,
        execution_profile: ps.execution_profile || "UNKNOWN",
        execution_status: "FAILED",
        fail_class: job.fail_class,
        pricing_state: ps.pricing_state || "UNKNOWN",
        price_usd: ps.price_usd || 0,
        max_runtime_ms: ps.base_runtime_ms || ps.runtime_ms || 0,
        stop_reason: job.stop_reason
      });
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
      }
    }
  }
}

run();
