"use strict";

// Offline test. All customer prices MUST originate from backend quote offers.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const pricing = require("../assets/js/render_pricing");

const plans = {
  budget: { max_hours: 1.5, minimum_price_usd: 1, hourly_rate_usd: 1 },
  standard: { max_hours: 4, minimum_price_usd: 3, hourly_rate_usd: 1 },
  fast: { max_hours: 8, minimum_price_usd: 6, hourly_rate_usd: 1.25 },
  express: { max_hours: 12, minimum_price_usd: 10, hourly_rate_usd: 1.5 },
  long_render: { max_hours: null, minimum_price_usd: 12, hourly_rate_usd: 1 }
};

function response(hours, recommended, offeredPrices, manual = false) {
  const expires_at = new Date(Date.now() + 3600000).toISOString();
  const offers = Object.fromEntries(
    Object.entries(offeredPrices).map(([plan, amount]) => [plan, {
      quote_id: "quote-" + plan,
      pricing_model: "FIXED_QUOTE_V1",
      plan,
      currency: "USD",
      fixed_price_usd: amount,
      expires_at
    }])
  );
  return {
    status: "OK",
    pricing_model: "FIXED_QUOTE_V1",
    fixed_quote_offers: offers,
    real_precheck: { status: "OK", estimated_hours_real: hours, requires_manual_quote: manual },
    requires_manual_quote: manual,
    manual_quote: { reason: "Manual review required" },
    pricing_snapshot: { plans },
    plan_suggestion: {
      recommended_profile: recommended,
      manual_review_required: manual,
      plan_analysis: Object.keys(plans).map((plan) => ({
        plan, fits: plan === "long_render" ? hours > 12 : hours <= plans[plan].max_hours
      }))
    }
  };
}

test("UI takes exact quoted dollars from server, not plan rate x estimated time", () => {
  const model = pricing.makeModel(response(7.2, "fast", { fast: 11.25, express: 17.33 }));
  assert.equal(model.recommended, "fast");
  assert.equal(model.rows.find((p) => p.key === "fast").fixedPrice, 11.25);
  assert.equal(model.rows.find((p) => p.key === "express").fixedPrice, 17.33);
  assert.equal(model.rows.find((p) => p.key === "standard").eligible, false);
  assert.equal(model.rows.find((p) => p.key === "long_render").eligible, false);
});

test("short-job backend fixed offers are not recomputed in browser", () => {
  const model = pricing.makeModel(response(0.5, "budget",
    { budget: 1, standard: 3, fast: 6.50, express: 10 }));
  assert.equal(model.rows.find((p) => p.key === "fast").fixedPrice, 6.5);
});

test("confirmation sends only a server-issued quote ID, never a client-set amount", () => {
  const model = pricing.makeModel(response(7.2, "fast", { fast: 11.25 }));
  const request = pricing.makeConfirmation(model, "job-1", "fast", "launch");
  assert.deepEqual(request, {
    job_id: "job-1",
    plan: "fast",
    contract_type: "FIXED_QUOTE",
    quote_id: "quote-fast",
    voucher_code: "launch"
  });
  assert.throws(() => pricing.makeConfirmation(model, "job-1", "standard"), /valid fixed-price/);
});

test("Long Render is manual-quote only in first fixed-price version", () => {
  const model = pricing.makeModel(response(13, "long_render", {}, true));
  assert.equal(model.manualQuote, true);
  assert.equal(model.recommended, null);
  assert.throws(() => pricing.makeConfirmation(model, "job-2", "long_render"), /manual/);
});

test("old hourly backend and missing offers fail closed", () => {
  assert.throws(() => pricing.makeModel({
    real_precheck: { estimated_hours_real: 1 },
    pricing_snapshot: { plans }
  }), /not available/);
  const old = response(1, "budget", { budget: 2 });
  delete old.pricing_model;
  assert.throws(() => pricing.makeModel(old), /not available/);
});

test("expired quotes cannot be confirmed", () => {
  const data = response(1, "budget", { budget: 2 });
  const model = pricing.makeModel(data);
  const plan = model.rows.find((p) => p.key === "budget");
  assert.throws(() => pricing.makeConfirmation(model, "job", "budget",
    null, Date.parse(plan.expiresAt) + 1), /expired/);
});

test("homepage accepts locked offers and idempotent confirmation without hourly controls", () => {
  const html = fs.readFileSync(path.resolve(__dirname, "../index.html"), "utf8");
  assert.match(html, /src="\/assets\/js\/render_pricing\.js"/);
  assert.match(html, /GpuRenderPricing\.makeModel/);
  assert.match(html, /GpuRenderPricing\.makeConfirmation/);
  assert.match(html, /data\?\.ok === true/);
  assert.match(html, /\/api\/contracts\/confirm/);
  assert.match(html, /Your total agreed render price/);
  assert.doesNotMatch(html, /\bslot_analysis\b|\bslot_prices_usd\b|\bslotRadio\b/);
  assert.doesNotMatch(html, /capSlider|overflowToggle|HOURLY_OVERFLOW/);
  const landing = fs.readFileSync(path.resolve(__dirname, "../blender-render-farm.html"), "utf8");
  assert.doesNotMatch(landing, /exact price/i);
});

