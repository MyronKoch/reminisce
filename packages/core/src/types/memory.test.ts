/**
 * Tests for Memory type guards
 */

import { describe, test, expect } from 'bun:test';
import {
  isWorkingMemory,
  isEpisodicMemory,
  isSemanticMemory,
  isProceduralMemory,
  type WorkingMemoryItem,
  type EpisodicMemory,
  type SemanticMemory,
  type ProceduralMemory,
  type BaseMemory,
} from './memory.js';
import { createMemoryID } from './memory-id.js';
import { createProvenance } from './provenance.js';
import { createSalience, createSalienceSignals } from './salience.js';

// Test helpers
function createBaseMemory(layer: 'working' | 'episodic' | 'semantic' | 'procedural'): BaseMemory {
  return {
    memory_id: createMemoryID(layer, 'test-session', 'test-machine'),
    content: {},
    provenance: createProvenance([], 'direct'),
    salience: createSalience(createSalienceSignals()),
  };
}

function createWorkingMemory(): WorkingMemoryItem {
  return {
    ...createBaseMemory('working'),
    memory_id: createMemoryID('working', 'test-session', 'test-machine'),
    content: {
      type: 'message',
      data: 'test data',
    },
    slot: 0,
    overflowed: false,
  };
}

function createEpisodicMemory(): EpisodicMemory {
  return {
    ...createBaseMemory('episodic'),
    memory_id: createMemoryID('episodic', 'test-session', 'test-machine'),
    content: {
      event: 'Test event',
      summary: 'Test summary',
      entities: ['entity1', 'entity2'],
    },
    started_at: new Date(),
    session_id: 'test-session',
    consolidated: false,
  };
}

function createSemanticMemory(): SemanticMemory {
  return {
    ...createBaseMemory('semantic'),
    memory_id: createMemoryID('semantic', 'test-session', 'test-machine'),
    content: {
      fact: 'Test fact',
      subject: 'subject',
      predicate: 'predicate',
      object: 'object',
    },
    source_episode_ids: [],
  };
}

function createProceduralMemory(): ProceduralMemory {
  return {
    ...createBaseMemory('procedural'),
    memory_id: createMemoryID('procedural', 'test-session', 'test-machine'),
    content: {
      name: 'Test Procedure',
      description: 'Test description',
    },
    version: 1,
    execution_count: 0,
  };
}

describe('isWorkingMemory', () => {
  test('returns true for working memory', () => {
    const memory = createWorkingMemory();
    expect(isWorkingMemory(memory)).toBe(true);
  });

  test('returns false for episodic memory', () => {
    const memory = createEpisodicMemory();
    expect(isWorkingMemory(memory)).toBe(false);
  });

  test('returns false for semantic memory', () => {
    const memory = createSemanticMemory();
    expect(isWorkingMemory(memory)).toBe(false);
  });

  test('returns false for procedural memory', () => {
    const memory = createProceduralMemory();
    expect(isWorkingMemory(memory)).toBe(false);
  });

  test('returns false for base memory without layer specified', () => {
    const memory = createBaseMemory('episodic');
    expect(isWorkingMemory(memory)).toBe(false);
  });
});

describe('isEpisodicMemory', () => {
  test('returns true for episodic memory', () => {
    const memory = createEpisodicMemory();
    expect(isEpisodicMemory(memory)).toBe(true);
  });

  test('returns false for working memory', () => {
    const memory = createWorkingMemory();
    expect(isEpisodicMemory(memory)).toBe(false);
  });

  test('returns false for semantic memory', () => {
    const memory = createSemanticMemory();
    expect(isEpisodicMemory(memory)).toBe(false);
  });

  test('returns false for procedural memory', () => {
    const memory = createProceduralMemory();
    expect(isEpisodicMemory(memory)).toBe(false);
  });
});

describe('isSemanticMemory', () => {
  test('returns true for semantic memory', () => {
    const memory = createSemanticMemory();
    expect(isSemanticMemory(memory)).toBe(true);
  });

  test('returns false for working memory', () => {
    const memory = createWorkingMemory();
    expect(isSemanticMemory(memory)).toBe(false);
  });

  test('returns false for episodic memory', () => {
    const memory = createEpisodicMemory();
    expect(isSemanticMemory(memory)).toBe(false);
  });

  test('returns false for procedural memory', () => {
    const memory = createProceduralMemory();
    expect(isSemanticMemory(memory)).toBe(false);
  });
});

describe('isProceduralMemory', () => {
  test('returns true for procedural memory', () => {
    const memory = createProceduralMemory();
    expect(isProceduralMemory(memory)).toBe(true);
  });

  test('returns false for working memory', () => {
    const memory = createWorkingMemory();
    expect(isProceduralMemory(memory)).toBe(false);
  });

  test('returns false for episodic memory', () => {
    const memory = createEpisodicMemory();
    expect(isProceduralMemory(memory)).toBe(false);
  });

  test('returns false for semantic memory', () => {
    const memory = createSemanticMemory();
    expect(isProceduralMemory(memory)).toBe(false);
  });
});

describe('Type guard narrowing', () => {
  test('type guards narrow types correctly', () => {
    const memory: BaseMemory = createWorkingMemory();

    if (isWorkingMemory(memory)) {
      // Should be able to access WorkingMemoryItem-specific fields
      expect(memory.slot).toBeDefined();
      expect(memory.overflowed).toBeDefined();
    } else {
      throw new Error('Type guard failed');
    }
  });

  test('episodic type guard enables access to episodic fields', () => {
    const memory: BaseMemory = createEpisodicMemory();

    if (isEpisodicMemory(memory)) {
      expect(memory.started_at).toBeInstanceOf(Date);
      expect(memory.session_id).toBeDefined();
      expect(memory.consolidated).toBe(false);
    } else {
      throw new Error('Type guard failed');
    }
  });

  test('semantic type guard enables access to semantic fields', () => {
    const memory: BaseMemory = createSemanticMemory();

    if (isSemanticMemory(memory)) {
      expect(memory.source_episode_ids).toBeDefined();
      expect(Array.isArray(memory.source_episode_ids)).toBe(true);
    } else {
      throw new Error('Type guard failed');
    }
  });

  test('procedural type guard enables access to procedural fields', () => {
    const memory: BaseMemory = createProceduralMemory();

    if (isProceduralMemory(memory)) {
      expect(memory.version).toBe(1);
      expect(memory.execution_count).toBe(0);
    } else {
      throw new Error('Type guard failed');
    }
  });
});
