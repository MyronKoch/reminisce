/**
 * Tests for Reminisce API Server
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createApp } from './server.js';
import { Reminisce } from '@reminisce/orchestrator';

describe('Reminisce API Server', () => {
  let reminisce: Reminisce;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    reminisce = new Reminisce({ machineId: 'test-api' });
    reminisce.startSession('test-session');
    app = createApp(reminisce);
  });

  afterEach(async () => {
    await reminisce.endSession();
  });

  describe('GET /health', () => {
    test('returns ok status', async () => {
      const res = await app.request('/health');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('ok');
      expect(data.timestamp).toBeDefined();
    });
  });

  describe('GET /api/memory/working', () => {
    test('returns empty array when no items', async () => {
      const res = await app.request('/api/memory/working');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.items).toEqual([]);
    });

    test('returns items after remember', async () => {
      await reminisce.remember({
        type: 'context',
        data: { test: true },
        summary: 'Test item',
      });

      const res = await app.request('/api/memory/working');
      const data = await res.json();
      expect(data.items.length).toBe(1);
      expect(data.items[0].content.summary).toBe('Test item');
    });
  });

  describe('GET /api/memory/episodic', () => {
    test('returns episodic memories', async () => {
      const res = await app.request('/api/memory/episodic');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.items)).toBe(true);
    });

    test('respects limit parameter', async () => {
      const res = await app.request('/api/memory/episodic?limit=5');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.items)).toBe(true);
    });
  });

  describe('GET /api/memory/semantic', () => {
    test('returns semantic facts', async () => {
      const res = await app.request('/api/memory/semantic');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.items)).toBe(true);
    });

    test('filters by subject', async () => {
      await reminisce.storeFact({
        fact: 'User likes TypeScript',
        subject: 'user',
        predicate: 'likes',
        object: 'TypeScript',
        sourceEpisodeIds: [],
      });

      const res = await app.request('/api/memory/semantic?subject=user');
      const data = await res.json();
      expect(data.items.length).toBeGreaterThan(0);
      expect(data.items[0].content.subject).toBe('user');
    });
  });

  describe('GET /api/graph', () => {
    test('returns knowledge graph structure', async () => {
      const res = await app.request('/api/graph');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.nodes).toBeDefined();
      expect(data.edges).toBeDefined();
      expect(Array.isArray(data.nodes)).toBe(true);
      expect(Array.isArray(data.edges)).toBe(true);
    });

    test('builds graph from facts', async () => {
      await reminisce.storeFact({
        fact: 'User prefers TypeScript',
        subject: 'user',
        predicate: 'prefers',
        object: 'TypeScript',
        sourceEpisodeIds: [],
      });

      const res = await app.request('/api/graph');
      const data = await res.json();

      // Find nodes and edges for our fact
      const userNode = data.nodes.find((n: { label: string }) => n.label === 'user');
      const tsNode = data.nodes.find((n: { label: string }) => n.label === 'TypeScript');
      const edge = data.edges.find((e: { label: string }) => e.label === 'prefers');

      expect(userNode).toBeDefined();
      expect(tsNode).toBeDefined();
      expect(edge).toBeDefined();
    });
  });

  describe('GET /api/search', () => {
    test('searches across layers', async () => {
      await reminisce.remember({
        type: 'context',
        data: { info: 'TypeScript preference' },
        summary: 'User prefers TypeScript',
        tags: ['preference'],
      });

      const res = await app.request('/api/search?q=TypeScript');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.working).toBeDefined();
      expect(data.episodic).toBeDefined();
      expect(data.semantic).toBeDefined();
    });
  });

  describe('GET /api/stats', () => {
    test('returns system stats', async () => {
      const res = await app.request('/api/stats');
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.sessions).toBeDefined();
      expect(data.workingMemorySize).toBeDefined();
      expect(data.workingMemoryCapacity).toBeDefined();
    });
  });

  describe('POST /api/consolidate', () => {
    test('triggers consolidation', async () => {
      const res = await app.request('/api/consolidate', { method: 'POST' });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.result).toBeDefined();
    });
  });

  describe('POST /api/memory/remember', () => {
    test('adds item to working memory', async () => {
      const res = await app.request('/api/memory/remember', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'context',
          data: { info: 'API test' },
          summary: 'Test from API',
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.item.content.summary).toBe('Test from API');
    });
  });

  describe('POST /api/memory/fact', () => {
    test('stores a fact', async () => {
      const res = await app.request('/api/memory/fact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fact: 'Test fact from API',
          subject: 'api',
          predicate: 'creates',
          object: 'fact',
          sourceEpisodeIds: [],
        }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.fact.content.fact).toBe('Test fact from API');
    });
  });
});
