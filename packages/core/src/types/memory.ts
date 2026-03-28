/**
 * Base Memory Types - Common interfaces for all memory layers
 */

import type { MemoryID, MemoryLayer } from './memory-id.js';
import type { Provenance } from './provenance.js';
import type { Salience } from './salience.js';

/**
 * Base interface that all memories implement
 */
export interface BaseMemory {
  /** Unique identifier with layer and provenance info */
  memory_id: MemoryID;

  /** Content of the memory (layer-specific) */
  content: unknown;

  /** Embedding vector for semantic search */
  embedding?: number[];

  /** Provenance tracking */
  provenance: Provenance;

  /** Salience scoring */
  salience: Salience;

  /** Optional tags for filtering */
  tags?: string[];

  /** Metadata (layer-specific) */
  metadata?: Record<string, unknown>;
}

/**
 * Working Memory Item - Active context during a session
 */
export interface WorkingMemoryItem extends BaseMemory {
  memory_id: MemoryID & { layer: 'working' };

  /** The actual content being held in working memory */
  content: {
    /** Type of content */
    type: 'message' | 'tool_result' | 'context' | 'goal';

    /** Raw content */
    data: unknown;

    /** Summary for overflow to episodic */
    summary?: string;
  };

  /** Position in the working memory buffer */
  slot: number;

  /** Whether this has overflowed to episodic */
  overflowed: boolean;
}

/**
 * Episodic Memory - "What happened when"
 */
export interface EpisodicMemory extends BaseMemory {
  memory_id: MemoryID & { layer: 'episodic' };

  content: {
    /** What happened */
    event: string;

    /** Structured event data */
    event_data?: Record<string, unknown>;

    /** Summary of the episode */
    summary: string;

    /** Key entities involved */
    entities: string[];

    /** Emotional valence (-1 to 1) */
    valence?: number;
  };

  /** When the episode started */
  started_at: Date;

  /** When the episode ended */
  ended_at?: Date;

  /** Session this episode belongs to */
  session_id: string;

  /** Whether this has been consolidated to semantic */
  consolidated: boolean;

  /** Facts extracted during consolidation */
  extracted_fact_ids?: MemoryID[];
}

/**
 * Semantic Memory - Facts, entities, relationships
 */
export interface SemanticMemory extends BaseMemory {
  memory_id: MemoryID & { layer: 'semantic' };

  content: {
    /** The fact or knowledge */
    fact: string;

    /** Subject of the fact */
    subject?: string;

    /** Predicate/relationship */
    predicate?: string;

    /** Object of the fact */
    object?: string;

    /** Category for organization */
    category?: string;
  };

  /** Source episodes this was derived from */
  source_episode_ids: MemoryID[];

  /** Related facts (graph edges) */
  related_fact_ids?: MemoryID[];
}

/**
 * Procedural Memory - Skills and workflows
 */
export interface ProceduralMemory extends BaseMemory {
  memory_id: MemoryID & { layer: 'procedural' };

  content: {
    /** Name of the skill/procedure */
    name: string;

    /** Description of what this does */
    description: string;

    /** Steps or implementation */
    steps?: string[];

    /** Executable code if applicable */
    code?: string;

    /** Language of the code */
    language?: string;
  };

  /** Version for tracking updates */
  version: number;

  /** Previous versions */
  previous_versions?: MemoryID[];

  /** Success rate when executed */
  success_rate?: number;

  /** Number of times executed */
  execution_count: number;
}

/**
 * Union type for any memory
 */
export type Memory =
  | WorkingMemoryItem
  | EpisodicMemory
  | SemanticMemory
  | ProceduralMemory;

/**
 * Type guard for WorkingMemoryItem
 */
export function isWorkingMemory(memory: BaseMemory): memory is WorkingMemoryItem {
  return memory.memory_id.layer === 'working';
}

/**
 * Type guard for EpisodicMemory
 */
export function isEpisodicMemory(memory: BaseMemory): memory is EpisodicMemory {
  return memory.memory_id.layer === 'episodic';
}

/**
 * Type guard for SemanticMemory
 */
export function isSemanticMemory(memory: BaseMemory): memory is SemanticMemory {
  return memory.memory_id.layer === 'semantic';
}

/**
 * Type guard for ProceduralMemory
 */
export function isProceduralMemory(memory: BaseMemory): memory is ProceduralMemory {
  return memory.memory_id.layer === 'procedural';
}
