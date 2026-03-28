import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SqliteSemanticStore } from './semantic-store.js';
import { existsSync, unlinkSync } from 'fs';
import type { FactInput } from '@reminisce/semantic';

const TEST_DB = '/tmp/reminisce-semantic-test.db';
const MACHINE_ID = 'test-machine';
const SESSION_ID = 'test-session';

describe('SqliteSemanticStore', () => {
  let store: SqliteSemanticStore;

  beforeEach(() => {
    // Clean up any existing test database
    if (existsSync(TEST_DB)) {
      unlinkSync(TEST_DB);
    }
    if (existsSync(`${TEST_DB}-wal`)) {
      unlinkSync(`${TEST_DB}-wal`);
    }
    if (existsSync(`${TEST_DB}-shm`)) {
      unlinkSync(`${TEST_DB}-shm`);
    }
    store = new SqliteSemanticStore(TEST_DB, {
      machineId: MACHINE_ID,
      sessionId: SESSION_ID,
    });
  });

  afterEach(() => {
    store.close();
    // Clean up test database
    if (existsSync(TEST_DB)) {
      unlinkSync(TEST_DB);
    }
    if (existsSync(`${TEST_DB}-wal`)) {
      unlinkSync(`${TEST_DB}-wal`);
    }
    if (existsSync(`${TEST_DB}-shm`)) {
      unlinkSync(`${TEST_DB}-shm`);
    }
  });

  describe('store', () => {
    it('should store a fact', async () => {
      const input: FactInput = {
        fact: 'User prefers TypeScript',
        subject: 'user',
        predicate: 'prefers',
        object: 'TypeScript',
        sourceEpisodeIds: [],
      };

      const fact = await store.store(input);

      expect(fact.memory_id.layer).toBe('semantic');
      expect(fact.content.fact).toBe('User prefers TypeScript');
      expect(fact.content.subject).toBe('user');
      expect(fact.content.predicate).toBe('prefers');
      expect(fact.content.object).toBe('TypeScript');
    });

    it('should store fact with category and tags', async () => {
      const input: FactInput = {
        fact: 'System uses bun',
        category: 'technical',
        tags: ['stack', 'tooling'],
        sourceEpisodeIds: [],
      };

      const fact = await store.store(input);

      expect(fact.content.category).toBe('technical');
      expect(fact.tags).toEqual(['stack', 'tooling']);
    });

    it('should store fact with custom confidence', async () => {
      const input: FactInput = {
        fact: 'User might like Python',
        confidence: 0.6,
        sourceEpisodeIds: [],
      };

      const fact = await store.store(input);

      expect(fact.provenance.confidence).toBe(0.6);
    });
  });

  describe('get', () => {
    it('should retrieve stored fact by ID', async () => {
      const input: FactInput = {
        fact: 'Retrieve test fact',
        sourceEpisodeIds: [],
      };

      const stored = await store.store(input);
      const retrieved = await store.get(stored.memory_id.id);

      expect(retrieved).toBeDefined();
      expect(retrieved!.content.fact).toBe('Retrieve test fact');
    });

    it('should return undefined for non-existent ID', async () => {
      const result = await store.get('non-existent-id');
      expect(result).toBeUndefined();
    });
  });

  describe('query', () => {
    beforeEach(async () => {
      await store.store({
        fact: 'User prefers TypeScript',
        subject: 'user',
        predicate: 'prefers',
        object: 'TypeScript',
        category: 'preferences',
        sourceEpisodeIds: [],
      });
      await store.store({
        fact: 'User prefers dark mode',
        subject: 'user',
        predicate: 'prefers',
        object: 'dark mode',
        category: 'preferences',
        sourceEpisodeIds: [],
      });
      await store.store({
        fact: 'System uses bun',
        subject: 'system',
        predicate: 'uses',
        object: 'bun',
        category: 'technical',
        sourceEpisodeIds: [],
      });
    });

    it('should query by subject', async () => {
      const results = await store.query({ subject: 'user' });
      expect(results.length).toBe(2);
    });

    it('should query by predicate', async () => {
      const results = await store.query({ predicate: 'prefers' });
      expect(results.length).toBe(2);
    });

    it('should query by category', async () => {
      const results = await store.query({ category: 'technical' });
      expect(results.length).toBe(1);
    });

    it('should query by text', async () => {
      const results = await store.query({ text: 'TypeScript' });
      expect(results.length).toBe(1);
    });
  });

  describe('checkContradiction', () => {
    it('should detect contradiction when same subject+predicate has different object', async () => {
      await store.store({
        fact: 'User prefers TypeScript',
        subject: 'user',
        predicate: 'prefers_language',
        object: 'TypeScript',
        sourceEpisodeIds: [],
      });

      const result = await store.checkContradiction({
        fact: 'User prefers Python',
        subject: 'user',
        predicate: 'prefers_language',
        object: 'Python',
        sourceEpisodeIds: [],
      });

      expect(result.hasContradiction).toBe(true);
      expect(result.conflicts.length).toBe(1);
    });

    it('should not detect contradiction for same fact', async () => {
      await store.store({
        fact: 'User prefers TypeScript',
        subject: 'user',
        predicate: 'prefers_language',
        object: 'TypeScript',
        sourceEpisodeIds: [],
      });

      const result = await store.checkContradiction({
        fact: 'User prefers TypeScript again',
        subject: 'user',
        predicate: 'prefers_language',
        object: 'TypeScript',
        sourceEpisodeIds: [],
      });

      expect(result.hasContradiction).toBe(false);
    });
  });

  describe('retract', () => {
    it('should retract a fact', async () => {
      const fact = await store.store({
        fact: 'Fact to retract',
        sourceEpisodeIds: [],
      });

      const retracted = await store.retract(fact.memory_id.id, 'Outdated information');

      expect(retracted).toBeDefined();
      expect(retracted!.provenance.retracted).toBe(true);
      expect(retracted!.provenance.retracted_reason).toBe('Outdated information');
    });

    it('should exclude retracted facts from default queries', async () => {
      const fact = await store.store({
        fact: 'Fact to hide',
        sourceEpisodeIds: [],
      });

      await store.retract(fact.memory_id.id, 'No longer valid');

      const results = await store.query({});
      expect(results.length).toBe(0);

      const resultsWithRetracted = await store.query({ includeRetracted: true });
      expect(resultsWithRetracted.length).toBe(1);
    });
  });

  describe('supersede', () => {
    it('should supersede a fact with a new one', async () => {
      const oldFact = await store.store({
        fact: 'User uses npm',
        subject: 'user',
        predicate: 'uses',
        object: 'npm',
        sourceEpisodeIds: [],
      });

      const result = await store.supersede(oldFact.memory_id.id, {
        fact: 'User uses bun',
        subject: 'user',
        predicate: 'uses',
        object: 'bun',
        sourceEpisodeIds: [],
      });

      expect(result).toBeDefined();
      expect(result!.old.provenance.retracted).toBe(true);
      expect(result!.old.provenance.superseded_by).toBeDefined();
      expect(result!.new.content.object).toBe('bun');
    });
  });

  describe('linkFacts and getRelated', () => {
    it('should link facts and retrieve related', async () => {
      const fact1 = await store.store({
        fact: 'TypeScript is a language',
        sourceEpisodeIds: [],
      });

      const fact2 = await store.store({
        fact: 'JavaScript is a language',
        sourceEpisodeIds: [],
      });

      await store.linkFacts(fact1.memory_id.id, fact2.memory_id.id);

      const related1 = await store.getRelated(fact1.memory_id.id);
      expect(related1.length).toBe(1);
      expect(related1[0]!.memory_id.id).toBe(fact2.memory_id.id);

      const related2 = await store.getRelated(fact2.memory_id.id);
      expect(related2.length).toBe(1);
      expect(related2[0]!.memory_id.id).toBe(fact1.memory_id.id);
    });
  });

  describe('validate', () => {
    it('should boost confidence when validating', async () => {
      const fact = await store.store({
        fact: 'Fact to validate',
        confidence: 0.5,
        sourceEpisodeIds: [],
      });

      const validated = await store.validate(fact.memory_id.id, 0.2);

      expect(validated).toBeDefined();
      expect(validated!.provenance.confidence).toBeCloseTo(0.7, 1);
    });
  });

  describe('persistence', () => {
    it('should persist data across store instances', async () => {
      const input: FactInput = {
        fact: 'Persistent fact',
        sourceEpisodeIds: [],
      };

      const stored = await store.store(input);
      store.close();

      // Create new store instance
      const newStore = new SqliteSemanticStore(TEST_DB, {
        machineId: MACHINE_ID,
        sessionId: SESSION_ID,
      });

      const retrieved = await newStore.get(stored.memory_id.id);

      expect(retrieved).toBeDefined();
      expect(retrieved!.content.fact).toBe('Persistent fact');

      newStore.close();
    });
  });
});
