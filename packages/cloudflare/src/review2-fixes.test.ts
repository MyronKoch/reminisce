/**
 * Review2 Fixes - Targeted Tests
 *
 * Tests for correctness fixes identified in code review round 2:
 * 1. safeParseInt (indirect via API endpoints)
 * 2. Duplicate UUID fix (episode handler) - D1 and Vectorize get same ID
 * 3. Duplicate UUID fix (fact handler) - D1 and Vectorize get same ID
 * 4. /api/init requires auth (no longer public)
 * 5. /api/stats tenant isolation (session count query includes tenant_id)
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { createWorkerApp, type Env } from './worker.js';

// ─────────────────────────────────────────────────────────────
// Mock Utilities
// ─────────────────────────────────────────────────────────────

/** Generate valid HMAC token for PIN authentication */
async function generateValidCookie(
  pin: string,
  salt = 'reminisce-test-auth-salt'
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(salt),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(pin));
  return `reminisce-auth=${btoa(String.fromCharCode(...new Uint8Array(sig)))}`;
}

interface CapturedQuery {
  sql: string;
  params: unknown[];
}

interface MockStatement {
  bind: (...args: unknown[]) => MockStatement;
  first: <T = unknown>() => Promise<T | null>;
  run: () => Promise<{ success: boolean; meta: { changes: number } }>;
  all: <T = unknown>() => Promise<{
    results: T[];
    success: boolean;
    meta: { changes: number };
  }>;
}

/**
 * Shared capturing arrays. These are STABLE references that persist across
 * store cache reuse - since the stores hold a reference to the DB mock object
 * and we MUTATE these arrays (clear them), the stores always write to the same
 * array.
 *
 * IMPORTANT: The worker.ts module has a module-level storeCache Map that
 * caches D1EpisodicStore / D1SemanticStore instances by "tenantId:machineId".
 * This means the DB reference in the store is from the FIRST env.DB ever
 * passed for that tenant/machine combo. We work around this by using a SINGLE
 * shared mock DB object whose capture arrays are cleared between tests.
 */
const sharedCaptures = {
  queries: [] as CapturedQuery[],
  inserts: [] as CapturedQuery[],
};

function clearCaptures(): void {
  sharedCaptures.queries.length = 0;
  sharedCaptures.inserts.length = 0;
}

/**
 * Shared mock D1 database. The same object is reused across tests so that
 * cached stores (from the module-level storeCache) still route through our
 * capture arrays.
 */
const sharedMockD1 = (() => {
  const createStatement = (query: string): MockStatement => {
    let boundParams: unknown[] = [];

    const stmt: MockStatement = {
      bind: (...args: unknown[]) => {
        boundParams = args;
        return stmt;
      },
      first: async <T = unknown>() => {
        sharedCaptures.queries.push({ sql: query, params: [...boundParams] });
        // Mock tenant lookup
        if (query.includes('FROM tenants WHERE api_key')) {
          const apiKey = boundParams[0] as string;
          if (apiKey === 'test-api-key-123') {
            return {
              id: 'test-tenant',
              name: 'Test Tenant',
              api_key: apiKey,
              allowed_machines: null,
              rate_limit: null,
              active: 1,
              created_at: new Date().toISOString(),
            } as T;
          }
          return null;
        }
        // Mock count queries
        if (query.includes('COUNT(*)')) {
          return { count: 0 } as T;
        }
        // Mock session count
        if (query.includes('COUNT(DISTINCT session_id)')) {
          return { sessions: 5 } as T;
        }
        return null;
      },
      run: async () => {
        const entry = { sql: query, params: [...boundParams] };
        sharedCaptures.queries.push(entry);
        if (query.includes('INSERT')) {
          sharedCaptures.inserts.push(entry);
        }
        return { success: true, meta: { changes: 1 } };
      },
      all: async <T = unknown>() => {
        sharedCaptures.queries.push({ sql: query, params: [...boundParams] });
        return { results: [] as T[], success: true, meta: { changes: 0 } };
      },
    };

    return stmt;
  };

  return {
    prepare: createStatement,
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
  };
})();

