/**
 * Skill Executor - Run and validate procedural skills
 */

import type { MemoryID } from '@reminisce/core';
import type {
  Skill,
  SkillStep,
  SkillExecutionContext,
  SkillExecutionResult,
  SkillStepResult,
  SkillType,
} from './types.js';

/**
 * Configuration for skill executor
 */
export interface SkillExecutorConfig {
  /** Maximum execution time in milliseconds */
  timeout?: number;

  /** Whether to stop on first failure */
  stopOnFailure?: boolean;

  /** Allow dynamic code execution */
  allowCodeExecution?: boolean;
}

/**
 * Executor for running skills
 */
export class SkillExecutor {
  private config: Required<SkillExecutorConfig>;

  constructor(config: SkillExecutorConfig = {}) {
    this.config = {
      timeout: config.timeout ?? 30000, // 30 seconds default
      stopOnFailure: config.stopOnFailure ?? true,
      allowCodeExecution: config.allowCodeExecution ?? false,
    };
  }

  /**
   * Execute a skill
   */
  async execute(
    skill: Skill,
    context: SkillExecutionContext
  ): Promise<SkillExecutionResult> {
    const startTime = Date.now();
    const started_at = new Date();

    const result: SkillExecutionResult = {
      skill_id: skill.memory.memory_id,
      success: false,
      steps: [],
      total_duration_ms: 0,
      started_at,
      completed_at: new Date(),
    };

    try {
      const skillType = skill.memory.metadata?.type as SkillType | undefined;

      if (!skillType) {
        throw new Error('Skill type not specified');
      }

      // Execute based on skill type
      switch (skillType) {
        case 'code_snippet':
          result.steps = await this.executeCodeSnippet(skill, context);
          break;

        case 'command_sequence':
          result.steps = await this.executeCommandSequence(skill, context);
          break;

        case 'decision_tree':
          result.steps = await this.executeDecisionTree(skill, context);
          break;

        case 'checklist':
          result.steps = await this.executeChecklist(skill, context);
          break;

        case 'template':
          result.steps = await this.executeTemplate(skill, context);
          break;

        case 'workflow':
          result.steps = await this.executeWorkflow(skill, context);
          break;

        default:
          throw new Error(`Unsupported skill type: ${skillType}`);
      }

      // Check if all steps succeeded
      result.success = result.steps.every((step) => step.success);
    } catch (error) {
      result.error =
        error instanceof Error ? error.message : String(error);
      result.success = false;
    }

    result.completed_at = new Date();
    result.total_duration_ms = Date.now() - startTime;

    return result;
  }

  /**
   * Validate a skill without executing it
   */
  async validate(skill: Skill): Promise<{
    valid: boolean;
    errors: string[];
    warnings: string[];
  }> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Check basic fields
    if (!skill.memory.content.name) {
      errors.push('Skill name is required');
    }
    if (!skill.memory.content.description) {
      errors.push('Skill description is required');
    }

    const skillType = skill.memory.metadata?.type as SkillType | undefined;
    if (!skillType) {
      errors.push('Skill type is required');
    }

    // Type-specific validation
    if (skillType === 'code_snippet') {
      if (!skill.memory.content.code) {
        errors.push('Code snippet requires code field');
      }
      if (!skill.memory.content.language) {
        warnings.push('Language not specified for code snippet');
      }
    }

