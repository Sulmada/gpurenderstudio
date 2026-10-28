"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const pricing=require("../assets/js/render_pricing");
test("a server amount is displayed unchanged even if rates/multipliers suggest a different amount",()=>{
 const data={pricing_model:"FIXED_QUOTE_V1",fixed_quote_offers:{budget:{pricing_model:"FIXED_QUOTE_V1",plan:"budget",currency:"USD",quoted_price_usd:7.37,quote_id:"server-only",expires_at:new Date(Date.now()+60000).toISOString()}},
  pricing_snapshot:{time_multiplier:999,plans:{budget:{max_hours:1.5,minimum_price_usd:99,hourly_rate_usd:999}}},real_precheck:{estimated_hours_real:0.01},plan_suggestion:{recommended_profile:"budget",plan_analysis:[{plan:"budget",fits:true}]}};
 const model=pricing.makeModel(data);assert.equal(pricing.money(model.rows[0].fixedPrice),"$7.37");
 model.rows[0].fixedPrice=0.01;
 const payload=pricing.makeConfirmation(model,"job","budget");assert.equal(payload.quote_id,"server-only");
 assert.equal(Object.hasOwn(payload,"quoted_price_usd"),false);
});
test("current public pricing copy promises a locked total, never a runtime meter",()=>{
 for(const name of ["index.html","pricing-explained.html","blender-render-farm.html"]){
  const text=fs.readFileSync(path.join(__dirname,"..",name),"utf8");
  assert.match(text,/fixed|locked/i);assert.match(text,/cannot increase|never increases/i);
  assert.doesNotMatch(text,/actual GPU render time [×*]|spending cap for extended jobs|estimated \$/i);
 }
});
test("staging pages on loopback 8088 use API 3002 and public pages keep production API",()=>{
 const vm=require("node:vm");
 for(const page of ["index.html","status/index.html"]){
  const html=fs.readFileSync(path.join(__dirname,"..",page),"utf8");
  const expression=html.match(/const API_BASE = [\s\S]*?;/)[0]+"\nAPI_BASE";
  for(const hostname of ["localhost","127.0.0.1"])
   assert.equal(vm.runInNewContext(expression,{window:{},location:{hostname,port:"8088"}}),`http://${hostname}:3002`);
  assert.equal(vm.runInNewContext(expression,{window:{},location:{hostname:"gpurenderstudio.com",port:""}}),"https://api.gpurenderstudio.com");
 }
});

test("advisory calculator cannot display legacy slot prices as customer quotes",()=>{
 const text=fs.readFileSync(path.join(__dirname,"..","tools/render-time-calculator.html"),"utf8");
 assert.match(text,/time illustration, not a price quote/);
 assert.doesNotMatch(text,/slot_prices_usd|Likely Studio Plans/);
});
