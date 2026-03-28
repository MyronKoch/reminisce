import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SqliteEpisodicStore } from './episodic-store.js';
import { existsSync, unlinkSync } from 'fs';
import type { EpisodeInput } from '@reminisce/episodic';

const TEST_DB = '/tmp/reminisce-episodic-test.db';
const MACHINE_ID = 'test-machine';

describe('SqliteEpisodicStore', () => {
  let store: SqliteEpisodicStore;

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
    store = new SqliteEpisodicStore(TEST_DB, { machineId: MACHINE_ID });
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
    it('should store an episode', async () => {
      const input: EpisodeInput = {
        event: 'test_event',
        summary: 'Test episode summary',
        sessionId: 'session-1',
        entities: ['user', 'assistant'],
      };

      const episode = await store.store(input);

      expect(episode.memory_id.layer).toBe('episodic');
      expect(episode.content.event).toBe('test_event');
      expect(episode.content.summary).toBe('Test episode summary');
      expect(episode.session_id).toBe('session-1');
      expect(episode.content.entities).toEqual(['user', 'assistant']);
      expect(episode.consolidated).toBe(false);
    });

    it('should store episode with tags', async () => {
      const input: EpisodeInput = {
        event: 'tagged_event',
        summary: 'Tagged episode',
        sessionId: 'session-1',
        tags: ['important', 'test'],
      };

      const episode = await store.store(input);

      expect(episode.tags).toEqual(['important', 'test']);
    });

    it('should store episode with valence', async () => {
      const input: EpisodeInput = {
        event: 'emotional_event',
        summary: 'Positive episode',
        sessionId: 'session-1',
        valence: 0.8,
      };

      const episode = await store.store(input);

      expect(episode.content.valence).toBe(0.8);
    });
  });

  describe('get', () => {
    it('should retrieve stored episode by ID', async () => {
      const input: EpisodeInput = {
        event: 'retrieve_test',
        summary: 'Episode to retrieve',
        sessionId: 'session-1',
      };

      const stored = await store.store(input);
      const retrieved = await store.get(stored.memory_id.id);

      expect(retrieved).toBeDefined();
      expect(retrieved!.content.event).toBe('retrieve_test');
    });

    it('should return undefined for non-existent ID', async () => {
      const result = await store.get('non-existent-id');
      expect(result).toBeUndefined();
    });

    it('should reinforce salience on retrieval', async () => {
      const input: EpisodeInput = {
        event: 'reinforce_test',
        summary: 'Episode for reinforcement',
        sessionId: 'session-1',
      };

      const stored = await store.store(input);
      const originalScore = stored.salience.current_score;

      const retrieved = await store.get(stored.memory_id.id);
      expect(retrieved!.salience.current_score).toBeGreaterThanOrEqual(originalScore);
    });
  });

  describe('query', () => {
    beforeEach(async () => {
      // Create test episodes in different sessions
      await store.store({
        event: 'event1',
        summary: 'First episode',
        sessionId: 'session-1',
        entities: ['user'],
        tags: ['tag1'],
      });
      await store.store({
        event: 'event2',
        summary: 'Second episode',
        sessionId: 'session-1',
        entities: ['assistant'],
        tags: ['tag2'],
      });
      await store.store({
        event: 'event3',
        summary: 'Third episode',
        sessionId: 'session-2',
        entities: ['user'],
        tags: ['tag1', 'tag2'],
      });
    });

    it('should query by session', async () => {
      const results = await store.query({ sessionId: 'session-1' });
      expect(results.length).toBe(2);
    });

    it('should query by entities', async () => {
      const results = await store.query({ entities: ['user'] });
      expect(results.length).toBe(2);
    });

    it('should query by tags', async () => {
      const results = await store.query({ tags: ['tag1'] });
      expect(results.length).toBe(2);
    });

    it('should apply limit', async () => {
      const results = await store.query({ limit: 1 });
      expect(results.length).toBe(1);
    });
  });

  describe('markConsolidated', () => {
    it('should mark episodes as consolidated', async () => {
      const input: EpisodeInput = {
        event: 'consolidate_test',
        summary: 'Episode to consolidate',
        sessionId: 'session-1',
      };

      const episode = await store.store(input);
      expect(episode.consolidated).toBe(false);

      await store.markConsolidated([episode.memory_id.id], []);

      const retrieved = await store.get(episode.memory_id.id);
      expect(retrieved!.consolidated).toBe(true);
    });
  });

  describe('deleteBySession', () => {
    it('should delete all episodes in a session', async () => {
      await store.store({
        event: 'event1',
        summary: 'Session 1 episode 1',
        sessionId: 'session-to-delete',
      });
      await store.store({
        event: 'event2',
        summary: 'Session 1 episode 2',
        sessionId: 'session-to-delete',
      });
      await store.store({
        event: 'event3',
        summary: 'Other session',
        sessionId: 'session-to-keep',
      });

      const deleted = await store.deleteBySession('session-to-delete');
      expect(deleted).toBe(2);

      const remaining = await store.count();
      expect(remaining).toBe(1);
    });
  });

  describe('storeBatch', () => {
    it('should store multiple episodes in a transaction', async () => {
      const inputs: EpisodeInput[] = [
        { event: 'batch1', summary: 'Batch episode 1', sessionId: 'batch-session' },
        { event: 'batch2', summary: 'Batch episode 2', sessionId: 'batch-session' },
        { event: 'batch3', summary: 'Batch episode 3', sessionId: 'batch-session' },
      ];

      const results = await store.storeBatch(inputs);
      expect(results.length).toBe(3);

      const count = await store.count();
      expect(count).toBe(3);
    });
  });

  describe('persistence', () => {
    it('should persist data across store instances', async () => {
      const input: EpisodeInput = {
        event: 'persist_test',
        summary: 'Episode to persist',
        sessionId: 'persist-session',
      };

      const stored = await store.store(input);
      store.close();

      // Create new store instance
      const newStore = new SqliteEpisodicStore(TEST_DB, { machineId: MACHINE_ID });
      const retrieved = await newStore.get(stored.memory_id.id);

      expect(retrieved).toBeDefined();
      expect(retrieved!.content.event).toBe('persist_test');

      newStore.close();
    });
  });
});
