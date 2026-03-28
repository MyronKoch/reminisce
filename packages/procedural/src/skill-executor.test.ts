/**
 * Tests for Skill Executor
 */

import { describe, expect, test } from 'bun:test';
import { createMemoryID } from '@reminisce/core';
import { InMemorySkillStore } from './skill-store.js';
import { SkillExecutor } from './skill-executor.js';
import type { SkillInput, SkillStep } from './types.js';

describe('SkillExecutor', () => {
  describe('validate', () => {
    test('validates a valid code snippet', async () => {
      const store = new InMemorySkillStore();
      const executor = new SkillExecutor();

      const skill = await store.storeSkill({
        name: 'Hello World',
        description: 'Print hello world',
        type: 'code_snippet',
        code: 'console.log("Hello");',
        language: 'typescript',
        sourceEpisodeIds: [],
      });

      const validation = await executor.validate(skill);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    test('detects missing required fields', async () => {
      const store = new InMemorySkillStore();
      const executor = new SkillExecutor();

      const skill = await store.storeSkill({
        name: '',
        description: '',
        type: 'code_snippet',
        sourceEpisodeIds: [],
      });

      const validation = await executor.validate(skill);
      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
    });

    test('validates workflow with steps', async () => {
      const store = new InMemorySkillStore();
      const executor = new SkillExecutor();

      const steps: SkillStep[] = [
        {
          order: 1,
          description: 'Step 1',
          action_type: 'execute',
        },
        {
          order: 2,
          description: 'Step 2',
          action_type: 'execute',
        },
      ];

      const skill = await store.storeSkill({
        name: 'Workflow',
        description: 'A workflow',
        type: 'workflow',
        steps,
        sourceEpisodeIds: [],
      });

      const validation = await executor.validate(skill);
      expect(validation.valid).toBe(true);
    });

    test('detects missing steps in workflow', async () => {
      const store = new InMemorySkillStore();
      const executor = new SkillExecutor();

      const skill = await store.storeSkill({
        name: 'Workflow',
        description: 'A workflow',
        type: 'workflow',
        sourceEpisodeIds: [],
      });

      const validation = await executor.validate(skill);
      expect(validation.valid).toBe(false);
      expect(validation.errors.some((e) => e.includes('step'))).toBe(true);
    });

    test('detects invalid step ordering', async () => {
      const store = new InMemorySkillStore();
      const executor = new SkillExecutor();

      const steps: SkillStep[] = [
        {
          order: 1,
          description: 'Step 1',
          action_type: 'execute',
        },
        {
          order: 3, // Skip 2
          description: 'Step 3',
          action_type: 'execute',
        },
      ];

      const skill = await store.storeSkill({
        name: 'Workflow',
        description: 'A workflow',
        type: 'workflow',
        steps,
        sourceEpisodeIds: [],
      });

      const validation = await executor.validate(skill);
      expect(validation.valid).toBe(false);
      expect(
        validation.errors.some((e) => e.includes('sequential'))
      ).toBe(true);
    });
  });

  describe('execute', () => {
    test('executes checklist in dry run mode', async () => {
      const store = new InMemorySkillStore();
      const executor = new SkillExecutor();

      const steps: SkillStep[] = [
        {
          order: 1,
          description: 'Check requirements',
          action_type: 'check',
        },
        {
          order: 2,
          description: 'Prepare environment',
          action_type: 'manual',
        },
        {
          order: 3,
          description: 'Run tests',
          action_type: 'execute',
        },
      ];

      const skill = await store.storeSkill({
        name: 'Deployment Checklist',
        description: 'Pre-deployment checklist',
        type: 'checklist',
        steps,
        sourceEpisodeIds: [],
      });

      const result = await executor.execute(skill, {
        variables: {},
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.steps).toHaveLength(3);
      expect(result.steps[0]?.step).toBe(1);
      expect(result.steps[1]?.step).toBe(2);
      expect(result.steps[2]?.step).toBe(3);
      expect(result.total_duration_ms).toBeGreaterThanOrEqual(0);
    });

    test('executes command sequence in dry run mode', async () => {
      const store = new InMemorySkillStore();
      const executor = new SkillExecutor();

      const steps: SkillStep[] = [
        {
          order: 1,
          description: 'Create directory',
          action_type: 'execute',
          content: 'mkdir test',
        },
        {
          order: 2,
          description: 'Change directory',
          action_type: 'execute',
          content: 'cd test',
        },
        {
          order: 3,
          description: 'Create file',
          action_type: 'execute',
          content: 'touch README.md',
        },
      ];

      const skill = await store.storeSkill({
        name: 'Setup Project',
        description: 'Create project structure',
        type: 'command_sequence',
        steps,
        sourceEpisodeIds: [],
      });

      const logs: string[] = [];
      const result = await executor.execute(skill, {
        variables: {},
        dryRun: true,
        onLog: (msg) => logs.push(msg),
      });

      expect(result.success).toBe(true);
      expect(result.steps).toHaveLength(3);
      expect(logs.length).toBeGreaterThan(0);
    });

    test('executes decision tree with conditions', async () => {
      const store = new InMemorySkillStore();
      const executor = new SkillExecutor();

      const steps: SkillStep[] = [
        {
          order: 1,
          description: 'Check environment',
          action_type: 'decision',
          conditions: [
            { variable: 'env', operator: '==', value: 'production' },
          ],
          next_steps: [
            { condition: 'success', goto: 2 },
            { condition: 'failure', goto: 3 },
          ],
        },
        {
          order: 2,
          description: 'Use production config',
          action_type: 'execute',
        },
        {
          order: 3,
          description: 'Use development config',
          action_type: 'execute',
        },
      ];

      const skill = await store.storeSkill({
        name: 'Config Selector',
        description: 'Select config based on environment',
        type: 'decision_tree',
        steps,
        sourceEpisodeIds: [],
      });

      // Test with production environment
      const prodResult = await executor.execute(skill, {
        variables: { env: 'production' },
        dryRun: true,
      });

      expect(prodResult.success).toBe(true);
      expect(prodResult.steps.some((s) => s.step === 2)).toBe(true);
      expect(prodResult.steps.some((s) => s.step === 3)).toBe(false);

      // Test with development environment
      const devResult = await executor.execute(skill, {
        variables: { env: 'development' },
        dryRun: true,
      });

      // Decision tree overall success depends on whether a failure branch was taken
      // In this case, step 1 fails (condition not met), but execution succeeds by following failure branch
      expect(devResult.steps.some((s) => s.step === 2)).toBe(false);
      expect(devResult.steps.some((s) => s.step === 3)).toBe(true);
    });

    test('executes template with variable substitution', async () => {
      const store = new InMemorySkillStore();
      const executor = new SkillExecutor();

      const skill = await store.storeSkill({
        name: 'Greeting Template',
        description: 'Generate personalized greeting',
        type: 'template',
        code: 'Hello {{name}}, welcome to {{project}}!',
        variables: [
          { name: 'name', description: 'User name' },
          { name: 'project', description: 'Project name' },
        ],
        sourceEpisodeIds: [],
      });

      const result = await executor.execute(skill, {
        variables: {
          name: 'Alice',
          project: 'Reminisce',
        },
        dryRun: false,
      });

      expect(result.success).toBe(true);
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]?.data).toEqual({
        output: 'Hello Alice, welcome to Reminisce!',
      });
    });

    test('uses default values for missing template variables', async () => {
      const store = new InMemorySkillStore();
      const executor = new SkillExecutor();

      const skill = await store.storeSkill({
        name: 'Template',
        description: 'Template with defaults',
        type: 'template',
        code: 'Hello {{name}}!',
        variables: [
          { name: 'name', description: 'Name', default_value: 'World' },
        ],
        sourceEpisodeIds: [],
      });

      const result = await executor.execute(skill, {
        variables: {}, // No variables provided
        dryRun: false,
      });

      expect(result.success).toBe(true);
      expect(result.steps[0]?.data).toEqual({
        output: 'Hello World!',
      });
    });

    test('calls callbacks during execution', async () => {
      const store = new InMemorySkillStore();
      const executor = new SkillExecutor();

      const steps: SkillStep[] = [
        { order: 1, description: 'Step 1', action_type: 'execute' },
        { order: 2, description: 'Step 2', action_type: 'execute' },
      ];

      const skill = await store.storeSkill({
        name: 'Test',
        description: 'Test callbacks',
        type: 'workflow',
        steps,
        sourceEpisodeIds: [],
      });

      const completedSteps: number[] = [];
      const logs: string[] = [];

      await executor.execute(skill, {
        variables: {},
        dryRun: true,
        onStepComplete: (step) => completedSteps.push(step),
        onLog: (msg) => logs.push(msg),
      });

      expect(completedSteps).toEqual([1, 2]);
      expect(logs.length).toBeGreaterThan(0);
    });

    test('prevents code execution without allowCodeExecution flag', async () => {
      const store = new InMemorySkillStore();
      const executor = new SkillExecutor({ allowCodeExecution: false });

      const skill = await store.storeSkill({
        name: 'Code',
        description: 'Execute code',
        type: 'code_snippet',
        code: 'console.log("test")',
        sourceEpisodeIds: [],
      });

      const result = await executor.execute(skill, {
        variables: {},
        dryRun: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/disabled/i);
    });

    test('handles unsupported skill type', async () => {
      const store = new InMemorySkillStore();
      const executor = new SkillExecutor();

      const skill = await store.storeSkill({
        name: 'Test',
        description: 'Test',
        type: 'code_snippet', // Will be changed
        sourceEpisodeIds: [],
      });

      // Manually change type to something unsupported
      if (skill.memory.metadata) {
        skill.memory.metadata.type = 'invalid_type' as any;
      }

      const result = await executor.execute(skill, {
        variables: {},
        dryRun: true,
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
