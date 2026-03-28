/**
 * Basic usage examples for @reminisce/procedural
 */

import {
  InMemorySkillStore,
  SkillExecutor,
  type SkillInput,
  type SkillStep,
} from '../src/index.js';
import { createMemoryID } from '@reminisce/core';

async function main() {
  // Initialize store and executor
  const store = new InMemorySkillStore();
  const executor = new SkillExecutor({
    timeout: 30000,
    stopOnFailure: true,
    allowCodeExecution: false, // Keep code execution disabled for safety
  });

  console.log('=== @reminisce/procedural Examples ===\n');

  // Example 1: Code Snippet Skill
  console.log('1. Code Snippet Skill');
  const codeSkill = await store.storeSkill({
    name: 'Hello World',
    description: 'Print a greeting message',
    type: 'code_snippet',
    code: 'console.log("Hello, World!");',
    language: 'typescript',
    tags: ['tutorial', 'basic'],
    sourceEpisodeIds: [createMemoryID('episodic', 'session-1', 'user-agent')],
    confidence: 0.9,
  });
  console.log(`  Created skill: ${codeSkill.memory.content.name}`);
  console.log(`  Confidence: ${codeSkill.refinement.confidence}\n`);

  // Example 2: Workflow with Steps
  console.log('2. Workflow Skill');
  const workflowSteps: SkillStep[] = [
    {
      order: 1,
      description: 'Initialize TypeScript project',
      action_type: 'execute',
      content: 'npm init -y',
    },
    {
      order: 2,
      description: 'Install TypeScript',
      action_type: 'execute',
      content: 'npm install --save-dev typescript',
    },
    {
      order: 3,
      description: 'Create tsconfig.json',
      action_type: 'execute',
      content: 'npx tsc --init',
    },
  ];

  const workflowSkill = await store.storeSkill({
    name: 'Setup TypeScript Project',
    description: 'Initialize a new TypeScript project with npm',
    type: 'workflow',
    steps: workflowSteps,
    tags: ['typescript', 'setup', 'npm'],
    sourceEpisodeIds: [createMemoryID('episodic', 'session-1', 'user-agent')],
  });
  console.log(`  Created workflow: ${workflowSkill.memory.content.name}`);
  console.log(`  Steps: ${workflowSteps.length}\n`);

  // Example 3: Decision Tree
  console.log('3. Decision Tree Skill');
  const decisionSteps: SkillStep[] = [
    {
      order: 1,
      description: 'Check if running in production',
      action_type: 'decision',
      conditions: [{ variable: 'env', operator: '==', value: 'production' }],
      next_steps: [
        { condition: 'success', goto: 2 },
        { condition: 'failure', goto: 3 },
      ],
    },
    {
      order: 2,
      description: 'Use production configuration',
      action_type: 'execute',
      content: 'cp config.prod.json config.json',
    },
    {
      order: 3,
      description: 'Use development configuration',
      action_type: 'execute',
      content: 'cp config.dev.json config.json',
    },
  ];

  const decisionSkill = await store.storeSkill({
    name: 'Environment Config Selector',
    description: 'Select appropriate config based on environment',
    type: 'decision_tree',
    steps: decisionSteps,
    tags: ['config', 'environment'],
    sourceEpisodeIds: [createMemoryID('episodic', 'session-1', 'user-agent')],
  });
  console.log(`  Created decision tree: ${decisionSkill.memory.content.name}\n`);

  // Example 4: Template Skill
  console.log('4. Template Skill');
  const templateSkill = await store.storeSkill({
    name: 'README Generator',
    description: 'Generate a README file from template',
    type: 'template',
    code: `# {{projectName}}

{{description}}

## Installation

\`\`\`bash
npm install {{packageName}}
\`\`\`

## Author

{{author}}`,
    variables: [
      { name: 'projectName', description: 'Project name' },
      { name: 'description', description: 'Project description' },
      { name: 'packageName', description: 'NPM package name' },
      { name: 'author', description: 'Author name', default_value: 'Anonymous' },
    ],
    tags: ['template', 'documentation'],
    sourceEpisodeIds: [createMemoryID('episodic', 'session-1', 'user-agent')],
  });
  console.log(`  Created template: ${templateSkill.memory.content.name}\n`);

  // Example 5: Execute a skill (dry run)
  console.log('5. Executing Skills (Dry Run)');
  const workflowResult = await executor.execute(workflowSkill, {
    variables: {},
    dryRun: true,
    onLog: (msg, level) => console.log(`  [${level}] ${msg}`),
  });
  console.log(`  Workflow executed: ${workflowResult.success}`);
  console.log(`  Steps completed: ${workflowResult.steps.length}`);
  console.log(`  Duration: ${workflowResult.total_duration_ms}ms\n`);

  // Example 6: Execute template
  console.log('6. Executing Template');
  const templateResult = await executor.execute(templateSkill, {
    variables: {
      projectName: 'My Awesome Project',
      description: 'A really cool project',
      packageName: '@myorg/awesome',
      author: 'Jane Developer',
    },
    dryRun: false,
  });
  console.log(`  Template rendered: ${templateResult.success}`);
  if (templateResult.steps[0]?.data) {
    console.log(`  Output:\n${templateResult.steps[0].data.output}\n`);
  }

  // Example 7: Record execution and track refinement
  console.log('7. Recording Execution & Refinement');
  await store.recordExecution({
    skill_id: workflowSkill.memory.memory_id,
    success: workflowResult.success,
    steps: workflowResult.steps,
    total_duration_ms: workflowResult.total_duration_ms,
    started_at: workflowResult.started_at,
    completed_at: workflowResult.completed_at,
  });

  const refinement = await store.getRefinement(
    workflowSkill.memory.memory_id
  );
  console.log(`  Execution count: ${refinement?.execution_count}`);
  console.log(`  Success rate: ${refinement?.success_rate}`);
  console.log(`  Confidence: ${refinement?.confidence}\n`);

  // Example 8: Query skills
  console.log('8. Querying Skills');
  const typescriptSkills = await store.querySkills({
    tags: ['typescript'],
    minConfidence: 0.5,
    sortBy: 'confidence',
    sortDirection: 'desc',
  });
  console.log(`  Found ${typescriptSkills.length} TypeScript skills`);
  for (const skill of typescriptSkills) {
    console.log(
      `    - ${skill.memory.content.name} (confidence: ${skill.refinement.confidence})`
    );
  }
  console.log();

  // Example 9: Get top skills
  console.log('9. Top Skills by Confidence');
  const topSkills = await store.getTopSkills(3, 'confidence');
  for (const skill of topSkills) {
    console.log(
      `  ${skill.memory.content.name}: ${skill.refinement.confidence.toFixed(2)}`
    );
  }
  console.log();

  // Example 10: Validate a skill
  console.log('10. Skill Validation');
  const validation = await executor.validate(decisionSkill);
  console.log(`  Valid: ${validation.valid}`);
  if (validation.errors.length > 0) {
    console.log(`  Errors: ${validation.errors.join(', ')}`);
  }
  if (validation.warnings.length > 0) {
    console.log(`  Warnings: ${validation.warnings.join(', ')}`);
  }

  console.log('\n=== All examples completed ===');
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
