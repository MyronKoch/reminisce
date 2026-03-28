/**
 * Tests for Skill Store
 */

import { describe, expect, test, beforeEach } from 'bun:test';
import { createMemoryID } from '@reminisce/core';
import { InMemorySkillStore } from './skill-store.js';
import type {
  SkillInput,
  SkillExecution,
  SkillStepResult,
  SkillStep,
} from './types.js';

describe('InMemorySkillStore', () => {
  let store: InMemorySkillStore;

  beforeEach(() => {
    store = new InMemorySkillStore();
  });

  describe('storeSkill', () => {
    test('stores a basic code snippet skill', async () => {
      const input: SkillInput = {
        name: 'Hello World',
        description: 'Print hello world',
        type: 'code_snippet',
        code: 'console.log("Hello, World!");',
        language: 'typescript',
        tags: ['tutorial', 'basic'],
        sourceEpisodeIds: [createMemoryID('episodic')],
        confidence: 0.9,
      };

      const skill = await store.storeSkill(input);

      expect(skill.memory.memory_id.layer).toBe('procedural');
      expect(skill.memory.content.name).toBe('Hello World');
      expect(skill.memory.content.code).toBe('console.log("Hello, World!");');
      expect(skill.memory.content.language).toBe('typescript');
      expect(skill.memory.tags).toEqual(['tutorial', 'basic']);
      expect(skill.refinement.confidence).toBe(0.9);
      expect(skill.refinement.execution_count).toBe(0);
      expect(skill.refinement.success_rate).toBe(0);
    });

    test('stores a workflow with steps', async () => {
      const steps: SkillStep[] = [
        {
          order: 1,
          description: 'Initialize project',
          action_type: 'execute',
          content: 'npm init -y',
        },
        {
          order: 2,
          description: 'Install dependencies',
          action_type: 'execute',
          content: 'npm install typescript',
        },
        {
          order: 3,
          description: 'Create config',
          action_type: 'execute',
          content: 'npx tsc --init',
        },
      ];

      const input: SkillInput = {
        name: 'Setup TypeScript Project',
        description: 'Initialize a new TypeScript project',
        type: 'workflow',
        steps,
        tags: ['typescript', 'setup'],
        sourceEpisodeIds: [createMemoryID('episodic')],
      };

      const skill = await store.storeSkill(input);

      expect(skill.memory.content.steps).toHaveLength(3);
      expect(skill.memory.metadata?.steps).toEqual(steps);
      expect(skill.memory.metadata?.type).toBe('workflow');
    });

    test('stores a decision tree', async () => {
      const steps: SkillStep[] = [
        {
          order: 1,
          description: 'Check if file exists',
          action_type: 'check',
          conditions: [
            { variable: 'file_exists', operator: '==', value: true },
          ],
          next_steps: [
            { condition: 'success', goto: 2 },
            { condition: 'failure', goto: 3 },
          ],
        },
        {
          order: 2,
          description: 'Read existing file',
          action_type: 'execute',
        },
        {
          order: 3,
          description: 'Create new file',
          action_type: 'execute',
        },
      ];

      const input: SkillInput = {
        name: 'File Handler',
        description: 'Read or create file based on existence',
        type: 'decision_tree',
        steps,
        sourceEpisodeIds: [createMemoryID('episodic')],
      };

      const skill = await store.storeSkill(input);

      expect(skill.memory.metadata?.type).toBe('decision_tree');
      const storedSteps = skill.memory.metadata?.steps as SkillStep[];
      expect(storedSteps[0]?.next_steps).toHaveLength(2);
    });
  });

  describe('getSkill', () => {
    test('retrieves an existing skill', async () => {
      const input: SkillInput = {
        name: 'Test Skill',
        description: 'A test skill',
        type: 'checklist',
        sourceEpisodeIds: [],
      };

      const stored = await store.storeSkill(input);
      const retrieved = await store.getSkill(stored.memory.memory_id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.memory.content.name).toBe('Test Skill');
    });

    test('returns null for non-existent skill', async () => {
      const fakeId = createMemoryID('procedural');
      const result = await store.getSkill(fakeId);

      expect(result).toBeNull();
    });

    test('reinforces salience on retrieval', async () => {
      const input: SkillInput = {
        name: 'Test',
        description: 'Test',
        type: 'checklist',
        sourceEpisodeIds: [],
      };

      const stored = await store.storeSkill(input);
      const initialSalience = stored.memory.salience.current_score;

      await store.getSkill(stored.memory.memory_id);
      const retrieved = await store.getSkill(stored.memory.memory_id);

      // Salience should have increased due to retrieval reinforcement
      expect(retrieved?.memory.salience.current_score).toBeGreaterThan(
        initialSalience
      );
    });
  });

  describe('querySkills', () => {
    beforeEach(async () => {
      // Populate with test skills
      await store.storeSkill({
        name: 'TypeScript Setup',
        description: 'Setup TypeScript project',
        type: 'workflow',
        language: 'typescript',
        tags: ['typescript', 'setup'],
        sourceEpisodeIds: [],
        confidence: 0.9,
      });

      await store.storeSkill({
        name: 'Python Setup',
        description: 'Setup Python project',
        type: 'workflow',
        language: 'python',
        tags: ['python', 'setup'],
        sourceEpisodeIds: [],
        confidence: 0.8,
      });

      await store.storeSkill({
        name: 'Hello World TS',
        description: 'Print hello in TypeScript',
        type: 'code_snippet',
        language: 'typescript',
        tags: ['tutorial'],
        sourceEpisodeIds: [],
        confidence: 0.95,
      });
    });

    test('filters by text search', async () => {
      const results = await store.querySkills({ text: 'TypeScript' });
      expect(results).toHaveLength(2);
      expect(results.every((s) => s.memory.content.name.includes('TS') || s.memory.content.name.includes('TypeScript'))).toBe(true);
    });

    test('filters by type', async () => {
      const results = await store.querySkills({ type: 'workflow' });
      expect(results).toHaveLength(2);
      expect(results.every((s) => s.memory.metadata?.type === 'workflow')).toBe(true);
    });

    test('filters by language', async () => {
      const results = await store.querySkills({ language: 'typescript' });
      expect(results).toHaveLength(2);
    });

    test('filters by tags', async () => {
      const results = await store.querySkills({ tags: ['setup'] });
      expect(results).toHaveLength(2);
    });

    test('filters by minimum confidence', async () => {
      const results = await store.querySkills({ minConfidence: 0.85 });
      expect(results).toHaveLength(2);
      expect(results.every((s) => s.refinement.confidence >= 0.85)).toBe(true);
    });

    test('sorts by confidence descending', async () => {
      const results = await store.querySkills({
        sortBy: 'confidence',
        sortDirection: 'desc',
      });
      expect(results[0]?.refinement.confidence).toBe(0.95);
      expect(results[1]?.refinement.confidence).toBe(0.9);
      expect(results[2]?.refinement.confidence).toBe(0.8);
    });

    test('applies pagination', async () => {
      const page1 = await store.querySkills({ limit: 2, offset: 0 });
      const page2 = await store.querySkills({ limit: 2, offset: 2 });

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(1);
      expect(page1[0]?.memory.memory_id).not.toBe(page2[0]?.memory.memory_id);
    });
  });

  describe('updateSkill', () => {
    test('updates skill content', async () => {
      const input: SkillInput = {
        name: 'Original Name',
        description: 'Original description',
        type: 'checklist',
        sourceEpisodeIds: [],
      };

      const skill = await store.storeSkill(input);
      const initialVersion = skill.memory.version;

      const updated = await store.updateSkill(skill.memory.memory_id, {
        name: 'Updated Name',
        description: 'Updated description',
      });

      expect(updated.memory.content.name).toBe('Updated Name');
      expect(updated.memory.content.description).toBe('Updated description');
      expect(updated.memory.version).toBe(initialVersion + 1);
      expect(updated.refinement.version).toBe(initialVersion + 1);
    });

    test('throws error for non-existent skill', async () => {
      const fakeId = createMemoryID('procedural');

      await expect(
        store.updateSkill(fakeId, { name: 'New Name' })
      ).rejects.toThrow();
    });
  });

  describe('recordExecution', () => {
    test('updates execution counts and success rate', async () => {
      const skill = await store.storeSkill({
        name: 'Test',
        description: 'Test',
        type: 'checklist',
        sourceEpisodeIds: [],
      });

      const execution: SkillExecution = {
        skill_id: skill.memory.memory_id,
        success: true,
        steps: [
          {
            step: 1,
            success: true,
            message: 'Done',
            duration_ms: 100,
            executed_at: new Date(),
          },
        ],
        total_duration_ms: 100,
        started_at: new Date(),
        completed_at: new Date(),
      };

      await store.recordExecution(execution);

      const updated = await store.getSkill(skill.memory.memory_id);
      expect(updated?.refinement.execution_count).toBe(1);
      expect(updated?.refinement.success_count).toBe(1);
      expect(updated?.refinement.success_rate).toBe(1.0);
    });

    test('increases confidence on success', async () => {
      const skill = await store.storeSkill({
        name: 'Test',
        description: 'Test',
        type: 'checklist',
        sourceEpisodeIds: [],
        confidence: 0.5,
      });

      const initialConfidence = skill.refinement.confidence;

      await store.recordExecution({
        skill_id: skill.memory.memory_id,
        success: true,
        steps: [],
        total_duration_ms: 100,
        started_at: new Date(),
        completed_at: new Date(),
      });

      const updated = await store.getSkill(skill.memory.memory_id);
      expect(updated?.refinement.confidence).toBeGreaterThan(
        initialConfidence
      );
    });

    test('decreases confidence on failure', async () => {
      const skill = await store.storeSkill({
        name: 'Test',
        description: 'Test',
        type: 'checklist',
        sourceEpisodeIds: [],
        confidence: 0.8,
      });

      const initialConfidence = skill.refinement.confidence;

      await store.recordExecution({
        skill_id: skill.memory.memory_id,
        success: false,
        steps: [],
        total_duration_ms: 100,
        started_at: new Date(),
        completed_at: new Date(),
        error: 'Something failed',
      });

      const updated = await store.getSkill(skill.memory.memory_id);
      expect(updated?.refinement.confidence).toBeLessThan(initialConfidence);
    });

    test('maintains recent executions list', async () => {
      const skill = await store.storeSkill({
        name: 'Test',
        description: 'Test',
        type: 'checklist',
        sourceEpisodeIds: [],
      });

      // Record multiple executions
      for (let i = 0; i < 5; i++) {
        await store.recordExecution({
          skill_id: skill.memory.memory_id,
          success: i % 2 === 0, // Alternate success/failure
          steps: [],
          total_duration_ms: 100,
          started_at: new Date(),
          completed_at: new Date(),
        });
      }

      const updated = await store.getSkill(skill.memory.memory_id);
      expect(updated?.refinement.recent_executions).toHaveLength(5);
      expect(updated?.refinement.execution_count).toBe(5);
      expect(updated?.refinement.success_rate).toBe(0.6); // 3 successes out of 5
    });

    test('limits recent executions to maxRecentExecutions', async () => {
      const storeWithLimit = new InMemorySkillStore({
        maxRecentExecutions: 3,
      });

      const skill = await storeWithLimit.storeSkill({
        name: 'Test',
        description: 'Test',
        type: 'checklist',
        sourceEpisodeIds: [],
      });

      // Record 5 executions
      for (let i = 0; i < 5; i++) {
        await storeWithLimit.recordExecution({
          skill_id: skill.memory.memory_id,
          success: true,
          steps: [],
          total_duration_ms: 100,
          started_at: new Date(),
          completed_at: new Date(),
        });
      }

      const updated = await storeWithLimit.getSkill(skill.memory.memory_id);
      expect(updated?.refinement.recent_executions).toHaveLength(3);
    });
  });

  describe('getTopSkills', () => {
    test('returns top skills by confidence', async () => {
      await store.storeSkill({
        name: 'Skill 1',
        description: 'Test',
        type: 'checklist',
        sourceEpisodeIds: [],
        confidence: 0.9,
      });

      await store.storeSkill({
        name: 'Skill 2',
        description: 'Test',
        type: 'checklist',
        sourceEpisodeIds: [],
        confidence: 0.7,
      });

      await store.storeSkill({
        name: 'Skill 3',
        description: 'Test',
        type: 'checklist',
        sourceEpisodeIds: [],
        confidence: 0.95,
      });

      const top2 = await store.getTopSkills(2, 'confidence');
      expect(top2).toHaveLength(2);
      expect(top2[0]?.memory.content.name).toBe('Skill 3');
      expect(top2[1]?.memory.content.name).toBe('Skill 1');
    });
  });

  describe('deleteSkill', () => {
    test('deletes an existing skill', async () => {
      const skill = await store.storeSkill({
        name: 'To Delete',
        description: 'Test',
        type: 'checklist',
        sourceEpisodeIds: [],
      });

      const deleted = await store.deleteSkill(skill.memory.memory_id);
      expect(deleted).toBe(true);

      const retrieved = await store.getSkill(skill.memory.memory_id);
      expect(retrieved).toBeNull();
    });

    test('returns false for non-existent skill', async () => {
      const fakeId = createMemoryID('procedural');
      const deleted = await store.deleteSkill(fakeId);
      expect(deleted).toBe(false);
    });
  });

  describe('getSkillCount', () => {
    test('returns correct skill count', async () => {
      expect(await store.getSkillCount()).toBe(0);

      await store.storeSkill({
        name: 'Skill 1',
        description: 'Test',
        type: 'checklist',
        sourceEpisodeIds: [],
      });

      expect(await store.getSkillCount()).toBe(1);

      await store.storeSkill({
        name: 'Skill 2',
        description: 'Test',
        type: 'checklist',
        sourceEpisodeIds: [],
      });

      expect(await store.getSkillCount()).toBe(2);
    });
  });
});
