/**
 * Tests for salience computation
 *
 * PHILOSOPHY: Salience determines retrieval PRIORITY, not existence.
 * - High salience = appears in top results automatically
 * - Low salience = still findable with specific queries
 * - Nothing is ever truly "forgotten" (except explicit suppression)
 */

import { describe, test, expect } from 'bun:test';
import {
  createSalienceSignals,
  computeSalience,
  createSalience,
  reinforceOnRetrieval,
  combineScores,
  // New names
  applyRetrievalDeprioritization,
  applyBatchDeprioritization,
  DEFAULT_DEPRIORITIZATION_CONFIG,
  // Deprecated aliases (still work for backwards compatibility)
  applyRetrievalForgetting,
  applyBatchForgetting,
  DEFAULT_WEIGHTS,
  DEFAULT_FORGETTING_CONFIG,
} from './salience.js';

describe('createSalienceSignals', () => {
  test('creates neutral signals', () => {
    const signals = createSalienceSignals();
    expect(signals.reward_signal).toBe(0);
    expect(signals.error_signal).toBe(0);
    expect(signals.user_pinned).toBe(false);
    expect(signals.user_blocked).toBe(false);
    expect(signals.novelty_score).toBe(0.5);
    expect(signals.access_count).toBe(0);
  });
});

