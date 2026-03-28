/**
 * Tests for the ReDoS fix in skill-executor.ts
 *
 * The executeTemplate method previously used `new RegExp(...)` to substitute
 * template variables, which was vulnerable to Regular Expression Denial of
 * Service (ReDoS) when variable names contained regex metacharacters. The fix
 * replaced it with `String.prototype.replaceAll`, which treats the search
 * string as a literal — no regex involved.
 *
 * These tests verify:
 *  1. Basic template variable substitution correctness
 *  2. Safety with regex-special variable names
 *  3. End-to-end template execution via SkillExecutor
 *  4. Performance — malicious variable names don't cause hangs
 */

import { describe, it, expect } from 'bun:test';
import { SkillExecutor } from './skill-executor.js';
import type { Skill, SkillExecutionContext } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal mock Skill of type 'template' with the given code and
 * variable definitions. Uses `as any` liberally to avoid needing the full
 * ProceduralMemory / SkillRefinement shapes.
 */
function makeTemplateSkill(
  code: string,
  variables: Array<{ name: string; default_value?: unknown }>
): Skill {
  return {
    memory: {
      memory_id: { id: 'test-skill-001', layer: 'procedural' } as any,
      content: {
        name: 'Test Template Skill',
        description: 'A template used in ReDoS-fix tests',
        code,
      },
      provenance: {} as any,
      salience: {} as any,
      metadata: {
        type: 'template',
        variables,
      },
      version: 1,
      execution_count: 0,
    } as any,
    refinement: {
      skill_id: { id: 'test-skill-001', layer: 'procedural' } as any,
      version: 1,
      execution_count: 0,
      success_count: 0,
      success_rate: 0,
      confidence: 1,
      recent_executions: [],
      last_updated_at: new Date(),
    },
  };
}

function makeContext(variables: Record<string, unknown>): SkillExecutionContext {
  return { variables };
}

// ---------------------------------------------------------------------------
// 1. Template variable substitution correctness
// ---------------------------------------------------------------------------

describe('Template variable substitution correctness', () => {
  const executor = new SkillExecutor();

  it('replaces a single variable correctly', async () => {
    const skill = makeTemplateSkill('Hello {{name}}!', [
      { name: 'name' },
    ]);
    const result = await executor.execute(skill, makeContext({ name: 'Alice' }));

    expect(result.success).toBe(true);
    expect((result.steps[0]?.data as any)?.output).toBe('Hello Alice!');
  });

  it('replaces multiple different variables', async () => {
    const skill = makeTemplateSkill('{{greeting}}, {{name}}! Welcome to {{place}}.', [
      { name: 'greeting' },
      { name: 'name' },
      { name: 'place' },
    ]);
    const result = await executor.execute(
      skill,
      makeContext({ greeting: 'Hi', name: 'Bob', place: 'Wonderland' })
    );

    expect(result.success).toBe(true);
    expect((result.steps[0]?.data as any)?.output).toBe(
      'Hi, Bob! Welcome to Wonderland.'
    );
  });

  it('replaces the same variable used multiple times', async () => {
    const skill = makeTemplateSkill('{{x}} + {{x}} = 2 * {{x}}', [
      { name: 'x' },
    ]);
    const result = await executor.execute(skill, makeContext({ x: '5' }));

    expect(result.success).toBe(true);
    expect((result.steps[0]?.data as any)?.output).toBe('5 + 5 = 2 * 5');
  });

  it('returns the template unchanged when there are no variables', async () => {
    const skill = makeTemplateSkill('No variables here.', []);
    const result = await executor.execute(skill, makeContext({}));

    expect(result.success).toBe(true);
    expect((result.steps[0]?.data as any)?.output).toBe('No variables here.');
  });

  it('replaces with empty string when variable is not in context and has no default', async () => {
    const skill = makeTemplateSkill('Hello {{missing}}!', [
      { name: 'missing' },
    ]);
    const result = await executor.execute(skill, makeContext({}));

    expect(result.success).toBe(true);
    expect((result.steps[0]?.data as any)?.output).toBe('Hello !');
  });

  it('uses default_value when variable is not in context', async () => {
    const skill = makeTemplateSkill('Hello {{who}}!', [
      { name: 'who', default_value: 'World' },
    ]);
    const result = await executor.execute(skill, makeContext({}));

    expect(result.success).toBe(true);
    expect((result.steps[0]?.data as any)?.output).toBe('Hello World!');
  });

  it('prefers context value over default_value', async () => {
    const skill = makeTemplateSkill('Hello {{who}}!', [
      { name: 'who', default_value: 'World' },
    ]);
    const result = await executor.execute(
      skill,
      makeContext({ who: 'Override' })
    );

    expect(result.success).toBe(true);
    expect((result.steps[0]?.data as any)?.output).toBe('Hello Override!');
  });
});

