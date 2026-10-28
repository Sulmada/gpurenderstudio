/* GPU Render Studio fixed-price offer adapter.
 * Never compute the customer's quote from rates in the browser.
 * The server-owned, precheck-persisted quote is the sole billing authority.
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

  function makeModel(precheck, nowMs = Date.now()) {
    const snapshot = precheck?.pricing_snapshot;
    const plans = snapshot?.plans;
    const suggestion = precheck?.plan_suggestion || precheck?.slot_suggestion;
    const analysis = suggestion?.plan_analysis;
    const offers = precheck?.fixed_quote_offers;
    const hours = precheck?.real_precheck?.estimated_hours_real;

    // Refuse to display "estimated = fixed" on an older hourly backend.
    if (precheck?.pricing_model !== "FIXED_QUOTE_V1" ||
        !offers || !plans || !Array.isArray(analysis) ||
        typeof hours !== "number" || !Number.isFinite(hours) || hours < 0) {
      throw new Error("Fixed-price quotes are not available yet. Please try again later.");
    }

    const byPlan = Object.fromEntries(analysis.map((entry) => [entry.plan, entry]));
    const manualQuote = precheck.requires_manual_quote === true ||
      suggestion.manual_review_required === true ||
      precheck.real_precheck.requires_manual_quote === true;

    const rows = ORDER.map((key) => {
      const config = plans[key];
      const fit = byPlan[key];
      if (!config || !fit) return null;
      const offer = offers[key];
      const expiryMs = offer ? Date.parse(offer.expires_at) : NaN;
      const validOffer = offer && offer.pricing_model === "FIXED_QUOTE_V1" &&
        offer.plan === key && offer.currency === "USD" &&
        typeof offer.quoted_price_usd === "number" &&
        Number.isFinite(offer.quoted_price_usd) && offer.quoted_price_usd > 0 &&
        typeof offer.quote_id === "string" && offer.quote_id.length > 0 &&
        Number.isFinite(expiryMs) && nowMs < expiryMs;

      return {
        key,
        label: NAMES[key],
        maxHours: config.max_hours,
        eligible: !manualQuote && fit.fits === true && !!validOffer,
        fixedPrice: validOffer ? offer.quoted_price_usd : null,
        quoteId: validOffer ? offer.quote_id : null,
        expiresAt: validOffer ? offer.expires_at : null
      };
    }).filter(Boolean);

    const recommended = rows.some((r) => r.key === suggestion.recommended_profile && r.eligible)
      ? suggestion.recommended_profile
      : (rows.find((r) => r.eligible) || {}).key || null;

    return {
      manualQuote,
      manualReason: precheck?.manual_quote?.reason,
      hours,
      rows,
      recommended
    };
  }

  function makeConfirmation(model, jobId, planKey, voucherCode, nowMs = Date.now()) {
    if (!jobId) throw new Error("Missing job ID.");
    if (!model || model.manualQuote) throw new Error("This job requires manual review.");
    const plan = model.rows.find((row) => row.key === planKey && row.eligible);
    if (!plan) throw new Error("Select a plan with a valid fixed-price quote.");
    if (!Number.isFinite(Date.parse(plan.expiresAt)) || nowMs >= Date.parse(plan.expiresAt)) {
      throw new Error("The fixed-price quote has expired. Please run precheck again.");
    }

    // The browser sends only the opaque quote ID. The backend validates it
    // against the persisted offer and writes the locked amount to the contract.
    return {
      job_id: jobId,
      plan: plan.key,
      contract_type: "FIXED_QUOTE",
      quote_id: plan.quoteId,
      voucher_code: voucherCode ? String(voucherCode).trim() : null
    };
  }

  const api = { makeModel, makeConfirmation, money };
  if (root) root.GpuRenderPricing = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : null);