describe('computeSalience', () => {
  test('returns -1 for user_blocked', () => {
    const signals = createSalienceSignals();
    signals.user_blocked = true;
    const { score } = computeSalience(signals);
    expect(score).toBe(-1);
  });

  test('boosts score for user_pinned', () => {
    const signals = createSalienceSignals();
    const { score: baseScore } = computeSalience(signals);

    signals.user_pinned = true;
    const { score: pinnedScore } = computeSalience(signals);

    expect(pinnedScore).toBeGreaterThan(baseScore);
    expect(pinnedScore - baseScore).toBeCloseTo(DEFAULT_WEIGHTS.user_pin_boost, 2);
  });

  test('includes instrumentation data', () => {
    const signals = createSalienceSignals();
    signals.reward_signal = 0.8;
    signals.error_signal = 0.2;

    const { instrumentation } = computeSalience(signals);

    expect(instrumentation.computed_at).toBeInstanceOf(Date);
    expect(instrumentation.raw_signals.reward).toBe(0.8);
    expect(instrumentation.raw_signals.error).toBe(0.2);
    expect(instrumentation.weighted_contributions.reward).toBeCloseTo(0.8 * DEFAULT_WEIGHTS.reward, 4);
  });

  test('bounds signals to [0, 1]', () => {
    const signals = createSalienceSignals();
    signals.reward_signal = 1.5; // Over 1
    signals.error_signal = -0.5; // Under 0

    const { score, instrumentation } = computeSalience(signals);

    expect(instrumentation.raw_signals.reward).toBe(1);
    expect(instrumentation.raw_signals.error).toBe(0);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  test('high reward + high access = elevated salience', () => {
    const signals = createSalienceSignals();
    signals.reward_signal = 0.9;
    signals.access_count = 50;
    signals.last_accessed = new Date();

    const { score } = computeSalience(signals);
    // Should be elevated compared to neutral (0.5 novelty + 0.5 goal = ~0.125 baseline)
    expect(score).toBeGreaterThan(0.3);

    // Compare to neutral signals
    const neutralSignals = createSalienceSignals();
    const { score: neutralScore } = computeSalience(neutralSignals);
    expect(score).toBeGreaterThan(neutralScore);
  });
});

describe('reinforceOnRetrieval', () => {
  test('increments access count', () => {
    const signals = createSalienceSignals();
    const salience = createSalience(signals);

    expect(salience.signals.access_count).toBe(0);

    const reinforced = reinforceOnRetrieval(salience);
    expect(reinforced.signals.access_count).toBe(1);

    const reinforcedAgain = reinforceOnRetrieval(reinforced);
    expect(reinforcedAgain.signals.access_count).toBe(2);
  });

  test('updates last_accessed', () => {
    const signals = createSalienceSignals();
    signals.last_accessed = new Date(Date.now() - 1000 * 60 * 60 * 24); // 1 day ago
    const salience = createSalience(signals);

    const before = salience.signals.last_accessed.getTime();
    const reinforced = reinforceOnRetrieval(salience);
    const after = reinforced.signals.last_accessed.getTime();

    expect(after).toBeGreaterThan(before);
  });
});

describe('applyRetrievalForgetting', () => {
  test('does not apply forgetting below competitor threshold', () => {
    const signals = createSalienceSignals();
    signals.goal_relevance = 0.8;
    const salience = createSalience(signals);

    // Similarity below threshold (default 0.6)
    const { salience: updated, result } = applyRetrievalForgetting(salience, 0.5);

    expect(result.applied).toBe(false);
    expect(result.exempt_reason).toBe('below_threshold');
    expect(updated.signals.goal_relevance).toBe(0.8); // Unchanged
  });

  test('applies forgetting above competitor threshold', () => {
    const signals = createSalienceSignals();
    signals.goal_relevance = 0.8;
    const salience = createSalience(signals);

    // Similarity above threshold
    const { salience: updated, result } = applyRetrievalForgetting(salience, 0.9);

    expect(result.applied).toBe(true);
    expect(result.reduction).toBeGreaterThan(0);
    expect(updated.signals.goal_relevance).toBeLessThan(0.8);
  });

  test('higher similarity causes more forgetting', () => {
    const signals1 = createSalienceSignals();
    signals1.goal_relevance = 0.8;
    const salience1 = createSalience(signals1);

    const signals2 = createSalienceSignals();
    signals2.goal_relevance = 0.8;
    const salience2 = createSalience(signals2);

    const { result: result1 } = applyRetrievalForgetting(salience1, 0.7); // Lower similarity
    const { result: result2 } = applyRetrievalForgetting(salience2, 0.95); // Higher similarity

    expect(result2.reduction).toBeGreaterThan(result1.reduction);
  });

  test('exempts pinned memories when configured', () => {
    const signals = createSalienceSignals();
    signals.goal_relevance = 0.8;
    signals.user_pinned = true;
    const salience = createSalience(signals);

    const { result } = applyRetrievalForgetting(salience, 0.9);

    expect(result.applied).toBe(false);
    expect(result.exempt_reason).toBe('pinned');
  });

  test('can forget pinned memories when configured', () => {
    const signals = createSalienceSignals();
    signals.goal_relevance = 0.8;
    signals.user_pinned = true;
    const salience = createSalience(signals);

    const config = { ...DEFAULT_FORGETTING_CONFIG, exempt_pinned: false };
    const { result } = applyRetrievalForgetting(salience, 0.9, config);

    expect(result.applied).toBe(true);
  });

  test('exempts blocked memories', () => {
    const signals = createSalienceSignals();
    signals.user_blocked = true;
    const salience = createSalience(signals);

    const { result } = applyRetrievalForgetting(salience, 0.9);

    expect(result.applied).toBe(false);
    expect(result.exempt_reason).toBe('blocked');
  });

  test('respects max_reduction cap', () => {
    const signals = createSalienceSignals();
    signals.goal_relevance = 0.8;
    const salience = createSalience(signals);

    // Even with very high similarity, reduction is capped
    const { result } = applyRetrievalForgetting(salience, 1.0);

    expect(result.reduction).toBeLessThanOrEqual(DEFAULT_FORGETTING_CONFIG.max_reduction);
  });

  test('includes deprioritization data in instrumentation', () => {
    const signals = createSalienceSignals();
    signals.goal_relevance = 0.8;
    const salience = createSalience(signals);

    const { salience: updated, result } = applyRetrievalForgetting(salience, 0.85);

    expect(result.applied).toBe(true);
    expect(updated.instrumentation.raw_signals.deprioritization_applied).toBe(result.reduction);
    expect(updated.instrumentation.raw_signals.competitor_similarity).toBe(0.85);
  });
});

describe('applyBatchForgetting', () => {
  test('applies forgetting to multiple competitors', () => {
    const competitors = [
      { salience: createSalience(createSalienceSignals()), similarity: 0.7 },
      { salience: createSalience(createSalienceSignals()), similarity: 0.5 }, // Below threshold
      { salience: createSalience(createSalienceSignals()), similarity: 0.9 },
    ];

    const results = applyBatchForgetting(competitors);

    expect(results.length).toBe(3);
    expect(results[0]!.result.applied).toBe(true);  // 0.7 > 0.6
    expect(results[1]!.result.applied).toBe(false); // 0.5 < 0.6
    expect(results[2]!.result.applied).toBe(true);  // 0.9 > 0.6
  });
});

// ─────────────────────────────────────────────────────────────
// New tests for ranking-based salience (no recency decay)
// ─────────────────────────────────────────────────────────────

describe('No Recency Decay (Machine Advantage)', () => {
  test('old memories have same score as new memories (all else equal)', () => {
    // Create two identical memories - one accessed just now, one accessed 6 months ago
    const recentSignals = createSalienceSignals();
    recentSignals.access_count = 5;
    recentSignals.last_accessed = new Date(); // Just accessed

    const oldSignals = createSalienceSignals();
    oldSignals.access_count = 5;
    oldSignals.last_accessed = new Date(Date.now() - 1000 * 60 * 60 * 24 * 180); // 180 days ago

    const { score: recentScore } = computeSalience(recentSignals);
    const { score: oldScore } = computeSalience(oldSignals);

    // Scores should be IDENTICAL - no recency decay
    expect(oldScore).toBe(recentScore);
  });

  test('access count increases ranking, not recency', () => {
    // More accessed = higher ranking
    const frequentSignals = createSalienceSignals();
    frequentSignals.access_count = 100;
    frequentSignals.last_accessed = new Date(Date.now() - 1000 * 60 * 60 * 24 * 365); // 1 year ago

    const infrequentSignals = createSalienceSignals();
    infrequentSignals.access_count = 1;
    infrequentSignals.last_accessed = new Date(); // Just now

    const { score: frequentScore } = computeSalience(frequentSignals);
    const { score: infrequentScore } = computeSalience(infrequentSignals);

    // Frequently accessed should rank higher even if old
    expect(frequentScore).toBeGreaterThan(infrequentScore);
  });

  test('all memories remain searchable regardless of age', () => {
    // Even ancient memories with low activity should have positive scores
    const ancientSignals = createSalienceSignals();
    ancientSignals.access_count = 0;
    ancientSignals.last_accessed = new Date('2020-01-01'); // 5 years old
    ancientSignals.novelty_score = 0.1; // Low novelty
    ancientSignals.goal_relevance = 0.1; // Low relevance

    const { score } = computeSalience(ancientSignals);

    // Should still have a positive score (searchable)
    expect(score).toBeGreaterThan(0);
  });
});

describe('combineScores (Salience-weighted ranking)', () => {
  test('pure semantic search (salience_weight = 0)', () => {
    const combined = combineScores(0.8, 0.2, { salience_weight: 0 });
    expect(combined).toBe(0.8); // Pure semantic
  });

  test('pure salience ranking (salience_weight = 1)', () => {
    const combined = combineScores(0.2, 0.8, { salience_weight: 1 });
    // Salience 0.8 normalized to [0,1] = (0.8+1)/2 = 0.9
    expect(combined).toBeCloseTo(0.9, 2);
  });

  test('default blending (salience_weight = 0.3)', () => {
    const semantic = 0.8;
    const salience = 0.6;
    const combined = combineScores(semantic, salience, { salience_weight: 0.3 });

    // 0.8 * 0.7 + ((0.6+1)/2) * 0.3 = 0.56 + 0.24 = 0.8
    const normalizedSalience = (salience + 1) / 2;
    const expected = semantic * 0.7 + normalizedSalience * 0.3;
    expect(combined).toBeCloseTo(expected, 4);
  });

  test('blocked memories (salience = -1) get 0 unless explicitly included', () => {
    const combined = combineScores(0.9, -1, { include_suppressed: false });
    expect(combined).toBe(0);

    const included = combineScores(0.9, -1, { include_suppressed: true });
    expect(included).toBeGreaterThan(0);
  });
});

describe('New names (applyRetrievalDeprioritization)', () => {
  test('new function names work correctly', () => {
    const signals = createSalienceSignals();
    signals.goal_relevance = 0.8;
    const salience = createSalience(signals);

    // Use new name
    const { salience: updated, result } = applyRetrievalDeprioritization(salience, 0.9);

    expect(result.applied).toBe(true);
    expect(result.reduction).toBeGreaterThan(0);
    expect(updated.signals.goal_relevance).toBeLessThan(0.8);
  });

  test('batch deprioritization with new name', () => {
    const competitors = [
      { salience: createSalience(createSalienceSignals()), similarity: 0.7 },
      { salience: createSalience(createSalienceSignals()), similarity: 0.9 },
    ];

    const results = applyBatchDeprioritization(competitors);

    expect(results.length).toBe(2);
    expect(results[0]!.result.applied).toBe(true);
    expect(results[1]!.result.applied).toBe(true);
  });

  test('DEFAULT_DEPRIORITIZATION_CONFIG equals DEFAULT_FORGETTING_CONFIG', () => {
    expect(DEFAULT_DEPRIORITIZATION_CONFIG).toEqual(DEFAULT_FORGETTING_CONFIG);
  });
});
