// Phase 1 – account tiers
// These modify the profile entry_price_usd via a multiplier.
// Prices remain per completed job.

module.exports = [
  { name: "ENTRY",        minJobs: 0,   multiplier: 1.00 },
  { name: "VERIFIED",     minJobs: 4,   multiplier: 0.97 },
  { name: "REGULAR",      minJobs: 11,  multiplier: 0.95 },
  { name: "ACTIVE",       minJobs: 26,  multiplier: 0.93 },
  { name: "TRUSTED",      minJobs: 76,  multiplier: 0.91 },
  { name: "HIGH_VOLUME",  minJobs: 200, multiplier: 0.89 }
];
