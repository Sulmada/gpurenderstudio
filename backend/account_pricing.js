// -------------------------------------------------------------
// ACCOUNT PRICING – Phase 1
// Combines execution profiles with account tier (name only)
// -------------------------------------------------------------

const PROFILES = require("./execution_profiles");
const TIERS = require("./account_tiers");
const { getJobsByEmail } = require("./queue");

// -------------------------------------------------------------
// Resolve account tier by job count (name only, no pricing)
// -------------------------------------------------------------
function getAccountTier(email) {
  const jobs = getJobsByEmail(email);
  const count = jobs.length;

  let tier = TIERS[0];

  for (const t of TIERS) {
    if (count >= t.minJobs) {
      tier = t;
    }
  }

  return tier;
}

// -------------------------------------------------------------
// Resolve pricing for a given execution profile
// -------------------------------------------------------------
function getProfilePricing(email, execution_profile) {
  const profile = PROFILES[execution_profile];
  if (!profile) {
    throw new Error(`UNKNOWN_EXECUTION_PROFILE: ${execution_profile}`);
  }

  const tier = getAccountTier(email);

  const tier_adjusted_price =
    profile.entry_price_usd * tier.multiplier;

  return {
    tier_name: tier.name,
    execution_profile: profile.key,

    base_price_usd: tier_adjusted_price,
    floor_usd: profile.floor_usd,
    max_runtime_ms: profile.max_runtime_ms
  };
}

module.exports = {
  getProfilePricing
};
