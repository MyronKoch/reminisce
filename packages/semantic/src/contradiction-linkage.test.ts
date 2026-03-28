/**
 * Tests for contradiction linkage fix and OFFSET-without-LIMIT fix.
 *
 * Covers:
 * 1. FactInput.contradictionIds wiring into provenance.contradiction_ids
 * 2. OFFSET-without-LIMIT behavior in SQLite stores (guard against invalid SQL)
 * 3. OFFSET+LIMIT pagination behavior in both in-memory and SQLite stores
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { InMemorySemanticStore } from './store.js';
import type { FactInput } from './store.js';
import type { MemoryID } from '@reminisce/core';
import { createMemoryID } from '@reminisce/core';
import { InMemoryEpisodicStore } from '@reminisce/episodic';
import { SqliteEpisodicStore } from '@reminisce/storage-sqlite';
import { SqliteSemanticStore } from '@reminisce/storage-sqlite';

// ── Helpers ──────────────────────────────────────────────────────────

function makeSourceEpisodeId(label: string): MemoryID {
  return {
    id: `ep-${label}`,
    layer: 'episodic',
    created_at: new Date(),
    source_session: 'test-session',
    source_machine: 'test-machine',
  };
}

function makeContradictionId(label: string): MemoryID {
  return {
    id: `contra-${label}`,
    layer: 'semantic',
    created_at: new Date(),
    source_session: 'test-session',
    source_machine: 'test-machine',
  };
}

function baseFact(overrides: Partial<FactInput> = {}): FactInput {
  return {
    fact: 'User prefers TypeScript',
    subject: 'user',
    predicate: 'prefers',
    object: 'TypeScript',
    sourceEpisodeIds: [makeSourceEpisodeId('1')],
    ...overrides,
  };
}

// ── 1. FactInput.contradictionIds wiring ─────────────────────────────

describe('FactInput.contradictionIds wiring', () => {
  let store: InMemorySemanticStore;

  beforeEach(() => {
    store = new InMemorySemanticStore({
      machineId: 'test-machine',
      sessionId: 'test-session',
    });
  });

  it('stores a fact WITH contradictionIds and they appear in provenance', async () => {
    const contraId1 = makeContradictionId('old-pref');
    const contraId2 = makeContradictionId('old-pref-2');

    const stored = await store.store(baseFact({
      contradictionIds: [contraId1, contraId2],
    }));

    expect(stored.provenance.contradiction_ids).toBeDefined();
    expect(stored.provenance.contradiction_ids).toHaveLength(2);
    expect(stored.provenance.contradiction_ids[0]!.id).toBe('contra-old-pref');
    expect(stored.provenance.contradiction_ids[1]!.id).toBe('contra-old-pref-2');
  });

  it('stores a fact WITHOUT contradictionIds and provenance.contradiction_ids is empty', async () => {
    const stored = await store.store(baseFact());

    expect(stored.provenance.contradiction_ids).toBeDefined();
    expect(stored.provenance.contradiction_ids).toHaveLength(0);
  });

  it('stores a fact with empty contradictionIds array and it remains empty', async () => {
    const stored = await store.store(baseFact({
      contradictionIds: [],
    }));

    expect(stored.provenance.contradiction_ids).toBeDefined();
    expect(stored.provenance.contradiction_ids).toHaveLength(0);
  });

  it('stores a fact with multiple contradictionIds and all appear in provenance', async () => {
    const ids = ['a', 'b', 'c', 'd'].map(label => makeContradictionId(label));

    const stored = await store.store(baseFact({
      contradictionIds: ids,
    }));

    expect(stored.provenance.contradiction_ids).toHaveLength(4);
    const storedIds = stored.provenance.contradiction_ids.map(id => id.id);
    expect(storedIds).toContain('contra-a');
    expect(storedIds).toContain('contra-b');
    expect(storedIds).toContain('contra-c');
    expect(storedIds).toContain('contra-d');
  });

  it('persists contradictionIds through get() retrieval', async () => {
    const contraId = makeContradictionId('persist-test');

    const stored = await store.store(baseFact({
      contradictionIds: [contraId],
    }));

    const retrieved = await store.get(stored.memory_id.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.provenance.contradiction_ids).toHaveLength(1);
    expect(retrieved!.provenance.contradiction_ids[0]!.id).toBe('contra-persist-test');
  });

  it('persists contradictionIds through query() retrieval', async () => {
    const contraId = makeContradictionId('query-test');

    await store.store(baseFact({
      contradictionIds: [contraId],
    }));

    const results = await store.query({ subject: 'user' });
    expect(results).toHaveLength(1);
    expect(results[0]!.provenance.contradiction_ids).toHaveLength(1);
    expect(results[0]!.provenance.contradiction_ids[0]!.id).toBe('contra-query-test');
  });
});

// ── 2. OFFSET-without-LIMIT in InMemoryEpisodicStore ─────────────────

describe('InMemoryEpisodicStore offset/limit pagination', () => {
  let store: InMemoryEpisodicStore;

  beforeEach(async () => {
    store = new InMemoryEpisodicStore({ machineId: 'test-machine' });

    // Insert 10 episodes
    for (let i = 0; i < 10; i++) {
      await store.store({
        event: `event-${i}`,
        summary: `Summary ${i}`,
        sessionId: 'test-session',
      });
    }
  });

  it('query with offset but no limit returns results with offset applied', async () => {
    // The in-memory store applies offset independently via slice
    const allResults = await store.query({});
    const offsetResults = await store.query({ offset: 5 });

    expect(allResults).toHaveLength(10);
    expect(offsetResults).toHaveLength(5);
  });

  it('query with both offset and limit paginates correctly', async () => {
    const results = await store.query({ offset: 2, limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('query with limit only returns limited results', async () => {
    const results = await store.query({ limit: 4 });
    expect(results).toHaveLength(4);
  });

  it('query with no offset or limit returns all results', async () => {
    const results = await store.query({});
    expect(results).toHaveLength(10);
  });
});

// ── 3. OFFSET-without-LIMIT in InMemorySemanticStore ─────────────────

describe('InMemorySemanticStore offset/limit pagination', () => {
  let store: InMemorySemanticStore;

  beforeEach(async () => {
    store = new InMemorySemanticStore({
      machineId: 'test-machine',
      sessionId: 'test-session',
    });

    // Insert 10 facts
    for (let i = 0; i < 10; i++) {
      await store.store({
        fact: `Fact number ${i}`,
        subject: 'system',
        predicate: 'has_property',
        object: `property-${i}`,
        sourceEpisodeIds: [makeSourceEpisodeId(`src-${i}`)],
      });
    }
  });

  it('query with offset but no limit returns results with offset applied', async () => {
    const allResults = await store.query({});
    const offsetResults = await store.query({ offset: 5 });

    expect(allResults).toHaveLength(10);
    expect(offsetResults).toHaveLength(5);
  });

  it('query with both offset and limit paginates correctly', async () => {
    const results = await store.query({ offset: 2, limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('query with limit only returns limited results', async () => {
    const results = await store.query({ limit: 4 });
    expect(results).toHaveLength(4);
  });

  it('query with no offset or limit returns all results', async () => {
    const results = await store.query({});
    expect(results).toHaveLength(10);
  });
});

// ── 4. OFFSET-without-LIMIT fix in SqliteEpisodicStore ───────────────
// The fix: OFFSET is only added to SQL when LIMIT is also present.
// Without this fix, SQL `SELECT ... OFFSET 5` without LIMIT is invalid in SQLite.

describe('SqliteEpisodicStore OFFSET-without-LIMIT fix', () => {
  let store: SqliteEpisodicStore;

  beforeEach(async () => {
    store = new SqliteEpisodicStore(':memory:', { machineId: 'test-machine' });

    // Insert 10 episodes
    for (let i = 0; i < 10; i++) {
      await store.store({
        event: `event-${i}`,
        summary: `Summary for event ${i}`,
        sessionId: 'test-session',
      });
    }
  });

  it('query with offset but NO limit returns ALL results (offset ignored safely)', async () => {
    // The SQLite fix guards: `if (query.offset && query.limit)` — so offset
    // is silently ignored when there's no limit. This prevents invalid SQL.
    const results = await store.query({ offset: 5 });

    // All 10 results returned because OFFSET without LIMIT is a no-op
    expect(results).toHaveLength(10);
  });

  it('query with both offset and limit paginates correctly', async () => {
    const results = await store.query({ offset: 2, limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('query with limit only returns limited results', async () => {
    const results = await store.query({ limit: 4 });
    expect(results).toHaveLength(4);
  });

  it('query with no offset or limit returns all results', async () => {
    const results = await store.query({});
    expect(results).toHaveLength(10);
  });

  it('query with offset=0 and limit returns correct results', async () => {
    const results = await store.query({ offset: 0, limit: 5 });
    // offset=0 is falsy, so OFFSET clause is not added; we still get the first 5
    expect(results).toHaveLength(5);
  });
});

// ── 5. OFFSET-without-LIMIT fix in SqliteSemanticStore ───────────────

describe('SqliteSemanticStore OFFSET-without-LIMIT fix', () => {
  let store: SqliteSemanticStore;

  beforeEach(async () => {
    store = new SqliteSemanticStore(':memory:', {
      machineId: 'test-machine',
      sessionId: 'test-session',
    });

    // Insert 10 facts
    for (let i = 0; i < 10; i++) {
      await store.store({
        fact: `Fact number ${i}`,
        subject: 'system',
        predicate: 'has_property',
        object: `property-${i}`,
        sourceEpisodeIds: [makeSourceEpisodeId(`src-${i}`)],
      });
    }
  });

  it('query with offset but NO limit returns ALL results (offset ignored safely)', async () => {
    // Same fix as episodic: OFFSET without LIMIT is silently ignored
    const results = await store.query({ offset: 5 });

    // All 10 results returned because OFFSET without LIMIT is a no-op
    expect(results).toHaveLength(10);
  });

  it('query with both offset and limit paginates correctly', async () => {
    const results = await store.query({ offset: 2, limit: 3 });
    expect(results).toHaveLength(3);
  });

  it('query with limit only returns limited results', async () => {
    const results = await store.query({ limit: 4 });
    expect(results).toHaveLength(4);
  });

  it('query with no offset or limit returns all results', async () => {
    const results = await store.query({});
    expect(results).toHaveLength(10);
  });

  it('query with offset=0 and limit returns correct results', async () => {
    const results = await store.query({ offset: 0, limit: 5 });
    // offset=0 is falsy, so OFFSET clause is not added; we still get the first 5
    expect(results).toHaveLength(5);
  });
});
