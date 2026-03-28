import { describe, it, expect, beforeEach } from 'bun:test';
import type { WorkingMemoryItem, EpisodicMemory, SemanticMemory } from '@reminisce/core';
import {
  SuppressionManager,
  createTopicBlockRule,
  createSessionBlockRule,
  createEntityRedactRule,
  type SuppressionRule,
} from './suppression.js';

// Helper to create mock memories
function createMockWorkingMemory(overrides: Partial<{
  summary: string;
  data: unknown;
  tags: string[];
  machineId: string;
}> = {}): WorkingMemoryItem {
  return {
    memory_id: {
      id: 'wm-1',
      layer: 'working',
      created_at: new Date(),
      source_session: 'test-session',
      source_machine: overrides.machineId ?? 'test-machine',
    },
    provenance: {
      source_ids: [],
      derivation_type: 'direct',
      confidence: 1,
      last_validated: new Date(),
      contradiction_ids: [],
      retracted: false,
    },
    salience: {
      current_score: 0.7,
      signals: {},
      decay_rate: 0.1,
      last_accessed: new Date(),
      access_count: 1,
    },
    content: {
      type: 'message',
      data: overrides.data ?? 'test data',
      summary: overrides.summary ?? 'Test working memory item',
    },
    slot: 0,
    overflowed: false,
    tags: overrides.tags ?? [],
  };
}

function createMockEpisodicMemory(overrides: Partial<{
  event: string;
  summary: string;
  entities: string[];
  sessionId: string;
  tags: string[];
  machineId: string;
  timestamp: Date;
}> = {}): EpisodicMemory {
  const timestamp = overrides.timestamp ?? new Date();
  return {
    memory_id: {
      id: 'ep-1',
      layer: 'episodic',
      created_at: timestamp,
      source_session: overrides.sessionId ?? 'session-1',
      source_machine: overrides.machineId ?? 'test-machine',
    },
    provenance: {
      source_ids: [],
      derivation_type: 'direct',
      confidence: 1,
      last_validated: new Date(),
      contradiction_ids: [],
      retracted: false,
    },
    salience: {
      current_score: 0.7,
      signals: {},
      decay_rate: 0.1,
      last_accessed: new Date(),
      access_count: 1,
    },
    content: {
      event: overrides.event ?? 'test-event',
      summary: overrides.summary ?? 'Test episode summary',
      entities: overrides.entities ?? ['user', 'system'],
    },
    started_at: timestamp,
    session_id: overrides.sessionId ?? 'session-1',
    consolidated: false,
    tags: overrides.tags ?? [],
  };
}

function createMockSemanticMemory(overrides: Partial<{
  fact: string;
  subject: string;
  object: string;
  tags: string[];
  machineId: string;
}> = {}): SemanticMemory {
  return {
    memory_id: {
      id: 'sm-1',
      layer: 'semantic',
      created_at: new Date(),
      source_session: 'test-session',
      source_machine: overrides.machineId ?? 'test-machine',
    },
    provenance: {
      source_ids: [],
      derivation_type: 'consolidated',
      confidence: 0.9,
      last_validated: new Date(),
      contradiction_ids: [],
      retracted: false,
    },
    salience: {
      current_score: 0.8,
      signals: {},
      decay_rate: 0.05,
      last_accessed: new Date(),
      access_count: 1,
    },
    content: {
      fact: overrides.fact ?? 'User prefers dark mode',
      subject: overrides.subject ?? 'user',
      predicate: 'prefers',
      object: overrides.object ?? 'dark mode',
    },
    source_episode_ids: [],
    tags: overrides.tags ?? [],
  };
}

