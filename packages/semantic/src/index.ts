/**
 * @reminisce/semantic - Semantic Memory Package
 *
 * Long-term storage for facts, entities, and relationships.
 * The "slow learning" neocortical system that receives consolidated knowledge.
 *
 * @packageDocumentation
 */

export {
  type SemanticStore,
  type SemanticStoreConfig,
  type SemanticQuery,
  type FactInput,
  type ContradictionResult,
  InMemorySemanticStore,
} from './store.js';

// Re-export relevant types from core
export { type SemanticMemory } from '@reminisce/core';
