/**
 * Provenance - Track where memories came from and how they're related
 *
 * Critical for:
 * - Updating semantic facts when source episodes change
 * - Retracting information when sources are invalidated
 * - Resolving contradictions between memories
 * - Audit trails for compliance
 */

import type { MemoryID } from './memory-id.js';

/**
 * How a memory was derived from its sources
 */
export type DerivationType =
  | 'direct'           // User explicitly stated this
  | 'consolidated'     // Extracted from episodic memories during consolidation
  | 'inferred'         // LLM inferred this from context
  | 'user_declared';   // User explicitly corrected/declared this fact

/**
 * Provenance tracks the origin and validity of a memory
 */
export interface Provenance {
  /** Parent memories this was derived from */
  source_ids: MemoryID[];

  /** How this memory was created */
  derivation_type: DerivationType;

  /** Confidence in this memory (0-1), decays without reinforcement */
  confidence: number;

  /** Last time this memory was validated/accessed */
  last_validated: Date;

  /** Memories that contradict this one */
  contradiction_ids: MemoryID[];

  /** Whether this memory has been retracted */
  retracted: boolean;

  /** Why this memory was retracted */
  retracted_reason?: string;

  /** If superseded, the newer memory that replaced this */
  superseded_by?: MemoryID;
}

/**
 * Create initial provenance for a new memory
 */
export function createProvenance(
  sourceIds: MemoryID[],
  derivationType: DerivationType,
  confidence: number = 1.0
): Provenance {
  return {
    source_ids: sourceIds,
    derivation_type: derivationType,
    confidence: Math.max(0, Math.min(1, confidence)),
    last_validated: new Date(),
    contradiction_ids: [],
    retracted: false,
  };
}

/**
 * State transitions for provenance lifecycle
 */
export type ProvenanceAction =
  | { type: 'validate'; confidence_boost?: number }
  | { type: 'decay'; amount: number }
  | { type: 'add_contradiction'; memory_id: MemoryID }
  | { type: 'resolve_contradiction'; memory_id: MemoryID }
  | { type: 'retract'; reason: string }
  | { type: 'supersede'; new_memory: MemoryID }
  | { type: 'reinstate' };

/**
 * Apply a state transition to provenance
 */
export function applyProvenanceAction(
  provenance: Provenance,
  action: ProvenanceAction
): Provenance {
  switch (action.type) {
    case 'validate':
      return {
        ...provenance,
        last_validated: new Date(),
        confidence: Math.min(1, provenance.confidence + (action.confidence_boost ?? 0.1)),
      };

    case 'decay':
      return {
        ...provenance,
        confidence: Math.max(0, provenance.confidence - action.amount),
      };

    case 'add_contradiction':
      return {
        ...provenance,
        contradiction_ids: [...provenance.contradiction_ids, action.memory_id],
      };

    case 'resolve_contradiction':
      return {
        ...provenance,
        contradiction_ids: provenance.contradiction_ids.filter(
          id => id.id !== action.memory_id.id
        ),
      };

    case 'retract':
      return {
        ...provenance,
        retracted: true,
        retracted_reason: action.reason,
      };

    case 'supersede':
      return {
        ...provenance,
        retracted: true,
        retracted_reason: 'superseded',
        superseded_by: action.new_memory,
      };

    case 'reinstate': {
      // With exactOptionalPropertyTypes, we can't assign undefined
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { retracted_reason, superseded_by, ...rest } = provenance;
      return {
        ...rest,
        retracted: false,
      };
    }
  }
}

/**
 * Check if a memory is currently valid (not retracted, confidence > 0)
 */
export function isValid(provenance: Provenance): boolean {
  return !provenance.retracted && provenance.confidence > 0;
}

/**
 * Check if a memory has unresolved contradictions
 */
export function hasContradictions(provenance: Provenance): boolean {
  return provenance.contradiction_ids.length > 0;
}

/**
 * Calculate confidence decay based on time since last validation
 *
 * Uses exponential decay with configurable half-life
 */
export function calculateDecay(
  provenance: Provenance,
  halfLifeDays: number = 30
): number {
  const daysSinceValidation =
    (Date.now() - provenance.last_validated.getTime()) / (1000 * 60 * 60 * 24);

  const decayFactor = Math.pow(0.5, daysSinceValidation / halfLifeDays);
  return provenance.confidence * decayFactor;
}
