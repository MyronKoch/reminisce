/**
 * Procedural Memory Types
 *
 * Types for storing and managing executable patterns:
 * - Skills: Reusable procedures with steps
 * - Workflows: Complex sequences of operations
 * - Patterns: Decision trees and templates
 */

import type { MemoryID, ProceduralMemory } from '@reminisce/core';

/**
 * Type of executable skill
 */
export type SkillType =
  | 'code_snippet'      // Executable code
  | 'command_sequence'  // CLI commands to run
  | 'decision_tree'     // Conditional branching logic
  | 'checklist'         // Step-by-step checklist
  | 'template'          // Template with variables
  | 'workflow';         // Complex multi-step workflow

/**
 * A single step in a skill execution
 */
export interface SkillStep {
  /** Step number (1-indexed) */
  order: number;

  /** Description of what this step does */
  description: string;

  /** Type of action */
  action_type: 'execute' | 'check' | 'decision' | 'manual';

  /** Executable content (code, command, etc) */
  content?: string;

  /** Language/interpreter if executable */
  language?: string;

  /** Expected outcome or success criteria */
  expected_outcome?: string;

  /** Conditions for executing this step */
  conditions?: {
    /** Variable to check */
    variable: string;
    /** Operator (==, !=, >, <, etc) */
    operator: string;
    /** Value to compare against */
    value: unknown;
  }[];

  /** Next steps based on outcome */
  next_steps?: {
    /** Condition that determines this path */
    condition: 'success' | 'failure' | 'skip' | string;
    /** Step number to jump to */
    goto: number;
  }[];
}

/**
 * Input for creating a new skill
 */
export interface SkillInput {
  /** Name of the skill */
  name: string;

  /** What this skill does */
  description: string;

  /** Type of skill */
  type: SkillType;

  /** Steps to execute (for procedural skills) */
  steps?: SkillStep[];

  /** Executable code (for code_snippet type) */
  code?: string;

  /** Programming language */
  language?: string;

  /** Template variables (for template type) */
  variables?: {
    name: string;
    description: string;
    default_value?: unknown;
  }[];

  /** Tags for categorization */
  tags?: string[];

  /** Source episodes where this was learned/used */
  sourceEpisodeIds: MemoryID[];

  /** Initial confidence (0-1) */
  confidence?: number;

  /** Initial success rate */
  successRate?: number;
}

/**
 * Context for skill execution
 */
export interface SkillExecutionContext {
  /** Variables available during execution */
  variables: Record<string, unknown>;

  /** Whether to execute in dry-run mode */
  dryRun?: boolean;

  /** Callback for logging */
  onLog?: (message: string, level: 'info' | 'warn' | 'error') => void;

  /** Callback for step completion */
  onStepComplete?: (step: number, result: SkillStepResult) => void;
}

/**
 * Result of executing a single step
 */
export interface SkillStepResult {
  /** Step that was executed */
  step: number;

  /** Whether the step succeeded */
  success: boolean;

  /** Output or error message */
  message?: string;

  /** Data returned by the step */
  data?: unknown;

  /** Time taken (milliseconds) */
  duration_ms: number;

  /** Timestamp of execution */
  executed_at: Date;
}

/**
 * Complete result of skill execution
 */
export interface SkillExecutionResult {
  /** Skill that was executed */
  skill_id: MemoryID;

  /** Overall success */
  success: boolean;

  /** Results from each step */
  steps: SkillStepResult[];

  /** Total duration */
  total_duration_ms: number;

  /** Error if failed */
  error?: string;

  /** Timestamp when execution started */
  started_at: Date;

  /** Timestamp when execution completed */
  completed_at: Date;
}

/**
 * Record of a skill execution for tracking refinement
 */
export interface SkillExecution extends SkillExecutionResult {
  /** Episode ID where this execution occurred */
  episode_id?: MemoryID;

  /** Context variables at execution time */
  context?: Record<string, unknown>;
}

/**
 * Skill refinement tracking
 */
export interface SkillRefinement {
  /** Skill being refined */
  skill_id: MemoryID;

  /** Current version number */
  version: number;

  /** Total number of executions */
  execution_count: number;

  /** Number of successful executions */
  success_count: number;

  /** Calculated success rate (0-1) */
  success_rate: number;

  /** Confidence level (increases with successful use) */
  confidence: number;

  /** Recent executions (last N) */
  recent_executions: SkillExecution[];

  /** Last time this skill was executed */
  last_executed_at?: Date;

  /** Last time this skill was updated */
  last_updated_at: Date;

  /** Suggested improvements based on failures */
  suggested_improvements?: string[];
}

/**
 * Query options for skill retrieval
 */
export interface SkillQuery {
  /** Search in skill name/description */
  text?: string;

  /** Filter by skill type */
  type?: SkillType;

  /** Filter by tags */
  tags?: string[];

  /** Filter by language */
  language?: string;

  /** Minimum confidence threshold */
  minConfidence?: number;

  /** Minimum success rate */
  minSuccessRate?: number;

  /** Maximum results */
  limit?: number;

  /** Offset for pagination */
  offset?: number;

  /** Sort by */
  sortBy?: 'confidence' | 'success_rate' | 'execution_count' | 'last_executed' | 'created';

  /** Sort direction */
  sortDirection?: 'asc' | 'desc';
}

/**
 * Skill with its procedural memory and refinement data
 */
export interface Skill {
  /** The procedural memory record */
  memory: ProceduralMemory;

  /** Refinement tracking data */
  refinement: SkillRefinement;
}
