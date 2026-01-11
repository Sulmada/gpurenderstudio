// =============================================================
// GPU RENDER STUDIO – PHASE 1.1
// render_worker.js (CANONICAL – SNAPSHOT DRIVEN, HARDENED)
// =============================================================

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const queue = require("./queue");
const { logJobMetrics } = require("./metrics_writer");
const failPolicy = require("./fail_policy");
const precheckBlender = require("./precheck_blender");

// pricing_engine may observe load for future jobs,
// but MUST NOT influence current job
require("./pricing_engine");

// -------------------------------------------------------------
// BOOT DIAGNOSTICS
// -------------------------------------------------------------
console.log("[WORKER] booting");
console.log("[WORKER] CWD:", process.cwd());
console.log("[WORKER] queue.js:", require.resolve("./queue"));

// -------------------------------------------------------------
// PROCESS SAFETY
// -------------------------------------------------------------
process.on("exit", code =>
  console.log("[WORKER] exit", code)
);

process.on("uncaughtException", err =>
  console.error("[WORKER] UNCAUGHT_EXCEPTION", err)
);

process.on("unhandledRejection", err =>
  console.error("[WORKER] UNHANDLED_REJECTION", err)
);

// -------------------------------------------------------------
// CONSTANTS (CANONICAL)
// -------------------------------------------------------------
const GRACE_PERIOD_MS = 10_000;
const IDLE_SLEEP_MS   = 3_000;
const PAUSED_SLEEP_MS = 5_000;

// MUST MATCH server.js
const RENDER_ROOT = "/mnt/c/gpu_render_service/renders";

const SYSTEM_CONTROL_PATH =
  path.join(__dirname, "system_control.json");

const BLENDER_EXE =
  "/mnt/c/Program Files/Blender Foundation/Blender 5.0/blender.exe";

// -------------------------------------------------------------
// HELPERS
// -------------------------------------------------------------
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getSystemControl() {
  try {
    return JSON.parse(
      fs.readFileSync(SYSTEM_CONTROL_PATH, "utf8")
    );
  } catch {
    return {
      ingest_enabled: false,
      worker_enabled: false,
      reason: "system_control.json missing"
    };
  }
}

