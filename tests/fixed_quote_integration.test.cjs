"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const pricing = require("../assets/js/render_pricing.js");
const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const status = fs.readFileSync(path.join(root, "status/index.html"), "utf8");
const quote = {quote_id:"fixed-test",pricing_model:"FIXED_QUOTE_V1",plan:"budget",currency:"USD",quoted_price_usd:3.25,expires_at:new Date(Date.now()+3600000).toISOString()};
const response = {pricing_model:"FIXED_QUOTE_V1",fixed_quote_offers:{budget:quote},real_precheck:{estimated_hours_real:0.1},pricing_snapshot:{plans:{budget:{max_hours:1.5}}},plan_suggestion:{recommended_profile:"budget",plan_analysis:[{plan:"budget",fits:true}]}};
test("fixed-price adapter uses backend offer and opaque quote id",()=>{
 const model=pricing.makeModel(response);
 assert.equal(model.rows[0].fixedPrice,3.25);
 assert.deepEqual(pricing.makeConfirmation(model,"job-test","budget",null),{job_id:"job-test",plan:"budget",contract_type:"FIXED_QUOTE",quote_id:"fixed-test",voucher_code:null});
});
test("hourly prechecks fail closed",()=>{
 assert.throws(()=>pricing.makeModel({...response,pricing_model:undefined}),/not available/);
});
test("verified homepage uses fixed quote without hourly confirmation",()=>{
 assert.match(html,/src="\/assets\/js\/render_pricing\.js"/);
 assert.match(html,/GpuRenderPricing\.makeModel\(precheck\)/);
 assert.match(html,/GpuRenderPricing\.makeConfirmation\(/);
 assert.match(html,/Your total agreed render price/);
 assert.doesNotMatch(html,/let contract_type = "HOURLY_BUDGET"/);
 assert.match(html,/getJobToken\(CURRENT_JOB_ID\)/);
 assert.match(html,/\/api\/contracts\/confirm/);
});
test("status and download implementation still present",()=>{
 assert.match(status,/access_token/);
 assert.match(html,/renderMyJobs\(data\.jobs\)/);
});

