/**
 * Evaluation Harness - For tuning salience weights and measuring memory quality
 *
 * Per reviewer feedback: need datasets, gold labels, runbook
 * This module provides the infrastructure to collect and analyze that data.
 */

import type { SalienceSignals, SalienceInstrumentation, SalienceWeights } from '../types/salience.js';
import { computeSalience, DEFAULT_WEIGHTS, markValidated } from '../types/salience.js';
import { analyzeBatch, createBatch, suggestWeightAdjustments } from '../salience/index.js';

// Re-export benchmark suite
export {
  runBenchmarks,
  runAllBenchmarks,
  formatBenchmarkReport,
  type BenchmarkConfig,
  type BenchmarkSuiteName,
  type BenchmarkResult,
  type BenchmarkReport,
  type BenchmarkSuiteReport,
} from './benchmark.js';

/**
 * A labeled example for evaluation
 */
export interface LabeledExample {
  /** Unique ID for this example */
  id: string;

  /** Input signals */
  signals: SalienceSignals;

  /** Ground truth: was this memory actually useful? */
  was_useful: boolean;

  /** Optional: why it was/wasn't useful */
  reason?: string;

  /** When this label was created */
  labeled_at: Date;

  /** Who created this label (for audit) */
  labeled_by?: string;
}

/**
 * Evaluation dataset
 */
export interface EvalDataset {
  /** Dataset name */
  name: string;

  /** Description of what this dataset tests */
  description: string;

  /** Labeled examples */
  examples: LabeledExample[];

  /** When created */
  created_at: Date;

  /** Version for tracking updates */
  version: number;
}

/**
 * Evaluation results
 */
export interface EvalResults {
  /** Dataset evaluated */
  dataset_name: string;

  /** Weights used */
  weights: SalienceWeights;

  /** Number of examples */
  n_examples: number;

  /** Accuracy at various thresholds */
  accuracy_at_threshold: Record<number, number>;

  /** Precision/recall at default threshold (0.5) */
  precision: number;
  recall: number;
  f1: number;

  /** False positive/negative examples for debugging */
  false_positives: LabeledExample[];
  false_negatives: LabeledExample[];

  /** Average salience for useful vs not useful */
  avg_salience_useful: number;
  avg_salience_not_useful: number;

  /** Separation score (how well salience separates useful from not) */
  separation_score: number;
}

/**
 * Create a new evaluation dataset
 */
export function createDataset(
  name: string,
  description: string,
  examples: LabeledExample[] = []
): EvalDataset {
  return {
    name,
    description,
    examples,
    created_at: new Date(),
    version: 1,
  };
}

/**
 * Add a labeled example to a dataset
 */
export function addExample(
  dataset: EvalDataset,
  signals: SalienceSignals,
  wasUseful: boolean,
  reason?: string,
  labeledBy?: string
): EvalDataset {
  const example: LabeledExample = {
    id: `${dataset.name}-${dataset.examples.length + 1}`,
    signals,
    was_useful: wasUseful,
    labeled_at: new Date(),
  };

  if (reason !== undefined) {
    example.reason = reason;
  }
  if (labeledBy !== undefined) {
    example.labeled_by = labeledBy;
  }

  return {
    ...dataset,
    examples: [...dataset.examples, example],
    version: dataset.version + 1,
  };
}

/**
 * Run evaluation on a dataset
 */
