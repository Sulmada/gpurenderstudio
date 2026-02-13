// =============================================================
// GPU RENDER STUDIO – PHASE 1.3
// server.js – Backend API (UPLOAD, CONTRACTS, STATUS, PAYMENT)
// =============================================================

"use strict";

const path = require("path");
const fs = require("fs-extra");
const express = require("express");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const { v4: uuidv4 } = require("uuid");
const Stripe = require("stripe");
const archiver = require("archiver");
const STALE_HEARTBEAT_MS = Number(process.env.STALE_HEARTBEAT_MS || 120000);
const REAPER_INTERVAL_MS = Number(process.env.REAPER_INTERVAL_MS || 60000);

require("dotenv").config({
  path: path.join(__dirname, ".env")
});

// -------------------------------------------------------------
// CORE BACKEND MODULES (Phase 1.3)
// -------------------------------------------------------------
const queue = require("./queue");
const getCurrentPricingState =
  require("./pricing_reader").getCurrentPricingState;
const pricingEngine = require("./pricing_engine");
const apiPrecheckReal = require("./contracts/api_precheck_real");
const apiPrecheck = require("./contracts/api_precheck");
const apiConfirm = require("./contracts/api_confirm");

// -------------------------------------------------------------
// PHASE CONTROL
// -------------------------------------------------------------
console.log("[BOOT] Phase 1.3 Server Initializing");

const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || null;
if (!STRIPE_SECRET) {
  console.warn("[BOOT] WARNING: STRIPE_SECRET_KEY missing, payment disabled.");
}
const stripe = STRIPE_SECRET ? new Stripe(STRIPE_SECRET) : null;

// -------------------------------------------------------------
// EXPRESS APP
// -------------------------------------------------------------
const app = express();
app.set("trust proxy", 1);

// -------------------------------------------------------------
// UUID VALIDATION
// -------------------------------------------------------------
function isUuid(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    str
  );
}

