/**
 * @reminisce/reminisce - Reminisce
 *
 * AI memory that thinks like a human brain.
 *
 * This is the unified entry point for Reminisce. Import everything you need from here.
 *
 * @example
 * ```typescript
 * import { Reminisce, SqliteEpisodicStore, SqliteSemanticStore } from '@reminisce/reminisce';
 *
 * // With SQLite persistence
 * const reminisce = new Reminisce({
 *   machineId: 'my-agent',
 *   episodicStore: new SqliteEpisodicStore('./memory.db', { machineId: 'my-agent' }),
 *   semanticStore: new SqliteSemanticStore('./memory.db', { machineId: 'my-agent', sessionId: 'default' }),
 * });
 *
 * reminisce.startSession();
 * await reminisce.remember({ type: 'context', data: { user: 'prefers dark mode' } });
 * await reminisce.endSession();
 * ```
 *
 * @packageDocumentation
 */

// Main orchestrator
export { Reminisce, type ReminisceConfig, type SearchResult, type Session } from '@reminisce/orchestrator';

// Core types
export {
  // Memory types
  type BaseMemory,
  type WorkingMemoryItem,
  type EpisodicMemory,
  type SemanticMemory,
  type ProceduralMemory,
  type Memory,
  type MemoryID,
  type MemoryLayer,
  // Salience
  type SalienceSignals,
  type SalienceInstrumentation,
  type Salience,
  type SalienceWeights,
  // Provenance
  type Provenance,
  type DerivationType,
  type ProvenanceAction,
  // Utils
  createMemoryID,
  parseMemoryID,
  serializeMemoryID,
  createSalienceSignals,
  computeSalience,
  createSalience,
  createProvenance,
  applyProvenanceAction,
  VERSION,
} from '@reminisce/core';

// Working memory
export {
  WorkingMemoryBuffer,
  type WorkingMemoryInput,
  type WorkingMemoryConfig,
  type WorkingMemoryContentType,
} from '@reminisce/working';

// Episodic memory
export {
  InMemoryEpisodicStore,
  type EpisodicStore,
  type EpisodicStoreConfig,
  type EpisodeInput,
  type EpisodicQuery,
} from '@reminisce/episodic';

// Semantic memory
export {
  InMemorySemanticStore,
  type SemanticStore,
  type SemanticStoreConfig,
  type FactInput,
  type SemanticQuery,
  type ContradictionResult,
} from '@reminisce/semantic';

// Consolidation
export {
  ConsolidationEngine,
  type ConsolidationConfig,
  type ConsolidationResult,
  type FactExtractor,
} from '@reminisce/consolidation';

// SQLite storage
export {
  SqliteEpisodicStore,
  SqliteSemanticStore,
  initializeSchema,
  // Vector search
  initializeVectorSearch,
  storeEpisodicEmbedding,
  storeSemanticEmbedding,
  searchEpisodicByVector,
  searchSemanticByVector,
  isVectorSearchAvailable,
  getVectorVersion,
  type VectorConfig,
  type EpisodicRow,
  type SemanticRow,
} from '@reminisce/storage-sqlite';
