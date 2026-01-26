// backend/worker/runtime_budget.js
// GPU RENDER STUDIO – PHASE 1.3
// RUNTIME BUDGET + BILLING SEMANTICS (WORKER-SAFE)

"use strict";

/**
 * Compute effective time limits for worker runtime.
 *
 * contract must contain:
 *   base_hours_limit    (number)
 *   hourly_rate_usd     (number)
 *   execution_mode      ("BUDGET_STOP" | "HARD_RUN")
 *   overflow_allowed    (bool)
 *   cap_enabled         (bool)
 *   cap_hours           (number or Infinity)
 *
 * Interpretation:
 *   BUDGET_STOP:
 *      maxRuntime = base_hours_limit
 *      overflow never charged
 *
 *   HARD_RUN:
 *      maxRuntime = min(slotBudgetLimit, capLimit)
 *      slotBudgetLimit = base_hours_limit if !overflow_allowed
 *                      = base_hours_limit + overflowBudget if overflow allowed
 *
 *   If cap_enabled && cap_hours < slotBudgetLimit → cap dominates
 */
function computeTimeLimits(contract) {
  const baseLimit = Number(contract.base_hours_limit || 0);
  if (!Number.isFinite(baseLimit) || baseLimit <= 0) {
    throw new Error("INVALID_BASE_LIMIT");
  }

  const overflowAllowed = !!contract.overflow_allowed;
  const executionMode = contract.execution_mode || "BUDGET_STOP";

  // Overflowbudget definieras så här:
  // Phase 1.3: overflow är "öppen" om execution_mode === HARD_RUN och overflow_allowed === true
  // Vi behöver inte ett separat "overflow_allowed_hours" längre.
  const overflowBudget = overflowAllowed && executionMode === "HARD_RUN"
    ? Infinity // i HARD_RUN kan slotBudget teoretiskt expandera, men stoppas av cap ändå
    : 0;

  // SlotBudgetLimit = bas + overflowBudget (overflowBudget är ev. Infinity)
  let slotBudgetLimit = baseLimit;
  if (overflowBudget === Infinity) {
    slotBudgetLimit = Infinity;
  }

  // Cap
  let capLimit = Infinity;
  if (contract.cap_enabled && typeof contract.cap_hours === "number") {
    const ch = Number(contract.cap_hours);
    if (Number.isFinite(ch) && ch > 0) {
      capLimit = ch;
    }
  }

  let maxRuntimeHours;
  let isCapDominant = false;

  if (executionMode === "BUDGET_STOP") {
    // SlotBudget = base only
    maxRuntimeHours = baseLimit;
  } else {
    // HARD_RUN → worker får springa tills antingen slotBudget eller cap är nådd
    maxRuntimeHours = Math.min(slotBudgetLimit, capLimit);
    if (capLimit <= slotBudgetLimit) {
      isCapDominant = true;
    }
  }

  return {
    execution_mode: executionMode,
    baseLimit,
    overflowAllowed,
    slotBudgetLimit,
    capLimit,
    maxRuntimeHours,
    isCapDominant
  };
}

/**
 * Compute billing after job completes or is stopped.
 *
 * contract:
 *   base_hours_limit
 *   hourly_rate_usd
 *   overflow_allowed
 *   execution_mode
 *   cap_enabled
 *   cap_usd
 *
 * @param {object} contract - job.contract
 * @param {number} elapsedHours - real runtime in hours (worker measured)
 * @param {object} limits - from computeTimeLimits(contract)
 * @returns {object} billing
 *
 * Billing rules PHASE 1.3:
 *   base billed always
 *   overflow billed only if:
 *      execution_mode == HARD_RUN AND overflow_allowed == true
 *
 *   if cap_enabled: billed <= cap_usd
 *   partial_success if:
 *      budgetStop OR capStop OR timeLimitStop
 */
function computeBilling(contract, elapsedHours, limits) {
  const {
    baseLimit,
    overflowAllowed,
    slotBudgetLimit,
    capLimit,
    execution_mode
  } = limits;

  const safeElapsed = Math.max(0, Number(elapsedHours || 0));

  const hourlyRate = Number(contract.hourly_rate_usd || 0);
  const basePriceUsd = Number(contract.base_price_usd || 0);

  // BASE usage = min(elapsed, baseLimit) men billing baspris är fast
  // Overflow usage = (elapsed - baseLimit) om HARD_RUN + overflowAllowed
  let overflowHours = 0;
  if (execution_mode === "HARD_RUN" && overflowAllowed && safeElapsed > baseLimit) {
    overflowHours = safeElapsed - baseLimit;
  }

  let overflowUsd = overflowHours * hourlyRate;
  let billedUsd = basePriceUsd + overflowUsd;

  let completedWithCap = false;
  let completedWithBudget = false;
  let stopReason = null;

  // CAP enforcement
  if (contract.cap_enabled && typeof contract.cap_usd === "number") {
    const capUsd = Math.max(0, Number(contract.cap_usd));
    if (billedUsd > capUsd) {
      billedUsd = capUsd;
      overflowUsd = Math.max(0, billedUsd - basePriceUsd);
      completedWithCap = true;
      stopReason = "CAP";
    }
  }

  // Budget stop:
  // elapsed >= baseLimit (BUDGET_STOP mode)
  // eller elapsed >= slotBudgetLimit (HARD_RUN utan cap-dominans)
  if (!completedWithCap) {
    if (execution_mode === "BUDGET_STOP" && safeElapsed >= baseLimit - 1e-6) {
      completedWithBudget = true;
      stopReason = "BUDGET";
    }
    else if (execution_mode === "HARD_RUN" && Number.isFinite(slotBudgetLimit)) {
      if (safeElapsed >= slotBudgetLimit - 1e-6) {
        completedWithBudget = true;
        stopReason = "BUDGET";
      }
    }
  }

  return {
    slot: contract.slot,
    execution_mode: execution_mode,

    elapsed_hours: safeElapsed,
    base_hours_limit: baseLimit,
    slot_budget_limit_hours: slotBudgetLimit,
    cap_hours: capLimit,

    overflow_allowed: overflowAllowed,
    overflow_hours: overflowHours,

    hourly_rate_usd: hourlyRate,
    base_price_usd: basePriceUsd,
    overflow_usd: overflowUsd,
    billed_usd: billedUsd,

    cap_enabled: !!contract.cap_enabled,
    cap_usd: contract.cap_enabled ? Number(contract.cap_usd || 0) : null,

    completed_with_cap: completedWithCap,
    completed_with_budget: completedWithBudget,
    completed_partial: completedWithCap || completedWithBudget,
    stop_reason: stopReason
  };
}

module.exports = {
  computeTimeLimits,
  computeBilling
};
