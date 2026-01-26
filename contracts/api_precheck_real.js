// backend/contracts/api_precheck_real.js
// GPU RENDER STUDIO – PHASE 1.3
// REAL PRECHECK (GPU-ONLY TIMING + PRICING SNAPSHOT + SLOT SUGGESTION)

"use strict";

const queue = require("../queue");
const pricingReader = require("../pricing_reader");
const { spawnSync } = require("child_process");
const path = require("path");

// Samma Blender-EXE som i worker
const BLENDER_EXE =
  "/mnt/c/Program Files/Blender Foundation/Blender 5.0/blender.exe";

// Phase 1.3 standard hourly billing (speglar api_confirm.js)
const HOURLY_RATE_USD = 1.0;

// Slot → base hours (speglar api_confirm.js)
const SLOT_LIMITS = {
  STRICT: 1.5,
  EXTENDED: 4.0,
  FLEXIBLE: 8.0,
  OPEN_FIXED_MAX: 12.0
};

// GPU precheck settings
const TEST_SAMPLES = 32; // låga samples, tids-skalning gör resten

// -----------------------------------------------------
// RUN PYTHON SNIPPET INSIDE BLENDER
// Returns stdout string
// -----------------------------------------------------
function runBlenderPy(args) {
  const proc = spawnSync(BLENDER_EXE, args, {
    windowsHide: true,
    encoding: "utf8"
  });
  if (proc.error) throw proc.error;
  return proc.stdout || "";
}