function wslToWindowsPath(p) {
  return p
    .replace(/^\/mnt\/([a-z])\//i, (_, d) => `${d.toUpperCase()}:\\`)
    .replace(/\//g, "\\");
}

// -------------------------------------------------------------
// CONTRACT ENFORCEMENT
// -------------------------------------------------------------
function ensureJobShape(job) {
  if (!job) throw new Error("MISSING_JOB");

  if (!job.pricing_snapshot ||
      typeof job.pricing_snapshot !== "object") {
    throw new Error("MISSING_PRICING_SNAPSHOT");
  }

  const ps = job.pricing_snapshot;

  if (!Number.isFinite(ps.runtime_ms) || ps.runtime_ms <= 0)
    throw new Error("MISSING_PRICING_SNAPSHOT");

  if (typeof ps.execution_profile !== "string")
    throw new Error("MISSING_PRICING_SNAPSHOT");

  if (typeof ps.pricing_state !== "string")
    throw new Error("MISSING_PRICING_SNAPSHOT");

  if (!Number.isFinite(ps.price_usd) || ps.price_usd < 0)
    throw new Error("MISSING_PRICING_SNAPSHOT");
}

// -------------------------------------------------------------
// ERROR → FAIL CODE MAPPING
// -------------------------------------------------------------
function mapErrorToFailCode(err) {
  const msg = err && err.message ? String(err.message) : "";

  if (msg === "RENDER_TIMEOUT")       return "TIMEOUT";
  if (msg === "PRESET_VIOLATION")     return "PRESET_VIOLATION";
  if (msg === "NO_OUTPUT_PRODUCED")   return "NO_OUTPUT_PRODUCED";
  if (msg.startsWith("BLENDER_EXIT_"))return "BLENDER_CRASH";
  if (msg.startsWith("BLENDER_START_FAILED"))
    return "BLENDER_START_FAILED";
  if (msg === "MISSING_PRICING_SNAPSHOT")
    return "INTERNAL_CONTRACT_VIOLATION";

  return "BLENDER_START_FAILED";
}

// -------------------------------------------------------------
// BLENDER RUNNER
// -------------------------------------------------------------
function runBlenderRender(job) {
  return new Promise((resolve, reject) => {
    ensureJobShape(job);

    const MAX_RUNTIME_MS = job.pricing_snapshot.runtime_ms;

    const outputDir =
      path.join(RENDER_ROOT, job.job_id);

    fs.mkdirSync(outputDir, { recursive: true });

    const winBlendPath  = wslToWindowsPath(job.file_path);
    const winOutputBase =
      wslToWindowsPath(path.join(outputDir, "frame_#####"));

    const TEST_FRAME = 64;

    const args = [
      "-b",
      winBlendPath,
      "--factory-startup",
      "-E", "CYCLES",
      "-o", winOutputBase,
      "-f", String(TEST_FRAME)
    ];

    console.log(
      `[${job.trace_id}] Blender start – max ${Math.round(
        MAX_RUNTIME_MS / 60000
      )} min`
    );

    let finished = false;
    let aborted  = false;

    const blender = spawn(BLENDER_EXE, args, {
      shell: false,
      windowsHide: true
    });

    const timeout = setTimeout(() => {
      if (finished) return;

      aborted = true;
      console.error(
        `[TIMEOUT] Job ${job.job_id} exceeded runtime window`
      );

      blender.kill("SIGINT");

      setTimeout(() => {
        if (!finished) {
          console.error(
            `[KILL] Forcing Blender shutdown ${job.job_id}`
          );
          blender.kill("SIGKILL");
        }
      }, GRACE_PERIOD_MS);

      reject(new Error("RENDER_TIMEOUT"));
    }, MAX_RUNTIME_MS);

    blender.stdout.on("data", d =>
      process.stdout.write(`[BLENDER ${job.job_id}] ${d}`)
    );

    blender.stderr.on("data", d =>
      process.stderr.write(`[BLENDER ${job.job_id} STDERR] ${d}`)
    );

    blender.on("error", err => {
      clearTimeout(timeout);
      reject(
        new Error(
          `BLENDER_START_FAILED:${err.message || "unknown"}`
        )
      );
    });

    blender.on("close", code => {
      finished = true;
      clearTimeout(timeout);

      if (aborted) return;

      if (code === 0) resolve();
      else reject(new Error(`BLENDER_EXIT_${code}`));
    });
  });
}

// -------------------------------------------------------------
// MAIN WORKER LOOP
// -------------------------------------------------------------
async function run() {
  console.log("[WORKER] main loop started");

  while (true) {
    const sys = getSystemControl();

    if (!sys.worker_enabled) {
      console.log("[WORKER] paused");
      await sleep(PAUSED_SLEEP_MS);
      continue;
    }

    const job = queue.getNextQueued();
    if (!job) {
      await sleep(IDLE_SLEEP_MS);
      continue;
    }

    if (!job.timestamps) job.timestamps = {};
    if (!job.meta) job.meta = {};
    if (typeof job.meta.email !== "string")
      job.meta.email = "";

    console.log(
      `[${job.trace_id}] Processing job ${job.job_id}`
    );

    try {
      ensureJobShape(job);

      // ---------------- PRECHECK ----------------
      job.status = "precheck";
      queue.updateJob(job);

      const meta = await precheckBlender(job.file_path);

      if (!meta ||
          !Number.isFinite(meta.frames) ||
          !Number.isFinite(meta.x) ||
          !Number.isFinite(meta.y) ||
          !Number.isFinite(meta.samples)) {
        throw new Error("BLENDER_START_FAILED:PRECHECK_OUTPUT_INVALID");
      }

      if (
        meta.frames  > 300  ||
        meta.x       > 4096 ||
        meta.y       > 2160 ||
        meta.samples > 1024
      ) {
        throw new Error("PRESET_VIOLATION");
      }

      // ---------------- RUN ----------------
      job.status = "running";
      job.timestamps.started =
        new Date().toISOString();
      queue.updateJob(job);

      await runBlenderRender(job);

      // ---------------- OUTPUT VALIDATION ----------------
      const outputDir =
        path.join(RENDER_ROOT, job.job_id);

      const files =
        fs.existsSync(outputDir)
          ? fs.readdirSync(outputDir)
              .filter(f => !f.startsWith("."))
          : [];

      if (files.length === 0) {
        throw new Error("NO_OUTPUT_PRODUCED");
      }

      // ---------------- SUCCESS ----------------
      job.status = "success";
      job.timestamps.ended =
        new Date().toISOString();
      queue.updateJob(job);

      logJobMetrics({
        timestamp: new Date().toISOString(),
        job_id: job.job_id,
        trace_id: job.trace_id,
        email: job.meta.email,
        execution_profile:
          job.pricing_snapshot.execution_profile,
        execution_status: "SUCCESS",
        fail_class: null,
        runtime_seconds:
          (new Date(job.timestamps.ended) -
           new Date(job.timestamps.started)) / 1000,
        pricing_state:
          job.pricing_snapshot.pricing_state,
        price_usd:
          job.pricing_snapshot.price_usd,
        max_runtime_ms:
          job.pricing_snapshot.runtime_ms
      });

      console.log(
        `[${job.trace_id}] Job ${job.job_id} completed successfully`
      );

    } catch (err) {
      const msg =
        err && err.message ? err.message : "unknown";

      console.error(
        `[${job.trace_id}] Job ${job.job_id} failed: ${msg}`
      );

      job.status = "failed";
      job.timestamps.ended =
        new Date().toISOString();

      const failCode = mapErrorToFailCode(err);
      job.fail_code = failCode;

      const policy = failPolicy[failCode];
      if (!policy) {
        job.fail_class = "OWNER_NOTIFY";
        job.owner_notify = true;
        job.customer_action = null;
      } else {
        job.fail_class = policy.fail_class;
        job.owner_notify = policy.owner_notify;
        job.customer_action = policy.customer_action;
      }

      queue.updateJob(job);

      logJobMetrics({
        timestamp: new Date().toISOString(),
        job_id: job.job_id,
        trace_id: job.trace_id,
        email: job.meta.email,
        execution_profile:
          job.pricing_snapshot?.execution_profile || "UNKNOWN",
        execution_status: "FAILED",
        fail_class: job.fail_class,
        runtime_seconds:
          job.timestamps.started
            ? (new Date(job.timestamps.ended) -
               new Date(job.timestamps.started)) / 1000
            : 0,
        pricing_state:
          job.pricing_snapshot?.pricing_state || "UNKNOWN",
        price_usd:
          job.pricing_snapshot?.price_usd || 0,
        max_runtime_ms:
          job.pricing_snapshot?.runtime_ms || 0
      });
    }
  }
}

run();
