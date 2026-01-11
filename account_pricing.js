const TIERS = require("./account_tiers");
const PROFILES = require("./execution_profiles");
const { getJobsByEmail } = require("./queue");

function getAccountTier(email) {
  const jobs = getJobsByEmail(email);
  const count = jobs.length;

  let tier = TIERS[0];
  for (const t of TIERS) {
    if (count >= t.minJobs) tier = t;
  }
  return tier;
}

function getProfilePricing(email, profile_key) {
  const profile = PROFILES[profile_key];
  if (!profile) {
    throw new Error("UNKNOWN_PROFILE");
  }

  const tier = getAccountTier(email);

  const base_price = +(profile.entry_price_usd * tier.multiplier).toFixed(3);

  return {
    profile_key: profile.key,
    profile_label: profile.label,
    tier_name: tier.name,
    base_price_usd: base_price,
    floor_usd: profile.floor_usd,
    max_runtime_ms: profile.max_runtime_ms
  };
}

module.exports = { getAccountTier, getProfilePricing };
