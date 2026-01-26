// backend/contracts/api_confirm.js – Phase 1.3 LOCKED
"use strict";

const queue = require("../queue");

module.exports = function apiConfirm(req, res) {
  const { job_id, slot, contract_type, cap_usd } = req.body || {};

  // --------------------------------------------------
  // Basic validation
  // --------------------------------------------------
  if (!job_id) {
    return res.status(400).json({ error: "MISSING_JOB_ID" });
  }

  const job = queue.getJob(job_id);
  if (!job) {
    return res.status(404).json({ error: "JOB_NOT_FOUND" });
  }

  // --------------------------------------------------
  // Idempotency guard
  // --------------------------------------------------
  if (job.contract && job.contract.valid) {
    console.log(`[CONFIRM] idempotent hit for job ${job_id}`);

    return res.json({
      ok: true,
      idempotent: true,
      job_id,
      status: job.status,
      contract: job.contract
    });
  }

  // --------------------------------------------------
  // Status guard
  // --------------------------------------------------
  if (job.status !== "uploaded") {
    return res.status(409).json({
      error: "JOB_ALREADY_CONFIRMED",
      status: job.status
    });
  }

  if (!job.real_precheck || job.real_precheck.status !== "OK") {
    return res.status(400).json({ error: "REAL_PRECHECK_REQUIRED" });
  }

  if (!slot) {
    return res.status(400).json({ error: "MISSING_SLOT" });
  }

  // --------------------------------------------------
  // Pricing snapshot required for Phase 1.3
  // --------------------------------------------------
  const ps = job.pricing_snapshot;
  if (!ps) {
    console.error(`[CONFIRM] missing pricing snapshot for ${job_id}`);
    return res.status(500).json({ error: "MISSING_PRICING_SNAPSHOT" });
  }

  const hourlyRate = Number(ps.hourly_rate_usd || 1);
  const slotLimits = ps.slot_limits || {};
  const baseHours = Number(slotLimits[slot]);

  if (!Number.isFinite(hourlyRate) || hourlyRate <= 0) {
    return res.status(500).json({ error: "INVALID_HOURLY_RATE" });
  }

  if (!Number.isFinite(baseHours) || baseHours <= 0) {
    return res.status(400).json({ error: "INVALID_SLOT" });
  }

  // --------------------------------------------------
  // Contract type validation
  // --------------------------------------------------
  const validTypes = new Set([
    "HOURLY_BUDGET",
    "HOURLY_OVERFLOW",
    "HOURLY_OVERFLOW_CAP"
  ]);

  if (!contract_type || !validTypes.has(contract_type)) {
    return res.status(400).json({ error: "INVALID_CONTRACT_TYPE" });
  }

  // --------------------------------------------------
  // Contract semantics (Phase 1.3)
  // --------------------------------------------------
  let execution_mode = "BUDGET_STOP";
  let overflow_allowed = false;
  let cap_enabled = false;
  let final_cap_usd = null;
  let final_cap_hours = Infinity;

  if (contract_type === "HOURLY_BUDGET") {
    execution_mode = "BUDGET_STOP";
    overflow_allowed = false;
  }

  if (contract_type === "HOURLY_OVERFLOW") {
    execution_mode = "HARD_RUN";
    overflow_allowed = true;
  }

  if (contract_type === "HOURLY_OVERFLOW_CAP") {
    execution_mode = "HARD_RUN";
    overflow_allowed = true;
    cap_enabled = true;

    if (cap_usd === undefined || cap_usd === null || isNaN(cap_usd)) {
      return res.status(400).json({ error: "CAP_REQUIRED" });
    }

    final_cap_usd = Number(cap_usd);

    if (!Number.isFinite(final_cap_usd) || final_cap_usd <= 0) {
      return res.status(400).json({ error: "INVALID_CAP_VALUE" });
    }

    final_cap_hours = final_cap_usd / hourlyRate;

    if (!Number.isFinite(final_cap_hours) || final_cap_hours <= 0) {
      return res.status(400).json({ error: "INVALID_CAP_RESULT" });
    }

    // round to seconds precision (prevents float drift in runtime_budget)
    final_cap_hours =
      Math.floor(final_cap_hours * 3600) / 3600;
  }

  // --------------------------------------------------
  // Build contract
  // --------------------------------------------------
  const base_price_usd = baseHours * hourlyRate;

  const contract = {
    job_id,

    slot,
    contract_type,
    execution_mode,

    base_hours_limit: baseHours,
    hourly_rate_usd: hourlyRate,
    base_price_usd,

    overflow_allowed,

    cap_enabled,
    cap_usd: final_cap_usd,
    cap_hours: final_cap_hours,

    confirmed_at: new Date().toISOString(),
    valid: true
  };

  // --------------------------------------------------
  // State transition: uploaded → queued
  // --------------------------------------------------
  job.contract = contract;
  job.status = "queued";

  queue.updateJob(job);

  console.log(
    `[CONFIRM] job=${job_id} slot=${slot} type=${contract_type} overflow=${overflow_allowed} cap=${final_cap_usd}`
  );

  return res.json({
    status: "OK",
    job_id,
    contract
  });
};