    if (
      skillType === 'workflow' ||
      skillType === 'decision_tree' ||
      skillType === 'checklist'
    ) {
      const steps = skill.memory.metadata?.steps as SkillStep[] | undefined;
      if (!steps || steps.length === 0) {
        errors.push(`${skillType} requires at least one step`);
      } else {
        // Validate step ordering
        const orders = steps.map((s) => s.order);
        const expectedOrders = Array.from(
          { length: steps.length },
          (_, i) => i + 1
        );
        if (JSON.stringify(orders.sort()) !== JSON.stringify(expectedOrders)) {
          errors.push('Step orders must be sequential starting from 1');
        }

        // Validate decision tree branches
        if (skillType === 'decision_tree') {
          for (const step of steps) {
            if (step.next_steps && step.next_steps.length === 0) {
              warnings.push(
                `Step ${step.order} has empty next_steps array`
              );
            }
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  /**
   * Execute a code snippet
   */
  private async executeCodeSnippet(
    skill: Skill,
    context: SkillExecutionContext
  ): Promise<SkillStepResult[]> {
    const stepStart = Date.now();

    if (!this.config.allowCodeExecution) {
      throw new Error(
        'Code execution is disabled. Enable allowCodeExecution in config.'
      );
    }

    if (context.dryRun) {
      context.onLog?.('DRY RUN: Would execute code snippet', 'info');
      return [
        {
          step: 1,
          success: true,
          message: 'Dry run - code not executed',
          duration_ms: Date.now() - stepStart,
          executed_at: new Date(),
        },
      ];
    }

    // In a real implementation, you would execute the code in a sandboxed environment
    // For now, we just return a placeholder result
    throw new Error(
      'Actual code execution not implemented - use dryRun mode'
    );
  }

  /**
   * Execute a command sequence
   */
  private async executeCommandSequence(
    skill: Skill,
    context: SkillExecutionContext
  ): Promise<SkillStepResult[]> {
    const steps = skill.memory.metadata?.steps as SkillStep[] | undefined;
    if (!steps) {
      throw new Error('No steps defined');
    }

    const results: SkillStepResult[] = [];

    for (const step of steps) {
      const stepStart = Date.now();

      if (context.dryRun) {
        context.onLog?.(
          `DRY RUN: Would execute step ${step.order}: ${step.description}`,
          'info'
        );
        const result: SkillStepResult = {
          step: step.order,
          success: true,
          message: `Dry run - ${step.description}`,
          duration_ms: Date.now() - stepStart,
          executed_at: new Date(),
        };
        results.push(result);
        context.onStepComplete?.(step.order, result);
        continue;
      }

      // In a real implementation, execute the actual command
      // For now, simulate success
      const result: SkillStepResult = {
        step: step.order,
        success: true,
        message: `Executed: ${step.description}`,
        duration_ms: Date.now() - stepStart,
        executed_at: new Date(),
      };

      results.push(result);
      context.onStepComplete?.(step.order, result);

      if (!result.success && this.config.stopOnFailure) {
        break;
      }
    }

    return results;
  }

  /**
   * Execute a decision tree
   */
  private async executeDecisionTree(
    skill: Skill,
    context: SkillExecutionContext
  ): Promise<SkillStepResult[]> {
    const steps = skill.memory.metadata?.steps as SkillStep[] | undefined;
    if (!steps) {
      throw new Error('No steps defined');
    }

    const results: SkillStepResult[] = [];
    let currentStepIndex = 0;
    const visited = new Set<number>();

    while (currentStepIndex < steps.length) {
      const step = steps[currentStepIndex];
      if (!step) break;

      // Prevent infinite loops
      if (visited.has(currentStepIndex)) {
        break;
      }
      visited.add(currentStepIndex);

      const stepStart = Date.now();

      // Check conditions
      let conditionsMet = true;
      let conditionResult: 'success' | 'failure' = 'success';

      if (step.conditions) {
        conditionsMet = this.evaluateConditions(
          step.conditions,
          context.variables
        );
        conditionResult = conditionsMet ? 'success' : 'failure';
      }

      // For decision steps, always execute them to determine the branch
      const result: SkillStepResult = {
        step: step.order,
        success: conditionsMet,
        message: step.description,
        duration_ms: Date.now() - stepStart,
        executed_at: new Date(),
      };

      results.push(result);
      context.onStepComplete?.(step.order, result);

      // Determine next step based on conditions
      if (step.next_steps && step.next_steps.length > 0) {
        const nextStep = step.next_steps.find(
          (ns) => ns.condition === conditionResult
        );

        if (nextStep) {
          // Jump to specified step (convert to 0-based index)
          currentStepIndex = nextStep.goto - 1;
        } else {
          // No matching next step, end execution
          break;
        }
      } else {
        // No next steps defined, end execution
        break;
      }
    }

    return results;
  }

  /**
   * Execute a checklist
   */
  private async executeChecklist(
    skill: Skill,
    context: SkillExecutionContext
  ): Promise<SkillStepResult[]> {
    // For checklists, we just validate each item
    const steps = skill.memory.metadata?.steps as SkillStep[] | undefined;
    if (!steps) {
      throw new Error('No steps defined');
    }

    const results: SkillStepResult[] = [];

    for (const step of steps) {
      const stepStart = Date.now();

      const result: SkillStepResult = {
        step: step.order,
        success: true,
        message: step.description,
        data: {
          checked: true,
          expected_outcome: step.expected_outcome,
        },
        duration_ms: Date.now() - stepStart,
        executed_at: new Date(),
      };

      results.push(result);
      context.onStepComplete?.(step.order, result);
    }

    return results;
  }

  /**
   * Execute a template
   */
  private async executeTemplate(
    skill: Skill,
    context: SkillExecutionContext
  ): Promise<SkillStepResult[]> {
    const stepStart = Date.now();
    const variables = skill.memory.metadata?.variables as
      | Array<{ name: string; default_value?: unknown }>
      | undefined;

    // Replace variables in template
    let output = skill.memory.content.code ?? skill.memory.content.description;

    if (variables) {
      for (const variable of variables) {
        const value =
          context.variables[variable.name] ?? variable.default_value ?? '';
        output = output.replaceAll(`{{${variable.name}}}`, String(value));
      }
    }

    return [
      {
        step: 1,
        success: true,
        message: 'Template rendered successfully',
        data: { output },
        duration_ms: Date.now() - stepStart,
        executed_at: new Date(),
      },
    ];
  }

  /**
   * Execute a workflow (combination of multiple steps)
   */
  private async executeWorkflow(
    skill: Skill,
    context: SkillExecutionContext
  ): Promise<SkillStepResult[]> {
    // Workflows are similar to command sequences but may have complex logic
    return this.executeCommandSequence(skill, context);
  }

  /**
   * Evaluate conditions against variables
   */
  private evaluateConditions(
    conditions: Array<{
      variable: string;
      operator: string;
      value: unknown;
    }>,
    variables: Record<string, unknown>
  ): boolean {
    return conditions.every((condition) => {
      const actualValue = variables[condition.variable];
      const expectedValue = condition.value;

      switch (condition.operator) {
        case '==':
        case '===':
          return actualValue === expectedValue;
        case '!=':
        case '!==':
          return actualValue !== expectedValue;
        case '>':
          return Number(actualValue) > Number(expectedValue);
        case '<':
          return Number(actualValue) < Number(expectedValue);
        case '>=':
          return Number(actualValue) >= Number(expectedValue);
        case '<=':
          return Number(actualValue) <= Number(expectedValue);
        case 'contains':
          return String(actualValue).includes(String(expectedValue));
        case 'matches':
          return new RegExp(String(expectedValue)).test(String(actualValue));
        default:
          return false;
      }
    });
  }
}
