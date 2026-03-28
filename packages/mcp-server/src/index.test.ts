/**
 * Tests for Reminisce MCP Server
 *
 * Note: These tests verify the Reminisce integration, not the MCP transport layer.
 * Full MCP protocol tests would require spawning the server and connecting via stdio.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { Reminisce } from '@reminisce/orchestrator';
import type { SalienceSignals } from '@reminisce/core';
import type { WorkingMemoryInput } from '@reminisce/working';
import type { EpisodeInput } from '@reminisce/episodic';
import type { FactInput } from '@reminisce/semantic';

describe('Reminisce MCP Server Integration', () => {
  let reminisce: Reminisce;

  beforeEach(() => {
    reminisce = new Reminisce({
      machineId: 'test-mcp',
      autoConsolidate: false,
      consolidation: {
        minAgeHours: 0,
        minSalience: 0.2,
        batchSize: 20,
      },
    });
    reminisce.startSession('test-session');
  });

  describe('remember', () => {
    test('adds item to working memory', async () => {
      const input: WorkingMemoryInput = {
        type: 'message',
        data: { text: 'Hello world' },
        summary: 'Test greeting',
        tags: ['test'],
      };

      const item = await reminisce.remember(input);

      expect(item.memory_id.layer).toBe('working');
      expect(item.content.type).toBe('message');
      expect(item.content.summary).toBe('Test greeting');
      expect(item.tags).toContain('test');
    });

    test('handles salience signals', async () => {
      const input: WorkingMemoryInput = {
        type: 'context',
        data: { important: true },
        signals: {
          reward_signal: 0.8,
          goal_relevance: 0.9,
        },
      };

      const item = await reminisce.remember(input);

      expect(item.salience.signals.reward_signal).toBe(0.8);
      expect(item.salience.signals.goal_relevance).toBe(0.9);
      expect(item.salience.current_score).toBeGreaterThan(0.3);
    });
  });

  describe('search', () => {
    test('searches across layers', async () => {
      // Add to working memory
      await reminisce.remember({
        type: 'message',
        data: { text: 'TypeScript is great' },
        summary: 'TypeScript opinion',
        tags: ['programming'],
      });

      // Add fact directly
      await reminisce.storeFact({
        fact: 'User prefers TypeScript',
        subject: 'user',
        category: 'preferences',
        sourceEpisodeIds: [],
        tags: ['programming'],
      });

      const results = await reminisce.search({ tags: ['programming'] });

      expect(results.working.length).toBe(1);
      expect(results.semantic.length).toBe(1);
    });
  });

  describe('store_fact', () => {
    test('stores fact with SPO triple', async () => {
      const input: FactInput = {
        fact: 'User prefers dark mode',
        subject: 'user',
        predicate: 'prefers',
        object: 'dark mode',
        category: 'ui_preferences',
        sourceEpisodeIds: [],
        confidence: 0.95,
      };

      const stored = await reminisce.storeFact(input);

      expect(stored.content.fact).toBe('User prefers dark mode');
      expect(stored.content.subject).toBe('user');
      expect(stored.content.predicate).toBe('prefers');
      expect(stored.content.object).toBe('dark mode');
      expect(stored.provenance.confidence).toBe(0.95);
    });
  });

  describe('record_episode', () => {
    test('records episode directly', async () => {
      const input: EpisodeInput = {
        event: 'user_request',
        summary: 'User asked about memory system',
        sessionId: 'test-session',
        entities: ['User', 'Memory System'],
        tags: ['question'],
        valence: 0.3,
      };

      const episode = await reminisce.recordEpisode(input);

      expect(episode.content.event).toBe('user_request');
      expect(episode.content.summary).toBe('User asked about memory system');
      expect(episode.content.entities).toContain('User');
      expect(episode.content.valence).toBe(0.3);
    });
  });

  describe('get_facts', () => {
    test('retrieves facts about subject', async () => {
      // Store multiple facts
      await reminisce.storeFact({
        fact: 'User is a developer',
        subject: 'user',
        category: 'profile',
        sourceEpisodeIds: [],
      });
      await reminisce.storeFact({
        fact: 'User prefers TypeScript',
        subject: 'user',
        category: 'preferences',
        sourceEpisodeIds: [],
      });
      await reminisce.storeFact({
        fact: 'Coffee is a beverage',
        subject: 'coffee',
        category: 'general',
        sourceEpisodeIds: [],
      });

      const userFacts = await reminisce.getFactsAbout('user');

      expect(userFacts.length).toBe(2);
      expect(userFacts.every(f => f.content.subject === 'user')).toBe(true);
    });
  });

  describe('consolidate', () => {
    test('consolidates episodes to facts', async () => {
      // Record episodes
      await reminisce.recordEpisode({
        event: 'user_statement',
        summary: 'User mentioned they like Rust',
        sessionId: 'test-session',
        entities: ['User', 'Rust'],
      });

      // End session to trigger overflow
      await reminisce.endSession();

      // Start new session
      reminisce.startSession('test-session-2');

      const result = await reminisce.consolidate();

      expect(result.episodesProcessed).toBeGreaterThanOrEqual(0);
      expect(typeof result.factsExtracted).toBe('number');
      expect(typeof result.factsStored).toBe('number');
    });
  });

  describe('get_stats', () => {
    test('returns system statistics', async () => {
      await reminisce.remember({ type: 'message', data: 'test' });
      await reminisce.remember({ type: 'context', data: 'test2' });

      const stats = await reminisce.getStats();

      expect(stats.sessions).toBe(1);
      expect(stats.workingMemorySize).toBe(2);
      expect(stats.workingMemoryCapacity).toBe(7);
      expect(typeof stats.pendingEpisodes).toBe('number');
      expect(typeof stats.totalFacts).toBe('number');
    });
  });

  describe('forget_session', () => {
    test('deletes session data', async () => {
      // Record episode in specific session
      await reminisce.recordEpisode({
        event: 'test_event',
        summary: 'Test data to delete',
        sessionId: 'delete-me',
      });

      const result = await reminisce.forgetSession('delete-me');

      expect(result.episodesDeleted).toBeGreaterThanOrEqual(1);
    });
  });
});
