// =============================================================
// GPU RENDER STUDIO – PHASE 1.1
// server.js (CANONICAL – SANITIZED)
// =============================================================

const path = require("path");

require("dotenv").config({
  path: path.join(__dirname, ".env")
});

// -------------------------------------------------------------
// BOOT
// -------------------------------------------------------------
console.log(
  "[BOOT] STRIPE_SECRET_KEY:",
  process.env.STRIPE_SECRET_KEY ? "LOADED" : "MISSING"
);
const archiver = require("archiver");
const fs = require("fs-extra");
const express = require("express");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const { v4: uuidv4 } = require("uuid");
const Stripe = require("stripe");
const RENDER_ROOT = "/mnt/c/gpu_render_service/renders";

// -------------------------------------------------------------
// STRIPE (SINGLE INSTANCE)
// -------------------------------------------------------------
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// -------------------------------------------------------------
// APP
// -------------------------------------------------------------
const app = express();
app.set("trust proxy", 1);

// -------------------------------------------------------------
// HEALTH CHECK (DEBUG / OPS ONLY)
// -------------------------------------------------------------
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    time: new Date().toISOString()
  });
});

// -------------------------------------------------------------
// INTERNAL MODULES
// -------------------------------------------------------------
const executionProfiles = require("./execution_profiles");
const { getCurrentPricingState } = require("./pricing_reader");
const pricingEngine = require("./pricing_engine");
const queue = require("./queue");

process.on("unhandledRejection", err => {
  console.error("UNHANDLED REJECTION", err);
});

// -------------------------------------------------------------
// PRICING OBSERVER (PASSIVE, READ-ONLY)
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
setInterval(runPricingEvaluation, 30_000);

// -------------------------------------------------------------
// CORS (PHASE 1 – EXPLICIT)
// -------------------------------------------------------------
const ALLOWED_ORIGIN = "https://sulmada.github.io";

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// -------------------------------------------------------------
// STRIPE WEBHOOK (RAW BODY – MUST COME BEFORE JSON)
// -------------------------------------------------------------
app.post(
  "/api/stripe/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("[STRIPE] Invalid signature:", err.message);
      return res.status(400).send("Webhook Error");
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const jobId = session.metadata?.job_id;

      if (!jobId) {
        console.error("[STRIPE] Missing job_id metadata");
        return res.json({ received: true });
      }

      const job = queue.getJob(jobId);
      if (!job) {
        console.error("[STRIPE] Job not found:", jobId);
        return res.json({ received: true });
      }

      if (job.payment.status !== "PAID") {
        job.payment.status = "PAID";
        job.payment.stripe_session_id = session.id;
        job.payment.paid_at = new Date().toISOString();
        queue.updateJob(job);

        console.log(`[STRIPE] Job ${jobId} marked as PAID`);
      }
    }

    res.json({ received: true });
  }
);

// -------------------------------------------------------------
// JSON BODY (AFTER WEBHOOK)
// -------------------------------------------------------------
app.use(express.json());

// -------------------------------------------------------------
// RATE LIMITING
// -------------------------------------------------------------
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20
});

const statusLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120
});

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
// MULTER
// -------------------------------------------------------------
const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, uploadDir),
    filename: (_, file, cb) =>
      cb(null, uuidv4() + path.extname(file.originalname))
  })
});

// =============================================================
// 1. UPLOAD JOB (SNAPSHOT-BASED)
// =============================================================
app.post(
  "/api/upload",
  uploadLimiter,
  upload.single("file"),
  (req, res) => {
    const sys = getSystemControl();
    if (!sys.ingest_enabled) {
      return res.status(403).json({ error: "INGEST_DISABLED" });
    }

    if (!req.file) {
      return res.status(400).json({ error: "NO_FILE" });
    }

    if (req.body.project_type !== "blender") {
      return res.status(400).json({ error: "UNSUPPORTED_PROJECT_TYPE" });
    }

    const email =
      (req.body.email && req.body.email.toLowerCase().trim()) ||
      `anonymous:${req.ip}`;

    const execution_profile =
      req.body.execution_profile || "entry-120min";

    const profile = executionProfiles[execution_profile];
    if (!profile) {
      return res.status(400).json({ error: "UNKNOWN_EXECUTION_PROFILE" });
    }

    const pricingState = getCurrentPricingState();
    const timeMultiplier =
      typeof pricingState.time_multiplier === "number"
        ? pricingState.time_multiplier
        : 1.0;

    const runtime_ms = Math.round(
      profile.base_runtime_ms * timeMultiplier
    );

    if (!Number.isFinite(runtime_ms) || runtime_ms <= 0) {
      return res.status(500).json({
        error: "INTERNAL_CONTRACT_VIOLATION"
      });
    }

    const pricing_snapshot = {
      execution_profile,
      pricing_state: pricingState.state,
      time_multiplier: timeMultiplier,
      runtime_ms,
      price_usd: profile.entry_price_usd,
      locked_at: new Date().toISOString()
    };

    const job_id = uuidv4();
    const trace_id = `job-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`;

    const job = {
      job_id,
      trace_id,
      phase: "1.1",
      status: "queued",
      file_path: req.file.path,
      meta: { email },
      pricing_snapshot,
      payment: {
        status: "UNPAID",
        stripe_session_id: null
      },
      timestamps: {
        created: new Date().toISOString(),
        started: null,
        ended: null
      }
    };

    queue.addProject(job);

    res.json({
      ok: true,
      job_id,
      pricing_snapshot
    });
  }
);

