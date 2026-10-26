"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const pricing = require("../assets/js/render_pricing.js");
const html = fs.readFileSync(path.join(__dirname, "../index.html"), "utf8");
const start = html.indexOf("function publicName(name) {");
const end = html.indexOf("/* =========================================================\n   CONFIRM", start);
assert.ok(start >= 0 && end > start, "plan chooser source anchors");
const chooser = html.slice(start, end);
const confirmStart = html.indexOf("async function confirmContract() {");
const confirmEnd = html.indexOf("if (myJobsList) {", confirmStart);
assert.ok(confirmStart >= 0 && confirmEnd > confirmStart, "confirmation source anchors");
const confirmation = html.slice(confirmStart, confirmEnd);
function precheck({manual=false,missing=false,long=false}={}) {
  const now = new Date(Date.now() + 3600000).toISOString();
  const names = ["budget","standard","fast","express","long_render"];
  const offers = Object.fromEntries(names.filter(n => n !== "long_render").map((plan,i) => [plan,{
    pricing_model:"FIXED_QUOTE_V1",plan,currency:"USD",fixed_price_usd:[1.75,3,6,10][i],
    quote_id:"opaque-"+plan,expires_at:now
  }]));
  return {
    pricing_model:"FIXED_QUOTE_V1", fixed_quote_offers:offers,
    real_precheck:{estimated_hours_real:long?14:0.05},
    pricing_snapshot:{plans:Object.fromEntries(names.map(n=>[n,{max_hours:n==="long_render"?null:12}]))},
    plan_suggestion:{
      recommended_profile:long?"long_render":"budget",
      manual_review_required:manual,
      plan_analysis:missing?[]:names.map(plan=>({plan,fits:long?plan==="long_render":plan!=="long_render"}))
    },
    requires_manual_quote:manual
  };
}
function render(data) {
  const elements = new Map();
  let htmlContent = "";
  const resultBox = {
    get innerHTML(){return htmlContent;},
    set innerHTML(v){htmlContent=v;},
    textContent:""
  };
  const el = id => {
    if (!elements.has(id)) elements.set(id,{id,textContent:"",disabled:false,value:"",
      addEventListener(){}});
    return elements.get(id);
  };
  const radios = () => [...htmlContent.matchAll(/<input type="radio" name="fixedPlanRadio" value="([^"]+)"([^>]*)>/g)].map(match=>({
    value:match[1], checked:/\bchecked\b/.test(match[2]), disabled:/\bdisabled\b/.test(match[2]),
    addEventListener(){}
  }));
  const document={
    getElementById:el,
    querySelector:selector=>selector.includes("fixedPlanRadio")?radios().find(r=>r.checked&&!r.disabled)||null:null,
    querySelectorAll:selector=>selector.includes("fixedPlanRadio")?radios():[]
  };
  const scope={resultBox,document,GpuRenderPricing:pricing,CURRENT_FIXED_QUOTE_MODEL:null,confirmStatus:{textContent:""},confirmContract(){}};
  vm.runInNewContext(chooser,scope);
  scope.renderSlotChooser(data);
  return {resultBox,radios,scope};
}
test("Budget selection displays exact server-fixed amount",()=>{
  const ui=render(precheck());
  assert.equal(ui.radios().find(r=>r.checked)?.value,"budget");
  assert.equal(ui.radios().length,5);
  assert.equal(ui.radios().find(r=>r.value==="long_render").disabled,true);
  assert.match(ui.resultBox.innerHTML,/\$1\.75 fixed total/);
  assert.doesNotMatch(ui.resultBox.innerHTML,/estimated \$|\/GPU hour/i);
});
test("manual review cannot be automatically confirmed",()=>{
  const ui=render(precheck({manual:true}));
  assert.equal(ui.radios().some(r=>r.checked),false);
  assert.match(ui.resultBox.innerHTML,/No automatic fixed-price offer/);
});
test("Long Render without a signed fixed offer is not selectable",()=>{
  const ui=render(precheck({long:true}));
  assert.equal(ui.radios().some(r=>r.checked),false);
  assert.equal(ui.radios().find(r=>r.value==="long_render").disabled,true);
});
test("missing plan analysis fails closed",()=>{
  const ui=render(precheck({missing:true}));
  assert.match(ui.resultBox.textContent,/not available/i);
  assert.equal(ui.radios().length,0);
});
test("confirmation posts only the canonical plan and server quote id",async()=>{
  const data=precheck();const model=pricing.makeModel(data);
  let request=null;
  const status={textContent:""};
  const doc={
    getElementById:id=>id==="confirmBtn"?{disabled:false,textContent:""}:id==="voucherInput"?{value:"launch"}:null,
    querySelector:()=>({value:"budget"})
  };
  const scope={
    CURRENT_JOB_ID:"fixture-job",CURRENT_FIXED_QUOTE_MODEL:model,
    API_BASE:"https://example.invalid",confirmStatus:status,GpuRenderPricing:pricing,
    getJobToken(){return "access-abc";},
    document:doc,console,
    window:{location:{origin:"https://example.invalid",href:""}},
    fetch:async(url,init)=>{request={url,body:JSON.parse(init.body)};
      return {ok:true,json:async()=>({status:"OK"})};}
  };
  vm.runInNewContext("let CONFIRM_IN_FLIGHT = false;\n"+confirmation,scope);
  await scope.confirmContract();
  assert.equal(request.body.plan,"budget");
  assert.equal(request.body.quote_id,"opaque-budget");
  assert.equal(request.body.contract_type,"FIXED_QUOTE");
  assert.equal(request.body.voucher_code,"launch");
  assert.equal(Object.hasOwn(request.body,"cap_usd"),false);
  assert.equal(Object.hasOwn(request.body,"fixed_price_usd"),false);
  assert.match(scope.window.location.href,/access_token=access-abc/);
});
