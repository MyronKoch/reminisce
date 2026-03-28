/**
 * Salience Module - Extended utilities for salience computation and analysis
 */

export {
  type SalienceSignals,
  type SalienceInstrumentation,
  type Salience,
  type SalienceWeights,
  DEFAULT_WEIGHTS,
  createSalienceSignals,
  computeSalience,
  createSalience,
  reinforceOnRetrieval,
  markValidated,
} from '../types/salience.js';

/**
 * Batch of instrumentation records for analysis
 */
export interface InstrumentationBatch {
  records: SalienceInstrumentation[];
  created_at: Date;
  session_id?: string;
}

/**
 * Analysis results from instrumentation
 */
export interface SalienceAnalysis {
  /** Number of records analyzed */
  sample_size: number;

  /** Average contribution per signal */
  avg_contributions: Record<string, number>;

  /** Correlation between signal and validated_useful (if available) */
  usefulness_correlations?: Record<string, number>;

  /** Suggested weight adjustments based on analysis */
  suggested_adjustments?: Partial<SalienceWeights>;

  /** Records with highest/lowest scores */
  extremes: {
    highest: SalienceInstrumentation[];
    lowest: SalienceInstrumentation[];
  };
}

import type { SalienceInstrumentation, SalienceWeights } from '../types/salience.js';

/**
 * Collect instrumentation for later analysis
 */
export function createBatch(
  records: SalienceInstrumentation[],
  sessionId?: string
): InstrumentationBatch {
  const batch: InstrumentationBatch = {
    records,
    created_at: new Date(),
  };
  if (sessionId !== undefined) {
    batch.session_id = sessionId;
  }
  return batch;
}

/**
 * Analyze a batch of instrumentation records
 *
 * Use this to understand which signals are contributing most
 * and to identify potential weight tuning opportunities
 */
export function analyzeBatch(batch: InstrumentationBatch): SalienceAnalysis {
  const { records } = batch;

  if (records.length === 0) {
    return {
      sample_size: 0,
      avg_contributions: {},
      extremes: { highest: [], lowest: [] },
    };
  }

  // Compute average contributions per signal
  const contributionSums: Record<string, number> = {};
  const contributionCounts: Record<string, number> = {};

  for (const record of records) {
    for (const [signal, value] of Object.entries(record.weighted_contributions)) {
      contributionSums[signal] = (contributionSums[signal] ?? 0) + value;
      contributionCounts[signal] = (contributionCounts[signal] ?? 0) + 1;
    }
  }

  const avgContributions: Record<string, number> = {};
  for (const signal of Object.keys(contributionSums)) {
    avgContributions[signal] = contributionSums[signal]! / contributionCounts[signal]!;
  }

  // Find extremes
  const sorted = [...records].sort((a, b) => b.final_score - a.final_score);
  const highest = sorted.slice(0, 5);
  const lowest = sorted.slice(-5).reverse();

  // Compute usefulness correlations if validation data exists
  const validatedRecords = records.filter(r => r.validated_useful !== undefined);

  const result: SalienceAnalysis = {
    sample_size: records.length,
    avg_contributions: avgContributions,
    extremes: { highest, lowest },
  };

  if (validatedRecords.length >= 10) {
    result.usefulness_correlations = computeUsefulnessCorrelations(validatedRecords);
  }

  return result;
}

/**
 * Compute correlation between each signal and usefulness
 */
function computeUsefulnessCorrelations(
  records: SalienceInstrumentation[]
): Record<string, number> {
  const correlations: Record<string, number> = {};

  // Get all signal names
  const signals = new Set<string>();
  for (const record of records) {
    for (const signal of Object.keys(record.raw_signals)) {
      signals.add(signal);
    }
  }

  // Compute point-biserial correlation for each signal
  for (const signal of signals) {
    const useful = records.filter(r => r.validated_useful === true);
    const notUseful = records.filter(r => r.validated_useful === false);

    if (useful.length === 0 || notUseful.length === 0) continue;

    const usefulMean =
      useful.reduce((sum, r) => sum + (r.raw_signals[signal] ?? 0), 0) / useful.length;
    const notUsefulMean =
      notUseful.reduce((sum, r) => sum + (r.raw_signals[signal] ?? 0), 0) / notUseful.length;

    // Simple difference as proxy for correlation direction
    correlations[signal] = usefulMean - notUsefulMean;
  }

  return correlations;
}

/**
 * Suggest weight adjustments based on analysis
 *
 * This is a simple heuristic - for production, use proper ML
 */
export function suggestWeightAdjustments(
  analysis: SalienceAnalysis,
  currentWeights: SalienceWeights
): Partial<SalienceWeights> {
  if (!analysis.usefulness_correlations) {
    return {};
  }

  const suggestions: Partial<SalienceWeights> = {};
  const correlations = analysis.usefulness_correlations;

  // Map signal names to weight keys
  const signalToWeight: Record<string, keyof SalienceWeights> = {
    reward: 'reward',
    error: 'error',
    novelty: 'novelty',
    emotion: 'emotion',
    goal: 'goal',
  };

  for (const [signal, weightKey] of Object.entries(signalToWeight)) {
    const correlation = correlations[signal];
    if (correlation === undefined) continue;

    const currentWeight = currentWeights[weightKey];
    if (typeof currentWeight !== 'number') continue;

    // Increase weight if positively correlated with usefulness
    // Decrease if negatively correlated
    // Max adjustment of 20%
    const adjustment = Math.max(-0.2, Math.min(0.2, correlation));
    const newWeight = currentWeight * (1 + adjustment);

    // Only suggest if change is meaningful (>5%)
    if (Math.abs(adjustment) > 0.05) {
      suggestions[weightKey] = Math.max(0.01, Math.min(0.5, newWeight));
    }
  }

  return suggestions;
}

/**
 * Format analysis for logging/display
 */
export function formatAnalysis(analysis: SalienceAnalysis): string {
  const lines: string[] = [
    `Salience Analysis (n=${analysis.sample_size})`,
    '',
    'Average Contributions:',
  ];

  for (const [signal, avg] of Object.entries(analysis.avg_contributions)) {
    lines.push(`  ${signal}: ${avg.toFixed(4)}`);
  }

  if (analysis.usefulness_correlations) {
    lines.push('', 'Usefulness Correlations:');
    for (const [signal, corr] of Object.entries(analysis.usefulness_correlations)) {
      const direction = corr > 0 ? '+' : '';
      lines.push(`  ${signal}: ${direction}${corr.toFixed(4)}`);
    }
  }

  lines.push('', 'Score Extremes:');
  lines.push('  Highest:');
  for (const record of analysis.extremes.highest) {
    lines.push(`    ${record.final_score.toFixed(4)}`);
  }
  lines.push('  Lowest:');
  for (const record of analysis.extremes.lowest) {
    lines.push(`    ${record.final_score.toFixed(4)}`);
  }

  return lines.join('\n');
}
