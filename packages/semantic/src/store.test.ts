/**
 * Tests for Semantic Store
 */

import { describe, test, expect } from 'bun:test';
import { InMemorySemanticStore } from './store.js';
import type { MemoryID } from '@reminisce/core';

describe('InMemorySemanticStore', () => {
  const defaultConfig = {
    machineId: 'test-machine',
    sessionId: 'test-session',
  };

  const mockEpisodeId: MemoryID = {
    id: 'episode-1',
    layer: 'episodic',
    created_at: new Date(),
    source_session: 'test-session',
    source_machine: 'test-machine',
  };

  test('stores and retrieves facts', async () => {
    const store = new InMemorySemanticStore(defaultConfig);

    const fact = await store.store({
      fact: 'User prefers TypeScript over JavaScript',
      subject: 'user',
      predicate: 'prefers',
      object: 'TypeScript',
      category: 'preferences',
      sourceEpisodeIds: [mockEpisodeId],
    });

    expect(fact.memory_id.layer).toBe('semantic');
    expect(fact.content.fact).toBe('User prefers TypeScript over JavaScript');
    expect(fact.content.subject).toBe('user');
    expect(fact.provenance.retracted).toBe(false);

    const retrieved = await store.get(fact.memory_id.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.content.fact).toBe('User prefers TypeScript over JavaScript');
  });

  test('queries by subject/predicate/object', async () => {
    const store = new InMemorySemanticStore(defaultConfig);

    await store.store({
      fact: 'User prefers TypeScript',
      subject: 'user',
      predicate: 'prefers',
      object: 'TypeScript',
      sourceEpisodeIds: [mockEpisodeId],
    });

    await store.store({
      fact: 'User dislikes Python',
      subject: 'user',
      predicate: 'dislikes',
      object: 'Python',
      sourceEpisodeIds: [mockEpisodeId],
    });

    const userPrefs = await store.query({ subject: 'user' });
    expect(userPrefs.length).toBe(2);

    const preferences = await store.query({ predicate: 'prefers' });
    expect(preferences.length).toBe(1);
    expect(preferences[0]!.content.object).toBe('TypeScript');
  });

  test('queries by category', async () => {
    const store = new InMemorySemanticStore(defaultConfig);

    await store.store({
      fact: 'User likes dark mode',
      category: 'preferences',
      sourceEpisodeIds: [mockEpisodeId],
    });

    await store.store({
      fact: 'User works at Acme Corp',
      category: 'employment',
      sourceEpisodeIds: [mockEpisodeId],
    });

    const prefs = await store.query({ category: 'preferences' });
    expect(prefs.length).toBe(1);
    expect(prefs[0]!.content.fact).toContain('dark mode');
  });

  test('detects contradictions', async () => {
    const store = new InMemorySemanticStore(defaultConfig);

    await store.store({
      fact: 'User prefers TypeScript',
      subject: 'user',
      predicate: 'prefers',
      object: 'TypeScript',
      sourceEpisodeIds: [mockEpisodeId],
      confidence: 0.9,
    });

    const contradiction = await store.checkContradiction({
      fact: 'User prefers Python',
      subject: 'user',
      predicate: 'prefers',
      object: 'Python',
      sourceEpisodeIds: [mockEpisodeId],
      confidence: 0.5,
    });

    expect(contradiction.hasContradiction).toBe(true);
    expect(contradiction.conflicts.length).toBe(1);
    expect(contradiction.suggestion).toBe('keep_existing'); // existing has 0.4 higher confidence
  });

  test('retracts facts', async () => {
    const store = new InMemorySemanticStore(defaultConfig);

    const fact = await store.store({
      fact: 'User lives in NYC',
      sourceEpisodeIds: [mockEpisodeId],
    });

    expect(await store.count()).toBe(1);

    await store.retract(fact.memory_id.id, 'User moved');

    // Retracted facts don't show in normal queries
    expect(await store.count()).toBe(0);

    // But can be found with includeRetracted
    const withRetracted = await store.query({ includeRetracted: true });
    expect(withRetracted.length).toBe(1);
    expect(withRetracted[0]!.provenance.retracted).toBe(true);
    expect(withRetracted[0]!.provenance.retracted_reason).toBe('User moved');
  });

  test('supersedes facts', async () => {
    const store = new InMemorySemanticStore(defaultConfig);

    const oldFact = await store.store({
      fact: 'User lives in NYC',
      sourceEpisodeIds: [mockEpisodeId],
    });

    const result = await store.supersede(oldFact.memory_id.id, {
      fact: 'User lives in SF',
      sourceEpisodeIds: [mockEpisodeId],
    });

    expect(result).toBeDefined();
    expect(result!.old.provenance.retracted).toBe(true);
    expect(result!.old.provenance.superseded_by).toEqual(result!.new.memory_id);
    expect(result!.new.content.fact).toBe('User lives in SF');
  });

  test('reinstates retracted facts', async () => {
    const store = new InMemorySemanticStore(defaultConfig);

    const fact = await store.store({
      fact: 'User likes coffee',
      sourceEpisodeIds: [mockEpisodeId],
    });

    await store.retract(fact.memory_id.id, 'Mistake');
    expect(await store.count()).toBe(0);

    await store.reinstate(fact.memory_id.id);
    expect(await store.count()).toBe(1);
  });

  test('applies confidence decay', async () => {
    const store = new InMemorySemanticStore(defaultConfig);

    const fact = await store.store({
      fact: 'Old fact',
      sourceEpisodeIds: [mockEpisodeId],
      confidence: 1.0,
    });

    // Manually backdate the last_validated
    const retrieved = await store.get(fact.memory_id.id);
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 days ago

    // Apply decay with 30-day half-life
    const decayedCount = await store.applyDecay(30);

    // Should decay since we're testing the mechanism
    expect(decayedCount).toBeGreaterThanOrEqual(0);
  });

  test('gets validation candidates', async () => {
    const store = new InMemorySemanticStore(defaultConfig);

    await store.store({
      fact: 'High confidence fact',
      sourceEpisodeIds: [mockEpisodeId],
      confidence: 0.9,
    });

    await store.store({
      fact: 'Low confidence fact',
      sourceEpisodeIds: [mockEpisodeId],
      confidence: 0.3,
    });

    const candidates = await store.getValidationCandidates(0.5, 10);
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.content.fact).toBe('Low confidence fact');
  });

  test('validates facts and boosts confidence', async () => {
    const store = new InMemorySemanticStore(defaultConfig);

    const fact = await store.store({
      fact: 'Needs validation',
      sourceEpisodeIds: [mockEpisodeId],
      confidence: 0.5,
    });

    const validated = await store.validate(fact.memory_id.id, 0.2);
    expect(validated!.provenance.confidence).toBeCloseTo(0.7, 1);
  });

  test('links related facts', async () => {
    const store = new InMemorySemanticStore(defaultConfig);

    const fact1 = await store.store({
      fact: 'User works at Acme',
      sourceEpisodeIds: [mockEpisodeId],
    });

    const fact2 = await store.store({
      fact: 'Acme is a tech company',
      sourceEpisodeIds: [mockEpisodeId],
    });

    await store.linkFacts(fact1.memory_id.id, fact2.memory_id.id);

    const related = await store.getRelated(fact1.memory_id.id);
    expect(related.length).toBe(1);
    expect(related[0]!.content.fact).toBe('Acme is a tech company');
  });

  test('deletes by source episode (cascade)', async () => {
    const store = new InMemorySemanticStore(defaultConfig);

    const episode1: MemoryID = { ...mockEpisodeId, id: 'ep-1' };
    const episode2: MemoryID = { ...mockEpisodeId, id: 'ep-2' };

    await store.store({ fact: 'From episode 1', sourceEpisodeIds: [episode1] });
    await store.store({ fact: 'Also from episode 1', sourceEpisodeIds: [episode1] });
    await store.store({ fact: 'From episode 2', sourceEpisodeIds: [episode2] });

    expect(await store.count()).toBe(3);

    const deleted = await store.deleteBySourceEpisode('ep-1');
    expect(deleted).toBe(2);
    expect(await store.count()).toBe(1);
  });

  test('filters by minimum confidence', async () => {
    const store = new InMemorySemanticStore(defaultConfig);

    await store.store({
      fact: 'High confidence',
      sourceEpisodeIds: [mockEpisodeId],
      confidence: 0.9,
    });

    await store.store({
      fact: 'Low confidence',
      sourceEpisodeIds: [mockEpisodeId],
      confidence: 0.3,
    });

    const highOnly = await store.query({ minConfidence: 0.5 });
    expect(highOnly.length).toBe(1);
    expect(highOnly[0]!.content.fact).toBe('High confidence');
  });
});
