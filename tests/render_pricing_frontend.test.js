"use strict";

// Run: node --test tests/render_pricing_frontend.test.js
// Pure, offline regression tests: no GPU access, HTTP calls or payment operations.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const pricing = require("../assets/js/render_pricing");

const plans = {
  budget: { max_hours: 1.5, minimum_price_usd: 1, hourly_rate_usd: 1, preemptible: false },
  standard: { max_hours: 4, minimum_price_usd: 3, hourly_rate_usd: 1, preemptible: false },
  fast: { max_hours: 8, minimum_price_usd: 6, hourly_rate_usd: 1.25, preemptible: false },
  express: { max_hours: 12, minimum_price_usd: 10, hourly_rate_usd: 1.5, preemptible: false },
  long_render: { max_hours: null, minimum_price_usd: 12, hourly_rate_usd: 1, preemptible: true }
};

function response(hours, recommended, manual = false, longEligible = false) {
  return {
    status: "OK",
    real_precheck: { status: "OK", estimated_hours_real: hours, requires_manual_quote: manual },
    requires_manual_quote: manual,
    manual_quote: { reason: "Manual review needed" },
    pricing_snapshot: { plans },
    plan_suggestion: {
      recommended_profile: recommended,
      manual_review_required: manual,
      plan_analysis: [
        ...["budget", "standard", "fast", "express"].map((plan) => ({
          plan, fits: hours <= plans[plan].max_hours
        })),
        { plan: "long_render", fits: longEligible }
      ]
    }
  };
}

test("pricing uses live canonical plans, including Fast and Express hourly rates", () => {
  const model = pricing.makeModel(response(7.2, "fast"));
  assert.equal(model.recommended, "fast");
  assert.equal(model.rows.find((p) => p.key === "fast").estimatedPrice, 9);
  assert.equal(model.rows.find((p) => p.key === "express").estimatedPrice, 10.8);
  assert.equal(model.rows.find((p) => p.key === "standard").eligible, false);
  assert.equal(model.rows.find((p) => p.key === "fast").eligible, true);
  assert.equal(model.rows.find((p) => p.key === "long_render").eligible, false);
});

test("short jobs respect plan minimums, not old fixed slot prices", () => {
  const model = pricing.makeModel(response(0.5, "budget"));
  assert.equal(model.rows.find((p) => p.key === "budget").estimatedPrice, 1);
  assert.equal(model.rows.find((p) => p.key === "standard").estimatedPrice, 3);
  assert.equal(model.rows.find((p) => p.key === "fast").estimatedPrice, 6);
  assert.equal(model.rows.find((p) => p.key === "express").estimatedPrice, 10);
});

test("ordinary confirmation uses canonical plan and never uncapped overflow", () => {
  const model = pricing.makeModel(response(7.2, "fast"));
  const request = pricing.makeConfirmation(model, "job-1", "fast", false, null, "launch");
  assert.deepEqual(request, {
    job_id: "job-1", plan: "fast", contract_type: "HOURLY_BUDGET",
    cap_usd: null, voucher_code: "launch"
  });
  const capped = pricing.makeConfirmation(model, "job-1", "fast", true, 5, null);
  assert.equal(capped.contract_type, "HOURLY_OVERFLOW_CAP");
  assert.equal(capped.cap_usd, 5); // Additional spending; backend adds plan minimum.
  assert.throws(() => pricing.makeConfirmation(model, "job-1", "fast", true, 0), /limit/);
  assert.throws(() => pricing.makeConfirmation(model, "job-1", "standard", false), /eligible/);
});

test("eligible Long Render is explicit, uncapped and preemptible in the backend", () => {
  const model = pricing.makeModel(response(13, "long_render", false, true));
  assert.equal(model.recommended, "long_render");
  assert.equal(model.rows.find((p) => p.key === "long_render").estimatedPrice, 13);
  const request = pricing.makeConfirmation(model, "job-2", "long_render", false, null);
  assert.equal(request.contract_type, "HOURLY_OVERFLOW");
  assert.equal(request.cap_usd, null);
});

test("manual quote or invalid schemas fail closed", () => {
  const model = pricing.makeModel(response(14, null, true, false));
  assert.equal(model.manualQuote, true);
  assert.throws(() => pricing.makeConfirmation(model, "job-3", "express", false), /manual/);
  assert.throws(() => pricing.makeModel({ real_precheck: { estimated_hours_real: 1 } }), /unavailable/);
});

test("published homepage uses new schema and accepts idempotent confirmation", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../index.html"), "utf8");
  assert.match(html, /src="\/assets\/js\/render_pricing\.js"/);
  assert.match(html, /GpuRenderPricing\.makeModel/);
  assert.match(html, /GpuRenderPricing\.makeConfirmation/);
  assert.match(html, /data\?\.ok === true/);
  assert.doesNotMatch(html, /\bslot_analysis\b|\bslot_prices_usd\b|\bslotRadio\b/);
  assert.doesNotMatch(html, /exact price/i, "do not promise fixed prices before rendering");
  assert.match(html, /\/api\/contracts\/confirm/, "Phase 2 confirm endpoint");
  const landing = fs.readFileSync(path.resolve(__dirname, "../blender-render-farm.html"), "utf8");
  assert.doesNotMatch(landing, /exact price/i, "landing page must not promise a fixed precheck price");
});
