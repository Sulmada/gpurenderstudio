"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
function sourceBetween(start, end) {
  const a = html.indexOf(start);
  assert.ok(a >= 0, "missing source anchor: " + start);
  const b = html.indexOf(end, a + start.length);
  assert.ok(b > a, "missing source end: " + end);
  return html.slice(a, b);
}
const chooserSource = sourceBetween(
  "function publicName(name) {",
  "/* =========================================================\n   CONFIRM"
);
const confirmSource = sourceBetween(
  "async function confirmContract() {",
  "if (myJobsList) {"
);

function fixture() {
  const config = [
    ["budget", 1, 1, 1.5],
    ["standard", 3, 1, 4],
    ["fast", 6, 1.25, 8],
    ["express", 10, 1.5, 12],
    ["long_render", 12, 1, null]
  ];
  return {
    real_precheck: {
      estimated_hours_real: 0.05,
      estimated_hours_effective: 0.05,
      estimated_time_human: "3m"
    },
    pricing_snapshot: {
      plans: Object.fromEntries(config.map(([name, min, rate, max]) =>
        [name, { minimum_price_usd: min, hourly_rate_usd: rate, max_hours: max }]))
    },
    plan_suggestion: {
      recommended_profile: "budget",
      plan_analysis: config.map(([plan]) => ({
        plan,
        fits: plan !== "long_render",
        exceeds: plan === "long_render",
        near_limit: false
      }))
    },
    requires_manual_quote: false
  };
}

function dom() {
  let htmlContent = "";
  const elements = new Map();
  const resultBox = {
    textContent: "",
    get innerHTML() { return htmlContent; },
    set innerHTML(value) { htmlContent = value; }
  };
  function getElement(id) {
    if (!elements.has(id)) elements.set(id, {
      id,
      checked: false,
      disabled: false,
      value: id === "capSlider" ? "5" : "",
      style: { display: "" },
      textContent: "",
      addEventListener() {}
    });
    return elements.get(id);
  }
  function radios() {
    return [...htmlContent.matchAll(
      /<input type="radio" name="slotRadio" value="([^"]+)"([^>]*)>/g
    )].map(match => ({
      value: match[1],
      checked: /\bchecked\b/.test(match[2]),
      disabled: /\bdisabled\b/.test(match[2])
    }));
  }
  const document = {
    getElementById: getElement,
    querySelector(selector) {
      return selector.includes('slotRadio')
        ? radios().find(r => r.checked && !r.disabled) || null : null;
    },
    querySelectorAll(selector) {
      return selector.includes('slotRadio')
        ? radios().map(r => ({ ...r, addEventListener() {} })) : [];
    }
  };
  return { document, resultBox, radios };
}

function evaluateChooser(model) {
  const ui = dom();
  const scope = {
    document: ui.document,
    resultBox: ui.resultBox,
    safeNum: x => typeof x === "number" && Number.isFinite(x) ? x : null,
    confirmContract() {}
  };
  vm.runInNewContext(chooserSource, scope);
  scope.renderSlotChooser(model);
  const button = ui.resultBox.innerHTML.match(
    /<button[^>]*id="confirmBtn"[^>]*>/
  )?.[0];
  assert.ok(button, "confirmation button missing");
  return {
    ...ui,
    buttonDisabled: /\bdisabled\b/.test(button),
    selected: ui.radios().find(r => r.checked)?.value || null
  };
}

test("Phase 2 Budget plan has a checked radio and correct minimum", () => {
  const ui = evaluateChooser(fixture());
  assert.equal(ui.selected, "budget");
  assert.equal(ui.buttonDisabled, false);
  assert.equal(ui.radios().length, 5);
  assert.equal(ui.radios().find(r => r.value === "long_render").disabled, true);
  assert.ok(ui.resultBox.innerHTML.includes("Estimated $1.00"));
  assert.ok(ui.resultBox.innerHTML.includes("minimum $1.00"));
});

test("manual quote prevents automatic confirmation", () => {
  const model = fixture();
  model.requires_manual_quote = true;
  const ui = evaluateChooser(model);
  assert.equal(ui.selected, null);
  assert.equal(ui.buttonDisabled, true);
  assert.ok(ui.resultBox.innerHTML.includes("manual quote"));
});

test("Long Render is selectable only when eligible", () => {
  const model = fixture();
  model.real_precheck.estimated_hours_real = 14;
  model.plan_suggestion.recommended_profile = "long_render";
  for (const option of model.plan_suggestion.plan_analysis) {
    option.fits = option.plan === "long_render";
    option.exceeds = !option.fits;
  }
  const ui = evaluateChooser(model);
  assert.equal(ui.selected, "long_render");
  assert.equal(ui.buttonDisabled, false);
  assert.equal(ui.radios().find(r => r.value === "budget").disabled, true);
});

test("missing plan analysis fails closed", () => {
  const model = fixture();
  model.plan_suggestion.plan_analysis = [];
  const ui = evaluateChooser(model);
  assert.equal(ui.selected, null);
  assert.equal(ui.buttonDisabled, true);
});

test("confirmation posts canonical plan, never legacy slot", async () => {
  const model = fixture();
  let request = null;
  const status = { textContent: "" };
  const elements = {
    confirmBtn: { disabled: false, textContent: "" },
    overflowToggle: { checked: false },
    capBlock: { style: { display: "none" } },
    capSlider: { value: "5" },
    voucherInput: { value: "" }
  };
  const scope = {
    CURRENT_JOB_ID: "fixture-job",
    CURRENT_PRECHECK: model,
    API_BASE: "https://example.invalid",
    confirmStatus: status,
    getJobToken() { return null; },
    window: { location: { origin: "https://example.invalid", href: "" } },
    document: {
      getElementById: id => elements[id] || null,
      querySelector: () => ({ value: "budget" })
    },
    fetch: async (url, init) => {
      request = { url, body: JSON.parse(init.body) };
      return { ok: true, json: async () => ({ status: "OK" }) };
    }
  };
  vm.runInNewContext("let CONFIRM_IN_FLIGHT = false;\n" + confirmSource, scope);
  await scope.confirmContract();
  assert.equal(request.body.plan, "budget");
  assert.ok(!Object.prototype.hasOwnProperty.call(request.body, "slot"));
  assert.equal(request.body.contract_type, "HOURLY_BUDGET");
  assert.equal(request.body.job_id, "fixture-job");
});
