#!/usr/bin/env bun
/**
 * Run evaluation on synthetic dataset
 *
 * Usage: bun run src/eval/run-eval.ts
 */

import { createSyntheticDataset, evaluate, formatResults, gridSearch } from './index.js';
import { DEFAULT_WEIGHTS } from '../types/salience.js';

console.log('Reminisce Salience Evaluation Harness');
console.log('=================================\n');

// Create and evaluate on synthetic dataset
const dataset = createSyntheticDataset();
console.log(`Dataset: ${dataset.name}`);
console.log(`Examples: ${dataset.examples.length}`);
console.log(`Description: ${dataset.description}\n`);

// Evaluate with default weights
console.log('--- Default Weights ---\n');
const defaultResults = evaluate(dataset, DEFAULT_WEIGHTS);
console.log(formatResults(defaultResults));

// Grid search for better weights
console.log('\n--- Grid Search ---\n');
const searchResults = gridSearch(dataset, {
  reward: [0.15, 0.25, 0.35],
  error: [0.15, 0.20, 0.25],
  novelty: [0.10, 0.15, 0.20],
});

console.log('Top 3 weight configurations:');
for (let i = 0; i < Math.min(3, searchResults.length); i++) {
  const { weights, results } = searchResults[i]!;
  console.log(`\n${i + 1}. F1=${(results.f1 * 100).toFixed(1)}%`);
  console.log(`   reward=${weights.reward}, error=${weights.error}, novelty=${weights.novelty}`);
  console.log(`   separation=${results.separation_score.toFixed(3)}`);
}

console.log('\n--- Summary ---\n');
console.log(`Best F1: ${((searchResults[0]?.results.f1 ?? 0) * 100).toFixed(1)}%`);
console.log(`Default F1: ${(defaultResults.f1 * 100).toFixed(1)}%`);

if (searchResults[0] && searchResults[0].results.f1 > defaultResults.f1) {
  console.log('\nSuggested weight updates:');
  const best = searchResults[0].weights;
  if (best.reward !== DEFAULT_WEIGHTS.reward) {
    console.log(`  reward: ${DEFAULT_WEIGHTS.reward} -> ${best.reward}`);
  }
  if (best.error !== DEFAULT_WEIGHTS.error) {
    console.log(`  error: ${DEFAULT_WEIGHTS.error} -> ${best.error}`);
  }
  if (best.novelty !== DEFAULT_WEIGHTS.novelty) {
    console.log(`  novelty: ${DEFAULT_WEIGHTS.novelty} -> ${best.novelty}`);
  }
} else {
  console.log('\nDefault weights are optimal for this dataset.');
}
