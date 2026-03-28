/**
 * Reminisce HTTP API Server
 *
 * Provides REST endpoints for the Reminisce dashboard and external integrations.
 * Supports multi-tenant deployments with auth middleware.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Reminisce, SearchResult } from '@reminisce/orchestrator';
import type { WorkingMemoryItem, EpisodicMemory, SemanticMemory } from '@reminisce/core';
import {
  createAuthMiddleware,
  getAuth,
  type AuthConfig,
  type AuthContext,
} from './auth.js';

export interface APIServerConfig {
  reminisce: Reminisce;
  port?: number;
  corsOrigins?: string[];
  /** Authentication configuration */
  auth?: AuthConfig;
}

/** Multi-tenant config: provide Reminisce instance per tenant */
export interface MultiTenantConfig {
  /** Get or create Reminisce instance for a tenant */
  getReminisce: (tenantId: string, machineId: string) => Reminisce | Promise<Reminisce>;
  corsOrigins?: string[];
  auth: AuthConfig;
}

export interface KnowledgeGraphNode {
  id: string;
  label: string;
  type: 'subject' | 'object' | 'fact';
  data?: Record<string, unknown>;
}

export interface KnowledgeGraphEdge {
  source: string;
  target: string;
  label: string;
  factId: string;
}

export interface KnowledgeGraphData {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
}

/**
 * Create the Hono app with all Reminisce routes
 */