// -----------------------------------------------------
// VALIDATE GPU DEVICE
// -----------------------------------------------------
function detectGpuDevices() {
  const py = `
import bpy
prefs = bpy.context.preferences.addons['cycles'].preferences
prefs.refresh_devices()
names = [d.name for d in prefs.devices if d.type=='CUDA' or d.type=='OPTIX']
print(names)
`;
  const out = runBlenderPy(["-b", "--python-expr", py]);
  try {
    const m = out.match(/\[(.*?)\]/);
    if (!m) return [];
    const arr = m[1]
      .split(",")
      .map(s => s.replace(/['" ]/g, ""))
      .filter(Boolean);
    return arr;
  } catch {
    return [];
  }
}

// -----------------------------------------------------
// TIMING TEST (GPU-only, 1 frame, TEST_SAMPLES)
// -----------------------------------------------------
function doTimingTest(blendPathWin) {
  const py = `
import bpy, time, sys

bpy.ops.wm.open_mainfile(filepath=r"${blendPathWin}")

# Setup Cycles GPU (OptiX preferred)
prefs = bpy.context.preferences.addons['cycles'].preferences
prefs.refresh_devices()
prefs.compute_device_type = 'OPTIX'
for d in prefs.devices:
    d.use = ('OPTIX' in d.type or 'CUDA' in d.type)

bpy.context.scene.cycles.device = 'GPU'

# samples
bpy.context.scene.cycles.samples = ${TEST_SAMPLES}

scene = bpy.context.scene
start = scene.frame_start
end = scene.frame_end
total = end - start + 1
frame = start
scene.frame_set(frame)

t0 = time.time()
bpy.ops.render.render(write_still=False)
t1 = time.time()

dur = t1 - t0
print(f"T={dur},TOTAL_FRAMES={total}")
sys.exit(0)
`;
  const out = runBlenderPy(["-b", "--python-expr", py]);
  return out;
}

// -----------------------------------------------------
// SIMPLE SLOT SUGGESTION (recommended / safe / guaranteed)
// -----------------------------------------------------
function buildSlotSuggestion(estimatedHoursReal, estimatedHoursEffective, timeMult) {
  const slots = [
    { slot: "STRICT",         base_hours_limit: SLOT_LIMITS.STRICT },
    { slot: "EXTENDED",       base_hours_limit: SLOT_LIMITS.EXTENDED },
    { slot: "FLEXIBLE",       base_hours_limit: SLOT_LIMITS.FLEXIBLE },
    { slot: "OPEN_FIXED_MAX", base_hours_limit: SLOT_LIMITS.OPEN_FIXED_MAX }
  ];

  const analysis = slots.map(s => {
    const limit = s.base_hours_limit;
    const fitsBase = estimatedHoursEffective <= limit + 1e-9;
    const nearLimit = estimatedHoursEffective >= 0.8 * limit;
    const exceeds = !fitsBase;
    return {
      slot: s.slot,
      base_hours_limit: limit,
      fits_base: fitsBase,
      near_limit: nearLimit,
      exceeds
    };
  });

  // recommended: minsta slot där det får plats, helst inte "near_limit"
  let recommended = "OPEN_FIXED_MAX";
  const nonExceed = analysis.filter(a => !a.exceeds);
  if (nonExceed.length > 0) {
    const nonNear = nonExceed.filter(a => !a.near_limit);
    if (nonNear.length > 0) {
      recommended = nonNear[0].slot;
    } else {
      recommended = nonExceed[0].slot;
    }
  }

  // safe: första slot där det får plats (även om near_limit)
  let safe = "OPEN_FIXED_MAX";
  if (nonExceed.length > 0) {
    safe = nonExceed[0].slot;
  }

  // guaranteed: sista slot där det får plats, annars OPEN_FIXED_MAX
  let guaranteed = "OPEN_FIXED_MAX";
  const fitting = analysis.filter(a => !a.exceeds);
  if (fitting.length > 0) {
    guaranteed = fitting[fitting.length - 1].slot;
  }

  return {
    input: {
      estimated_hours_real: estimatedHoursReal,
      time_multiplier: timeMult,
      estimated_hours_effective: estimatedHoursEffective
    },
    slot_analysis: analysis,
    recommended_profile: recommended,
    safe_profile: safe,
    guaranteed_profile: guaranteed
  };
}

// -----------------------------------------------------
// MAIN HANDLER
// -----------------------------------------------------
module.exports = function apiPrecheckReal(req, res) {
  try {
    const job_id = req.body?.job_id;
    if (!job_id) {
      return res
        .status(400)
        .json({ status: "ERROR", error: "BAD_REQUEST", reason: "job_id required" });
    }

    const job = queue.getJob(job_id);
    if (!job) {
      return res
        .status(404)
        .json({ status: "ERROR", error: "JOB_NOT_FOUND" });
    }

    if (job.status !== "uploaded") {
      return res.status(400).json({
        status: "ERROR",
        error: "INVALID_STATE",
        reason: "Job must be 'uploaded' before real precheck"
      });
    }

    const blendPath = job.file_path;
    if (!blendPath) {
      return res.status(400).json({
        status: "ERROR",
        error: "MISSING_BLEND_PATH"
      });
    }

    const blendPathWin = blendPath
      .replace(/^\/mnt\/([a-z])\//i, (_, d) => `${d.toUpperCase()}:\\`)
      .replace(/\//g, "\\");

    // A) GPU presence
    const gpus = detectGpuDevices();
    if (!gpus.length) {
      return res.status(400).json({
        status: "ERROR",
        fail_class: "GPU_REQUIRED",
        reason: "No GPU devices detected for GPU-only precheck"
      });
    }

    // B) timing test (1 frame, TEST_SAMPLES)
    const out = doTimingTest(blendPathWin);

    const mT = out.match(/T=([0-9.]+)/);
    const mTot = out.match(/TOTAL_FRAMES=([0-9]+)/);

    if (!mT || !mTot) {
      return res.status(400).json({
        status: "ERROR",
        fail_class: "TIMING_FAILED",
        reason: "Could not parse timing output"
      });
    }

    const t = Number(mT[1]);
    const total = Number(mTot[1]);

    if (!Number.isFinite(t) || !Number.isFinite(total) || total <= 0) {
      return res.status(400).json({
        status: "ERROR",
        fail_class: "TIMING_FAILED",
        reason: "Invalid timing or frame count"
      });
    }

    // C) estimate (real time)
    const medianMs = t * 1000;
    const estimatedSeconds = t * total;
    const estimatedHoursReal = estimatedSeconds / 3600;

    // D) pricing multiplier / state
    const pstate = pricingReader.getCurrentPricingState();
    const timeMult = pstate?.time_multiplier || 1;
    const estimatedHoursEffective = estimatedHoursReal / timeMult;

    // E) pricing_snapshot – Phase 1.3 canonical
    const pricing_snapshot = {
      pricing_state: pstate?.state || "UNKNOWN",
      time_multiplier: timeMult,
      hourly_rate_usd: HOURLY_RATE_USD,
      slot_limits: { ...SLOT_LIMITS },
      since: pstate?.since || null
    };

    // F) real_precheck object
    const real_precheck = {
      status: "OK",
      timing: {
        tested_frames: 1,
        total_frames: total,
        median_ms_per_frame: medianMs
      },
      estimated_hours_real: estimatedHoursReal,
      pricing: {
        state: pstate?.state || "UNKNOWN",
        time_multiplier: timeMult
      },
      estimated_hours_effective: estimatedHoursEffective
    };

    // G) slot_suggestion (recommended / safe / guaranteed)
    const slot_suggestion = buildSlotSuggestion(
      estimatedHoursReal,
      estimatedHoursEffective,
      timeMult
    );

    // H) persist on job
    job.real_precheck = real_precheck;
    job.pricing_snapshot = pricing_snapshot;
    job.slot_suggestion = slot_suggestion;

    queue.updateJob(job);

    // I) response
    return res.json({
      status: "OK",
      job_id,
      real_precheck,
      pricing_snapshot,
      slot_suggestion
    });
  } catch (err) {
    console.error("[api_precheck_real] ERROR:", err);
    return res.status(500).json({
      status: "ERROR",
      fail_class: "INTERNAL",
      reason: String(err.message || err)
    });
  }
};
