/**
 * Tests for Provenance tracking and state transitions
 */

import { describe, test, expect } from 'bun:test';
import {
  createProvenance,
  applyProvenanceAction,
  isValid,
  hasContradictions,
  calculateDecay,
  type DerivationType,
} from './provenance.js';
import { createMemoryID } from './memory-id.js';

// Test helpers
function createTestMemoryID(suffix: string) {
  return createMemoryID('episodic', `session-${suffix}`, 'test-machine');
}

describe('createProvenance', () => {
  test('creates provenance with default confidence', () => {
    const sourceIds = [createTestMemoryID('1')];
    const provenance = createProvenance(sourceIds, 'consolidated');

    expect(provenance.source_ids).toEqual(sourceIds);
    expect(provenance.derivation_type).toBe('consolidated');
    expect(provenance.confidence).toBe(1.0);
    expect(provenance.contradiction_ids).toEqual([]);
    expect(provenance.retracted).toBe(false);
  });

  test('clamps confidence to [0, 1] range', () => {
    const sourceIds = [createTestMemoryID('1')];

    const tooHigh = createProvenance(sourceIds, 'direct', 1.5);
    expect(tooHigh.confidence).toBe(1.0);

    const tooLow = createProvenance(sourceIds, 'direct', -0.5);
    expect(tooLow.confidence).toBe(0);
  });

  test('accepts custom confidence value', () => {
    const sourceIds = [createTestMemoryID('1')];
    const provenance = createProvenance(sourceIds, 'inferred', 0.7);

    expect(provenance.confidence).toBe(0.7);
  });

  test('sets last_validated to current time', () => {
    const sourceIds = [createTestMemoryID('1')];
    const before = Date.now();
    const provenance = createProvenance(sourceIds, 'direct');
    const after = Date.now();

    const timestamp = provenance.last_validated.getTime();
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  test('handles all derivation types', () => {
    const sourceIds = [createTestMemoryID('1')];
    const types: DerivationType[] = ['direct', 'consolidated', 'inferred', 'user_declared'];

    for (const type of types) {
      const provenance = createProvenance(sourceIds, type);
      expect(provenance.derivation_type).toBe(type);
    }
  });
});

describe('applyProvenanceAction - validate', () => {
  test('updates last_validated timestamp', () => {
    const provenance = createProvenance([createTestMemoryID('1')], 'direct');

    // Wait a tiny bit to ensure timestamp changes
    const before = Date.now();
    const updated = applyProvenanceAction(provenance, { type: 'validate' });
    const after = Date.now();

    const timestamp = updated.last_validated.getTime();
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });

  test('boosts confidence by default amount (0.1)', () => {
    const provenance = createProvenance([createTestMemoryID('1')], 'direct', 0.5);
    const updated = applyProvenanceAction(provenance, { type: 'validate' });

    expect(updated.confidence).toBeCloseTo(0.6, 5);
  });

  test('boosts confidence by custom amount', () => {
    const provenance = createProvenance([createTestMemoryID('1')], 'direct', 0.5);
    const updated = applyProvenanceAction(provenance, {
      type: 'validate',
      confidence_boost: 0.3,
    });

    expect(updated.confidence).toBeCloseTo(0.8, 5);
  });

  test('caps confidence at 1.0', () => {
    const provenance = createProvenance([createTestMemoryID('1')], 'direct', 0.95);
    const updated = applyProvenanceAction(provenance, { type: 'validate' });

    expect(updated.confidence).toBe(1.0);
  });
});

describe('applyProvenanceAction - decay', () => {
  test('reduces confidence by specified amount', () => {
    const provenance = createProvenance([createTestMemoryID('1')], 'direct', 0.8);
    const updated = applyProvenanceAction(provenance, { type: 'decay', amount: 0.2 });

    expect(updated.confidence).toBeCloseTo(0.6, 5);
  });

  test('floors confidence at 0', () => {
    const provenance = createProvenance([createTestMemoryID('1')], 'direct', 0.3);
    const updated = applyProvenanceAction(provenance, { type: 'decay', amount: 0.5 });

    expect(updated.confidence).toBe(0);
  });
});

describe('applyProvenanceAction - retract', () => {
  test('sets retracted flag and reason', () => {
    const provenance = createProvenance([createTestMemoryID('1')], 'direct');
    const updated = applyProvenanceAction(provenance, {
      type: 'retract',
      reason: 'Source invalidated',
    });

    expect(updated.retracted).toBe(true);
    expect(updated.retracted_reason).toBe('Source invalidated');
  });
});

describe('applyProvenanceAction - supersede', () => {
  test('sets retracted flag and superseded_by', () => {
    const provenance = createProvenance([createTestMemoryID('1')], 'direct');
    const newMemory = createTestMemoryID('2');

    const updated = applyProvenanceAction(provenance, {
      type: 'supersede',
      new_memory: newMemory,
    });

    expect(updated.retracted).toBe(true);
    expect(updated.retracted_reason).toBe('superseded');
    expect(updated.superseded_by).toEqual(newMemory);
  });
});

describe('applyProvenanceAction - reinstate', () => {
  test('clears retracted status and reason', () => {
    let provenance = createProvenance([createTestMemoryID('1')], 'direct');

    // First retract
    provenance = applyProvenanceAction(provenance, {
      type: 'retract',
      reason: 'Test reason',
    });
    expect(provenance.retracted).toBe(true);

    // Then reinstate
    const updated = applyProvenanceAction(provenance, { type: 'reinstate' });

    expect(updated.retracted).toBe(false);
    expect(updated.retracted_reason).toBeUndefined();
    expect(updated.superseded_by).toBeUndefined();
  });
});

describe('applyProvenanceAction - add_contradiction', () => {
  test('adds contradiction to list', () => {
    const provenance = createProvenance([createTestMemoryID('1')], 'direct');
    const contradictingMemory = createTestMemoryID('2');

    const updated = applyProvenanceAction(provenance, {
      type: 'add_contradiction',
      memory_id: contradictingMemory,
    });

    expect(updated.contradiction_ids).toHaveLength(1);
    expect(updated.contradiction_ids[0]).toEqual(contradictingMemory);
  });

  test('appends to existing contradictions', () => {
    let provenance = createProvenance([createTestMemoryID('1')], 'direct');
    const contradiction1 = createTestMemoryID('2');
    const contradiction2 = createTestMemoryID('3');

    provenance = applyProvenanceAction(provenance, {
      type: 'add_contradiction',
      memory_id: contradiction1,
    });
    provenance = applyProvenanceAction(provenance, {
      type: 'add_contradiction',
      memory_id: contradiction2,
    });

    expect(provenance.contradiction_ids).toHaveLength(2);
  });
});

describe('applyProvenanceAction - resolve_contradiction', () => {
  test('removes specific contradiction from list', () => {
    let provenance = createProvenance([createTestMemoryID('1')], 'direct');
    const contradiction1 = createTestMemoryID('2');
    const contradiction2 = createTestMemoryID('3');

    // Add two contradictions
    provenance = applyProvenanceAction(provenance, {
      type: 'add_contradiction',
      memory_id: contradiction1,
    });
    provenance = applyProvenanceAction(provenance, {
      type: 'add_contradiction',
      memory_id: contradiction2,
    });

    // Resolve first one
    const updated = applyProvenanceAction(provenance, {
      type: 'resolve_contradiction',
      memory_id: contradiction1,
    });

    expect(updated.contradiction_ids).toHaveLength(1);
    expect(updated.contradiction_ids[0].id).toBe(contradiction2.id);
  });
});

describe('isValid', () => {
  test('returns true for non-retracted memory with confidence > 0', () => {
    const provenance = createProvenance([createTestMemoryID('1')], 'direct', 0.5);
    expect(isValid(provenance)).toBe(true);
  });

  test('returns false for retracted memory', () => {
    let provenance = createProvenance([createTestMemoryID('1')], 'direct', 1.0);
    provenance = applyProvenanceAction(provenance, { type: 'retract', reason: 'test' });

    expect(isValid(provenance)).toBe(false);
  });

  test('returns false for confidence = 0', () => {
    const provenance = createProvenance([createTestMemoryID('1')], 'direct', 0);
    expect(isValid(provenance)).toBe(false);
  });

  test('returns false for negative confidence', () => {
    let provenance = createProvenance([createTestMemoryID('1')], 'direct', 0.5);
    provenance = applyProvenanceAction(provenance, { type: 'decay', amount: 1.0 });

    expect(isValid(provenance)).toBe(false);
  });
});

describe('hasContradictions', () => {
  test('returns false for empty contradiction list', () => {
    const provenance = createProvenance([createTestMemoryID('1')], 'direct');
    expect(hasContradictions(provenance)).toBe(false);
  });

  test('returns true when contradictions exist', () => {
    let provenance = createProvenance([createTestMemoryID('1')], 'direct');
    provenance = applyProvenanceAction(provenance, {
      type: 'add_contradiction',
      memory_id: createTestMemoryID('2'),
    });

    expect(hasContradictions(provenance)).toBe(true);
  });
});

describe('calculateDecay', () => {
  test('returns full confidence when just validated', () => {
    const provenance = createProvenance([createTestMemoryID('1')], 'direct', 0.8);
    const decayed = calculateDecay(provenance, 30);

    expect(decayed).toBeCloseTo(0.8, 5);
  });

  test('applies exponential decay based on time', () => {
    const provenance = createProvenance([createTestMemoryID('1')], 'direct', 1.0);

    // Manually set last_validated to 30 days ago (one half-life)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    provenance.last_validated = thirtyDaysAgo;

    const decayed = calculateDecay(provenance, 30);

    // After one half-life, confidence should be ~0.5
    expect(decayed).toBeCloseTo(0.5, 1);
  });

  test('uses custom half-life', () => {
    const provenance = createProvenance([createTestMemoryID('1')], 'direct', 1.0);

    // Set to 60 days ago with 60-day half-life
    const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    provenance.last_validated = sixtyDaysAgo;

    const decayed = calculateDecay(provenance, 60);

    // After one half-life, confidence should be ~0.5
    expect(decayed).toBeCloseTo(0.5, 1);
  });

  test('handles multiple half-lives', () => {
    const provenance = createProvenance([createTestMemoryID('1')], 'direct', 1.0);

    // Set to 90 days ago with 30-day half-life (3 half-lives)
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    provenance.last_validated = ninetyDaysAgo;

    const decayed = calculateDecay(provenance, 30);

    // After 3 half-lives: 1.0 * (0.5^3) = 0.125
    expect(decayed).toBeCloseTo(0.125, 2);
  });
});