// ---------------------------------------------------------------------------
// 2. ReDoS-safe variable names (regex metacharacters treated literally)
// ---------------------------------------------------------------------------

describe('ReDoS-safe variable names', () => {
  const executor = new SkillExecutor();

  it('handles variable name with dots (foo.bar)', async () => {
    const skill = makeTemplateSkill('Value is {{foo.bar}}.', [
      { name: 'foo.bar' },
    ]);
    const result = await executor.execute(
      skill,
      makeContext({ 'foo.bar': '42' })
    );

    expect(result.success).toBe(true);
    expect((result.steps[0]?.data as any)?.output).toBe('Value is 42.');
  });

  it('handles variable name with plus (a+b)', async () => {
    const skill = makeTemplateSkill('Sum: {{a+b}}', [{ name: 'a+b' }]);
    const result = await executor.execute(
      skill,
      makeContext({ 'a+b': '3' })
    );

    expect(result.success).toBe(true);
    expect((result.steps[0]?.data as any)?.output).toBe('Sum: 3');
  });

  it('handles variable name with asterisk (x*y)', async () => {
    const skill = makeTemplateSkill('Product: {{x*y}}', [{ name: 'x*y' }]);
    const result = await executor.execute(
      skill,
      makeContext({ 'x*y': '6' })
    );

    expect(result.success).toBe(true);
    expect((result.steps[0]?.data as any)?.output).toBe('Product: 6');
  });

  it('handles variable name with brackets (test[0])', async () => {
    const skill = makeTemplateSkill('First: {{test[0]}}', [
      { name: 'test[0]' },
    ]);
    const result = await executor.execute(
      skill,
      makeContext({ 'test[0]': 'alpha' })
    );

    expect(result.success).toBe(true);
    expect((result.steps[0]?.data as any)?.output).toBe('First: alpha');
  });

  it('handles variable name with slashes (path/to/thing)', async () => {
    const skill = makeTemplateSkill('Path: {{path/to/thing}}', [
      { name: 'path/to/thing' },
    ]);
    const result = await executor.execute(
      skill,
      makeContext({ 'path/to/thing': '/usr/local' })
    );

    expect(result.success).toBe(true);
    expect((result.steps[0]?.data as any)?.output).toBe('Path: /usr/local');
  });

  it('handles variable name with dollar sign ($price)', async () => {
    const skill = makeTemplateSkill('Cost: {{$price}}', [
      { name: '$price' },
    ]);
    const result = await executor.execute(
      skill,
      makeContext({ $price: '9.99' })
    );

    expect(result.success).toBe(true);
    expect((result.steps[0]?.data as any)?.output).toBe('Cost: 9.99');
  });

  it('handles variable name with caret (^start)', async () => {
    const skill = makeTemplateSkill('Begin: {{^start}}', [
      { name: '^start' },
    ]);
    const result = await executor.execute(
      skill,
      makeContext({ '^start': 'GO' })
    );

    expect(result.success).toBe(true);
    expect((result.steps[0]?.data as any)?.output).toBe('Begin: GO');
  });

  it('handles variable name with pipe (a|b)', async () => {
    const skill = makeTemplateSkill('Choice: {{a|b}}', [{ name: 'a|b' }]);
    const result = await executor.execute(
      skill,
      makeContext({ 'a|b': 'yes' })
    );

    expect(result.success).toBe(true);
    expect((result.steps[0]?.data as any)?.output).toBe('Choice: yes');
  });

  it('handles variable name with backslash (back\\slash)', async () => {
    const name = 'back\\slash';
    const skill = makeTemplateSkill(`Result: {{${name}}}`, [{ name }]);
    const result = await executor.execute(skill, makeContext({ [name]: 'ok' }));

    expect(result.success).toBe(true);
    expect((result.steps[0]?.data as any)?.output).toBe('Result: ok');
  });

  it('handles variable name with parentheses and quantifiers ((a+)+)', async () => {
    const name = '(a+)+';
    const skill = makeTemplateSkill(`Val: {{${name}}}`, [{ name }]);
    const result = await executor.execute(skill, makeContext({ [name]: 'safe' }));

    expect(result.success).toBe(true);
    expect((result.steps[0]?.data as any)?.output).toBe('Val: safe');
  });
});