// -------------------------------------------------------------
// HELPER
// -------------------------------------------------------------
function pidAlive(pid) {
  if (!pid || typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// -------------------------------------------------------------
// BLENDER FILE SIGNATURE CHECK (after upload)
// -------------------------------------------------------------
async function validateBlendSignature(filePath) {
  const fd = await fs.open(filePath, "r");
  const buf = Buffer.alloc(16);
  await fs.read(fd, buf, 0, 16, 0);
  await fs.close(fd);

  // RAW .blend
  if (buf.slice(0, 7).toString("ascii") === "BLENDER") {
    return true;
  }

  // GZIP magic bytes
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    return true;
  }

  // ZSTD magic bytes
  if (
    buf[0] === 0x28 &&
    buf[1] === 0xb5 &&
    buf[2] === 0x2f &&
    buf[3] === 0xfd
  ) {
    return true;
  }

  return false;
}

// -------------------------------------------------------------
// REAPER
// -------------------------------------------------------------
function reaperTick() {
  try {
    const jobs = queue.listJobs ? queue.listJobs() : queue.getAllJobs?.() || [];
    const now = Date.now();

    for (const job of jobs) {
      if (job.status !== "running") continue;

      const w = job.worker || {};
      const lastSeenMs = w.last_seen ? Date.parse(w.last_seen) : null;

      let staleReason = null;

      if (!w.pid) {
        staleReason = "STALE_NO_PID";
      } else if (!pidAlive(w.pid)) {
        staleReason = "STALE_PID_DEAD";
      } else if (!lastSeenMs) {
        // pid exists but heartbeat not written yet – give grace
        console.warn(
          `[REAPER] heartbeat missing but pid alive job=${job.job_id}`
        );
      } else if (now - lastSeenMs > STALE_HEARTBEAT_MS) {
        staleReason = "STALE_HEARTBEAT";
      }

      if (!staleReason) continue;

      console.error(
        `[REAPER] job=${job.job_id} stale=${staleReason} pid=${w.pid} last_seen=${w.last_seen}`
      );

      job.status = "failed";
      job.stop_reason = "FAILED";
      job.stop_mechanism = "REAPER";
      job.fail_code = staleReason;
      job.timestamps = job.timestamps || {};
      job.timestamps.ended = new Date().toISOString();

      queue.updateJob(job);
    }
  } catch (err) {
    console.error("[REAPER] tick failed", err);
  }
}

// -------------------------------------------------------------
// HEALTH CHECK
// -------------------------------------------------------------
app.get("/api/health", (_, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// -------------------------------------------------------------
// GLOBAL REJECTION GUARD
// -------------------------------------------------------------
process.on("unhandledRejection", err => {
  console.error("UNHANDLED_REJECTION", err);
});

// -------------------------------------------------------------
// PASSIVE PRICING OBSERVER (Phase 1.3)
// -------------------------------------------------------------
function runPricingEvaluation() {
  try {
    pricingEngine.evaluatePricing({
      queueLength: queue.getQueueLength(),
      hasRunningJob: queue.hasRunningJob()
    });
  } catch (err) {
    console.error("PRICING_EVALUATION_FAILED", err);
  }
}
runPricingEvaluation();
setInterval(runPricingEvaluation, 30000);

// -------------------------------------------------------------
// CORS
// -------------------------------------------------------------
const PROD_ORIGIN = "https://gpurenderstudio.com";
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin === PROD_ORIGIN || process.env.NODE_ENV === "development") {
    res.setHeader("Access-Control-Allow-Origin", origin || PROD_ORIGIN);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Admin-Token"
  );

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// -------------------------------------------------------------
// STATUS ENDPOINT CACHE CONTROL
// -------------------------------------------------------------
app.use("/api/status", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// -------------------------------------------------------------
// WEBHOOK MUST COME BEFORE JSON PARSER
// -------------------------------------------------------------
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe) return res.status(503).send("Stripe disabled");

    const sig = req.headers["stripe-signature"];
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("[STRIPE] Invalid signature", err.message);
      return res.status(400).send("Webhook Error");
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const jobId = session.metadata?.job_id;

      if (!jobId) {
        console.error("[STRIPE] Missing job_id");
        return res.json({ received: true });
      }

      const job = queue.getJob(jobId);
      if (!job) {
        console.error("[STRIPE] Job not found", jobId);
        return res.json({ received: true });
      }

      if (job.payment?.status !== "PAID") {
        job.payment = {
          status: "PAID",
          stripe_session_id: session.id,
          paid_at: new Date().toISOString()
        };
        queue.updateJob(job);
        console.log(`[STRIPE] Job ${jobId} marked as PAID`);
      }
    }

    res.json({ received: true });
  }
);

// -------------------------------------------------------------
// JSON BODY FOR REGULAR ROUTES (BODY SIZE LIMIT)
// -------------------------------------------------------------
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

// -------------------------------------------------------------
// RATE LIMITERS (JSON RESPONSES + STANDARD HEADERS)
// -------------------------------------------------------------
function limiter(opts) {
  return rateLimit({
    ...opts,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_, res) => res.status(429).json({ error: "RATE_LIMITED" })
  });
}

const uploadLimiter = limiter({ windowMs: 15 * 60000, max: 20 });
const statusLimiter = limiter({ windowMs: 60000, max: 120 });
const contractsLimiter = limiter({ windowMs: 10000, max: 20 });
const downloadLimiter = limiter({ windowMs: 10 * 60 * 1000, max: 20 });

// -------------------------------------------------------------
// SYSTEM CONTROL
// -------------------------------------------------------------
const SYSTEM_CONTROL_PATH = path.join(__dirname, "system_control.json");
function getSystemControl() {
  try {
    return JSON.parse(fs.readFileSync(SYSTEM_CONTROL_PATH, "utf8"));
  } catch {
    return { ingest_enabled: false, worker_enabled: false };
  }
}

// -------------------------------------------------------------
// UPLOAD DIRECTORY
// -------------------------------------------------------------
const uploadDir = "/mnt/c/gpu_render_service/uploads/projects";
fs.ensureDirSync(uploadDir);

// -------------------------------------------------------------
// UPLOAD STORAGE
// -------------------------------------------------------------
const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, uploadDir),
    filename: (_, file, cb) =>
      cb(null, uuidv4() + path.extname(file.originalname))
  }),
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024 // 2 GB hard cap
  }
});


