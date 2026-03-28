# @reminisce/procedural

Procedural memory package for the Reminisce (Reminisce). Stores and executes skills, workflows, and executable patterns with automatic refinement through use.

## Features

- **Multiple Skill Types**: Code snippets, command sequences, decision trees, checklists, templates, and workflows
- **Skill Execution**: Run skills with context variables and track results
- **Refinement Tracking**: Confidence and success rate increase/decrease based on execution outcomes
- **Provenance**: Links to source episodes where skills were learned
- **Flexible Querying**: Search and filter skills by type, tags, confidence, success rate
- **Dry Run Mode**: Test skills without actual execution
- **Step-by-Step Execution**: Track individual step results and callbacks

## Installation

```bash
bun install @reminisce/procedural
```

## Usage

### Basic Skill Storage

```typescript
import { InMemorySkillStore } from '@reminisce/procedural';
import { createMemoryID } from '@reminisce/core';

const store = new InMemorySkillStore();

// Store a code snippet skill
const skill = await store.storeSkill({
  name: 'Hello World',
  description: 'Print hello world message',
  type: 'code_snippet',
  code: 'console.log("Hello, World!");',
  language: 'typescript',
  tags: ['tutorial', 'basic'],
  sourceEpisodeIds: [episodeId],
  confidence: 0.9,
});
```

### Workflow with Steps

```typescript
const workflow = await store.storeSkill({
  name: 'Setup TypeScript Project',
  description: 'Initialize a new TypeScript project',
  type: 'workflow',
  steps: [
    {
      order: 1,
      description: 'Initialize project',
      action_type: 'execute',
      content: 'npm init -y',
    },
    {
      order: 2,
      description: 'Install TypeScript',
      action_type: 'execute',
      content: 'npm install typescript --save-dev',
    },
    {
      order: 3,
      description: 'Create config',
      action_type: 'execute',
      content: 'npx tsc --init',
    },
  ],
  tags: ['typescript', 'setup'],
  sourceEpisodeIds: [episodeId],
});
```

### Decision Tree

```typescript
const decisionTree = await store.storeSkill({
  name: 'File Handler',
  description: 'Read or create file based on existence',
  type: 'decision_tree',
  steps: [
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
  ],
  sourceEpisodeIds: [episodeId],
});
```

### Template with Variables

```typescript
const template = await store.storeSkill({
  name: 'Email Template',
  description: 'Generate personalized email',
  type: 'template',
  code: 'Hello {{name}},\n\nWelcome to {{project}}!\n\nBest,\n{{sender}}',
  variables: [
    { name: 'name', description: 'Recipient name' },
    { name: 'project', description: 'Project name' },
    { name: 'sender', description: 'Sender name', default_value: 'The Team' },
  ],
  sourceEpisodeIds: [episodeId],
});
```

### Executing Skills

```typescript
import { SkillExecutor } from '@reminisce/procedural';

const executor = new SkillExecutor({
  timeout: 30000,
  stopOnFailure: true,
});

// Execute in dry run mode (safe, no actual execution)
const result = await executor.execute(skill, {
  variables: { name: 'Alice', project: 'Reminisce' },
  dryRun: true,
  onLog: (msg, level) => console.log(`[${level}] ${msg}`),
  onStepComplete: (step, result) => {
    console.log(`Step ${step} completed: ${result.success}`);
  },
});

console.log(`Success: ${result.success}`);
console.log(`Duration: ${result.total_duration_ms}ms`);
console.log(`Steps: ${result.steps.length}`);
```

### Recording Execution Results

```typescript
// Record the execution to update skill refinement
await store.recordExecution({
  skill_id: skill.memory.memory_id,
  success: result.success,
  steps: result.steps,
  total_duration_ms: result.total_duration_ms,
  started_at: result.started_at,
  completed_at: result.completed_at,
  episode_id: currentEpisodeId,
});

// Check updated refinement data
const refinement = await store.getRefinement(skill.memory.memory_id);
console.log(`Executions: ${refinement.execution_count}`);
console.log(`Success rate: ${refinement.success_rate}`);
console.log(`Confidence: ${refinement.confidence}`);
```

### Querying Skills

```typescript
// Search by text
const results = await store.querySkills({
  text: 'TypeScript',
  minConfidence: 0.7,
  sortBy: 'success_rate',
  sortDirection: 'desc',
  limit: 10,
});

// Filter by type and tags
const workflows = await store.querySkills({
  type: 'workflow',
  tags: ['setup'],
  minSuccessRate: 0.8,
});

// Get top skills
const topSkills = await store.getTopSkills(5, 'confidence');
```

### Validating Skills

```typescript
const validation = await executor.validate(skill);

if (!validation.valid) {
  console.error('Validation errors:', validation.errors);
  console.warn('Warnings:', validation.warnings);
}
```

## Skill Types

### code_snippet
Executable code in any language. Requires `code` and optionally `language` fields.

### command_sequence
Series of CLI commands to execute in order. Each step should have `content` with the command.

### decision_tree
Conditional branching logic. Steps can have `conditions` and `next_steps` for branching.

### checklist
Step-by-step checklist for manual processes. Focuses on validation rather than execution.

### template
Text template with variable substitution using `{{variable}}` syntax.

### workflow
Complex multi-step workflow combining multiple actions.

## Refinement System

Skills automatically track their performance through execution:

- **Confidence**: Increases on success (max 1.0), decreases on failure (min 0.0)
- **Success Rate**: Calculated from execution history
- **Execution Count**: Total times the skill has been run
- **Recent Executions**: Maintains history of last N executions (configurable)

## API Reference

### InMemorySkillStore

- `storeSkill(input: SkillInput): Promise<Skill>`
- `getSkill(skillId: MemoryID): Promise<Skill | null>`
- `querySkills(query: SkillQuery): Promise<Skill[]>`
- `updateSkill(skillId: MemoryID, updates: Partial<SkillInput>): Promise<Skill>`
- `recordExecution(execution: SkillExecution): Promise<void>`
- `getRefinement(skillId: MemoryID): Promise<SkillRefinement | null>`
- `getTopSkills(limit: number, sortBy: 'confidence' | 'success_rate'): Promise<Skill[]>`
- `deleteSkill(skillId: MemoryID): Promise<boolean>`
- `getSkillCount(): Promise<number>`

### SkillExecutor

- `execute(skill: Skill, context: SkillExecutionContext): Promise<SkillExecutionResult>`
- `validate(skill: Skill): Promise<{ valid: boolean; errors: string[]; warnings: string[] }>`

## Testing

```bash
bun test
```

## License

MIT
