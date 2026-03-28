/**
 * @reminisce/episodic - Episodic Memory Package
 *
 * Timeline-based "what happened when" storage.
 * Receives overflow from working memory and feeds consolidation to semantic.
 *
 * @packageDocumentation
 */

export {
  type EpisodicStore,
  type EpisodicStoreConfig,
  type EpisodicQuery,
  type EpisodeInput,
  InMemoryEpisodicStore,
} from './store.js';

// Re-export relevant types from core
export { type EpisodicMemory } from '@reminisce/core';
