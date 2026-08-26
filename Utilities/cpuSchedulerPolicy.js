'use strict';

const DEFAULT_PEAK_DECAY = 0.8;
const DEFAULT_PEAK_DECAY_INTERVAL = 50;

function finitePositive(value, fallback) {
  return typeof value === 'number' && isFinite(value) && value > 0 ? value : fallback;
}

function getExpectedRunInterval(stats, fallbackInterval) {
  return finitePositive(
    stats && stats.effectiveInterval,
    finitePositive(fallbackInterval, DEFAULT_PEAK_DECAY_INTERVAL)
  );
}

function getDecayedPeak(stats, now, decayPerInterval, fallbackInterval) {
  if (!stats || !(stats.runs > 0) || !(stats.peak > 0)) return 0;
  if (typeof stats.lastRun !== 'number' || typeof now !== 'number' || !isFinite(now)) {
    return stats.peak;
  }

  const decay = Math.min(1, Math.max(0, finitePositive(decayPerInterval, DEFAULT_PEAK_DECAY)));
  if (decay === 0) return 0;

  const elapsed = Math.max(0, now - stats.lastRun);
  const interval = getExpectedRunInterval(stats, fallbackInterval);
  return stats.peak * Math.pow(decay, elapsed / interval);
}

function estimateSectionCost(stats, now, decayPerInterval, fallbackInterval) {
  if (!stats || !(stats.runs > 0)) return 0;
  return Math.max(
    typeof stats.average === 'number' && isFinite(stats.average) ? stats.average : 0,
    getDecayedPeak(stats, now, decayPerInterval, fallbackInterval)
  );
}

function getProjectedBucketAfter(currentBucket, accountLimit, projectedCpu) {
  return currentBucket + accountLimit - projectedCpu;
}

function canUseBucketBurst(options) {
  const currentBucket = finitePositive(options && options.currentBucket, 0);
  const accountLimit = finitePositive(options && options.accountLimit, 0);
  const executionLimit = finitePositive(options && options.executionLimit, accountLimit);
  const projectedCpu = finitePositive(options && options.projectedCpu, 0);
  const tailReserve = Math.max(0, finitePositive(options && options.tailReserve, 0));
  const projectedTotal = projectedCpu + tailReserve;
  const minBucket = Math.max(0, finitePositive(options && options.minBucket, 0));
  const minBucketAfter = Math.max(0, finitePositive(options && options.minBucketAfter, 0));
  const maxBucketSpend = options && options.maxBucketSpend;

  if (currentBucket < minBucket) return false;
  if (projectedTotal > executionLimit) return false;
  if (getProjectedBucketAfter(currentBucket, accountLimit, projectedTotal) < minBucketAfter) {
    return false;
  }

  const overdraft = Math.max(0, projectedTotal - accountLimit);
  return !(typeof maxBucketSpend === 'number' && overdraft > maxBucketSpend);
}

module.exports = {
  getDecayedPeak: getDecayedPeak,
  estimateSectionCost: estimateSectionCost,
  getProjectedBucketAfter: getProjectedBucketAfter,
  canUseBucketBurst: canUseBucketBurst
};