export function evaluate(
  dataset: EvalDataset,
  weights: SalienceWeights = DEFAULT_WEIGHTS
): EvalResults {
  const thresholds = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];
  const accuracyAtThreshold: Record<number, number> = {};

  // Compute salience for all examples
  const scoredExamples = dataset.examples.map(example => {
    const { score } = computeSalience(example.signals, weights);
    return { example, score };
  });

  // Compute accuracy at each threshold
  for (const threshold of thresholds) {
    let correct = 0;
    for (const { example, score } of scoredExamples) {
      const predicted = score >= threshold;
      if (predicted === example.was_useful) correct++;
    }
    accuracyAtThreshold[threshold] = correct / scoredExamples.length;
  }

  // Compute precision/recall at 0.5 threshold
  const defaultThreshold = 0.5;
  let tp = 0, fp = 0, fn = 0;
  const falsePositives: LabeledExample[] = [];
  const falseNegatives: LabeledExample[] = [];

  for (const { example, score } of scoredExamples) {
    const predicted = score >= defaultThreshold;
    if (predicted && example.was_useful) tp++;
    if (predicted && !example.was_useful) {
      fp++;
      falsePositives.push(example);
    }
    if (!predicted && example.was_useful) {
      fn++;
      falseNegatives.push(example);
    }
  }

  const precision = tp / (tp + fp) || 0;
  const recall = tp / (tp + fn) || 0;
  const f1 = (2 * precision * recall) / (precision + recall) || 0;

  // Compute average salience by usefulness
  const usefulScores = scoredExamples
    .filter(s => s.example.was_useful)
    .map(s => s.score);
  const notUsefulScores = scoredExamples
    .filter(s => !s.example.was_useful)
    .map(s => s.score);

  const avgUseful = usefulScores.length > 0
    ? usefulScores.reduce((a, b) => a + b, 0) / usefulScores.length
    : 0;
  const avgNotUseful = notUsefulScores.length > 0
    ? notUsefulScores.reduce((a, b) => a + b, 0) / notUsefulScores.length
    : 0;

  // Separation score: how much gap between useful and not useful
  const separationScore = avgUseful - avgNotUseful;

  return {
    dataset_name: dataset.name,
    weights,
    n_examples: dataset.examples.length,
    accuracy_at_threshold: accuracyAtThreshold,
    precision,
    recall,
    f1,
    false_positives: falsePositives.slice(0, 10),
    false_negatives: falseNegatives.slice(0, 10),
    avg_salience_useful: avgUseful,
    avg_salience_not_useful: avgNotUseful,
    separation_score: separationScore,
  };
}

/**
 * Format evaluation results for display
 */
export function formatResults(results: EvalResults): string {
  const lines: string[] = [
    `Evaluation Results: ${results.dataset_name}`,
    `N=${results.n_examples}`,
    '',
    'Metrics at threshold=0.5:',
    `  Precision: ${(results.precision * 100).toFixed(1)}%`,
    `  Recall: ${(results.recall * 100).toFixed(1)}%`,
    `  F1: ${(results.f1 * 100).toFixed(1)}%`,
    '',
    'Accuracy at thresholds:',
  ];

  for (const [threshold, accuracy] of Object.entries(results.accuracy_at_threshold)) {
    lines.push(`  ${threshold}: ${(accuracy * 100).toFixed(1)}%`);
  }

  lines.push(
    '',
    'Salience Distribution:',
    `  Avg (useful): ${results.avg_salience_useful.toFixed(3)}`,
    `  Avg (not useful): ${results.avg_salience_not_useful.toFixed(3)}`,
    `  Separation: ${results.separation_score.toFixed(3)}`,
  );

  if (results.false_positives.length > 0) {
    lines.push('', 'Sample False Positives:');
    for (const fp of results.false_positives.slice(0, 3)) {
      lines.push(`  - ${fp.id}: ${fp.reason || 'no reason'}`);
    }
  }

  if (results.false_negatives.length > 0) {
    lines.push('', 'Sample False Negatives:');
    for (const fn of results.false_negatives.slice(0, 3)) {
      lines.push(`  - ${fn.id}: ${fn.reason || 'no reason'}`);
    }
  }

  return lines.join('\n');
}

/**
 * Grid search over weight combinations
 */
export function gridSearch(
  dataset: EvalDataset,
  paramRanges: Partial<Record<keyof SalienceWeights, number[]>>
): { weights: SalienceWeights; results: EvalResults }[] {
  const results: { weights: SalienceWeights; results: EvalResults }[] = [];

  // Generate all combinations
  const keys = Object.keys(paramRanges) as (keyof SalienceWeights)[];
  const ranges = keys.map(k => paramRanges[k]!);

  function* combinations(
    index: number,
    current: Partial<SalienceWeights>
  ): Generator<Partial<SalienceWeights>> {
    if (index === keys.length) {
      yield current;
      return;
    }
    for (const value of ranges[index]!) {
      yield* combinations(index + 1, { ...current, [keys[index]!]: value });
    }
  }

  for (const combo of combinations(0, {})) {
    const weights = { ...DEFAULT_WEIGHTS, ...combo };
    const evalResults = evaluate(dataset, weights);
    results.push({ weights, results: evalResults });
  }

  // Sort by F1 score
  results.sort((a, b) => b.results.f1 - a.results.f1);

  return results;
}