// ---------------------------------------------------------------------------
// 3. Template rendering via SkillExecutor (end-to-end)
// ---------------------------------------------------------------------------

describe('Template rendering via SkillExecutor', () => {
  it('executes a full template skill with multiple placeholders', async () => {
    const executor = new SkillExecutor();

    const skill = makeTemplateSkill(
      'Dear {{recipient}},\n\nRe: {{subject}}\n\nSincerely,\n{{sender}}',
      [
        { name: 'recipient' },
        { name: 'subject' },
        { name: 'sender' },
      ]
    );

    const result = await executor.execute(skill, {
      variables: {
        recipient: 'Engineering Team',
        subject: 'ReDoS Security Fix',
        sender: 'Security Bot',
      },
    });

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.success).toBe(true);
    expect(result.steps[0]?.message).toBe('Template rendered successfully');
    expect((result.steps[0]?.data as any)?.output).toBe(
      'Dear Engineering Team,\n\nRe: ReDoS Security Fix\n\nSincerely,\nSecurity Bot'
    );
    expect(result.total_duration_ms).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it('returns skill_id matching the input skill', async () => {
    const executor = new SkillExecutor();
    const skill = makeTemplateSkill('{{x}}', [{ name: 'x' }]);

    const result = await executor.execute(skill, makeContext({ x: '1' }));

    expect(result.skill_id).toBe(skill.memory.memory_id);
  });

  it('falls back to description when code is absent', async () => {
    const executor = new SkillExecutor();

    const skill: Skill = {
      memory: {
        memory_id: { id: 'desc-test', layer: 'procedural' } as any,
        content: {
          name: 'Description Template',
          description: 'Hello {{name}} from description',
          // no code field
        },
        provenance: {} as any,
        salience: {} as any,
        metadata: {
          type: 'template',
          variables: [{ name: 'name' }],
        },
        version: 1,
        execution_count: 0,
      } as any,
      refinement: {
        skill_id: { id: 'desc-test', layer: 'procedural' } as any,
        version: 1,
        execution_count: 0,
        success_count: 0,
        success_rate: 0,
        confidence: 1,
        recent_executions: [],
        last_updated_at: new Date(),
      },
    };

    const result = await executor.execute(skill, makeContext({ name: 'Kai' }));

    expect(result.success).toBe(true);
    expect((result.steps[0]?.data as any)?.output).toBe(
      'Hello Kai from description'
    );
  });

  it('renders template with no metadata.variables (null-safe)', async () => {
    const executor = new SkillExecutor();

    const skill: Skill = {
      memory: {
        memory_id: { id: 'no-vars', layer: 'procedural' } as any,
        content: {
          name: 'Static Template',
          description: 'No dynamic content',
          code: 'Static text, no placeholders',
        },
        provenance: {} as any,
        salience: {} as any,
        metadata: {
          type: 'template',
          // no variables key at all
        },
        version: 1,
        execution_count: 0,
      } as any,
      refinement: {
        skill_id: { id: 'no-vars', layer: 'procedural' } as any,
        version: 1,
        execution_count: 0,
        success_count: 0,
        success_rate: 0,
        confidence: 1,
        recent_executions: [],
        last_updated_at: new Date(),
      },
    };

    const result = await executor.execute(skill, makeContext({}));

    expect(result.success).toBe(true);
    expect((result.steps[0]?.data as any)?.output).toBe(
      'Static text, no placeholders'
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Malicious variable name doesn't cause hang (ReDoS performance guard)
// ---------------------------------------------------------------------------

describe('Malicious variable name does not cause hang', () => {
  const executor = new SkillExecutor();

  it('completes within 100ms even with catastrophic backtracking pattern (a+)+', async () => {
    // The classic ReDoS pattern: (a+)+ against "aaaaaaaaaaaaaaaaaaaaaaaa!"
    // With the old `new RegExp(...)` approach, this would cause exponential
    // backtracking and hang for minutes or longer. With replaceAll, it's a
    // simple literal string match that completes instantly.
    const maliciousName = '(a+)+';
    const skill = makeTemplateSkill(
      `Start {{${maliciousName}}} End`,
      [{ name: maliciousName }]
    );

    const start = performance.now();
    const result = await executor.execute(
      skill,
      makeContext({ [maliciousName]: 'SAFE' })
    );
    const elapsed = performance.now() - start;

    expect(result.success).toBe(true);
    expect((result.steps[0]?.data as any)?.output).toBe('Start SAFE End');
    expect(elapsed).toBeLessThan(100);
  });

  it('completes within 100ms with nested quantifiers (.*){10}', async () => {
    const maliciousName = '(.*){10}';
    const skill = makeTemplateSkill(
      `A {{${maliciousName}}} B`,
      [{ name: maliciousName }]
    );

    const start = performance.now();
    const result = await executor.execute(
      skill,
      makeContext({ [maliciousName]: 'OK' })
    );
    const elapsed = performance.now() - start;

    expect(result.success).toBe(true);
    expect((result.steps[0]?.data as any)?.output).toBe('A OK B');
    expect(elapsed).toBeLessThan(100);
  });

  it('completes within 100ms with alternation bomb (a|a|a|a|a)+', async () => {
    const maliciousName = '(a|a|a|a|a)+';
    const skill = makeTemplateSkill(
      `X {{${maliciousName}}} Y`,
      [{ name: maliciousName }]
    );

    const start = performance.now();
    const result = await executor.execute(
      skill,
      makeContext({ [maliciousName]: 'fast' })
    );
    const elapsed = performance.now() - start;

    expect(result.success).toBe(true);
    expect((result.steps[0]?.data as any)?.output).toBe('X fast Y');
    expect(elapsed).toBeLessThan(100);
  });

  it('completes within 100ms with complex evil pattern ([a-zA-Z]+)*$', async () => {
    const maliciousName = '([a-zA-Z]+)*$';
    const skill = makeTemplateSkill(
      `Result: {{${maliciousName}}}`,
      [{ name: maliciousName }]
    );

    const start = performance.now();
    const result = await executor.execute(
      skill,
      makeContext({ [maliciousName]: 'done' })
    );
    const elapsed = performance.now() - start;

    expect(result.success).toBe(true);
    expect((result.steps[0]?.data as any)?.output).toBe('Result: done');
    expect(elapsed).toBeLessThan(100);
  });

  it('handles many regex-special variables in one template without hanging', async () => {
    // Stress test: 20 variables, each with regex metacharacters
    const names = [
      'a+b', 'c*d', 'e.f', 'g|h', 'i(j)', 'k[l]', 'm{n}',
      'o^p', 'q$r', 's\\t', '(u+)+', '(v*)*', 'w?x', '.+',
      '.*', '\\d+', '\\w+', '[^a]', 'a{2,}', '(?:x)',
    ];
    const variables = names.map((n) => ({ name: n }));
    const template = names.map((n) => `{{${n}}}`).join(' ');
    const skill = makeTemplateSkill(template, variables);

    const contextVars: Record<string, string> = {};
    for (const n of names) {
      contextVars[n] = 'v';
    }

    const start = performance.now();
    const result = await executor.execute(skill, makeContext(contextVars));
    const elapsed = performance.now() - start;

    expect(result.success).toBe(true);
    const expected = names.map(() => 'v').join(' ');
    expect((result.steps[0]?.data as any)?.output).toBe(expected);
    expect(elapsed).toBeLessThan(100);
  });
});
