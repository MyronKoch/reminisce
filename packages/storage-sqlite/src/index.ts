/**
 * @reminisce/storage-sqlite
 *
 * SQLite storage backends for Reminisce episodic and semantic memory.
 * Uses Bun's built-in SQLite for high performance.
 * Optional vector search via sqlite-vec.
 */

export { SqliteEpisodicStore } from './episodic-store.js';
export { SqliteSemanticStore } from './semantic-store.js';
export { initializeSchema, type EpisodicRow, type SemanticRow } from './schema.js';

// Vector search (optional - requires sqlite-vec)
export {
  initializeVectorSearch,
  storeEpisodicEmbedding,
  storeSemanticEmbedding,
  searchEpisodicByVector,
  searchSemanticByVector,
  deleteEpisodicEmbedding,
  deleteSemanticEmbedding,
  batchStoreEpisodicEmbeddings,
  batchStoreSemanticEmbeddings,
  isVectorSearchAvailable,
  getVectorVersion,
  type VectorConfig,
} from './vector.js';

// Re-export store interfaces for convenience
export type {
  EpisodicStore,
  EpisodicStoreConfig,
  EpisodeInput,
  EpisodicQuery,
} from '@reminisce/episodic';

export type {
  SemanticStore,
  SemanticStoreConfig,
  FactInput,
  SemanticQuery,
  ContradictionResult,
} from '@reminisce/semantic';