/**
 * Create mock env using the shared DB mock.
 */
function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: sharedMockD1 as unknown as Env['DB'],
    AUTH_PIN: '1234',
    AUTH_SALT: 'reminisce-test-auth-salt',
    ADMIN_TENANT: 'admin',
    CORS_ORIGINS: '*',
    ALLOW_ANONYMOUS: 'false',
    ...overrides,
  };
}

/**
 * Create a Vectorize mock that captures upsert calls.
 */
function createCapturingVectorize(): {
  mock: Env['VECTORIZE'];
  upsertCalls: Array<unknown[]>;
} {
  const upsertCalls: Array<unknown[]> = [];
  const mock = {
    upsert: async (vectors: unknown[]) => {
      upsertCalls.push(vectors);
      return { count: vectors.length, ids: [] };
    },
    query: async () => ({ matches: [], count: 0 }),
    deleteByIds: async () => ({ count: 0, ids: [] }),
  } as Env['VECTORIZE'];
  return { mock, upsertCalls };
}

function createMockAI(): Env['AI'] {
  return {
    run: async () => ({ data: [new Array(768).fill(0)] }),
  } as Env['AI'];
}

/**
 * Mock ExecutionContext that captures waitUntil promises.
 */
function createMockCtx(): {
  waitUntil: (p: Promise<unknown>) => void;
  passThroughOnException: () => void;
  _promises: Promise<unknown>[];
} {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => {
      promises.push(p);
    },
    passThroughOnException: () => {},
    _promises: promises,
  };
}

// ─────────────────────────────────────────────────────────────
// Test Suites
// ─────────────────────────────────────────────────────────────