// =============================================================
// 2. JOB STATUS
// =============================================================
const { mapInternalToReason } = require("./reason/reason_mapper");

app.get("/api/status/:job_id", statusLimiter, (req, res) => {
  const job = queue.getJob(req.params.job_id);
  if (!job) {
    return res.status(404).json({ error: "JOB_NOT_FOUND" });
  }

  // Kopiera ut från queue utan att mutera lagring
  const response = { ...job };

  // Enrich reason för failed-jobb (Phase 1.1 style)
  if (response.status === "failed") {
    const internalCode =
      response.fail_internal ||  // framtida granular
      response.fail_code ||      // Phase 1.1 backend policy string
      null;

    if (internalCode) {
      const context = {
        pricing_snapshot: response.pricing_snapshot || null
      };
      response.reason = mapInternalToReason(internalCode, context);
    } else {
      response.reason = null;
    }
  } else {
    response.reason = null;
  }

  // Phase 1.1 compatibility block (legacy json)
  response.compat = {
    fail_code: response.fail_code || null,
    fail_class: response.fail_class || null,
    customer_action: response.customer_action || null
  };

  // Markera legacy-fält som deprecated i API-responsen
  // men låt dem ligga kvar i queue_store.json på disk
  delete response.fail_code;
  delete response.fail_class;
  delete response.customer_action;

  return res.json(response);
});

// =============================================================
// 3. PRICING STATUS
// =============================================================
app.get("/api/pricing/status", (_, res) => {
  res.json(getCurrentPricingState());
});

// =============================================================
// 4. EXECUTION PROFILES
// =============================================================
app.get("/api/profiles", (_, res) => {
  res.json(executionProfiles);
});

// =============================================================
// 5. STRIPE CHECKOUT
// =============================================================
app.post("/api/pay/:job_id", async (req, res) => {
  const job = queue.getJob(req.params.job_id);

  if (!job) return res.status(404).json({ error: "JOB_NOT_FOUND" });
  if (job.status !== "success")
    return res.status(400).json({ error: "JOB_NOT_COMPLETED" });
  if (job.payment.status === "PAID")
    return res.status(400).json({ error: "ALREADY_PAID" });

  try {
    const amountCents = Math.round(
      Math.max(job.pricing_snapshot.price_usd, 0.5) * 100
    );

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
      metadata: {
        job_id: job.job_id,
        trace_id: job.trace_id
      },
      success_url:
        `https://sulmada.github.io/gpurenderstudio/status/?job_id=${job.job_id}&paid=1`,
      cancel_url:
        `https://sulmada.github.io/gpurenderstudio/status/?job_id=${job.job_id}&cancelled=1`
    });

    job.payment.stripe_session_id = session.id;
    queue.updateJob(job);

    res.json({ checkout_url: session.url });

  } catch (err) {
    console.error("[STRIPE_SESSION_FAILED]", {
      message: err.message,
      type: err.type,
      rawType: err.rawType,
      statusCode: err.statusCode
    });

    res.status(502).json({
      error: "STRIPE_SESSION_FAILED",
      detail: err.message
    });
  }
});

// =============================================================
// 6. DOWNLOAD OUTPUT (PAID ONLY)
// =============================================================
app.get("/api/download/:job_id", async (req, res) => {
  try {
    const jobId = req.params.job_id;
    const job = queue.getJob(jobId);

    if (!job) {
      return res.status(404).json({ error: "JOB_NOT_FOUND" });
    }

    if (job.status !== "success") {
      return res.status(400).json({ error: "JOB_NOT_COMPLETED" });
    }

    if (job.payment?.status !== "PAID") {
      return res.status(402).json({ error: "PAYMENT_REQUIRED" });
    }

    const renderDir = path.join(RENDER_ROOT, jobId);

    console.log("[DOWNLOAD] cwd =", process.cwd());
    console.log("[DOWNLOAD] checking =", renderDir);

    if (!fs.existsSync(renderDir)) {
      console.error("[DOWNLOAD] Missing render directory:", renderDir);
      return res.status(500).json({ error: "OUTPUT_NOT_FOUND" });
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="render_${jobId}.zip"`
    );

    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.on("error", err => {
      console.error("[DOWNLOAD] Archive error:", err);
      res.status(500).end();
    });

    archive.pipe(res);
    archive.directory(renderDir, false);
    archive.finalize();

  } catch (err) {
    console.error("[DOWNLOAD_FAILED]", err);
    res.status(500).json({ error: "DOWNLOAD_FAILED" });
  }
});

// =============================================================
// LISTEN
// =============================================================
app.listen(3001, "0.0.0.0", () => {
  console.log("Backend running on http://0.0.0.0:3001");
});
