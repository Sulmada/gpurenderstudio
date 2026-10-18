/* GPU Render Studio Phase 2 pricing adapter.
 * Prices and eligibility are read exclusively from the actual precheck response.
 * Do not introduce static prices or the retired slot_prices_usd schema here.
 */
(function (root) {
  "use strict";

  const ORDER = ["budget", "standard", "fast", "express", "long_render"];
  const NAMES = {
    budget: "Budget",
    standard: "Standard",
    fast: "Fast",
    express: "Express",
    long_render: "Long Render"
  };

  function money(amount) {
    return "$" + Number(amount).toFixed(2);
  }

  function makeModel(precheck) {
    const plans = precheck && precheck.pricing_snapshot && precheck.pricing_snapshot.plans;
    const suggestion = precheck && (precheck.plan_suggestion || precheck.slot_suggestion);
    const analysis = suggestion && suggestion.plan_analysis;
    const hours = precheck && precheck.real_precheck && precheck.real_precheck.estimated_hours_real;

    if (!plans || !Array.isArray(analysis) || typeof hours !== "number" ||
        !Number.isFinite(hours) || hours < 0) {
      throw new Error("Pricing information is unavailable. Please do not confirm this job; contact support.");
    }

    const byPlan = Object.fromEntries(analysis.map((entry) => [entry.plan, entry]));
    const manualQuote = precheck.requires_manual_quote === true ||
      suggestion.manual_review_required === true ||
      precheck.real_precheck.requires_manual_quote === true;

    const rows = ORDER.map((key) => {
      const config = plans[key];
      const fit = byPlan[key];
      if (!config || !fit) return null;
      const minimum = config.minimum_price_usd;
      const hourly = config.hourly_rate_usd;
      if (typeof minimum !== "number" || !Number.isFinite(minimum) || minimum <= 0 ||
          typeof hourly !== "number" || !Number.isFinite(hourly) || hourly <= 0) {
        throw new Error("Incomplete pricing for " + key + ". Please contact support.");
      }
      return {
        key: key,
        label: NAMES[key],
        minimum: minimum,
        hourly: hourly,
        maxHours: config.max_hours,
        eligible: !manualQuote && fit.fits === true,
        estimatedPrice: Math.max(minimum, hours * hourly),
        preemptible: config.preemptible === true
      };
    }).filter(Boolean);

    const recommended = rows.some((r) => r.key === suggestion.recommended_profile && r.eligible)
      ? suggestion.recommended_profile
      : (rows.find((r) => r.eligible) || {}).key || null;

    return {
      manualQuote: manualQuote,
      manualReason: precheck.manual_quote && precheck.manual_quote.reason,
      hours: hours,
      rows: rows,
      recommended: recommended
    };
  }

  function makeConfirmation(model, jobId, planKey, allowExtended, capExtraUsd, voucherCode) {
    if (!jobId) throw new Error("Missing job ID.");
    if (!model || model.manualQuote) throw new Error("This job requires manual review.");
    const plan = model.rows.find((row) => row.key === planKey && row.eligible);
    if (!plan) throw new Error("Select an eligible render plan.");

    let contractType = "HOURLY_BUDGET";
    let capUsd = null;
    if (plan.key === "long_render") {
      // The backend explicitly routes eligible multi-frame long renders to an
      // uncapped, lower-priority, between-frames-preemptible execution mode.
      contractType = "HOURLY_OVERFLOW";
    } else if (allowExtended) {
      const extra = Number(capExtraUsd);
      if (!Number.isFinite(extra) || extra <= 0) {
        throw new Error("An additional spending limit is required for extended runs.");
      }
      contractType = "HOURLY_OVERFLOW_CAP";
      capUsd = extra; // Backend expects EXTRA USD, not total cap.
    }
    return {
      job_id: jobId,
      plan: plan.key,
      contract_type: contractType,
      cap_usd: capUsd,
      voucher_code: voucherCode ? String(voucherCode).trim() : null
    };
  }

  const api = { makeModel: makeModel, makeConfirmation: makeConfirmation, money: money };
  if (root) root.GpuRenderPricing = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : null);
