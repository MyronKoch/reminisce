/**
 * @reminisce/orchestrator - Memory Orchestrator Package
 *
 * Unified interface to the Reminisce.
 * Use this package to interact with all memory layers through a single API.
 *
 * @example
 * ```typescript
 * import { Reminisce } from '@reminisce/orchestrator';
 *
 * const reminisce = new Reminisce({ machineId: 'my-agent' });
 *
 * // Start a session
 * reminisce.startSession();
 *
 * // Remember things
 * await reminisce.remember({ type: 'message', data: 'Hello!' });
 *
 * // Search across all layers
 * const results = await reminisce.search({ text: 'Hello' });
 *
 * // End session (auto-consolidates)
 * await reminisce.endSession();
 * ```
 *
 * @packageDocumentation
 */

export { Reminisce, type ReminisceConfig, type SearchResult, type Session } from './reminisce.js';

// Observability exports
export {
  ObservabilityCollector,
  createPrometheusExporter,
  type ObservabilityConfig,
  type MetricEvent,
  type AggregatedMetrics,
  type SalienceBucket,
  type OperationType,
  type MemoryLayer,
} from './observability.js';

// Suppression policy exports
export {
  SuppressionManager,
  createTopicBlockRule,
  createSessionBlockRule,
  createEntityRedactRule,
  type SuppressionRule,
  type SuppressionCriteria,
  type SuppressionAction,
  type SuppressionCheckResult,
} from './suppression.js';

// Re-export commonly used types
export type {
  WorkingMemoryItem,
  EpisodicMemory,
  SemanticMemory,
  MemoryID,
  SalienceSignals,
} from '@reminisce/core';

export type { WorkingMemoryInput } from '@reminisce/working';
export type { EpisodeInput } from '@reminisce/episodic';
export type { FactInput } from '@reminisce/semantic';
export type { ConsolidationResult } from '@reminisce/consolidation';
