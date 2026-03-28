/**
 * Tests for D1 Storage Adapters
 *
 * Comprehensive tests covering D1EpisodicStore and D1SemanticStore
 * with mocked D1Database interface.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import type {
  EpisodicMemory,
  SemanticMemory,
  MemoryID,
  Provenance,
  Salience,
} from '@reminisce/core';
import { D1EpisodicStore, D1SemanticStore, SCHEMA } from './d1-storage.js';

// ─────────────────────────────────────────────────────────────
// Mock D1Database
// ─────────────────────────────────────────────────────────────

interface MockCall {
  sql: string;
  bindings: unknown[];
}

function createMockD1() {
  const calls: MockCall[] = [];
  let nextResult: any = {
    results: [],
    success: true,
    meta: {
      duration: 0,
      changes: 0,
      last_row_id: 0,
      changed_db: false,
      size_after: 0,
      rows_read: 0,
      rows_written: 0,
    },
  };

  const mockStmt = {
    bind: (...values: unknown[]) => {
      if (calls.length > 0) {
        calls[calls.length - 1].bindings = values;
      }
      return mockStmt;
    },
    first: async <T>() => {
      const result = nextResult.results?.[0] as T;
      return result ?? null;
    },
    run: async () => nextResult,
    all: async <T>() => nextResult as any,
  };

  return {
    db: {
      prepare: (sql: string) => {
        calls.push({ sql, bindings: [] });
        return mockStmt;
      },
      batch: async (stmts: any[]) => [],
      exec: async (sql: string) => {
        calls.push({ sql, bindings: [] });
        return { count: 1, duration: 0 };
      },
    },
    calls,
    setNextResult: (result: any) => {
      nextResult = result;
    },
    reset: () => {
      calls.length = 0;
      nextResult = {
        results: [],
        success: true,
        meta: {
          duration: 0,
          changes: 0,
          last_row_id: 0,
          changed_db: false,
          size_after: 0,
          rows_read: 0,
          rows_written: 0,
        },
      };
    },
  };
}

// ─────────────────────────────────────────────────────────────
// Test Fixtures
// ─────────────────────────────────────────────────────────────

function createTestMemoryID(layer: 'episodic' | 'semantic' = 'episodic'): MemoryID & { layer: typeof layer } {
  return {
    id: 'test-id-123',
    layer,
    source_machine: 'test-machine',
    source_session: 'test-session',
    created_at: new Date('2025-01-15T10:00:00Z'),
  };
}

function createTestProvenance(): Provenance {
  return {
    source_ids: [],
    derivation_type: 'direct',
    confidence: 0.9,
    last_validated: new Date('2025-01-15T10:00:00Z'),
    contradiction_ids: [],
    retracted: false,
  };
}

function createTestSalience(): Salience {
  return {
    signals: {
      reward_signal: 0.5,
      error_signal: 0,
      user_pinned: false,
      user_blocked: false,
      novelty_score: 0.7,
      emotional_intensity: 0.3,
      access_count: 1,
      last_accessed: new Date('2025-01-15T10:00:00Z'),
      goal_relevance: 0.8,
    },
    current_score: 0.65,
    instrumentation: {
      computed_at: new Date('2025-01-15T10:00:00Z'),
      raw_signals: {},
      weighted_contributions: {},
      final_score: 0.65,
    },
  };
}

function createTestEpisode(): EpisodicMemory {
  return {
    memory_id: createTestMemoryID('episodic'),
    session_id: 'test-session',
    content: {
      event: 'Test event occurred',
      summary: 'A test event for unit testing',
      entities: ['entity1', 'entity2'],
      valence: 0.5,
    },
    tags: ['test', 'unit-test'],
    provenance: createTestProvenance(),
    salience: createTestSalience(),
    consolidated: false,
    started_at: new Date('2025-01-15T10:00:00Z'),
    ended_at: new Date('2025-01-15T10:05:00Z'),
  };
}

function createTestFact(): SemanticMemory {
  return {
    memory_id: createTestMemoryID('semantic'),
    content: {
      fact: 'Test fact about something',
      subject: 'testing',
      predicate: 'is',
      object: 'important',
      category: 'methodology',
    },
    source_episode_ids: [],
    tags: ['test', 'fact'],
    provenance: createTestProvenance(),
    salience: createTestSalience(),
  };
}

// ─────────────────────────────────────────────────────────────
// D1EpisodicStore Tests
// ─────────────────────────────────────────────────────────────

describe('D1EpisodicStore', () => {
  let mock: ReturnType<typeof createMockD1>;
  let store: D1EpisodicStore;

  beforeEach(() => {
    mock = createMockD1();
    store = new D1EpisodicStore(mock.db as any, {
      tenantId: 'test-tenant',
      machineId: 'test-machine',
    });
  });

  describe('initialize', () => {
    it('should execute SCHEMA', async () => {
      await store.initialize();

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].sql).toBe(SCHEMA);
    });
  });

  describe('store', () => {
    it('should insert episode with correct SQL and bindings', async () => {
      const episode = createTestEpisode();
      mock.setNextResult({ success: true, meta: { changes: 1, duration: 0, last_row_id: 0, changed_db: true, size_after: 0, rows_read: 0, rows_written: 1 } });

      await store.store(episode);

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].sql).toContain('INSERT INTO episodic_memories');

      const bindings = mock.calls[0].bindings;
      expect(bindings[0]).toBe('test-id-123'); // id
      expect(bindings[1]).toBe('test-tenant'); // tenant_id
      expect(bindings[2]).toBe('test-machine'); // machine_id
      expect(bindings[3]).toBe('test-session'); // session_id
      expect(bindings[4]).toBe('episodic'); // layer
      expect(bindings[5]).toBe('Test event occurred'); // event
      expect(bindings[6]).toBe('A test event for unit testing'); // summary
      expect(bindings[7]).toBe(JSON.stringify(['entity1', 'entity2'])); // entities
      expect(bindings[8]).toBe(0.5); // valence
      expect(bindings[9]).toBe(JSON.stringify(['test', 'unit-test'])); // tags
      expect(bindings[10]).toBe(0); // consolidated (false = 0)
      expect(bindings[11]).toBe('2025-01-15T10:00:00.000Z'); // started_at
      expect(bindings[12]).toBe('2025-01-15T10:05:00.000Z'); // ended_at
      expect(typeof bindings[13]).toBe('string'); // provenance JSON
      expect(typeof bindings[14]).toBe('string'); // salience JSON
    });

    it('should handle null entities and ended_at', async () => {
      const episode = createTestEpisode();
      episode.content.entities = undefined;
      episode.ended_at = undefined;

      await store.store(episode);

      const bindings = mock.calls[0].bindings;
      expect(bindings[7]).toBe(JSON.stringify([])); // entities defaults to []
      expect(bindings[12]).toBe(null); // ended_at
    });

    it('should scope by tenant_id', async () => {
      const episode = createTestEpisode();
      await store.store(episode);

      const bindings = mock.calls[0].bindings;
      expect(bindings[1]).toBe('test-tenant');
    });
  });

  describe('query', () => {
    it('should generate correct WHERE clause without sessionId', async () => {
      mock.setNextResult({ results: [], success: true });

      await store.query({ limit: 10, offset: 0 });

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].sql).toContain('WHERE tenant_id = ?');
      expect(mock.calls[0].sql).not.toContain('AND session_id');
      expect(mock.calls[0].bindings[0]).toBe('test-tenant');
    });

    it('should include sessionId in WHERE clause when provided', async () => {
      mock.setNextResult({ results: [], success: true });

      await store.query({ sessionId: 'session-123', limit: 10, offset: 0 });

      expect(mock.calls[0].sql).toContain('AND session_id = ?');
      expect(mock.calls[0].bindings[0]).toBe('test-tenant');
      expect(mock.calls[0].bindings[1]).toBe('session-123');
    });

    it('should respect limit and offset', async () => {
      mock.setNextResult({ results: [], success: true });

      await store.query({ limit: 25, offset: 50 });

      expect(mock.calls[0].sql).toContain('LIMIT ? OFFSET ?');
      const bindings = mock.calls[0].bindings;
      expect(bindings[bindings.length - 2]).toBe(25); // limit
      expect(bindings[bindings.length - 1]).toBe(50); // offset
    });

    it('should use default limit and offset', async () => {
      mock.setNextResult({ results: [], success: true });

      await store.query({});

      const bindings = mock.calls[0].bindings;
      expect(bindings[bindings.length - 2]).toBe(50); // default limit
      expect(bindings[bindings.length - 1]).toBe(0); // default offset
    });

    it('should convert rows to EpisodicMemory objects', async () => {
      const mockRow = {
        id: 'test-id',
        tenant_id: 'test-tenant',
        machine_id: 'test-machine',
        session_id: 'test-session',
        layer: 'episodic',
        event: 'Test event',
        summary: 'Test summary',
        entities: '["entity1"]',
        valence: 0.5,
        tags: '["tag1"]',
        consolidated: 0,
        started_at: '2025-01-15T10:00:00Z',
        ended_at: '2025-01-15T10:05:00Z',
        provenance: JSON.stringify(createTestProvenance()),
        salience: JSON.stringify(createTestSalience()),
        created_at: '2025-01-15T10:00:00Z',
        updated_at: '2025-01-15T10:01:00Z',
      };

      mock.setNextResult({ results: [mockRow], success: true });

      const results = await store.query({});

      expect(results.length).toBe(1);
      expect(results[0].memory_id.id).toBe('test-id');
      expect(results[0].content.event).toBe('Test event');
      expect(results[0].content.entities).toEqual(['entity1']);
      expect(results[0].consolidated).toBe(false);
    });
  });

  describe('getById', () => {
    it('should query by id and tenant_id', async () => {
      mock.setNextResult({ results: [], success: true });

      await store.getById('episode-123');

      expect(mock.calls[0].sql).toContain('WHERE id = ? AND tenant_id = ?');
      expect(mock.calls[0].bindings[0]).toBe('episode-123');
      expect(mock.calls[0].bindings[1]).toBe('test-tenant');
    });

    it('should return null when not found', async () => {
      mock.setNextResult({ results: [], success: true });

      const result = await store.getById('nonexistent');

      expect(result).toBe(null);
    });

    it('should return EpisodicMemory when found', async () => {
      const mockRow = {
        id: 'test-id',
        tenant_id: 'test-tenant',
        machine_id: 'test-machine',
        session_id: 'test-session',
        layer: 'episodic',
        event: 'Test event',
        summary: 'Test summary',
        entities: null,
        valence: 0,
        tags: null,
        consolidated: 0,
        started_at: '2025-01-15T10:00:00Z',
        ended_at: null,
        provenance: JSON.stringify(createTestProvenance()),
        salience: JSON.stringify(createTestSalience()),
        created_at: '2025-01-15T10:00:00Z',
        updated_at: '2025-01-15T10:01:00Z',
      };

      mock.setNextResult({ results: [mockRow], success: true });

      const result = await store.getById('test-id');

      expect(result).not.toBe(null);
      expect(result?.memory_id.id).toBe('test-id');
      expect(result?.content.entities).toEqual([]);
      expect(result?.ended_at).toBe(undefined);
    });
  });

  describe('delete', () => {
    it('should delete by id and tenant_id', async () => {
      mock.setNextResult({ success: true, meta: { changes: 1, duration: 0, last_row_id: 0, changed_db: true, size_after: 0, rows_read: 0, rows_written: 1 } });

      await store.delete('episode-123');

      expect(mock.calls[0].sql).toContain('DELETE FROM episodic_memories WHERE id = ? AND tenant_id = ?');
      expect(mock.calls[0].bindings[0]).toBe('episode-123');
      expect(mock.calls[0].bindings[1]).toBe('test-tenant');
    });

    it('should return true when row deleted', async () => {
      mock.setNextResult({ success: true, meta: { changes: 1, duration: 0, last_row_id: 0, changed_db: true, size_after: 0, rows_read: 0, rows_written: 1 } });

      const result = await store.delete('episode-123');

      expect(result).toBe(true);
    });

    it('should return false when no row deleted', async () => {
      mock.setNextResult({ success: true, meta: { changes: 0, duration: 0, last_row_id: 0, changed_db: false, size_after: 0, rows_read: 0, rows_written: 0 } });

      const result = await store.delete('nonexistent');

      expect(result).toBe(false);
    });
  });

  describe('deleteBySession', () => {
    it('should delete by session_id and tenant_id', async () => {
      mock.setNextResult({ success: true, meta: { changes: 3, duration: 0, last_row_id: 0, changed_db: true, size_after: 0, rows_read: 0, rows_written: 3 } });

      await store.deleteBySession('session-123');

      expect(mock.calls[0].sql).toContain('DELETE FROM episodic_memories WHERE session_id = ? AND tenant_id = ?');
      expect(mock.calls[0].bindings[0]).toBe('session-123');
      expect(mock.calls[0].bindings[1]).toBe('test-tenant');
    });

    it('should return count of deleted rows', async () => {
      mock.setNextResult({ success: true, meta: { changes: 5, duration: 0, last_row_id: 0, changed_db: true, size_after: 0, rows_read: 0, rows_written: 5 } });

      const result = await store.deleteBySession('session-123');

      expect(result).toBe(5);
    });
  });

  describe('count', () => {
    it('should query count with tenant_id', async () => {
      mock.setNextResult({ results: [{ count: 42 }], success: true });

      await store.count();

      expect(mock.calls[0].sql).toContain('SELECT COUNT(*) as count FROM episodic_memories WHERE tenant_id = ?');
      expect(mock.calls[0].bindings[0]).toBe('test-tenant');
    });

    it('should return count', async () => {
      mock.setNextResult({ results: [{ count: 42 }], success: true });

      const result = await store.count();

      expect(result).toBe(42);
    });

    it('should return 0 when no result', async () => {
      mock.setNextResult({ results: [], success: true });

      const result = await store.count();

      expect(result).toBe(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────
// D1SemanticStore Tests
// ─────────────────────────────────────────────────────────────

describe('D1SemanticStore', () => {
  let mock: ReturnType<typeof createMockD1>;
  let store: D1SemanticStore;

  beforeEach(() => {
    mock = createMockD1();
    store = new D1SemanticStore(mock.db as any, {
      tenantId: 'test-tenant',
      machineId: 'test-machine',
      sessionId: 'test-session',
    });
  });

  describe('initialize', () => {
    it('should execute SCHEMA', async () => {
      await store.initialize();

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].sql).toBe(SCHEMA);
    });
  });

  describe('store', () => {
    it('should insert fact with correct SQL and bindings', async () => {
      const fact = createTestFact();
      mock.setNextResult({ success: true, meta: { changes: 1, duration: 0, last_row_id: 0, changed_db: true, size_after: 0, rows_read: 0, rows_written: 1 } });

      await store.store(fact);

      expect(mock.calls.length).toBe(1);
      expect(mock.calls[0].sql).toContain('INSERT INTO semantic_memories');

      const bindings = mock.calls[0].bindings;
      expect(bindings[0]).toBe('test-id-123'); // id
      expect(bindings[1]).toBe('test-tenant'); // tenant_id
      expect(bindings[2]).toBe('test-machine'); // machine_id
      expect(bindings[3]).toBe('test-session'); // session_id
      expect(bindings[4]).toBe('semantic'); // layer
      expect(bindings[5]).toBe('Test fact about something'); // fact
      expect(bindings[6]).toBe('testing'); // subject
      expect(bindings[7]).toBe('is'); // predicate
      expect(bindings[8]).toBe('important'); // object
      expect(bindings[9]).toBe('methodology'); // category
      expect(bindings[10]).toBe(JSON.stringify([])); // source_episode_ids
      expect(bindings[11]).toBe(JSON.stringify(['test', 'fact'])); // tags
    });

    it('should handle null subject/predicate/object/category', async () => {
      const fact = createTestFact();
      fact.content.subject = undefined;
      fact.content.predicate = undefined;
      fact.content.object = undefined;
      fact.content.category = undefined;

      await store.store(fact);

      const bindings = mock.calls[0].bindings;
      expect(bindings[6]).toBe(null); // subject
      expect(bindings[7]).toBe(null); // predicate
      expect(bindings[8]).toBe(null); // object
      expect(bindings[9]).toBe(null); // category
    });

    it('should scope by tenant_id', async () => {
      const fact = createTestFact();
      await store.store(fact);

      const bindings = mock.calls[0].bindings;
      expect(bindings[1]).toBe('test-tenant');
    });
  });

  describe('query', () => {
    it('should generate correct WHERE clause without filters', async () => {
      mock.setNextResult({ results: [], success: true });

      await store.query({});

      expect(mock.calls[0].sql).toContain('WHERE tenant_id = ?');
      expect(mock.calls[0].sql).not.toContain('AND subject');
      expect(mock.calls[0].sql).not.toContain('AND category');
      expect(mock.calls[0].bindings[0]).toBe('test-tenant');
    });

    it('should filter by subject', async () => {
      mock.setNextResult({ results: [], success: true });

      await store.query({ subject: 'testing' });

      expect(mock.calls[0].sql).toContain('AND subject = ?');
      expect(mock.calls[0].bindings[1]).toBe('testing');
    });

    it('should filter by category', async () => {
      mock.setNextResult({ results: [], success: true });

      await store.query({ category: 'methodology' });

      expect(mock.calls[0].sql).toContain('AND category = ?');
      expect(mock.calls[0].bindings[1]).toBe('methodology');
    });

    it('should filter by both subject and category', async () => {
      mock.setNextResult({ results: [], success: true });

      await store.query({ subject: 'testing', category: 'methodology' });

      expect(mock.calls[0].sql).toContain('AND subject = ?');
      expect(mock.calls[0].sql).toContain('AND category = ?');
      expect(mock.calls[0].bindings[1]).toBe('testing');
      expect(mock.calls[0].bindings[2]).toBe('methodology');
    });

    it('should respect limit and offset', async () => {
      mock.setNextResult({ results: [], success: true });

      await store.query({ limit: 20, offset: 100 });

      const bindings = mock.calls[0].bindings;
      expect(bindings[bindings.length - 2]).toBe(20); // limit
      expect(bindings[bindings.length - 1]).toBe(100); // offset
    });

    it('should convert rows to SemanticMemory objects', async () => {
      const mockRow = {
        id: 'fact-id',
        tenant_id: 'test-tenant',
        machine_id: 'test-machine',
        session_id: 'test-session',
        layer: 'semantic',
        fact: 'Test fact',
        subject: 'testing',
        predicate: 'is',
        object: 'important',
        category: 'methodology',
        source_episode_ids: '[]',
        tags: '["tag1"]',
        provenance: JSON.stringify(createTestProvenance()),
        salience: JSON.stringify(createTestSalience()),
        created_at: '2025-01-15T10:00:00Z',
        updated_at: '2025-01-15T10:01:00Z',
      };

      mock.setNextResult({ results: [mockRow], success: true });

      const results = await store.query({});

      expect(results.length).toBe(1);
      expect(results[0].memory_id.id).toBe('fact-id');
      expect(results[0].content.fact).toBe('Test fact');
      expect(results[0].content.subject).toBe('testing');
    });
  });

  describe('getById', () => {
    it('should query by id and tenant_id', async () => {
      mock.setNextResult({ results: [], success: true });

      await store.getById('fact-123');

      expect(mock.calls[0].sql).toContain('WHERE id = ? AND tenant_id = ?');
      expect(mock.calls[0].bindings[0]).toBe('fact-123');
      expect(mock.calls[0].bindings[1]).toBe('test-tenant');
    });

    it('should return null when not found', async () => {
      mock.setNextResult({ results: [], success: true });

      const result = await store.getById('nonexistent');

      expect(result).toBe(null);
    });

    it('should return SemanticMemory when found', async () => {
      const mockRow = {
        id: 'fact-id',
        tenant_id: 'test-tenant',
        machine_id: 'test-machine',
        session_id: 'test-session',
        layer: 'semantic',
        fact: 'Test fact',
        subject: null,
        predicate: null,
        object: null,
        category: null,
        source_episode_ids: null,
        tags: null,
        provenance: JSON.stringify(createTestProvenance()),
        salience: JSON.stringify(createTestSalience()),
        created_at: '2025-01-15T10:00:00Z',
        updated_at: '2025-01-15T10:01:00Z',
      };

      mock.setNextResult({ results: [mockRow], success: true });

      const result = await store.getById('fact-id');

      expect(result).not.toBe(null);
      expect(result?.memory_id.id).toBe('fact-id');
      expect(result?.content.subject).toBe(undefined);
      expect(result?.tags).toEqual([]);
    });
  });

  describe('getBySubject', () => {
    it('should call query with subject', async () => {
      mock.setNextResult({ results: [], success: true });

      await store.getBySubject('testing');

      expect(mock.calls[0].sql).toContain('AND subject = ?');
      expect(mock.calls[0].bindings[1]).toBe('testing');
    });
  });

  describe('getByCategory', () => {
    it('should call query with category', async () => {
      mock.setNextResult({ results: [], success: true });

      await store.getByCategory('methodology');

      expect(mock.calls[0].sql).toContain('AND category = ?');
      expect(mock.calls[0].bindings[1]).toBe('methodology');
    });
  });

  describe('delete', () => {
    it('should delete by id and tenant_id', async () => {
      mock.setNextResult({ success: true, meta: { changes: 1, duration: 0, last_row_id: 0, changed_db: true, size_after: 0, rows_read: 0, rows_written: 1 } });

      await store.delete('fact-123');

      expect(mock.calls[0].sql).toContain('DELETE FROM semantic_memories WHERE id = ? AND tenant_id = ?');
      expect(mock.calls[0].bindings[0]).toBe('fact-123');
      expect(mock.calls[0].bindings[1]).toBe('test-tenant');
    });

    it('should return true when row deleted', async () => {
      mock.setNextResult({ success: true, meta: { changes: 1, duration: 0, last_row_id: 0, changed_db: true, size_after: 0, rows_read: 0, rows_written: 1 } });

      const result = await store.delete('fact-123');

      expect(result).toBe(true);
    });

    it('should return false when no row deleted', async () => {
      mock.setNextResult({ success: true, meta: { changes: 0, duration: 0, last_row_id: 0, changed_db: false, size_after: 0, rows_read: 0, rows_written: 0 } });

      const result = await store.delete('nonexistent');

      expect(result).toBe(false);
    });
  });

  describe('deleteBySession', () => {
    it('should delete by session_id and tenant_id', async () => {
      mock.setNextResult({ success: true, meta: { changes: 2, duration: 0, last_row_id: 0, changed_db: true, size_after: 0, rows_read: 0, rows_written: 2 } });

      await store.deleteBySession('session-123');

      expect(mock.calls[0].sql).toContain('DELETE FROM semantic_memories WHERE session_id = ? AND tenant_id = ?');
      expect(mock.calls[0].bindings[0]).toBe('session-123');
      expect(mock.calls[0].bindings[1]).toBe('test-tenant');
    });

    it('should return count of deleted rows', async () => {
      mock.setNextResult({ success: true, meta: { changes: 7, duration: 0, last_row_id: 0, changed_db: true, size_after: 0, rows_read: 0, rows_written: 7 } });

      const result = await store.deleteBySession('session-123');

      expect(result).toBe(7);
    });
  });

  describe('count', () => {
    it('should query count with tenant_id', async () => {
      mock.setNextResult({ results: [{ count: 100 }], success: true });

      await store.count();

      expect(mock.calls[0].sql).toContain('SELECT COUNT(*) as count FROM semantic_memories WHERE tenant_id = ?');
      expect(mock.calls[0].bindings[0]).toBe('test-tenant');
    });

    it('should return count', async () => {
      mock.setNextResult({ results: [{ count: 100 }], success: true });

      const result = await store.count();

      expect(result).toBe(100);
    });

    it('should return 0 when no result', async () => {
      mock.setNextResult({ results: [], success: true });

      const result = await store.count();

      expect(result).toBe(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────
// Row Converter Tests
// ─────────────────────────────────────────────────────────────

describe('Row converters', () => {
  let mock: ReturnType<typeof createMockD1>;
  let episodicStore: D1EpisodicStore;
  let semanticStore: D1SemanticStore;

  beforeEach(() => {
    mock = createMockD1();
    episodicStore = new D1EpisodicStore(mock.db as any, {
      tenantId: 'test-tenant',
      machineId: 'test-machine',
    });
    semanticStore = new D1SemanticStore(mock.db as any, {
      tenantId: 'test-tenant',
      machineId: 'test-machine',
      sessionId: 'test-session',
    });
  });

  describe('rowToEpisodic', () => {
    it('should handle all fields including null entities and valence', async () => {
      const mockRow = {
        id: 'episode-id',
        tenant_id: 'test-tenant',
        machine_id: 'test-machine',
        session_id: 'test-session',
        layer: 'episodic',
        event: 'Event text',
        summary: 'Summary text',
        entities: null,
        valence: null,
        tags: '["tag1", "tag2"]',
        consolidated: 1,
        started_at: '2025-01-15T10:00:00Z',
        ended_at: null,
        provenance: JSON.stringify(createTestProvenance()),
        salience: JSON.stringify(createTestSalience()),
        created_at: '2025-01-15T10:00:00Z',
        updated_at: '2025-01-15T10:01:00Z',
      };

      mock.setNextResult({ results: [mockRow], success: true });

      const results = await episodicStore.query({});

      expect(results.length).toBe(1);
      expect(results[0].content.entities).toEqual([]);
      expect(results[0].content.valence).toBe(0);
      expect(results[0].tags).toEqual(['tag1', 'tag2']);
      expect(results[0].consolidated).toBe(true);
      expect(results[0].ended_at).toBe(undefined);
    });

    it('should parse dates correctly', async () => {
      const mockRow = {
        id: 'episode-id',
        tenant_id: 'test-tenant',
        machine_id: 'test-machine',
        session_id: 'test-session',
        layer: 'episodic',
        event: 'Event',
        summary: 'Summary',
        entities: null,
        valence: 0,
        tags: null,
        consolidated: 0,
        started_at: '2025-01-15T10:00:00Z',
        ended_at: '2025-01-15T11:00:00Z',
        provenance: JSON.stringify(createTestProvenance()),
        salience: JSON.stringify(createTestSalience()),
        created_at: '2025-01-15T10:00:00Z',
        updated_at: '2025-01-15T10:01:00Z',
      };

      mock.setNextResult({ results: [mockRow], success: true });

      const results = await episodicStore.query({});

      expect(results[0].memory_id.created_at).toBeInstanceOf(Date);
      expect(results[0].started_at).toBeInstanceOf(Date);
      expect(results[0].ended_at).toBeInstanceOf(Date);
      expect(results[0].ended_at?.toISOString()).toBe('2025-01-15T11:00:00.000Z');
    });
  });

  describe('rowToSemantic', () => {
    it('should handle null subject/predicate/object/category', async () => {
      const mockRow = {
        id: 'fact-id',
        tenant_id: 'test-tenant',
        machine_id: 'test-machine',
        session_id: 'test-session',
        layer: 'semantic',
        fact: 'Fact text',
        subject: null,
        predicate: null,
        object: null,
        category: null,
        source_episode_ids: '[]',
        tags: '["tag1"]',
        provenance: JSON.stringify(createTestProvenance()),
        salience: JSON.stringify(createTestSalience()),
        created_at: '2025-01-15T10:00:00Z',
        updated_at: '2025-01-15T10:01:00Z',
      };

      mock.setNextResult({ results: [mockRow], success: true });

      const results = await semanticStore.query({});

      expect(results.length).toBe(1);
      expect(results[0].content.subject).toBe(undefined);
      expect(results[0].content.predicate).toBe(undefined);
      expect(results[0].content.object).toBe(undefined);
      expect(results[0].content.category).toBe(undefined);
    });

    it('should parse source_episode_ids with dates', async () => {
      const sourceId: MemoryID = {
        id: 'episode-1',
        layer: 'episodic',
        source_machine: 'machine-1',
        source_session: 'session-1',
        created_at: new Date('2025-01-15T09:00:00Z'),
      };

      const mockRow = {
        id: 'fact-id',
        tenant_id: 'test-tenant',
        machine_id: 'test-machine',
        session_id: 'test-session',
        layer: 'semantic',
        fact: 'Fact text',
        subject: 'subject',
        predicate: 'predicate',
        object: 'object',
        category: 'category',
        source_episode_ids: JSON.stringify([{
          ...sourceId,
          created_at: sourceId.created_at.toISOString(),
        }]),
        tags: null,
        provenance: JSON.stringify(createTestProvenance()),
        salience: JSON.stringify(createTestSalience()),
        created_at: '2025-01-15T10:00:00Z',
        updated_at: '2025-01-15T10:01:00Z',
      };

      mock.setNextResult({ results: [mockRow], success: true });

      const results = await semanticStore.query({});

      expect(results[0].source_episode_ids.length).toBe(1);
      expect(results[0].source_episode_ids[0].id).toBe('episode-1');
      expect(results[0].source_episode_ids[0].created_at).toBeInstanceOf(Date);
    });

    it('should handle malformed source_episode_ids JSON', async () => {
      const mockRow = {
        id: 'fact-id',
        tenant_id: 'test-tenant',
        machine_id: 'test-machine',
        session_id: 'test-session',
        layer: 'semantic',
        fact: 'Fact text',
        subject: null,
        predicate: null,
        object: null,
        category: null,
        source_episode_ids: 'invalid json',
        tags: null,
        provenance: JSON.stringify(createTestProvenance()),
        salience: JSON.stringify(createTestSalience()),
        created_at: '2025-01-15T10:00:00Z',
        updated_at: '2025-01-15T10:01:00Z',
      };

      mock.setNextResult({ results: [mockRow], success: true });

      const results = await semanticStore.query({});

      expect(results[0].source_episode_ids).toEqual([]);
    });
  });

  describe('parseProvenance', () => {
    it('should handle valid JSON', async () => {
      const provenance = createTestProvenance();
      const mockRow = {
        id: 'episode-id',
        tenant_id: 'test-tenant',
        machine_id: 'test-machine',
        session_id: 'test-session',
        layer: 'episodic',
        event: 'Event',
        summary: 'Summary',
        entities: null,
        valence: 0,
        tags: null,
        consolidated: 0,
        started_at: '2025-01-15T10:00:00Z',
        ended_at: null,
        provenance: JSON.stringify({
          ...provenance,
          last_validated: provenance.last_validated.toISOString(),
        }),
        salience: JSON.stringify(createTestSalience()),
        created_at: '2025-01-15T10:00:00Z',
        updated_at: '2025-01-15T10:01:00Z',
      };

      mock.setNextResult({ results: [mockRow], success: true });

      const results = await episodicStore.query({});

      expect(results[0].provenance.derivation_type).toBe('direct');
      expect(results[0].provenance.confidence).toBe(0.9);
      expect(results[0].provenance.last_validated).toBeInstanceOf(Date);
    });

    it('should fall back to defaults on error', async () => {
      const mockRow = {
        id: 'episode-id',
        tenant_id: 'test-tenant',
        machine_id: 'test-machine',
        session_id: 'test-session',
        layer: 'episodic',
        event: 'Event',
        summary: 'Summary',
        entities: null,
        valence: 0,
        tags: null,
        consolidated: 0,
        started_at: '2025-01-15T10:00:00Z',
        ended_at: null,
        provenance: 'invalid json',
        salience: JSON.stringify(createTestSalience()),
        created_at: '2025-01-15T10:00:00Z',
        updated_at: '2025-01-15T10:01:00Z',
      };

      mock.setNextResult({ results: [mockRow], success: true });

      const results = await episodicStore.query({});

      expect(results[0].provenance.derivation_type).toBe('direct');
      expect(results[0].provenance.confidence).toBe(1.0);
      expect(results[0].provenance.retracted).toBe(false);
    });
  });

  describe('parseSalience', () => {
    it('should handle valid JSON', async () => {
      const salience = createTestSalience();
      const mockRow = {
        id: 'episode-id',
        tenant_id: 'test-tenant',
        machine_id: 'test-machine',
        session_id: 'test-session',
        layer: 'episodic',
        event: 'Event',
        summary: 'Summary',
        entities: null,
        valence: 0,
        tags: null,
        consolidated: 0,
        started_at: '2025-01-15T10:00:00Z',
        ended_at: null,
        provenance: JSON.stringify(createTestProvenance()),
        salience: JSON.stringify({
          ...salience,
          signals: {
            ...salience.signals,
            last_accessed: salience.signals.last_accessed.toISOString(),
          },
          instrumentation: {
            ...salience.instrumentation,
            computed_at: salience.instrumentation.computed_at.toISOString(),
          },
        }),
        created_at: '2025-01-15T10:00:00Z',
        updated_at: '2025-01-15T10:01:00Z',
      };

      mock.setNextResult({ results: [mockRow], success: true });

      const results = await episodicStore.query({});

      expect(results[0].salience.current_score).toBe(0.65);
      expect(results[0].salience.signals.novelty_score).toBe(0.7);
      expect(results[0].salience.signals.last_accessed).toBeInstanceOf(Date);
      expect(results[0].salience.instrumentation.computed_at).toBeInstanceOf(Date);
    });

    it('should fall back to defaults on error', async () => {
      const mockRow = {
        id: 'episode-id',
        tenant_id: 'test-tenant',
        machine_id: 'test-machine',
        session_id: 'test-session',
        layer: 'episodic',
        event: 'Event',
        summary: 'Summary',
        entities: null,
        valence: 0,
        tags: null,
        consolidated: 0,
        started_at: '2025-01-15T10:00:00Z',
        ended_at: null,
        provenance: JSON.stringify(createTestProvenance()),
        salience: 'invalid json',
        created_at: '2025-01-15T10:00:00Z',
        updated_at: '2025-01-15T10:01:00Z',
      };

      mock.setNextResult({ results: [mockRow], success: true });

      const results = await episodicStore.query({});

      expect(results[0].salience.current_score).toBe(0.5);
      expect(results[0].salience.signals.novelty_score).toBe(0.5);
      expect(results[0].salience.signals.access_count).toBe(0);
    });
  });
});

// ─────────────────────────────────────────────────────────────
// Tenant Isolation Tests
// ─────────────────────────────────────────────────────────────

describe('Tenant isolation', () => {
  let mock: ReturnType<typeof createMockD1>;

  beforeEach(() => {
    mock = createMockD1();
  });

  it('should isolate episodic queries by tenant_id', async () => {
    const store1 = new D1EpisodicStore(mock.db as any, {
      tenantId: 'tenant-1',
      machineId: 'machine',
    });

    const store2 = new D1EpisodicStore(mock.db as any, {
      tenantId: 'tenant-2',
      machineId: 'machine',
    });

    mock.setNextResult({ results: [], success: true });
    await store1.query({});
    expect(mock.calls[0].bindings[0]).toBe('tenant-1');

    mock.reset();
    mock.setNextResult({ results: [], success: true });
    await store2.query({});
    expect(mock.calls[0].bindings[0]).toBe('tenant-2');
  });

  it('should isolate semantic queries by tenant_id', async () => {
    const store1 = new D1SemanticStore(mock.db as any, {
      tenantId: 'tenant-1',
      machineId: 'machine',
      sessionId: 'session',
    });

    const store2 = new D1SemanticStore(mock.db as any, {
      tenantId: 'tenant-2',
      machineId: 'machine',
      sessionId: 'session',
    });

    mock.setNextResult({ results: [], success: true });
    await store1.query({});
    expect(mock.calls[0].bindings[0]).toBe('tenant-1');

    mock.reset();
    mock.setNextResult({ results: [], success: true });
    await store2.query({});
    expect(mock.calls[0].bindings[0]).toBe('tenant-2');
  });

  it('should verify every query includes tenant_id parameter', async () => {
    const episodicStore = new D1EpisodicStore(mock.db as any, {
      tenantId: 'test-tenant',
      machineId: 'machine',
    });

    const semanticStore = new D1SemanticStore(mock.db as any, {
      tenantId: 'test-tenant',
      machineId: 'machine',
      sessionId: 'session',
    });

    mock.setNextResult({ results: [], success: true });

    // Test all episodic operations
    await episodicStore.query({});
    expect(mock.calls[0].sql).toContain('tenant_id');
    expect(mock.calls[0].bindings).toContain('test-tenant');

    mock.reset();
    mock.setNextResult({ results: [], success: true });
    await episodicStore.getById('id');
    expect(mock.calls[0].sql).toContain('tenant_id');
    expect(mock.calls[0].bindings).toContain('test-tenant');

    mock.reset();
    mock.setNextResult({ success: true, meta: { changes: 0, duration: 0, last_row_id: 0, changed_db: false, size_after: 0, rows_read: 0, rows_written: 0 } });
    await episodicStore.delete('id');
    expect(mock.calls[0].sql).toContain('tenant_id');
    expect(mock.calls[0].bindings).toContain('test-tenant');

    mock.reset();
    mock.setNextResult({ success: true, meta: { changes: 0, duration: 0, last_row_id: 0, changed_db: false, size_after: 0, rows_read: 0, rows_written: 0 } });
    await episodicStore.deleteBySession('session');
    expect(mock.calls[0].sql).toContain('tenant_id');
    expect(mock.calls[0].bindings).toContain('test-tenant');

    mock.reset();
    mock.setNextResult({ results: [{ count: 0 }], success: true });
    await episodicStore.count();
    expect(mock.calls[0].sql).toContain('tenant_id');
    expect(mock.calls[0].bindings).toContain('test-tenant');

    // Test all semantic operations
    mock.reset();
    mock.setNextResult({ results: [], success: true });
    await semanticStore.query({});
    expect(mock.calls[0].sql).toContain('tenant_id');
    expect(mock.calls[0].bindings).toContain('test-tenant');

    mock.reset();
    mock.setNextResult({ results: [], success: true });
    await semanticStore.getById('id');
    expect(mock.calls[0].sql).toContain('tenant_id');
    expect(mock.calls[0].bindings).toContain('test-tenant');

    mock.reset();
    mock.setNextResult({ success: true, meta: { changes: 0, duration: 0, last_row_id: 0, changed_db: false, size_after: 0, rows_read: 0, rows_written: 0 } });
    await semanticStore.delete('id');
    expect(mock.calls[0].sql).toContain('tenant_id');
    expect(mock.calls[0].bindings).toContain('test-tenant');

    mock.reset();
    mock.setNextResult({ success: true, meta: { changes: 0, duration: 0, last_row_id: 0, changed_db: false, size_after: 0, rows_read: 0, rows_written: 0 } });
    await semanticStore.deleteBySession('session');
    expect(mock.calls[0].sql).toContain('tenant_id');
    expect(mock.calls[0].bindings).toContain('test-tenant');

    mock.reset();
    mock.setNextResult({ results: [{ count: 0 }], success: true });
    await semanticStore.count();
    expect(mock.calls[0].sql).toContain('tenant_id');
    expect(mock.calls[0].bindings).toContain('test-tenant');
  });
});

// ─────────────────────────────────────────────────────────────
// SCHEMA Tests
// ─────────────────────────────────────────────────────────────

describe('SCHEMA constant', () => {
  it('should contain episodic_memories table', () => {
    expect(SCHEMA).toContain('CREATE TABLE IF NOT EXISTS episodic_memories');
  });

  it('should contain semantic_memories table', () => {
    expect(SCHEMA).toContain('CREATE TABLE IF NOT EXISTS semantic_memories');
  });

  it('should contain tenants table', () => {
    expect(SCHEMA).toContain('CREATE TABLE IF NOT EXISTS tenants');
  });

  it('should contain expected indexes', () => {
    expect(SCHEMA).toContain('idx_episodic_tenant');
    expect(SCHEMA).toContain('idx_episodic_session');
    expect(SCHEMA).toContain('idx_episodic_created');
    expect(SCHEMA).toContain('idx_semantic_tenant');
    expect(SCHEMA).toContain('idx_semantic_subject');
    expect(SCHEMA).toContain('idx_semantic_category');
    expect(SCHEMA).toContain('idx_tenants_api_key');
  });

  it('should have tenant_id as NOT NULL in all memory tables', () => {
    expect(SCHEMA).toMatch(/episodic_memories.*\n.*tenant_id TEXT NOT NULL/s);
    expect(SCHEMA).toMatch(/semantic_memories.*\n.*tenant_id TEXT NOT NULL/s);
  });
});
