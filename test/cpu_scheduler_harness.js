// LLM: Read docs/codex.js before reviewing or changing this file.
// Dependency-free tests for the CPU scheduler's pure admission policy.

'use strict';

const assert = require('assert');
const cpuSchedulerPolicy = require('../cpuSchedulerPolicy');

function assertAlmostEqual(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, actual + ' !== ' + expected);
}

const stats = {
  runs: 3,
  average: 4,
  peak: 40,
  lastRun: 0,
  effectiveInterval: 100
};

assertAlmostEqual(
  cpuSchedulerPolicy.getDecayedPeak(stats, 100, 0.8, 50),
  32
);
assertAlmostEqual(
  cpuSchedulerPolicy.estimateSectionCost(stats, 500, 0.8, 50),
  40 * Math.pow(0.8, 5)
);
assert.strictEqual(
  cpuSchedulerPolicy.estimateSectionCost(stats, 10000, 0.8, 50),
  4
);

assert.strictEqual(
  cpuSchedulerPolicy.getProjectedBucketAfter(3050, 20, 41),
  3029
);
assert.strictEqual(
  cpuSchedulerPolicy.canUseBucketBurst({
    currentBucket: 3050,
    accountLimit: 20,
    executionLimit: 500,
    projectedCpu: 40,
    tailReserve: 1,
    minBucket: 1000,
    minBucketAfter: 3000
  }),
  true
);
assert.strictEqual(
  cpuSchedulerPolicy.canUseBucketBurst({
    currentBucket: 3020,
    accountLimit: 20,
    executionLimit: 500,
    projectedCpu: 40,
    tailReserve: 1,
    minBucket: 1000,
    minBucketAfter: 3000
  }),
  false
);
assert.strictEqual(
  cpuSchedulerPolicy.canUseBucketBurst({
    currentBucket: 10000,
    accountLimit: 20,
    executionLimit: 50,
    projectedCpu: 50,
    tailReserve: 1,
    minBucket: 1000,
    minBucketAfter: 3000
  }),
  false
);
assert.strictEqual(
  cpuSchedulerPolicy.canUseBucketBurst({
    currentBucket: 10000,
    accountLimit: 20,
    executionLimit: 500,
    projectedCpu: 140,
    tailReserve: 1,
    minBucket: 1000,
    minBucketAfter: 3000,
    maxBucketSpend: 100
  }),
  false
);

console.log('CPU scheduler policy tests passed.');