// -------------------------------------------------------------
// CLEANUP ON MULTER SIZE ERROR
// -------------------------------------------------------------
app.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") {
    console.warn("[UPLOAD] rejected oversized file");
    return res.status(413).json({ error: "UPLOAD_TOO_LARGE" });
  }
  next(err);
});

// =============================================================
// 1. UPLOAD JOB (Phase 1.3)
// =============================================================
app.post(
  "/api/upload",
  uploadLimiter,
  upload.single("file"),
  async (req, res) => {
    const sys = getSystemControl();
    if (!sys.ingest_enabled) {
      return res.status(403).json({ error: "INGEST_DISABLED" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "NO_FILE" });
    }

    const ext = path.extname(req.file.originalname || "").toLowerCase();
    if (ext !== ".blend") {
      await fs.remove(req.file.path);
      return res.status(400).json({
        error: "UNSUPPORTED_FILE_TYPE",
        supported: [".blend"]
      });
    }

    // Signature check: reject fake .blend
    if (!(await validateBlendSignature(req.file.path))) {
      console.warn("[UPLOAD] invalid blend header:", req.file.path);
      await fs.remove(req.file.path);
      return res.status(400).json({ error: "INVALID_BLEND_FILE" });
    }

    const email =
      (req.body.email && req.body.email.toLowerCase().trim()) ||
      `anonymous:${req.ip}`;

    const job_id = uuidv4();
    const trace_id = `job-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    const job = {
      job_id,
      trace_id,
      phase: "1.3",
      status: "uploaded",
      file_path: req.file.path,
      meta: { email },
      contract: null,
      billing: null,
      payment: { status: "UNPAID" },
      timestamps: {
        created: new Date().toISOString(),
        started: null,
        ended: null
      }
    };

    queue.addProject(job);

    return res.status(200).json({ status: "OK", job_id });
  }
);

// =============================================================
// 2. REAL PRECHECK & CONFIRM (Phase 1.3)
// =============================================================
app.post("/api/contracts/precheck", (_, res) => {
  res.status(410).json({
    error: "DEPRECATED",
    use: "/api/contracts/precheck/real"
  });
});

app.post("/api/contracts/precheck/real", contractsLimiter, apiPrecheckReal);
app.post("/api/contracts/confirm", contractsLimiter, apiConfirm);

// =============================================================
// 3. STATUS (Phase 1.3 canonical)
// =============================================================
const { mapInternalToReason } = require("./reason/reason_mapper");

// Version
app.get("/api/status/version", statusLimiter, (_, res) => {
  res.json({
    phase: "1.3",
    module: "server.js",
    build: "2026-01-19",
    queue_store: "file:queue_store.json"
  });
});

// Översikt
app.get("/api/status", statusLimiter, (_, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString(),
    queue_length: queue.getQueueLength(),
    has_running: queue.hasRunningJob()
  });
});

// Köade jobb
app.get("/api/status/queue", statusLimiter, (_, res) => {
  const queued = queue.getJobsByStatus("queued").concat(
    queue.getJobsByStatus("confirmed")
  );
  res.json({ queued });
});

// Running
app.get("/api/status/running", statusLimiter, (_, res) => {
  const running = queue.getJobsByStatus("running");
  res.json({ running });
});

// Completed
app.get("/api/status/completed", statusLimiter, (_, res) => {
  const completed = queue.listCompleted();
  res.json({ completed });
});

// Alla jobb
app.get("/api/status/jobs", statusLimiter, (_, res) => {
  const all = queue.listJobs();
  res.json({ all });
});

// Enskilt jobb (kanonisk)
app.get("/api/status/:job_id", statusLimiter, (req, res) => {
  const job = queue.getJob(req.params.job_id);
  if (!job) {
    return res.status(404).json({ error: "JOB_NOT_FOUND" });
  }

  const {
    job_id,
    status,
    pricing_snapshot,
    contract,
    billing,
    stop_reason,
    payment,
    meta,
    timestamps,
    fail_code,
    fail_class,
    customer_action
  } = job;

  const execution_mode =
    (contract && contract.execution_mode) ||
    (pricing_snapshot && pricing_snapshot.execution_profile) ||
    "UNKNOWN";

  const contract_type =
    (contract && contract.contract_type) ||
    (pricing_snapshot && pricing_snapshot.contract_type) ||
    "UNKNOWN";

  const pricing_state =
    (pricing_snapshot && pricing_snapshot.pricing_state) || "UNKNOWN";

  let canonical_reason = null;
  if (status === "failed" && fail_code) {
    const context = { pricing_snapshot };
    canonical_reason = mapInternalToReason(fail_code, context);
  }

  const normalized_status = status || "unknown";

  const billing_safe = billing
    ? {
        slot: billing.slot || (contract && contract.slot) || null,
        execution_mode: billing.execution_mode || execution_mode,
        elapsed_hours: billing.elapsed_hours,
        base_hours_limit: billing.base_hours_limit,
        slot_budget_limit_hours: billing.slot_budget_limit_hours,
        cap_hours: billing.cap_hours,
        overflow_allowed: billing.overflow_allowed,
        overflow_hours: billing.overflow_hours,
        hourly_rate_usd: billing.hourly_rate_usd,
        base_price_usd: billing.base_price_usd,
        overflow_usd: billing.overflow_usd,
        billed_usd: billing.billed_usd,
        cap_enabled: billing.cap_enabled,
        cap_usd: billing.cap_usd,
        completed_with_cap: billing.completed_with_cap,
        completed_with_budget: billing.completed_with_budget,
        completed_partial: billing.completed_partial,
        stop_reason: billing.stop_reason
      }
    : null;

  const contract_safe = contract
    ? {
        slot: contract.slot,
        base_hours_limit: contract.base_hours_limit,
        hourly_rate_usd: contract.hourly_rate_usd,
        base_price_usd: contract.base_price_usd,
        contract_type,
        execution_mode
      }
    : null;

  const compat = {
    fail_code: fail_code || null,
    fail_class: fail_class || null,
    customer_action: customer_action || null
  };

  const response = {
    job_id,
    status: normalized_status,
    pricing_state,
    pricing_snapshot: pricing_snapshot || null,
    contract: contract_safe,
    billing: billing_safe,
    stop_reason:
      stop_reason || (billing_safe && billing_safe.stop_reason) || null,
    payment: payment || null,
    meta: meta || null,
    timestamps: timestamps || null,
    reason: canonical_reason,
    compat,
    progress: job.progress || null
  };

  return res.json(response);
});

// =============================================================
// 4. PRICING ENGINE STATE
// =============================================================
app.get("/api/pricing/status", (_, res) => {
  res.json(getCurrentPricingState());
});

// =============================================================
// 5. PAYMENT (Phase 1.3: billing-based)
// =============================================================
app.post("/api/pay/:job_id", statusLimiter, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: "PAYMENT_DISABLED" });

  const job = queue.getJob(req.params.job_id);
  if (!job) return res.status(404).json({ error: "JOB_NOT_FOUND" });

  if (job.status !== "success" && job.status !== "partial_success") {
    return res.status(400).json({ error: "JOB_NOT_COMPLETED" });
  }

  const billed = job.billing?.billed_usd;
  if (typeof billed !== "number" || billed <= 0) {
    return res.status(400).json({ error: "INVALID_BILLING" });
  }

  try {
    const amountCents = Math.round(billed * 100);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "GPU Render Job",
              description: job.job_id
            },
            unit_amount: amountCents
          },
          quantity: 1
        }
      ],
      metadata: { job_id: job.job_id, trace_id: job.trace_id },
      success_url: `${PROD_ORIGIN}/status/?job_id=${job.job_id}&paid=1`,
      cancel_url: `${PROD_ORIGIN}/status/?job_id=${job.job_id}&cancelled=1`
    });

    job.payment.stripe_session_id = session.id;
    queue.updateJob(job);

    res.json({ checkout_url: session.url });
  } catch (err) {
    console.error("[STRIPE_SESSION_FAILED]", err);
    res
      .status(502)
      .json({ error: "STRIPE_SESSION_FAILED", detail: err.message });
  }
});

// =============================================================
// 5b. EXTEND CAP + RESUME (Phase 1.3 final)
// =============================================================
app.post("/api/contracts/extend/:job_id", contractsLimiter, async (req, res) => {
  const job = queue.getJob(req.params.job_id);
  if (!job) return res.status(404).json({ error: "JOB_NOT_FOUND" });

  if (job.status !== "paused_cap") {
    return res.status(400).json({ error: "JOB_NOT_PAUSED_CAP" });
  }

  const newCap = Number(req.body.new_cap_usd);
  if (!Number.isFinite(newCap) || newCap <= job.billing?.cap_usd) {
    return res.status(400).json({ error: "INVALID_NEW_CAP" });
  }

  // --- update billing ---
  job.billing.cap_usd = newCap;
  job.billing.completed_with_cap = false;
  job.billing.stop_reason = null;

  // --- update contract ---
  if (job.contract) {
    job.contract.cap_usd = newCap;
  }

  // --- reset job state ---
  job.status = "queued";
  job.stop_reason = null;
  job.stop_mechanism = null;
  job.timestamps.started = null;
  job.timestamps.ended = null;

  queue.updateJob(job);

  console.log(
    `[RESUME] job=${job.job_id} cap_extended=${newCap} USD`
  );

  res.json({
    status: "OK",
    resumed: true,
    new_cap_usd: newCap
  });
});

// =============================================================
// 6. DOWNLOAD (PAID)
// =============================================================
const RENDER_ROOT = "/mnt/c/gpu_render_service/renders";

app.get("/api/download/:job_id", downloadLimiter, async (req, res) => {
  const jobId = req.params.job_id;
  console.log(
    `[DOWNLOAD] start job=${jobId} ip=${req.ip} ua="${req.headers["user-agent"] || ""}"`
  );

  // ---- basic validation ----
  if (!isUuid(jobId)) {
    return res.status(400).json({ error: "INVALID_JOB_ID" });
  }

  const job = queue.getJob(jobId);
  if (!job) return res.status(404).json({ error: "JOB_NOT_FOUND" });

  if (job.status !== "success" && job.status !== "partial_success") {
    return res.status(400).json({ error: "JOB_NOT_COMPLETED" });
  }

  if (job.payment?.status !== "PAID") {
    return res.status(402).json({ error: "PAYMENT_REQUIRED" });
  }

  // ---- resolve path safely ----
  const renderDir = path.resolve(RENDER_ROOT, job.job_id);
  const baseDir = path.resolve(RENDER_ROOT);

  if (!renderDir.startsWith(baseDir + path.sep)) {
    console.error("[DOWNLOAD] Path escape blocked:", renderDir);
    return res.status(400).json({ error: "INVALID_RENDER_PATH" });
  }

  if (!(await fs.pathExists(renderDir))) {
    console.error("[DOWNLOAD] Missing render dir", renderDir);
    return res.status(404).json({ error: "OUTPUT_NOT_FOUND" });
  }

  // ---- ensure directory only contains files ----
  const entries = await fs.readdir(renderDir, { withFileTypes: true });

  const files = entries.filter(e => e.isFile());
  if (!files.length) {
    return res.status(404).json({ error: "NO_OUTPUT_FILES" });
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="render_${job.job_id}.zip"`
  );

  const archive = archiver("zip", { zlib: { level: 9 } });

  archive.on("error", err => {
    console.error("[DOWNLOAD] Archive error:", err);
    if (!res.headersSent) res.status(500).end();
  });

  archive.on("warning", err => {
    console.warn("[DOWNLOAD] Archive warning:", err);
  });

  archive.on("end", () => {
    console.log(`[DOWNLOAD] completed job=${jobId}`);
  });

  // Abort zip if client disconnects
  res.on("close", () => {
    console.warn("[DOWNLOAD] client aborted", jobId);
    archive.abort();
  });

  archive.pipe(res);

  for (const f of files) {
    archive.file(path.join(renderDir, f.name), { name: f.name });
  }

  await archive.finalize();
});


// =============================================================
// LISTEN
// =============================================================
app.listen(3001, "0.0.0.0", () => {
  console.log("Phase 1.3 Backend running at http://0.0.0.0:3001");
});

setInterval(reaperTick, REAPER_INTERVAL_MS);
