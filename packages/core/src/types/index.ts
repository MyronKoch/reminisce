/**
 * Core Types - Public API
 */

// Memory ID and layer types
export {
  type MemoryID,
  type MemoryLayer,
  createMemoryID,
  parseMemoryID,
  serializeMemoryID,
  isValidMemoryID,
} from './memory-id.js';

// Provenance tracking
export {
  type Provenance,
  type DerivationType,
  type ProvenanceAction,
  createProvenance,
  applyProvenanceAction,
  isValid,
  hasContradictions,
  calculateDecay,
} from './provenance.js';

// Salience scoring (ranking-based, not decay-based)
export {
  type SalienceSignals,
  type SalienceInstrumentation,
  type Salience,
  type SalienceWeights,
  // New names (preferred)
  type RetrievalDeprioritizationConfig,
  type DeprioritizationResult,
  type SalienceSearchOptions,
  DEFAULT_WEIGHTS,
  DEFAULT_DEPRIORITIZATION_CONFIG,
  createSalienceSignals,
  computeSalience,
  createSalience,
  reinforceOnRetrieval,
  markValidated,
  applyRetrievalDeprioritization,
  applyBatchDeprioritization,
  combineScores,
  // Deprecated aliases (for backwards compatibility)
  type RetrievalForgettingConfig,
  type ForgettingResult,
  DEFAULT_FORGETTING_CONFIG,
  applyRetrievalForgetting,
  applyBatchForgetting,
} from './salience.js';

// Memory types
export {
  type BaseMemory,
  type WorkingMemoryItem,
  type EpisodicMemory,
  type SemanticMemory,
  type ProceduralMemory,
  type Memory,
  isWorkingMemory,
  isEpisodicMemory,
  isSemanticMemory,
  isProceduralMemory,
} from './memory.js';
