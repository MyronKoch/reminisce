/**
 * @reminisce/working - Working Memory Package
 *
 * Provides a capacity-limited buffer for active session context.
 * Based on Baddeley's working memory model with ~7 item limit.
 *
 * @packageDocumentation
 */

export {
  WorkingMemoryBuffer,
  type WorkingMemoryConfig,
  type WorkingMemoryInput,
  type WorkingMemoryContentType,
} from './buffer.js';

// Re-export relevant types from core
export { type WorkingMemoryItem } from '@reminisce/core';
