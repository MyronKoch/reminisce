/**
 * @reminisce/procedural - Procedural Memory Package
 *
 * Storage and execution for skills, workflows, and executable patterns.
 * Tracks skill refinement and confidence through repeated use.
 *
 * @packageDocumentation
 */

// Types
export type {
  SkillType,
  SkillStep,
  SkillInput,
  SkillExecutionContext,
  SkillStepResult,
  SkillExecutionResult,
  SkillExecution,
  SkillRefinement,
  SkillQuery,
  Skill,
} from './types.js';

// Skill Store
export {
  type SkillStore,
  type SkillStoreConfig,
  InMemorySkillStore,
} from './skill-store.js';

// Skill Executor
export {
  SkillExecutor,
  type SkillExecutorConfig,
} from './skill-executor.js';

// Re-export relevant types from core
export { type ProceduralMemory, type MemoryID } from '@reminisce/core';
