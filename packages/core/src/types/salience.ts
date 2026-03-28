/**
 * Salience Signals - Capture-time importance tagging for RANKING
 *
 * PHILOSOPHY: Salience determines retrieval PRIORITY, not existence.
 * - High salience = appears in top results automatically
 * - Low salience = still findable with specific queries
 * - Nothing is ever truly "forgotten" (except explicit suppression)
 *
 * This leverages machine advantages (perfect recall, needle-in-haystack search)
 * while using salience for intelligent auto-surfacing.
 *
 * Based on neuroscience of memory consolidation:
 * - Sharp Wave Ripples tag salient events during encoding
 * - Multiple signals contribute to ranking priority
 * - Signals are bounded [0,1] to prevent gaming/runaway values
 */

/**
 * Raw signals captured at memory creation time
 * Each signal is bounded [0, 1] for normalization
 */
export interface SalienceSignals {
  /** Positive outcome followed this memory (reward prediction) */
  reward_signal: number;

  /** Correction or failure followed this memory (error signal) */
  error_signal: number;

  /** User explicitly marked this as important (always surfaces) */
  user_pinned: boolean;

  /** User explicitly wants this suppressed (never surfaces, but still stored) */
  user_blocked: boolean;

  /** How different from existing memories (cosine distance) */
  novelty_score: number;

  /** Strong user reactions (detected from sentiment/patterns) */
  emotional_intensity: number;

  /** Number of times this memory has been retrieved (higher = more relevant) */
  access_count: number;

  /** When this memory was last accessed (for instrumentation, not decay) */
  last_accessed: Date;

  /** Relevance to current/recent objectives */
  goal_relevance: number;
}

/**
 * Instrumentation for tracking which signals predict value
 */
export interface SalienceInstrumentation {
  /** When this salience was computed */
  computed_at: Date;

  /** Raw signal values before weighting */
  raw_signals: Record<string, number>;

  /** Weighted contributions of each signal */
  weighted_contributions: Record<string, number>;

  /** Final computed score */
  final_score: number;

  /** Whether this memory was later validated as useful */
  validated_useful?: boolean;

  /** Validation timestamp for feedback loop */
  validated_at?: Date;
}

/**
 * Full salience record for a memory
 */
export interface Salience {
  /** Raw input signals */
  signals: SalienceSignals;

  /** Current computed score [0, 1] - used for RANKING, not filtering */
  current_score: number;

  /** Instrumentation for tuning/debugging */
  instrumentation: SalienceInstrumentation;
}

/**
 * Weights for salience computation
 * These should be tuned based on instrumentation feedback
 *
 * NOTE: recency_halflife_hours is DEPRECATED and kept for backwards compatibility.
 * Recency no longer affects score - old memories are just as valuable as new ones.
 */
export interface SalienceWeights {
  reward: number;
  error: number;
  novelty: number;
  emotion: number;
  access: number;
  goal: number;
  user_pin_boost: number;
  /** @deprecated Recency no longer affects ranking. Kept for backwards compat. */
  recency_halflife_hours: number;
}

export const DEFAULT_WEIGHTS: SalienceWeights = {
  reward: 0.25,
  error: 0.20,
  novelty: 0.15,
  emotion: 0.15,
  access: 0.15, // Increased from 0.10 - access frequency matters more now
  goal: 0.10,
  user_pin_boost: 0.30,
  recency_halflife_hours: 168, // Kept for backwards compat, but unused
};

/**
 * Configuration for retrieval-induced deprioritization
 *
 * Based on cognitive science: when memory A is retrieved in context C,
 * competing memories that share context C but weren't retrieved become
 * lower priority for auto-surfacing. They remain fully searchable.
 *
 * This is RANKING adjustment, not forgetting - everything stays accessible.
 */
export interface RetrievalDeprioritizationConfig {
  /** Priority reduction factor for non-retrieved competitors [0, 1] */
  deprioritization_factor: number;

  /** Minimum similarity threshold to be considered a competitor [0, 1] */
  competitor_threshold: number;

  /** Maximum priority reduction per event */
  max_reduction: number;

  /** Whether pinned memories are exempt from deprioritization */
  exempt_pinned: boolean;
}

/**
 * @deprecated Use RetrievalDeprioritizationConfig instead
 */
export type RetrievalForgettingConfig = RetrievalDeprioritizationConfig;

export const DEFAULT_DEPRIORITIZATION_CONFIG: RetrievalDeprioritizationConfig = {
  deprioritization_factor: 0.05, // 5% ranking reduction per non-retrieval
  competitor_threshold: 0.6, // Must be 60%+ similar to be a competitor
  max_reduction: 0.15, // Cap at 15% reduction per event
  exempt_pinned: true,
};

/**
 * @deprecated Use DEFAULT_DEPRIORITIZATION_CONFIG instead
 */
export const DEFAULT_FORGETTING_CONFIG = DEFAULT_DEPRIORITIZATION_CONFIG;

/**
 * Create initial salience signals (all neutral)
 */