/**
 * Simple synthetic dataset for initial testing
 */
export function createSyntheticDataset(): EvalDataset {
  const dataset = createDataset(
    'synthetic-v1',
    'Synthetic examples for initial weight tuning'
  );

  // High reward + high access = useful
  const useful1: SalienceSignals = {
    reward_signal: 0.9,
    error_signal: 0.1,
    user_pinned: false,
    user_blocked: false,
    novelty_score: 0.5,
    emotional_intensity: 0.3,
    access_count: 15,
    last_accessed: new Date(Date.now() - 1000 * 60 * 60), // 1 hour ago
    goal_relevance: 0.7,
  };

  // High error signal = useful (learning from mistakes)
  const useful2: SalienceSignals = {
    reward_signal: 0.1,
    error_signal: 0.9,
    user_pinned: false,
    user_blocked: false,
    novelty_score: 0.8,
    emotional_intensity: 0.6,
    access_count: 5,
    last_accessed: new Date(Date.now() - 1000 * 60 * 60 * 2), // 2 hours ago
    goal_relevance: 0.6,
  };

  // User pinned = useful
  const useful3: SalienceSignals = {
    reward_signal: 0.3,
    error_signal: 0.1,
    user_pinned: true,
    user_blocked: false,
    novelty_score: 0.4,
    emotional_intensity: 0.2,
    access_count: 2,
    last_accessed: new Date(Date.now() - 1000 * 60 * 60 * 24), // 1 day ago
    goal_relevance: 0.5,
  };

  // Low everything = not useful
  const notUseful1: SalienceSignals = {
    reward_signal: 0.1,
    error_signal: 0.1,
    user_pinned: false,
    user_blocked: false,
    novelty_score: 0.2,
    emotional_intensity: 0.1,
    access_count: 0,
    last_accessed: new Date(Date.now() - 1000 * 60 * 60 * 24 * 7), // 1 week ago
    goal_relevance: 0.1,
  };

  // Old and never accessed = not useful
  const notUseful2: SalienceSignals = {
    reward_signal: 0.3,
    error_signal: 0.2,
    user_pinned: false,
    user_blocked: false,
    novelty_score: 0.3,
    emotional_intensity: 0.2,
    access_count: 1,
    last_accessed: new Date(Date.now() - 1000 * 60 * 60 * 24 * 30), // 30 days ago
    goal_relevance: 0.2,
  };

  // User blocked = not useful
  const notUseful3: SalienceSignals = {
    reward_signal: 0.5,
    error_signal: 0.5,
    user_pinned: false,
    user_blocked: true,
    novelty_score: 0.5,
    emotional_intensity: 0.5,
    access_count: 10,
    last_accessed: new Date(),
    goal_relevance: 0.5,
  };

  return {
    ...dataset,
    examples: [
      { id: 'useful-1', signals: useful1, was_useful: true, reason: 'High reward and access', labeled_at: new Date() },
      { id: 'useful-2', signals: useful2, was_useful: true, reason: 'Important error to learn from', labeled_at: new Date() },
      { id: 'useful-3', signals: useful3, was_useful: true, reason: 'User explicitly pinned', labeled_at: new Date() },
      { id: 'not-useful-1', signals: notUseful1, was_useful: false, reason: 'Low signals across the board', labeled_at: new Date() },
      { id: 'not-useful-2', signals: notUseful2, was_useful: false, reason: 'Old and rarely accessed', labeled_at: new Date() },
      { id: 'not-useful-3', signals: notUseful3, was_useful: false, reason: 'User blocked', labeled_at: new Date() },
    ],
  };
}