describe('Review2 Fixes', () => {
  beforeEach(() => {
    clearCaptures();
  });

  // ───────────────────────────────────────────────────────────
  // 1. safeParseInt (tested indirectly via endpoints)
  // ───────────────────────────────────────────────────────────

  describe('safeParseInt via /api/memory/episodic', () => {
    it('limit=abc falls back to default 50', async () => {
      const env = createEnv();
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/memory/episodic?limit=abc', {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);

      // The query passes through D1EpisodicStore.query() which binds
      // [tenantId, limit, offset]. Find the SELECT query.
      const selectQuery = sharedCaptures.queries.find(
        (q) =>
          q.sql.includes('SELECT') &&
          q.sql.includes('episodic_memories') &&
          q.sql.includes('LIMIT')
      );
      expect(selectQuery).toBeDefined();
      // params: [tenantId, limit, offset]
      const limitParam = selectQuery!.params[1];
      expect(limitParam).toBe(50);
    });

    it('limit=-5 falls back to default 50', async () => {
      const env = createEnv();
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/memory/episodic?limit=-5', {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);

      const selectQuery = sharedCaptures.queries.find(
        (q) =>
          q.sql.includes('SELECT') &&
          q.sql.includes('episodic_memories') &&
          q.sql.includes('LIMIT')
      );
      expect(selectQuery).toBeDefined();
      expect(selectQuery!.params[1]).toBe(50);
    });

    it('limit=99999 clamps to 500', async () => {
      const env = createEnv();
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/memory/episodic?limit=99999', {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);

      const selectQuery = sharedCaptures.queries.find(
        (q) =>
          q.sql.includes('SELECT') &&
          q.sql.includes('episodic_memories') &&
          q.sql.includes('LIMIT')
      );
      expect(selectQuery).toBeDefined();
      expect(selectQuery!.params[1]).toBe(500);
    });

    it('limit=10 uses 10', async () => {
      const env = createEnv();
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/memory/episodic?limit=10', {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);

      const selectQuery = sharedCaptures.queries.find(
        (q) =>
          q.sql.includes('SELECT') &&
          q.sql.includes('episodic_memories') &&
          q.sql.includes('LIMIT')
      );
      expect(selectQuery).toBeDefined();
      expect(selectQuery!.params[1]).toBe(10);
    });
  });

  describe('safeParseInt via /api/memory/semantic', () => {
    it('limit=abc falls back to default 50', async () => {
      const env = createEnv();
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/memory/semantic?limit=abc', {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);

      const selectQuery = sharedCaptures.queries.find(
        (q) =>
          q.sql.includes('SELECT') &&
          q.sql.includes('semantic_memories') &&
          q.sql.includes('LIMIT')
      );
      expect(selectQuery).toBeDefined();
      expect(selectQuery!.params[1]).toBe(50);
    });
  });

  describe('safeParseInt via /api/search', () => {
    it('limit=abc falls back to default 10 (search default)', async () => {
      const env = createEnv();
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/search?q=test&limit=abc', {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);

      // Without Vectorize, fallback path queries D1. Search default limit is 10.
      const selectQuery = sharedCaptures.queries.find(
        (q) =>
          q.sql.includes('SELECT') &&
          q.sql.includes('episodic_memories') &&
          q.sql.includes('LIMIT')
      );
      expect(selectQuery).toBeDefined();
      expect(selectQuery!.params[1]).toBe(10);
    });

    it('limit=999 clamps to 100 (search max)', async () => {
      const env = createEnv();
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/search?q=test&limit=999', {
        headers: { Cookie: cookie },
      });
      expect(res.status).toBe(200);

      const selectQuery = sharedCaptures.queries.find(
        (q) =>
          q.sql.includes('SELECT') &&
          q.sql.includes('episodic_memories') &&
          q.sql.includes('LIMIT')
      );
      expect(selectQuery).toBeDefined();
      expect(selectQuery!.params[1]).toBe(100);
    });
  });

  // ───────────────────────────────────────────────────────────
  // 2. Duplicate UUID fix: episode handler
  // ───────────────────────────────────────────────────────────

  describe('Episode UUID consistency (D1 + Vectorize)', () => {
    it('auto-generated ID is the same for D1 and Vectorize when no memory_id provided', async () => {
      const vectorize = createCapturingVectorize();
      const env = createEnv({
        VECTORIZE: vectorize.mock,
        AI: createMockAI(),
      });
      const mockCtx = createMockCtx();
      const app = createWorkerApp(env, mockCtx as any);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/memory/episode', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'Test event for UUID check',
          summary: 'Testing that D1 and Vectorize get the same UUID',
        }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as { success: boolean; vectorIndex: string };
      expect(json.success).toBe(true);
      expect(json.vectorIndex).toBe('pending');

      // Wait for the waitUntil promise to resolve
      await Promise.all(mockCtx._promises);

      // Extract the ID that was inserted into D1
      const insertQuery = sharedCaptures.inserts.find((q) =>
        q.sql.includes('INSERT INTO episodic_memories')
      );
      expect(insertQuery).toBeDefined();
      const d1Id = insertQuery!.params[0] as string;
      expect(d1Id).toBeTruthy();
      expect(typeof d1Id).toBe('string');

      // Extract the ID that was sent to Vectorize via upsert
      expect(vectorize.upsertCalls.length).toBe(1);
      const upsertedVectors = vectorize.upsertCalls[0] as Array<{
        id: string;
        values: number[];
        metadata: Record<string, unknown>;
      }>;
      expect(upsertedVectors.length).toBe(1);
      const vectorId = upsertedVectors[0].id;

      // THE FIX: These must be identical
      expect(d1Id).toBe(vectorId);
    });

    it('explicit memory_id.id is used for both D1 and Vectorize', async () => {
      const vectorize = createCapturingVectorize();
      const env = createEnv({
        VECTORIZE: vectorize.mock,
        AI: createMockAI(),
      });
      const mockCtx = createMockCtx();
      const app = createWorkerApp(env, mockCtx as any);
      const cookie = await generateValidCookie('1234');

      const explicitId = 'my-custom-episode-id-12345';

      const res = await app.request('/api/memory/episode', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'Explicit ID test',
          summary: 'Testing that explicit IDs pass through',
          memory_id: { id: explicitId },
        }),
      });

      expect(res.status).toBe(200);
      await Promise.all(mockCtx._promises);

      // Check D1 got the explicit ID
      const insertQuery = sharedCaptures.inserts.find((q) =>
        q.sql.includes('INSERT INTO episodic_memories')
      );
      expect(insertQuery).toBeDefined();
      expect(insertQuery!.params[0]).toBe(explicitId);

      // Check Vectorize got the explicit ID
      expect(vectorize.upsertCalls.length).toBe(1);
      const upsertedVectors = vectorize.upsertCalls[0] as Array<{ id: string }>;
      expect(upsertedVectors[0].id).toBe(explicitId);
    });
  });

  // ───────────────────────────────────────────────────────────
  // 3. Duplicate UUID fix: fact handler
  // ───────────────────────────────────────────────────────────

  describe('Fact UUID consistency (D1 + Vectorize)', () => {
    it('auto-generated ID is the same for D1 and Vectorize when no memory_id provided', async () => {
      const vectorize = createCapturingVectorize();
      const env = createEnv({
        VECTORIZE: vectorize.mock,
        AI: createMockAI(),
      });
      const mockCtx = createMockCtx();
      const app = createWorkerApp(env, mockCtx as any);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/memory/fact', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fact: 'TypeScript is preferred over Python',
          subject: 'stack',
          predicate: 'prefers',
          object: 'TypeScript',
        }),
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as { success: boolean; vectorIndex: string };
      expect(json.success).toBe(true);
      expect(json.vectorIndex).toBe('pending');

      // Wait for the waitUntil promise to resolve
      await Promise.all(mockCtx._promises);

      // Extract the ID that was inserted into D1
      const insertQuery = sharedCaptures.inserts.find((q) =>
        q.sql.includes('INSERT INTO semantic_memories')
      );
      expect(insertQuery).toBeDefined();
      const d1Id = insertQuery!.params[0] as string;
      expect(d1Id).toBeTruthy();
      expect(typeof d1Id).toBe('string');

      // Extract the ID that was sent to Vectorize via upsert
      expect(vectorize.upsertCalls.length).toBe(1);
      const upsertedVectors = vectorize.upsertCalls[0] as Array<{
        id: string;
        values: number[];
        metadata: Record<string, unknown>;
      }>;
      expect(upsertedVectors.length).toBe(1);
      const vectorId = upsertedVectors[0].id;

      // THE FIX: These must be identical
      expect(d1Id).toBe(vectorId);
    });

    it('explicit memory_id.id is used for both D1 and Vectorize', async () => {
      const vectorize = createCapturingVectorize();
      const env = createEnv({
        VECTORIZE: vectorize.mock,
        AI: createMockAI(),
      });
      const mockCtx = createMockCtx();
      const app = createWorkerApp(env, mockCtx as any);
      const cookie = await generateValidCookie('1234');

      const explicitId = 'my-custom-fact-id-67890';

      const res = await app.request('/api/memory/fact', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fact: 'Explicit fact ID test',
          subject: 'test',
          predicate: 'has',
          object: 'explicit-id',
          memory_id: { id: explicitId },
        }),
      });

      expect(res.status).toBe(200);
      await Promise.all(mockCtx._promises);

      // Check D1 got the explicit ID
      const insertQuery = sharedCaptures.inserts.find((q) =>
        q.sql.includes('INSERT INTO semantic_memories')
      );
      expect(insertQuery).toBeDefined();
      expect(insertQuery!.params[0]).toBe(explicitId);

      // Check Vectorize got the explicit ID
      expect(vectorize.upsertCalls.length).toBe(1);
      const upsertedVectors = vectorize.upsertCalls[0] as Array<{ id: string }>;
      expect(upsertedVectors[0].id).toBe(explicitId);
    });
  });

  // ───────────────────────────────────────────────────────────
  // 4. /api/init requires auth
  // ───────────────────────────────────────────────────────────

  describe('/api/init auth requirement', () => {
    it('POST /api/init without auth returns 401', async () => {
      const env = createEnv();
      const app = createWorkerApp(env);

      const res = await app.request('/api/init', { method: 'POST' });

      expect(res.status).toBe(401);
    });

    it('POST /api/init with valid API key returns 200', async () => {
      const env = createEnv();
      const app = createWorkerApp(env);

      const res = await app.request('/api/init', {
        method: 'POST',
        headers: { 'X-API-Key': 'test-api-key-123' },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as { success: boolean; message: string };
      expect(json.success).toBe(true);
      expect(json.message).toBe('Schema initialized');
    });

    it('POST /api/init with valid PIN cookie returns 200', async () => {
      const env = createEnv();
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/init', {
        method: 'POST',
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const json = (await res.json()) as { success: boolean };
      expect(json.success).toBe(true);
    });

    it('POST /api/init with invalid API key returns 401', async () => {
      const env = createEnv();
      const app = createWorkerApp(env);

      const res = await app.request('/api/init', {
        method: 'POST',
        headers: { 'X-API-Key': 'bogus-key' },
      });

      expect(res.status).toBe(401);
    });
  });

  // ───────────────────────────────────────────────────────────
  // 5. /api/stats tenant isolation
  // ───────────────────────────────────────────────────────────

  describe('/api/stats tenant scoping', () => {
    it('session count query includes WHERE tenant_id = ?', async () => {
      const env = createEnv();
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/stats', {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);

      // Find the session count query
      const sessionQuery = sharedCaptures.queries.find((q) =>
        q.sql.includes('COUNT(DISTINCT session_id)')
      );
      expect(sessionQuery).toBeDefined();

      // Verify the SQL contains tenant_id filter
      expect(sessionQuery!.sql).toContain('WHERE tenant_id = ?');

      // PIN cookie auth resolves to the ADMIN_TENANT env var (default: 'admin')
      expect(sessionQuery!.params).toContain('admin');
    });

    it('session count query scopes to API key tenant', async () => {
      const env = createEnv();
      const app = createWorkerApp(env);

      const res = await app.request('/api/stats', {
        headers: { 'X-API-Key': 'test-api-key-123' },
      });

      expect(res.status).toBe(200);

      // Find the session count query
      const sessionQuery = sharedCaptures.queries.find((q) =>
        q.sql.includes('COUNT(DISTINCT session_id)')
      );
      expect(sessionQuery).toBeDefined();
      expect(sessionQuery!.sql).toContain('WHERE tenant_id = ?');

      // API key 'test-api-key-123' maps to tenant 'test-tenant'
      expect(sessionQuery!.params).toContain('test-tenant');
    });

    it('episodic and semantic count queries include tenant scoping', async () => {
      const env = createEnv();
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      await app.request('/api/stats', { headers: { Cookie: cookie } });

      // The stores' count() method queries "SELECT COUNT(*) ... WHERE tenant_id = ?"
      // These go through the shared mock D1, so check captures.
      const countQueries = sharedCaptures.queries.filter(
        (q) => q.sql.includes('COUNT(*)') && q.sql.includes('tenant_id')
      );
      // Should have at least 2 count queries (episodic + semantic)
      expect(countQueries.length).toBeGreaterThanOrEqual(2);

      // Verify one is for episodic and one for semantic
      const episodicCount = countQueries.find((q) =>
        q.sql.includes('episodic_memories')
      );
      const semanticCount = countQueries.find((q) =>
        q.sql.includes('semantic_memories')
      );
      expect(episodicCount).toBeDefined();
      expect(semanticCount).toBeDefined();
    });
  });
});