export function createSalienceSignals(): SalienceSignals {
  return {
    reward_signal: 0,
    error_signal: 0,
    user_pinned: false,
    user_blocked: false,
    novelty_score: 0.5, // Neutral novelty
    emotional_intensity: 0,
    access_count: 0,
    last_accessed: new Date(),
    goal_relevance: 0.5, // Neutral relevance
  };
}

/**
 * Bound a value to [0, 1] range
 */
function bound(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * @deprecated Recency decay is no longer used. Kept for backwards compatibility.
 * Old memories are just as valuable as new ones - machines don't need to forget.
 */
function computeRecencyFactor(lastAccessed: Date, halflifeHours: number): number {
  const hoursSinceAccess = (Date.now() - lastAccessed.getTime()) / (1000 * 60 * 60);
  return Math.pow(0.5, hoursSinceAccess / halflifeHours);
}

/**
 * Compute access frequency factor (logarithmic scaling)
 * More accesses = higher ranking priority
 */
function computeAccessFactor(accessCount: number): number {
  // Logarithmic scaling: 0 -> 0, 1 -> 0.3, 10 -> 0.7, 100 -> 1.0
  if (accessCount === 0) return 0;
  return bound(Math.log10(accessCount + 1) / 2);
}

/**
 * Compute salience score for RANKING (not filtering)
 *
 * Higher scores = surfaced first in auto-retrieval
 * Lower scores = still fully searchable, just not auto-surfaced
 *
 * Returns both the score and instrumentation data for feedback loop
 */
export function computeSalience(
  signals: SalienceSignals,
  weights: SalienceWeights = DEFAULT_WEIGHTS
): { score: number; instrumentation: SalienceInstrumentation } {
  // User blocked = score of -1 (suppressed from retrieval, but still stored)
  if (signals.user_blocked) {
    return {
      score: -1,
      instrumentation: {
        computed_at: new Date(),
        raw_signals: { user_blocked: 1 },
        weighted_contributions: { user_blocked: -1 },
        final_score: -1,
      },
    };
  }

  // Bound all inputs to prevent gaming
  const boundedSignals = {
    reward: bound(signals.reward_signal),
    error: bound(signals.error_signal),
    novelty: bound(signals.novelty_score),
    emotion: bound(signals.emotional_intensity),
    goal: bound(signals.goal_relevance),
  };

  // Compute access factor (no recency decay - all memories are equally accessible)
  const accessFactor = computeAccessFactor(signals.access_count);

  // Compute weighted contributions
  const contributions: Record<string, number> = {
    reward: boundedSignals.reward * weights.reward,
    error: boundedSignals.error * weights.error,
    novelty: boundedSignals.novelty * weights.novelty,
    emotion: boundedSignals.emotion * weights.emotion,
    access: accessFactor * weights.access, // No recency multiplier
    goal: boundedSignals.goal * weights.goal,
  };

  // Sum base score
  let score = Object.values(contributions).reduce((sum, v) => sum + v, 0);

  // Apply user pin boost (additive, after base calculation)
  if (signals.user_pinned) {
    contributions.user_pin = weights.user_pin_boost;
    score += weights.user_pin_boost;
  }

  // Final bounding
  const finalScore = bound(score);

  return {
    score: finalScore,
    instrumentation: {
      computed_at: new Date(),
      raw_signals: {
        ...boundedSignals,
        access_count: signals.access_count,
        user_pinned: signals.user_pinned ? 1 : 0,
      },
      weighted_contributions: contributions,
      final_score: finalScore,
    },
  };
}

/**
 * Create a full Salience record from signals
 */
export function createSalience(
  signals: SalienceSignals,
  weights?: SalienceWeights
): Salience {
  const { score, instrumentation } = computeSalience(signals, weights);
  return {
    signals,
    current_score: score,
    instrumentation,
  };
}

/**
 * Update salience after retrieval (retrieval-induced reinforcement)
 * Accessed memories rank higher in future retrievals
 */
export function reinforceOnRetrieval(
  salience: Salience,
  weights?: SalienceWeights
): Salience {
  const updatedSignals: SalienceSignals = {
    ...salience.signals,
    access_count: salience.signals.access_count + 1,
    last_accessed: new Date(),
  };

  return createSalience(updatedSignals, weights);
}

/**
 * Mark instrumentation as validated (for feedback loop)
 */
export function markValidated(
  instrumentation: SalienceInstrumentation,
  wasUseful: boolean
): SalienceInstrumentation {
  return {
    ...instrumentation,
    validated_useful: wasUseful,
    validated_at: new Date(),
  };
}

/**
 * Result of retrieval-induced deprioritization calculation
 */
export interface DeprioritizationResult {
  /** Whether deprioritization was applied */
  applied: boolean;

  /** The reduction amount (0 if not applied) */
  reduction: number;

  /** Reason if deprioritization was not applied */
  exempt_reason?: 'pinned' | 'below_threshold' | 'blocked';

  /** Similarity score that triggered competition */
  similarity?: number;
}

/**
 * @deprecated Use DeprioritizationResult instead
 */
export type ForgettingResult = DeprioritizationResult;

/**
 * Apply retrieval-induced deprioritization to a competing memory
 *
 * This implements ranking adjustment: when memory A is retrieved in context C,
 * competing memories that share context C but weren't retrieved become
 * lower priority for auto-surfacing. They remain fully searchable.
 *
 * @param salience - The salience of the competing (non-retrieved) memory
 * @param similarity - How similar this memory was to the query [0, 1]
 * @param config - Deprioritization configuration
 * @param weights - Salience weights for recomputation
 * @returns Updated salience and deprioritization result
 */
export function applyRetrievalDeprioritization(
  salience: Salience,
  similarity: number,
  config: RetrievalDeprioritizationConfig = DEFAULT_DEPRIORITIZATION_CONFIG,
  weights: SalienceWeights = DEFAULT_WEIGHTS
): { salience: Salience; result: DeprioritizationResult } {
  // Check exemptions
  if (salience.signals.user_pinned && config.exempt_pinned) {
    return {
      salience,
      result: { applied: false, reduction: 0, exempt_reason: 'pinned' },
    };
  }

  if (salience.signals.user_blocked) {
    return {
      salience,
      result: { applied: false, reduction: 0, exempt_reason: 'blocked' },
    };
  }

  // Only deprioritize if similarity exceeds competitor threshold
  if (similarity < config.competitor_threshold) {
    return {
      salience,
      result: {
        applied: false,
        reduction: 0,
        exempt_reason: 'below_threshold',
        similarity,
      },
    };
  }

  // Calculate reduction: higher similarity = more deprioritization
  // Scale by how similar the memory was (more similar = stronger competition)
  const scaledReduction = config.deprioritization_factor * (similarity - config.competitor_threshold) /
    (1 - config.competitor_threshold);
  const reduction = Math.min(scaledReduction, config.max_reduction);

  // Apply reduction to goal_relevance (primary target of ranking adjustment)
  // This reduces auto-surfacing priority while keeping the memory searchable
  const updatedSignals: SalienceSignals = {
    ...salience.signals,
    goal_relevance: bound(salience.signals.goal_relevance - reduction),
  };

  // Recompute salience with updated signals
  const { score, instrumentation } = computeSalience(updatedSignals, weights);

  // Add deprioritization event to instrumentation
  const updatedInstrumentation: SalienceInstrumentation = {
    ...instrumentation,
    raw_signals: {
      ...instrumentation.raw_signals,
      deprioritization_applied: reduction,
      competitor_similarity: similarity,
    },
  };

  return {
    salience: {
      signals: updatedSignals,
      current_score: score,
      instrumentation: updatedInstrumentation,
    },
    result: {
      applied: true,
      reduction,
      similarity,
    },
  };
}

/**
 * @deprecated Use applyRetrievalDeprioritization instead
 */
export const applyRetrievalForgetting = applyRetrievalDeprioritization;

/**
 * Batch apply deprioritization to multiple competing memories
 *
 * @param competitors - Array of [salience, similarity] pairs for each competitor
 * @param config - Deprioritization configuration
 * @param weights - Salience weights
 * @returns Array of updated saliences with their deprioritization results
 */
export function applyBatchDeprioritization(
  competitors: Array<{ salience: Salience; similarity: number }>,
  config: RetrievalDeprioritizationConfig = DEFAULT_DEPRIORITIZATION_CONFIG,
  weights: SalienceWeights = DEFAULT_WEIGHTS
): Array<{ salience: Salience; result: DeprioritizationResult }> {
  return competitors.map(({ salience, similarity }) =>
    applyRetrievalDeprioritization(salience, similarity, config, weights)
  );
}

/**
 * @deprecated Use applyBatchDeprioritization instead
 */
export const applyBatchForgetting = applyBatchDeprioritization;

// ─────────────────────────────────────────────────────────────
// Retrieval Strategy Types
// ─────────────────────────────────────────────────────────────

/**
 * Options for search with salience-weighted ranking
 */
export interface SalienceSearchOptions {
  /**
   * How much salience affects ranking [0, 1]
   * 0 = pure semantic relevance
   * 1 = heavily salience-weighted
   * Default: 0.3 (slight salience boost)
   */
  salience_weight?: number;

  /**
   * Include suppressed (blocked) memories
   * Default: false
   */
  include_suppressed?: boolean;

  /**
   * Minimum salience threshold (-1 to 1)
   * Only for filtering out very low priority results
   * Default: -1 (include everything)
   */
  min_salience?: number;
}

/**
 * Combine semantic similarity with salience for final ranking
 *
 * @param semanticScore - Raw semantic similarity [0, 1]
 * @param salienceScore - Salience score [-1, 1] (blocked = -1)
 * @param options - Search options
 * @returns Combined ranking score [0, 1]
 */
export function combineScores(
  semanticScore: number,
  salienceScore: number,
  options: SalienceSearchOptions = {}
): number {
  const { salience_weight = 0.3, include_suppressed = false } = options;

  // Blocked memories get 0 unless explicitly included
  if (salienceScore < 0 && !include_suppressed) {
    return 0;
  }

  // Normalize salience to [0, 1] for combination
  const normalizedSalience = (salienceScore + 1) / 2;

  // Weighted combination
  return (
    semanticScore * (1 - salience_weight) +
    normalizedSalience * salience_weight
  );
}
