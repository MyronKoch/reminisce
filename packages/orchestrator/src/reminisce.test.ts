/**
 * Tests for Reminisce Orchestrator
 */

import { describe, test, expect } from 'bun:test';
import { Reminisce } from './reminisce.js';

describe('Reminisce', () => {
  test('creates instance with default stores', () => {
    const reminisce = new Reminisce({ machineId: 'test' });
    expect(reminisce).toBeDefined();
  });

  test('starts and ends sessions', async () => {
    const reminisce = new Reminisce({ machineId: 'test' });

    const session = reminisce.startSession('session-1');
    expect(session.id).toBe('session-1');
    expect(reminisce.getSession()).toBe(session);

    const result = await reminisce.endSession();
    expect(result.sessionId).toBe('session-1');
    expect(reminisce.getSession()).toBeNull();
  });

  test('remembers items in working memory', async () => {
    const reminisce = new Reminisce({ machineId: 'test' });
    reminisce.startSession();

    const item = await reminisce.remember({
      type: 'message',
      data: { text: 'Hello world' },
      summary: 'Greeting',
    });

    expect(item.content.type).toBe('message');
    expect(item.memory_id.layer).toBe('working');

    const stats = await reminisce.getStats();
    expect(stats.workingMemorySize).toBe(1);

    await reminisce.endSession();
  });

  test('overflows working memory to episodic', async () => {
    const reminisce = new Reminisce({
      machineId: 'test',
      workingMemoryCapacity: 2,
    });
    reminisce.startSession();

    // Add 3 items to capacity-2 buffer
    await reminisce.remember({ type: 'message', data: 'item1' });
    await reminisce.remember({ type: 'message', data: 'item2' });
    await reminisce.remember({ type: 'message', data: 'item3' });

    const stats = await reminisce.getStats();
    expect(stats.workingMemorySize).toBe(2); // Capacity limit
    expect(stats.pendingEpisodes).toBe(1); // One overflowed

    await reminisce.endSession();
  });

  test('searches across all layers', async () => {
    const reminisce = new Reminisce({ machineId: 'test', autoConsolidate: false });
    reminisce.startSession();

    // Add to working memory
    await reminisce.remember({
      type: 'message',
      data: 'Working memory item',
      tags: ['test'],
    });

    // Add directly to episodic
    await reminisce.recordEpisode({
      event: 'test_event',
      summary: 'Episodic item',
      sessionId: 'test-session',
    });

    // Add directly to semantic
    await reminisce.storeFact({
      fact: 'Semantic fact',
      sourceEpisodeIds: [],
    });

    const results = await reminisce.search({});

    expect(results.working.length).toBe(1);
    expect(results.episodic.length).toBe(1);
    expect(results.semantic.length).toBe(1);

    await reminisce.endSession();
  });

  test('consolidates on session end when autoConsolidate is true', async () => {
    const reminisce = new Reminisce({
      machineId: 'test',
      autoConsolidate: true,
      consolidation: { minAgeHours: 0, minSalience: 0 },
    });
    reminisce.startSession();

    // Add some data that will overflow and consolidate
    await reminisce.remember({ type: 'message', data: 'test1', summary: 'Test 1' });
    await reminisce.remember({ type: 'message', data: 'test2', summary: 'Test 2' });

    const result = await reminisce.endSession();

    expect(result.consolidationResult).toBeDefined();
    expect(result.itemsFlushed).toBe(2);
  });

  test('manually triggers consolidation', async () => {
    const reminisce = new Reminisce({
      machineId: 'test',
      autoConsolidate: false,
      consolidation: { minAgeHours: 0, minSalience: 0 },
    });
    reminisce.startSession();

    // Record episode directly
    await reminisce.recordEpisode({
      event: 'test',
      summary: 'Test episode',
      sessionId: 'test',
      entities: ['Entity1'],
    });

    const result = await reminisce.consolidate();

    expect(result.episodesProcessed).toBe(1);
    expect(result.factsExtracted).toBeGreaterThan(0);
  });

  test('pins working memory items', async () => {
    const reminisce = new Reminisce({
      machineId: 'test',
      workingMemoryCapacity: 2,
    });
    reminisce.startSession();

    const item = await reminisce.remember({
      type: 'message',
      data: 'important',
      signals: { reward_signal: 0.1 }, // Low salience
    });

    reminisce.pin(item.memory_id.id);

    // Add more items
    await reminisce.remember({ type: 'message', data: 'other1', signals: { reward_signal: 0.05 } });
    await reminisce.remember({ type: 'message', data: 'other2', signals: { reward_signal: 0.3 } });

    // Pinned item should still be in working memory
    const stats = await reminisce.getStats();
    expect(stats.workingMemorySize).toBe(2);

    await reminisce.endSession();
  });

  test('blocks memories', async () => {
    const reminisce = new Reminisce({ machineId: 'test', autoConsolidate: false });
    reminisce.startSession();

    const item = await reminisce.remember({ type: 'message', data: 'to-block' });

    let stats = await reminisce.getStats();
    expect(stats.workingMemorySize).toBe(1);

    await reminisce.block(item.memory_id.id, 'working');

    stats = await reminisce.getStats();
    expect(stats.workingMemorySize).toBe(0);

    await reminisce.endSession();
  });

  test('gets recent episodes', async () => {
    const reminisce = new Reminisce({ machineId: 'test', autoConsolidate: false });
    reminisce.startSession();

    await reminisce.recordEpisode({ event: 'e1', summary: 's1', sessionId: 's1' });
    await reminisce.recordEpisode({ event: 'e2', summary: 's2', sessionId: 's1' });
    await reminisce.recordEpisode({ event: 'e3', summary: 's3', sessionId: 's1' });

    const recent = await reminisce.getRecentEpisodes(2);
    expect(recent.length).toBe(2);

    await reminisce.endSession();
  });

  test('gets facts about subject', async () => {
    const reminisce = new Reminisce({ machineId: 'test', autoConsolidate: false });

    await reminisce.storeFact({
      fact: 'User likes TypeScript',
      subject: 'user',
      predicate: 'likes',
      object: 'TypeScript',
      sourceEpisodeIds: [],
    });

    await reminisce.storeFact({
      fact: 'User works at Acme',
      subject: 'user',
      predicate: 'works_at',
      object: 'Acme',
      sourceEpisodeIds: [],
    });

    await reminisce.storeFact({
      fact: 'Acme is a company',
      subject: 'Acme',
      predicate: 'is_a',
      object: 'company',
      sourceEpisodeIds: [],
    });

    const userFacts = await reminisce.getFactsAbout('user');
    expect(userFacts.length).toBe(2);
  });

  test('forgets session data (GDPR)', async () => {
    const reminisce = new Reminisce({ machineId: 'test', autoConsolidate: false });

    await reminisce.recordEpisode({ event: 'e1', summary: 's1', sessionId: 'user-123' });
    await reminisce.recordEpisode({ event: 'e2', summary: 's2', sessionId: 'user-123' });
    await reminisce.recordEpisode({ event: 'e3', summary: 's3', sessionId: 'other' });

    const result = await reminisce.forgetSession('user-123');

    expect(result.episodesDeleted).toBe(2);

    const remaining = await reminisce.getRecentEpisodes(10);
    expect(remaining.length).toBe(1);
    expect(remaining[0]!.session_id).toBe('other');
  });

  test('auto-starts session on remember if none active', async () => {
    const reminisce = new Reminisce({ machineId: 'test' });

    expect(reminisce.getSession()).toBeNull();

    await reminisce.remember({ type: 'message', data: 'test' });

    expect(reminisce.getSession()).not.toBeNull();

    await reminisce.endSession();
  });
});
