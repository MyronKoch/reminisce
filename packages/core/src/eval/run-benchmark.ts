#!/usr/bin/env bun
/**
 * Run Reminisce Benchmark Suite
 *
 * Usage: bun run src/eval/run-benchmark.ts [--suite <name>] [--verbose]
 */

import {
  runBenchmarks,
  runAllBenchmarks,
  formatBenchmarkReport,
  type BenchmarkSuiteName,
} from './benchmark.js';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose') || args.includes('-v');
const suiteArg = args.find((_, i, arr) => arr[i - 1] === '--suite');

console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║            Reminisce Benchmark Suite Runner                     ║');
console.log('╚════════════════════════════════════════════════════════════╝');
console.log();

let report;

if (suiteArg) {
  const validSuites: BenchmarkSuiteName[] = ['salience', 'retrieval', 'consolidation', 'integration'];
  if (!validSuites.includes(suiteArg as BenchmarkSuiteName)) {
    console.error(`Invalid suite: ${suiteArg}`);
    console.error(`Valid suites: ${validSuites.join(', ')}`);
    process.exit(1);
  }

  console.log(`Running ${suiteArg} suite only...\n`);
  report = runBenchmarks({
    name: `${suiteArg}-only`,
    suites: [suiteArg as BenchmarkSuiteName],
    verbose,
  });
} else {
  console.log('Running all benchmark suites...\n');
  report = runAllBenchmarks();
}

console.log(formatBenchmarkReport(report));
console.log();

// Exit with error code if any tests failed
if (report.passRate < 1.0) {
  const failed = report.overallMaxScore - report.overallScore;
  console.log(`⚠️  ${failed} benchmark(s) failed`);

  if (verbose) {
    console.log('\nFailed benchmarks:');
    for (const [suiteName, suiteReport] of Object.entries(report.suites)) {
      if (!suiteReport) continue;
      for (const result of suiteReport.results) {
        if (!result.passed) {
          console.log(`  - ${suiteName}/${result.name}`);
          console.log(`    Details: ${JSON.stringify(result.details)}`);
        }
      }
    }
  }

  process.exit(1);
}

console.log('✅ All benchmarks passed!');
