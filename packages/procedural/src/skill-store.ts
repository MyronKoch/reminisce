/**
 * Skill Store - Storage and retrieval for procedural memories
 */

import type {
  MemoryID,
  ProceduralMemory,
  SalienceSignals,
  Provenance,
} from '@reminisce/core';
import {
  createMemoryID,
  createProvenance,
  createSalience,
  createSalienceSignals,
  reinforceOnRetrieval,
} from '@reminisce/core';

import type {
  SkillInput,
  Skill,
  SkillQuery,
  SkillRefinement,
  SkillExecution,
} from './types.js';

/**
 * Configuration for skill store
 */
export interface SkillStoreConfig {
  /** Maximum number of recent executions to track */
  maxRecentExecutions?: number;

  /** Decay rate for confidence over time */
  confidenceDecayRate?: number;
}

/**
 * Interface for skill storage
 */
export interface SkillStore {
  /**
   * Store a new skill
   */
  storeSkill(input: SkillInput): Promise<Skill>;

  /**
   * Retrieve a skill by ID
   */
  getSkill(skillId: MemoryID): Promise<Skill | null>;

  /**
   * Query skills
   */
  querySkills(query: SkillQuery): Promise<Skill[]>;

  /**
   * Update an existing skill
   */
  updateSkill(
    skillId: MemoryID,
    updates: Partial<SkillInput>
  ): Promise<Skill>;

  /**
   * Record a skill execution
   */
  recordExecution(execution: SkillExecution): Promise<void>;

  /**
   * Get refinement data for a skill
   */
  getRefinement(skillId: MemoryID): Promise<SkillRefinement | null>;

  /**
   * Get all skills sorted by confidence or success rate
   */
  getTopSkills(
    limit: number,
    sortBy: 'confidence' | 'success_rate'
  ): Promise<Skill[]>;

  /**
   * Delete a skill
   */
  deleteSkill(skillId: MemoryID): Promise<boolean>;

  /**
   * Get total skill count
   */
  getSkillCount(): Promise<number>;
}

/**
 * In-memory implementation of SkillStore
 */
export class InMemorySkillStore implements SkillStore {
  private skills: Map<string, Skill> = new Map();
  private config: Required<SkillStoreConfig>;

  constructor(config: SkillStoreConfig = {}) {
    this.config = {
      maxRecentExecutions: config.maxRecentExecutions ?? 10,
      confidenceDecayRate: config.confidenceDecayRate ?? 0.01,
    };
  }

  async storeSkill(input: SkillInput): Promise<Skill> {
    const memoryId = createMemoryID('procedural', 'default-session', 'default-machine');

    // Create provenance
    const provenance: Provenance = createProvenance(
      input.sourceEpisodeIds,
      'user_declared',
      input.confidence ?? 0.7
    );

    // Create salience signals
    const signals: SalienceSignals = createSalienceSignals();

    // Create procedural memory
    const memory: ProceduralMemory = {
      memory_id: memoryId as MemoryID & { layer: 'procedural' },
      content: {
        name: input.name,
        description: input.description,
        ...(input.steps && { steps: input.steps.map((s) => s.description) }),
        ...(input.code && { code: input.code }),
        ...(input.language && { language: input.language }),
      },
      provenance,
      salience: createSalience(signals),
      ...(input.tags && { tags: input.tags }),
      version: 1,
      execution_count: 0,
      ...(input.successRate !== undefined && { success_rate: input.successRate }),
      metadata: {
        type: input.type,
        steps: input.steps,
        variables: input.variables,
      },
    };

    // Create refinement tracking
    const refinement: SkillRefinement = {
      skill_id: memoryId,
      version: 1,
      execution_count: 0,
      success_count: 0,
      success_rate: input.successRate ?? 0,
      confidence: input.confidence ?? 0.7,
      recent_executions: [],
      last_updated_at: new Date(),
    };

    const skill: Skill = {
      memory,
      refinement,
    };

    this.skills.set(memoryId.id, skill);
    return skill;
  }

  async getSkill(skillId: MemoryID): Promise<Skill | null> {
    const skill = this.skills.get(skillId.id);
    if (!skill) return null;

    // Reinforce on retrieval
    skill.memory.salience = reinforceOnRetrieval(skill.memory.salience);

    return skill;
  }