describe('SuppressionManager', () => {
  let manager: SuppressionManager;

  beforeEach(() => {
    manager = new SuppressionManager();
  });

  describe('rule management', () => {
    it('should add and retrieve rules', () => {
      const rule = createTopicBlockRule('r1', 'Test Rule', ['password']);
      manager.addRule(rule);

      expect(manager.getRules()).toHaveLength(1);
      expect(manager.getRule('r1')).toEqual(rule);
    });

    it('should remove rules', () => {
      manager.addRule(createTopicBlockRule('r1', 'Test Rule', ['password']));
      expect(manager.removeRule('r1')).toBe(true);
      expect(manager.getRules()).toHaveLength(0);
    });

    it('should enable and disable rules', () => {
      manager.addRule(createTopicBlockRule('r1', 'Test Rule', ['password']));

      manager.setRuleEnabled('r1', false);
      expect(manager.getRule('r1')?.enabled).toBe(false);

      manager.setRuleEnabled('r1', true);
      expect(manager.getRule('r1')?.enabled).toBe(true);
    });

    it('should clear all rules', () => {
      manager.addRule(createTopicBlockRule('r1', 'Rule 1', ['password']));
      manager.addRule(createTopicBlockRule('r2', 'Rule 2', ['secret']));

      manager.clear();
      expect(manager.getRules()).toHaveLength(0);
    });
  });

  describe('topic pattern matching', () => {
    it('should block memories matching topic patterns', () => {
      manager.addRule(createTopicBlockRule('r1', 'Block passwords', ['password', 'secret']));

      const memory = createMockEpisodicMemory({
        summary: 'User mentioned their password is xyz',
      });

      const result = manager.checkEpisodicMemory(memory);
      expect(result.suppressed).toBe(true);
      expect(result.action).toBe('block');
    });

    it('should not block memories without matching patterns', () => {
      manager.addRule(createTopicBlockRule('r1', 'Block passwords', ['password']));

      const memory = createMockEpisodicMemory({
        summary: 'User discussed their favorite color',
      });

      const result = manager.checkEpisodicMemory(memory);
      expect(result.suppressed).toBe(false);
    });

    it('should support regex patterns', () => {
      manager.addRule(createTopicBlockRule('r1', 'Block credit cards', ['\\d{4}[- ]?\\d{4}[- ]?\\d{4}[- ]?\\d{4}']));

      const memory = createMockEpisodicMemory({
        summary: 'Card number is 1234-5678-9012-3456',
      });

      const result = manager.checkEpisodicMemory(memory);
      expect(result.suppressed).toBe(true);
    });

    it('should be case insensitive', () => {
      manager.addRule(createTopicBlockRule('r1', 'Block passwords', ['PASSWORD']));

      const memory = createMockEpisodicMemory({
        summary: 'my password is secret',
      });

      const result = manager.checkEpisodicMemory(memory);
      expect(result.suppressed).toBe(true);
    });
  });

  describe('session ID matching', () => {
    it('should block specific sessions', () => {
      manager.addRule(createSessionBlockRule('r1', 'Block debug sessions', ['debug-session-1', 'debug-session-2']));

      const memory = createMockEpisodicMemory({ sessionId: 'debug-session-1' });
      const result = manager.checkEpisodicMemory(memory);

      expect(result.suppressed).toBe(true);
      expect(result.action).toBe('skip_consolidation');
    });

    it('should not block other sessions', () => {
      manager.addRule(createSessionBlockRule('r1', 'Block debug sessions', ['debug-session-1']));

      const memory = createMockEpisodicMemory({ sessionId: 'production-session' });
      const result = manager.checkEpisodicMemory(memory);

      expect(result.suppressed).toBe(false);
    });
  });

  describe('entity matching', () => {
    it('should redact memories with matching entities', () => {
      manager.addRule(createEntityRedactRule('r1', 'Redact competitors', ['CompetitorCorp', 'RivalInc']));

      const memory = createMockEpisodicMemory({
        entities: ['user', 'CompetitorCorp', 'product'],
      });

      const result = manager.checkEpisodicMemory(memory);
      expect(result.suppressed).toBe(true);
      expect(result.action).toBe('redact');
    });

    it('should be case insensitive for entity matching', () => {
      manager.addRule(createEntityRedactRule('r1', 'Redact competitors', ['competitor']));

      const memory = createMockEpisodicMemory({
        entities: ['COMPETITOR_CORP'],
      });

      const result = manager.checkEpisodicMemory(memory);
      expect(result.suppressed).toBe(true);
    });
  });

  describe('machine ID matching', () => {
    it('should suppress memories from specific machines', () => {
      const rule: SuppressionRule = {
        id: 'r1',
        name: 'Block test machines',
        enabled: true,
        action: 'block',
        criteria: {
          machineIds: ['test-machine-1', 'dev-machine'],
        },
      };
      manager.addRule(rule);

      const memory = createMockEpisodicMemory({ machineId: 'test-machine-1' });
      const result = manager.checkEpisodicMemory(memory);

      expect(result.suppressed).toBe(true);
    });
  });

  describe('tag matching', () => {
    it('should suppress memories with matching tags', () => {
      const rule: SuppressionRule = {
        id: 'r1',
        name: 'Block sensitive',
        enabled: true,
        action: 'block',
        criteria: {
          tags: ['sensitive', 'private'],
        },
      };
      manager.addRule(rule);

      const memory = createMockEpisodicMemory({ tags: ['work', 'sensitive'] });
      const result = manager.checkEpisodicMemory(memory);

      expect(result.suppressed).toBe(true);
    });
  });

  describe('time range matching', () => {
    it('should suppress memories within time range', () => {
      const startDate = new Date('2024-01-01');
      const endDate = new Date('2024-01-31');

      const rule: SuppressionRule = {
        id: 'r1',
        name: 'Block January 2024',
        enabled: true,
        action: 'skip_consolidation',
        criteria: {
          timeRange: {
            start: startDate,
            end: endDate,
          },
        },
      };
      manager.addRule(rule);

      const memory = createMockEpisodicMemory({ timestamp: new Date('2024-01-15') });
      const result = manager.checkEpisodicMemory(memory);

      expect(result.suppressed).toBe(true);
    });

    it('should not suppress memories outside time range', () => {
      const rule: SuppressionRule = {
        id: 'r1',
        name: 'Block January 2024',
        enabled: true,
        action: 'skip_consolidation',
        criteria: {
          timeRange: {
            start: new Date('2024-01-01'),
            end: new Date('2024-01-31'),
          },
        },
      };
      manager.addRule(rule);

      const memory = createMockEpisodicMemory({ timestamp: new Date('2024-02-15') });
      const result = manager.checkEpisodicMemory(memory);

      expect(result.suppressed).toBe(false);
    });
  });

  describe('rule expiration', () => {
    it('should not apply expired rules', () => {
      const rule = createTopicBlockRule('r1', 'Expired rule', ['password'], {
        expiresAt: new Date('2020-01-01'), // In the past
      });
      manager.addRule(rule);

      const memory = createMockEpisodicMemory({
        summary: 'User mentioned password',
      });

      const result = manager.checkEpisodicMemory(memory);
      expect(result.suppressed).toBe(false);
    });

    it('should apply non-expired rules', () => {
      const futureDate = new Date();
      futureDate.setFullYear(futureDate.getFullYear() + 1);

      const rule = createTopicBlockRule('r1', 'Future rule', ['password'], {
        expiresAt: futureDate,
      });
      manager.addRule(rule);

      const memory = createMockEpisodicMemory({
        summary: 'User mentioned password',
      });

      const result = manager.checkEpisodicMemory(memory);
      expect(result.suppressed).toBe(true);
    });
  });

  describe('action priority', () => {
    it('should return most restrictive action when multiple rules match', () => {
      // Less restrictive
      manager.addRule(createTopicBlockRule('r1', 'Low priority', ['test'], {
        action: 'low_priority',
      }));
      // More restrictive
      manager.addRule(createTopicBlockRule('r2', 'Block', ['test'], {
        action: 'block',
      }));

      const memory = createMockEpisodicMemory({
        summary: 'This is a test message',
      });

      const result = manager.checkEpisodicMemory(memory);
      expect(result.suppressed).toBe(true);
      expect(result.matchedRules).toHaveLength(2);
      expect(result.action).toBe('block'); // Most restrictive
    });
  });

  describe('memory type checking', () => {
    it('should check working memory items', () => {
      manager.addRule(createTopicBlockRule('r1', 'Block secrets', ['secret']));

      const item = createMockWorkingMemory({
        summary: 'This contains a secret',
      });

      const result = manager.checkWorkingMemory(item);
      expect(result.suppressed).toBe(true);
    });

    it('should check semantic memories', () => {
      manager.addRule(createEntityRedactRule('r1', 'Redact user', ['user']));

      const fact = createMockSemanticMemory({
        subject: 'user',
        fact: 'User prefers dark mode',
      });

      const result = manager.checkSemanticMemory(fact);
      expect(result.suppressed).toBe(true);
    });
  });

  describe('import/export', () => {
    it('should export and import rules', () => {
      manager.addRule(createTopicBlockRule('r1', 'Rule 1', ['password'], { reason: 'Security' }));
      manager.addRule(createSessionBlockRule('r2', 'Rule 2', ['debug']));

      const exported = manager.exportRules();

      const newManager = new SuppressionManager();
      const imported = newManager.importRules(exported);

      expect(imported).toBe(2);
      expect(newManager.getRules()).toHaveLength(2);
      expect(newManager.getRule('r1')?.reason).toBe('Security');
    });
  });
});
