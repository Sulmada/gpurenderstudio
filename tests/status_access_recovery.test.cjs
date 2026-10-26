"use strict";

// Offline browser harness for the actual public status/index.html.
// No network requests, production credentials or server operations.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "../status/index.html"), "utf8");
const match = html.match(/<script>\s*([\s\S]*?)\s*<\/script>/);
assert.ok(match, "status page must retain its script");
const script = new vm.Script(match[1], { filename: "status/index.html" });

function openStatus(search, stored = {}) {
  const elements = new Map();
  const clipboard = [];
  const local = new Map(Object.entries(stored));
  function element(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        style: {},
        className: "",
        classList: { add() {} },
        textContent: "",
        innerHTML: "",
        children: [],
        handlers: {},
        parentNode: { insertBefore() {} },
        appendChild(node) { this.children.push(node); },
        addEventListener(event, callback) { this.handlers[event] = callback; },
        load() {},
        play() { return Promise.resolve(); }
      });
    }
    return elements.get(id);
  }
  const location = {
    origin: "https://gpurenderstudio.com",
    hostname: "gpurenderstudio.com",
    search
  };
  const context = {
    window: { location },
    location,
    URL,
    URLSearchParams,
    navigator: { clipboard: { async writeText(text) { clipboard.push(text); } } },
    localStorage: {
      getItem(k) { return local.get(k) || null; },
      setItem(k, v) { local.set(k, v); }
    },
    document: {
      getElementById: element,
      createElement: () => element("new-" + elements.size),
      querySelector: () => ({ textContent: "" })
    },
    console: { log() {}, warn() {}, error() {} },
    fetch: async () => ({ ok: true, json: async () => ({ status: "queued" }) }),
    setTimeout: () => 1,
    clearTimeout() {},
  };
  script.runInNewContext(context, { timeout: 5000 });
  return { element, clipboard, local };
}

(async () => {
  const job = "4857a420-d1a3-4b60-9fa5-469359a73324";
  const token = "a".repeat(64);

  // Direct navigation without a job ID cannot produce an unusable link.
  const empty = openStatus("");
  assert.equal(empty.element("jobStatus").textContent, "Missing job_id");
  assert.equal(empty.element("copyLinkBtn").style.display, "none");

  // From an email with no valid token: show identifier and recovery action.
  const lost = openStatus("?job_id=" + job);
  assert.equal(lost.element("jobId").textContent, job);
  assert.equal(lost.element("jobStatus").textContent, "Missing access token");
  assert.equal(lost.element("copyLinkBtn").style.display, "none");
  assert.equal(lost.element("actionArea").children[0].href, "/#my-jobs");

  // A different device with a token-bearing completion email is authorized.
  const fresh = openStatus("?job_id=" + job + "&access_token=" + token);
  assert.equal(fresh.local.get("job_token_" + job), token);
  await fresh.element("copyLinkBtn").handlers.click();
  const copied = new URL(fresh.clipboard[0]);
  assert.equal(copied.pathname, "/status/");
  assert.equal(copied.searchParams.get("job_id"), job);
  assert.equal(copied.searchParams.get("access_token"), token);

  // Stripe can return without a query token to the original browser.
  // The copied link must still include the securely stored job token.
  const returned = openStatus("?job_id=" + job + "&paid=1", {
    ["job_token_" + job]: token
  });
  await returned.element("copyLinkBtn").handlers.click();
  const canonical = new URL(returned.clipboard[0]);
  assert.equal(canonical.searchParams.get("access_token"), token);
  assert.equal(canonical.searchParams.has("paid"), false);
  assert.match(html, /name="referrer" content="no-referrer"/);

  console.log("Status page access recovery: PASS (4 browser scenarios)");
})().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