  async querySkills(query: SkillQuery): Promise<Skill[]> {
    let results = Array.from(this.skills.values());

    // Text search
    if (query.text) {
      const searchText = query.text.toLowerCase();
      results = results.filter(
        (skill) =>
          skill.memory.content.name.toLowerCase().includes(searchText) ||
          skill.memory.content.description.toLowerCase().includes(searchText)
      );
    }

    // Filter by type
    if (query.type) {
      results = results.filter(
        (skill) => skill.memory.metadata?.type === query.type
      );
    }

    // Filter by tags
    if (query.tags && query.tags.length > 0) {
      results = results.filter((skill) =>
        query.tags?.some((tag) => skill.memory.tags?.includes(tag))
      );
    }

    // Filter by language
    if (query.language) {
      results = results.filter(
        (skill) => skill.memory.content.language === query.language
      );
    }

    // Filter by confidence
    if (query.minConfidence !== undefined) {
      results = results.filter(
        (skill) => skill.refinement.confidence >= query.minConfidence!
      );
    }

    // Filter by success rate
    if (query.minSuccessRate !== undefined) {
      results = results.filter(
        (skill) => skill.refinement.success_rate >= query.minSuccessRate!
      );
    }

    // Sort
    const sortBy = query.sortBy ?? 'confidence';
    const sortDirection = query.sortDirection ?? 'desc';

    results.sort((a, b) => {
      let aValue: number;
      let bValue: number;

      switch (sortBy) {
        case 'confidence':
          aValue = a.refinement.confidence;
          bValue = b.refinement.confidence;
          break;
        case 'success_rate':
          aValue = a.refinement.success_rate;
          bValue = b.refinement.success_rate;
          break;
        case 'execution_count':
          aValue = a.refinement.execution_count;
          bValue = b.refinement.execution_count;
          break;
        case 'last_executed':
          aValue = a.refinement.last_executed_at?.getTime() ?? 0;
          bValue = b.refinement.last_executed_at?.getTime() ?? 0;
          break;
        case 'created':
          aValue = a.memory.memory_id.created_at.getTime();
          bValue = b.memory.memory_id.created_at.getTime();
          break;
        default:
          aValue = a.refinement.confidence;
          bValue = b.refinement.confidence;
      }

      return sortDirection === 'desc' ? bValue - aValue : aValue - bValue;
    });

    // Pagination
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 100;
    return results.slice(offset, offset + limit);
  }

  async updateSkill(
    skillId: MemoryID,
    updates: Partial<SkillInput>
  ): Promise<Skill> {
    const skill = await this.getSkill(skillId);
    if (!skill) {
      throw new Error(`Skill ${skillId.id} not found`);
    }

    // Increment version
    skill.memory.version += 1;
    skill.refinement.version += 1;

    // Update content
    if (updates.name !== undefined) {
      skill.memory.content.name = updates.name;
    }
    if (updates.description !== undefined) {
      skill.memory.content.description = updates.description;
    }
    if (updates.steps !== undefined) {
      skill.memory.content.steps = updates.steps.map((s) => s.description);
      if (skill.memory.metadata) {
        skill.memory.metadata.steps = updates.steps;
      }
    }
    if (updates.code !== undefined) {
      skill.memory.content.code = updates.code;
    }
    if (updates.language !== undefined) {
      skill.memory.content.language = updates.language;
    }
    if (updates.tags !== undefined) {
      skill.memory.tags = updates.tags;
    }
    if (updates.type !== undefined && skill.memory.metadata) {
      skill.memory.metadata.type = updates.type;
    }

    // Update refinement timestamp
    skill.refinement.last_updated_at = new Date();

    return skill;
  }

  async recordExecution(execution: SkillExecution): Promise<void> {
    const skill = await this.getSkill(execution.skill_id);
    if (!skill) {
      throw new Error(`Skill ${execution.skill_id.id} not found`);
    }

    // Update execution counts
    skill.refinement.execution_count += 1;
    skill.memory.execution_count += 1;

    if (execution.success) {
      skill.refinement.success_count += 1;
    }

    // Recalculate success rate
    skill.refinement.success_rate =
      skill.refinement.success_count / skill.refinement.execution_count;
    skill.memory.success_rate = skill.refinement.success_rate;

    // Update confidence based on success
    if (execution.success) {
      // Increase confidence on success (up to 1.0)
      skill.refinement.confidence = Math.min(
        1.0,
        skill.refinement.confidence + 0.05
      );
    } else {
      // Decrease confidence on failure (down to 0.0)
      skill.refinement.confidence = Math.max(
        0.0,
        skill.refinement.confidence - 0.1
      );
    }

    // Update last executed timestamp
    skill.refinement.last_executed_at = execution.completed_at;

    // Add to recent executions (keep only last N)
    skill.refinement.recent_executions.unshift(execution);
    if (
      skill.refinement.recent_executions.length >
      this.config.maxRecentExecutions
    ) {
      skill.refinement.recent_executions =
        skill.refinement.recent_executions.slice(
          0,
          this.config.maxRecentExecutions
        );
    }

    // Update salience - increment access count
    const updatedSignals: SalienceSignals = {
      ...skill.memory.salience.signals,
      access_count: skill.memory.salience.signals.access_count + 1,
      last_accessed: new Date(),
    };
    skill.memory.salience = createSalience(updatedSignals);
  }

  async getRefinement(skillId: MemoryID): Promise<SkillRefinement | null> {
    const skill = await this.getSkill(skillId);
    return skill?.refinement ?? null;
  }

  async getTopSkills(
    limit: number,
    sortBy: 'confidence' | 'success_rate'
  ): Promise<Skill[]> {
    return this.querySkills({
      sortBy,
      sortDirection: 'desc',
      limit,
    });
  }

  async deleteSkill(skillId: MemoryID): Promise<boolean> {
    return this.skills.delete(skillId.id);
  }

  async getSkillCount(): Promise<number> {
    return this.skills.size;
  }

  /**
   * Get all skills (for testing/debugging)
   */
  getAllSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  /**
   * Clear all skills (for testing)
   */
  clear(): void {
    this.skills.clear();
  }
}