export function createApp(reminisce: Reminisce, corsOrigins: string[] = ['*']): Hono {
  const app = new Hono();

  // Enable CORS for dashboard
  app.use('*', cors({
    origin: corsOrigins,
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type'],
  }));

  // Health check
  app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

  // ─────────────────────────────────────────────────────────────
  // Memory Endpoints
  // ─────────────────────────────────────────────────────────────

  // Get working memory
  app.get('/api/memory/working', async (c) => {
    const session = reminisce.getSession();
    if (!session) {
      return c.json({ items: [], message: 'No active session' });
    }
    const items = session.working.getAll();
    return c.json({ items });
  });

  // Add to working memory (dashboard-friendly endpoint)
  app.post('/api/memory/working', async (c) => {
    const body = await c.req.json();
    // Transform simple {content, context} into WorkingMemoryInput
    const input = {
      type: body.type || 'context',
      data: body.content || body.data || body,
      summary: body.summary || body.context,
      tags: body.tags,
    };
    const item = await reminisce.remember(input);
    return c.json({ success: true, item });
  });

  // Get episodic memories
  app.get('/api/memory/episodic', async (c) => {
    const limit = parseInt(c.req.query('limit') || '50');
    const sessionId = c.req.query('sessionId');
    const tags = c.req.query('tags')?.split(',').filter(Boolean);

    const query: { limit: number; sessionId?: string; tags?: string[] } = { limit };
    if (sessionId) query.sessionId = sessionId;
    if (tags?.length) query.tags = tags;

    const results = await reminisce.search(query);
    return c.json({ items: results.episodic });
  });

  // Get semantic facts
  app.get('/api/memory/semantic', async (c) => {
    const limit = parseInt(c.req.query('limit') || '50');
    const subject = c.req.query('subject');
    const category = c.req.query('category');
    const text = c.req.query('text');

    let facts: SemanticMemory[] = [];

    if (subject) {
      facts = await reminisce.getFactsAbout(subject);
    } else if (category) {
      facts = await reminisce.getFactsByCategory(category);
    } else if (text) {
      const results = await reminisce.search({ text, limit });
      facts = results.semantic;
    } else {
      const results = await reminisce.search({ limit });
      facts = results.semantic;
    }

    return c.json({ items: facts });
  });

  // ─────────────────────────────────────────────────────────────
  // Knowledge Graph
  // ─────────────────────────────────────────────────────────────

  // Get knowledge graph (subjects/predicates/objects as nodes/edges)
  app.get('/api/graph', async (c) => {
    const limit = parseInt(c.req.query('limit') || '100');
    const results = await reminisce.search({ limit });
    const facts = results.semantic;

    // Build graph from SPO triples (content.subject/predicate/object)
    const nodes = new Map<string, KnowledgeGraphNode>();
    const edges: KnowledgeGraphEdge[] = [];

    for (const fact of facts) {
      const content = fact.content;
      if (!content?.subject || !content?.object) continue;

      const subjectId = `s:${content.subject}`;
      const objectId = `o:${content.object}`;

      // Add subject node
      if (!nodes.has(subjectId)) {
        nodes.set(subjectId, {
          id: subjectId,
          label: content.subject,
          type: 'subject',
        });
      }

      // Add object node
      if (!nodes.has(objectId)) {
        nodes.set(objectId, {
          id: objectId,
          label: content.object,
          type: 'object',
        });
      }

      // Add edge
      edges.push({
        source: subjectId,
        target: objectId,
        label: content.predicate || 'relates_to',
        factId: fact.memory_id.id,
      });
    }

    const graphData: KnowledgeGraphData = {
      nodes: Array.from(nodes.values()),
      edges,
    };

    return c.json(graphData);
  });

  // ─────────────────────────────────────────────────────────────
  // Search
  // ─────────────────────────────────────────────────────────────

  app.get('/api/search', async (c) => {
    const q = c.req.query('q') || '';
    const limit = parseInt(c.req.query('limit') || '20');
    const tags = c.req.query('tags')?.split(',').filter(Boolean);

    const query: { text?: string; tags?: string[]; limit: number } = { limit };
    if (q) query.text = q;
    if (tags?.length) query.tags = tags;

    const results = await reminisce.search(query);
    return c.json(results);
  });

  // ─────────────────────────────────────────────────────────────
  // Stats & Management
  // ─────────────────────────────────────────────────────────────

  app.get('/api/stats', async (c) => {
    const stats = await reminisce.getStats();
    return c.json(stats);
  });

  app.post('/api/consolidate', async (c) => {
    try {
      const result = await reminisce.consolidate();
      return c.json({ success: true, result });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Write Operations (for advanced dashboard)
  // ─────────────────────────────────────────────────────────────

  app.post('/api/memory/remember', async (c) => {
    const body = await c.req.json();
    const item = await reminisce.remember(body);
    return c.json({ success: true, item });
  });

  app.post('/api/memory/fact', async (c) => {
    const body = await c.req.json();
    const fact = await reminisce.storeFact(body);
    return c.json({ success: true, fact });
  });

  app.post('/api/memory/episode', async (c) => {
    const body = await c.req.json();
    const episode = await reminisce.recordEpisode(body);
    return c.json({ success: true, episode });
  });

  app.delete('/api/memory/:layer/:id', async (c) => {
    const { layer, id } = c.req.param();
    if (!['working', 'episodic', 'semantic'].includes(layer)) {
      return c.json({ error: 'Invalid layer' }, 400);
    }
    await reminisce.block(id, layer as 'working' | 'episodic' | 'semantic');
    return c.json({ success: true });
  });

  // GDPR: Forget session
  app.delete('/api/session/:sessionId', async (c) => {
    const { sessionId } = c.req.param();
    const result = await reminisce.forgetSession(sessionId);
    return c.json({ success: true, ...result });
  });

  return app;
}

/**
 * Create a multi-tenant Hono app
 *
 * Each request gets the appropriate Reminisce instance based on auth context.
 * Suitable for Cloudflare Workers, Vercel Edge, etc.
 */
export function createMultiTenantApp(config: MultiTenantConfig): Hono {
  const { getReminisce, corsOrigins = ['*'], auth } = config;
  const app = new Hono();

  // Enable CORS
  app.use('*', cors({
    origin: corsOrigins,
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'X-API-Key', 'Authorization', 'X-Machine-ID'],
  }));

  // Auth middleware
  app.use('*', createAuthMiddleware(auth));

  // Health check (no auth required - handled by publicPaths)
  app.get('/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

  // Helper to get tenant's Reminisce instance
  const getTenantReminisce = async (c: { get: (key: string) => unknown }) => {
    const authCtx = c.get('auth') as AuthContext | undefined;
    const tenantId = authCtx?.tenant.id || 'anonymous';
    const machineId = authCtx?.machineId || 'default';
    return getReminisce(tenantId, machineId);
  };

  // ─────────────────────────────────────────────────────────────
  // Memory Endpoints (same as single-tenant, but with tenant isolation)
  // ─────────────────────────────────────────────────────────────

  app.get('/api/memory/working', async (c) => {
    const reminisce = await getTenantReminisce(c);
    const session = reminisce.getSession();
    if (!session) {
      return c.json({ items: [], message: 'No active session' });
    }
    const items = session.working.getAll();
    return c.json({ items });
  });

  app.get('/api/memory/episodic', async (c) => {
    const reminisce = await getTenantReminisce(c);
    const limit = parseInt(c.req.query('limit') || '50');
    const sessionId = c.req.query('sessionId');
    const tags = c.req.query('tags')?.split(',').filter(Boolean);

    const query: { limit: number; sessionId?: string; tags?: string[] } = { limit };
    if (sessionId) query.sessionId = sessionId;
    if (tags?.length) query.tags = tags;

    const results = await reminisce.search(query);
    return c.json({ items: results.episodic });
  });

  app.get('/api/memory/semantic', async (c) => {
    const reminisce = await getTenantReminisce(c);
    const limit = parseInt(c.req.query('limit') || '50');
    const subject = c.req.query('subject');
    const category = c.req.query('category');
    const text = c.req.query('text');

    let facts: SemanticMemory[] = [];

    if (subject) {
      facts = await reminisce.getFactsAbout(subject);
    } else if (category) {
      facts = await reminisce.getFactsByCategory(category);
    } else if (text) {
      const results = await reminisce.search({ text, limit });
      facts = results.semantic;
    } else {
      const results = await reminisce.search({ limit });
      facts = results.semantic;
    }

    return c.json({ items: facts });
  });

  // Knowledge graph
  app.get('/api/graph', async (c) => {
    const reminisce = await getTenantReminisce(c);
    const limit = parseInt(c.req.query('limit') || '100');
    const results = await reminisce.search({ limit });
    const facts = results.semantic;

    const nodes = new Map<string, KnowledgeGraphNode>();
    const edges: KnowledgeGraphEdge[] = [];

    for (const fact of facts) {
      const content = fact.content;
      if (!content?.subject || !content?.object) continue;

      const subjectId = `s:${content.subject}`;
      const objectId = `o:${content.object}`;

      if (!nodes.has(subjectId)) {
        nodes.set(subjectId, { id: subjectId, label: content.subject, type: 'subject' });
      }
      if (!nodes.has(objectId)) {
        nodes.set(objectId, { id: objectId, label: content.object, type: 'object' });
      }

      edges.push({
        source: subjectId,
        target: objectId,
        label: content.predicate || 'relates_to',
        factId: fact.memory_id.id,
      });
    }

    return c.json({ nodes: Array.from(nodes.values()), edges });
  });

  // Search
  app.get('/api/search', async (c) => {
    const reminisce = await getTenantReminisce(c);
    const q = c.req.query('q') || '';
    const limit = parseInt(c.req.query('limit') || '20');
    const tags = c.req.query('tags')?.split(',').filter(Boolean);

    const query: { text?: string; tags?: string[]; limit: number } = { limit };
    if (q) query.text = q;
    if (tags?.length) query.tags = tags;

    const results = await reminisce.search(query);
    return c.json(results);
  });

  // Stats
  app.get('/api/stats', async (c) => {
    const reminisce = await getTenantReminisce(c);
    const stats = await reminisce.getStats();
    return c.json(stats);
  });

  // Consolidation
  app.post('/api/consolidate', async (c) => {
    const reminisce = await getTenantReminisce(c);
    try {
      const result = await reminisce.consolidate();
      return c.json({ success: true, result });
    } catch (error) {
      return c.json({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 500);
    }
  });

  // Write operations
  app.post('/api/memory/remember', async (c) => {
    const reminisce = await getTenantReminisce(c);
    const body = await c.req.json();
    const item = await reminisce.remember(body);
    return c.json({ success: true, item });
  });

  app.post('/api/memory/fact', async (c) => {
    const reminisce = await getTenantReminisce(c);
    const body = await c.req.json();
    const fact = await reminisce.storeFact(body);
    return c.json({ success: true, fact });
  });

  app.post('/api/memory/episode', async (c) => {
    const reminisce = await getTenantReminisce(c);
    const body = await c.req.json();
    const episode = await reminisce.recordEpisode(body);
    return c.json({ success: true, episode });
  });

  app.delete('/api/memory/:layer/:id', async (c) => {
    const reminisce = await getTenantReminisce(c);
    const { layer, id } = c.req.param();
    if (!['working', 'episodic', 'semantic'].includes(layer)) {
      return c.json({ error: 'Invalid layer' }, 400);
    }
    await reminisce.block(id, layer as 'working' | 'episodic' | 'semantic');
    return c.json({ success: true });
  });

  // GDPR: Forget session
  app.delete('/api/session/:sessionId', async (c) => {
    const reminisce = await getTenantReminisce(c);
    const { sessionId } = c.req.param();
    const result = await reminisce.forgetSession(sessionId);
    return c.json({ success: true, ...result });
  });

  // Tenant info endpoint
  app.get('/api/tenant', (c) => {
    const auth = getAuth(c);
    if (!auth) {
      return c.json({ error: 'Not authenticated' }, 401);
    }
    return c.json({
      tenantId: auth.tenant.id,
      tenantName: auth.tenant.name,
      machineId: auth.machineId,
      authenticated: auth.authenticated,
    });
  });

  return app;
}

/**
 * Start the API server (single-tenant mode)
 */
export function startServer(config: APIServerConfig): void {
  const { reminisce, port = 3001, corsOrigins = ['*'], auth } = config;
  const app = auth
    ? createMultiTenantApp({ getReminisce: () => reminisce, corsOrigins, auth })
    : createApp(reminisce, corsOrigins);

  console.log(`🚀 Reminisce API Server starting on port ${port}`);
  console.log(`   Dashboard: http://localhost:${port}`);
  console.log(`   Health:    http://localhost:${port}/health`);

  Bun.serve({
    port,
    fetch: app.fetch,
  });
}
