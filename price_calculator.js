function calculateFinalPrice(basePriceUsd, discountPercent, floorUsd) {
  const discounted = basePriceUsd * (1 - (discountPercent / 100));
  const floored = Math.max(discounted, floorUsd);
  return +floored.toFixed(2);
}

module.exports = { calculateFinalPrice };
