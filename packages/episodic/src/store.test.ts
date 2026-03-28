/**
 * Tests for Episodic Store
 */

import { describe, test, expect } from 'bun:test';
import { InMemoryEpisodicStore } from './store.js';
import type { WorkingMemoryItem, MemoryID } from '@reminisce/core';
import { createSalience, createSalienceSignals, createProvenance } from '@reminisce/core';

describe('InMemoryEpisodicStore', () => {
  const defaultConfig = { machineId: 'test-machine' };

  test('stores and retrieves episodes', async () => {
    const store = new InMemoryEpisodicStore(defaultConfig);

    const episode = await store.store({
      event: 'user_message',
      summary: 'User said hello',
      sessionId: 'session-1',
    });

    expect(episode.memory_id.layer).toBe('episodic');
    expect(episode.content.event).toBe('user_message');
    expect(episode.consolidated).toBe(false);

    const retrieved = await store.get(episode.memory_id.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.content.summary).toBe('User said hello');
  });

  test('stores batch of episodes', async () => {
    const store = new InMemoryEpisodicStore(defaultConfig);

    const episodes = await store.storeBatch([
      { event: 'event1', summary: 'First', sessionId: 's1' },
      { event: 'event2', summary: 'Second', sessionId: 's1' },
      { event: 'event3', summary: 'Third', sessionId: 's1' },
    ]);

    expect(episodes.length).toBe(3);
    expect(await store.count()).toBe(3);
  });

  test('receives overflow from working memory', async () => {
    const store = new InMemoryEpisodicStore(defaultConfig);

    const workingItem: WorkingMemoryItem = {
      memory_id: {
        id: 'wm-1',
        layer: 'working',
        created_at: new Date(),
        source_session: 'session-1',
        source_machine: 'test',
      } as MemoryID & { layer: 'working' },
      content: {
        type: 'message',
        data: { text: 'Hello' },
        summary: 'Greeting message',
      },
      provenance: createProvenance([], 'direct'),
      salience: createSalience(createSalienceSignals()),
      slot: 0,
      overflowed: true,
    };

    const episodes = await store.receiveOverflow([workingItem]);

    expect(episodes.length).toBe(1);
    expect(episodes[0]!.content.event).toContain('working_memory_overflow');
    expect(episodes[0]!.provenance.source_ids[0]!.id).toBe('wm-1');
  });

  test('queries by session', async () => {
    const store = new InMemoryEpisodicStore(defaultConfig);

    await store.store({ event: 'e1', summary: 's1', sessionId: 'session-a' });
    await store.store({ event: 'e2', summary: 's2', sessionId: 'session-b' });
    await store.store({ event: 'e3', summary: 's3', sessionId: 'session-a' });

    const sessionA = await store.query({ sessionId: 'session-a' });
    expect(sessionA.length).toBe(2);

    const sessionB = await store.query({ sessionId: 'session-b' });
    expect(sessionB.length).toBe(1);
  });

  test('queries by time range', async () => {
    const store = new InMemoryEpisodicStore(defaultConfig);

    const now = new Date();
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

    await store.store({ event: 'old', summary: 'Old event', sessionId: 's1' });

    const recentOnly = await store.query({
      startTime: hourAgo,
      endTime: now,
    });

    expect(recentOnly.length).toBe(1);
  });

  test('queries by entities', async () => {
    const store = new InMemoryEpisodicStore(defaultConfig);

    await store.store({
      event: 'mention',
      summary: 'Mentioned Alice',
      sessionId: 's1',
      entities: ['Alice', 'Bob'],
    });
    await store.store({
      event: 'mention',
      summary: 'Mentioned Charlie',
      sessionId: 's1',
      entities: ['Charlie'],
    });

    const withAlice = await store.query({ entities: ['Alice'] });
    expect(withAlice.length).toBe(1);
    expect(withAlice[0]!.content.entities).toContain('Alice');
  });

  test('marks episodes as consolidated', async () => {
    const store = new InMemoryEpisodicStore(defaultConfig);

    const episode = await store.store({
      event: 'test',
      summary: 'Test',
      sessionId: 's1',
    });

    expect(episode.consolidated).toBe(false);

    const factId: MemoryID = {
      id: 'fact-1',
      layer: 'semantic',
      created_at: new Date(),
      source_session: 's1',
      source_machine: 'test',
    };

    await store.markConsolidated([episode.memory_id.id], [factId]);

    const updated = await store.get(episode.memory_id.id);
    expect(updated!.consolidated).toBe(true);
    expect(updated!.extracted_fact_ids).toContain(factId);
  });

  test('gets consolidation candidates', async () => {
    const store = new InMemoryEpisodicStore(defaultConfig);

    // Store episodes with different salience
    await store.store({
      event: 'high',
      summary: 'High salience',
      sessionId: 's1',
      signals: { reward_signal: 0.9 },
    });
    await store.store({
      event: 'low',
      summary: 'Low salience',
      sessionId: 's1',
      signals: { reward_signal: 0.1 },
    });

    // Get candidates with min salience 0.3
    const candidates = await store.getConsolidationCandidates(0, 0.3, 10);

    // Only high salience should qualify
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.content.event).toBe('high');
  });

  test('deletes by session (GDPR)', async () => {
    const store = new InMemoryEpisodicStore(defaultConfig);

    await store.store({ event: 'e1', summary: 's1', sessionId: 'user-123' });
    await store.store({ event: 'e2', summary: 's2', sessionId: 'user-123' });
    await store.store({ event: 'e3', summary: 's3', sessionId: 'other-user' });

    expect(await store.count()).toBe(3);

    const deleted = await store.deleteBySession('user-123');
    expect(deleted).toBe(2);
    expect(await store.count()).toBe(1);
  });

  test('queries unconsolidated only', async () => {
    const store = new InMemoryEpisodicStore(defaultConfig);

    const e1 = await store.store({ event: 'e1', summary: 's1', sessionId: 's1' });
    await store.store({ event: 'e2', summary: 's2', sessionId: 's1' });

    await store.markConsolidated([e1.memory_id.id], []);

    const unconsolidated = await store.query({ unconsolidatedOnly: true });
    expect(unconsolidated.length).toBe(1);
    expect(unconsolidated[0]!.content.event).toBe('e2');
  });

  test('reinforces salience on retrieval', async () => {
    const store = new InMemoryEpisodicStore(defaultConfig);

    const episode = await store.store({
      event: 'test',
      summary: 'Test',
      sessionId: 's1',
    });

    const initialAccessCount = episode.salience.signals.access_count;

    // Retrieve multiple times
    await store.get(episode.memory_id.id);
    await store.get(episode.memory_id.id);
    const retrieved = await store.get(episode.memory_id.id);

    expect(retrieved!.salience.signals.access_count).toBe(initialAccessCount + 3);
  });
});
