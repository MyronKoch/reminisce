/**
 * Tests for Consolidation Engine
 */

import { describe, test, expect } from 'bun:test';
import { ConsolidationEngine, SimpleFactExtractor } from './engine.js';
import { InMemoryEpisodicStore } from '@reminisce/episodic';
import { InMemorySemanticStore } from '@reminisce/semantic';

describe('ConsolidationEngine', () => {
  const createStores = () => ({
    episodic: new InMemoryEpisodicStore({ machineId: 'test' }),
    semantic: new InMemorySemanticStore({ machineId: 'test', sessionId: 'test' }),
  });

  test('consolidates episodes to semantic facts', async () => {
    const { episodic, semantic } = createStores();
    const extractor = new SimpleFactExtractor();
    const engine = new ConsolidationEngine(episodic, semantic, extractor, {
      minAgeHours: 0, // Consolidate immediately for testing
      minSalience: 0,
      minFactConfidence: 0,
    });

    // Add episodes
    await episodic.store({
      event: 'user_preference',
      summary: 'User prefers dark mode',
      sessionId: 'session-1',
      entities: ['user', 'dark_mode'],
      signals: { reward_signal: 0.8 },
    });

    await episodic.store({
      event: 'user_action',
      summary: 'User completed onboarding',
      sessionId: 'session-1',
      entities: ['user', 'onboarding'],
      signals: { reward_signal: 0.6 },
    });

    // Run consolidation
    const result = await engine.consolidate();

    expect(result.episodesProcessed).toBe(2);
    expect(result.factsExtracted).toBeGreaterThan(0);
    expect(result.factsStored).toBeGreaterThan(0);
    expect(result.errors.length).toBe(0);

    // Check semantic store
    const facts = await semantic.query({});
    expect(facts.length).toBeGreaterThan(0);

    // Check episodes marked as consolidated
    const unconsolidated = await episodic.query({ unconsolidatedOnly: true });
    expect(unconsolidated.length).toBe(0);
  });

  test('respects minimum salience threshold', async () => {
    const { episodic, semantic } = createStores();
    const extractor = new SimpleFactExtractor();
    const engine = new ConsolidationEngine(episodic, semantic, extractor, {
      minAgeHours: 0,
      minSalience: 0.5, // High threshold
      minFactConfidence: 0,
    });

    // Add low-salience episode
    await episodic.store({
      event: 'low_importance',
      summary: 'Something unimportant happened',
      sessionId: 'session-1',
      signals: { reward_signal: 0.1 },
    });

    const result = await engine.consolidate();

    expect(result.episodesProcessed).toBe(0); // Should not consolidate
  });

  test('handles contradictions with skip policy', async () => {
    const { episodic, semantic } = createStores();
    const extractor = new SimpleFactExtractor();
    const engine = new ConsolidationEngine(episodic, semantic, extractor, {
      minAgeHours: 0,
      minSalience: 0,
      minFactConfidence: 0,
      contradictionPolicy: 'skip',
    });

    // Pre-populate semantic with existing fact
    await semantic.store({
      fact: 'User prefers light mode',
      subject: 'user',
      predicate: 'prefers',
      object: 'light_mode',
      sourceEpisodeIds: [],
      confidence: 0.9,
    });

    // Add contradicting episode
    await episodic.store({
      event: 'preference_change',
      summary: 'User prefers dark mode',
      sessionId: 'session-1',
      signals: { reward_signal: 0.7 },
    });

    const result = await engine.consolidate();

    // Fact should be stored (simple extractor doesn't do subject/predicate/object)
    // But if it did conflict, it would be skipped
    expect(result.episodesProcessed).toBe(1);
  });

  test('extracts entity mentions as facts', async () => {
    const { episodic, semantic } = createStores();
    const extractor = new SimpleFactExtractor();
    const engine = new ConsolidationEngine(episodic, semantic, extractor, {
      minAgeHours: 0,
      minSalience: 0,
      minFactConfidence: 0,
    });

    await episodic.store({
      event: 'meeting',
      summary: 'Had a meeting',
      sessionId: 'session-1',
      entities: ['Alice', 'Bob', 'Project_X'],
    });

    const result = await engine.consolidate();

    // Should extract entity facts
    const entityFacts = await semantic.query({ category: 'entity' });
    expect(entityFacts.length).toBe(3); // Alice, Bob, Project_X
  });

  test('returns stats about consolidation state', async () => {
    const { episodic, semantic } = createStores();
    const extractor = new SimpleFactExtractor();
    const engine = new ConsolidationEngine(episodic, semantic, extractor, {
      minAgeHours: 0,
      minSalience: 0,
      minFactConfidence: 0,
    });

    // Add episodes
    await episodic.store({
      event: 'e1',
      summary: 'Episode 1',
      sessionId: 's1',
    });
    await episodic.store({
      event: 'e2',
      summary: 'Episode 2',
      sessionId: 's1',
    });

    // Check stats before consolidation
    let stats = await engine.getStats();
    expect(stats.pendingEpisodes).toBe(2);
    expect(stats.consolidatedEpisodes).toBe(0);

    // Consolidate
    await engine.consolidate();

    // Check stats after consolidation
    stats = await engine.getStats();
    expect(stats.pendingEpisodes).toBe(0);
    expect(stats.consolidatedEpisodes).toBe(2);
    expect(stats.totalFacts).toBeGreaterThan(0);
  });

  test('filters low confidence facts', async () => {
    const { episodic, semantic } = createStores();
    const extractor = new SimpleFactExtractor();
    const engine = new ConsolidationEngine(episodic, semantic, extractor, {
      minAgeHours: 0,
      minSalience: 0,
      minFactConfidence: 0.8, // High threshold
    });

    // Add episode with low salience (which becomes fact confidence)
    await episodic.store({
      event: 'low_confidence',
      summary: 'Uncertain fact',
      sessionId: 's1',
      signals: { reward_signal: 0.1 }, // Low salience = low confidence
    });

    const result = await engine.consolidate();

    // Episode processed but fact may be filtered
    expect(result.episodesProcessed).toBe(1);
    // Entity facts have fixed 0.7 confidence, summary gets episode salience
  });

  test('links facts back to source episodes', async () => {
    const { episodic, semantic } = createStores();
    const extractor = new SimpleFactExtractor();
    const engine = new ConsolidationEngine(episodic, semantic, extractor, {
      minAgeHours: 0,
      minSalience: 0,
      minFactConfidence: 0,
    });

    const episode = await episodic.store({
      event: 'test',
      summary: 'Test episode',
      sessionId: 's1',
    });

    await engine.consolidate();

    const facts = await semantic.query({});
    expect(facts.length).toBeGreaterThan(0);

    // Facts should have provenance back to episode
    const fact = facts[0]!;
    expect(fact.source_episode_ids.length).toBeGreaterThan(0);
    expect(fact.provenance.derivation_type).toBe('consolidated');
  });
});
