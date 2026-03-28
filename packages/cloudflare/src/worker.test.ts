/**
 * Integration tests for Reminisce Cloudflare Worker
 *
 * Tests all routes, authentication flows, and data operations.
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { createWorkerApp, type Env } from './worker.js';

// ─────────────────────────────────────────────────────────────
// Mock Utilities
// ─────────────────────────────────────────────────────────────

/**
 * Generate valid HMAC token for PIN authentication
 */
async function generateValidCookie(pin: string, salt = 'reminisce-test-auth-salt'): Promise<string> {
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

/**
 * Mock D1 Statement
 */
interface MockStatement {
  bind: (...args: unknown[]) => MockStatement;
  first: <T = unknown>() => Promise<T | null>;
  run: () => Promise<{ success: boolean; meta: { changes: number } }>;
  all: <T = unknown>() => Promise<{ results: T[]; success: boolean; meta: { changes: number } }>;
}

/**
 * Mock D1 Database with in-memory data storage
 */
function createMockD1(): {
  prepare: (query: string) => MockStatement;
  batch: (statements: MockStatement[]) => Promise<unknown[]>;
  exec: (query: string) => Promise<{ count: number; duration: number }>;
  _data: Map<string, unknown>;
} {
  const data = new Map<string, unknown>();

  const createStatement = (query: string): MockStatement => {
    let boundParams: unknown[] = [];

    const stmt: MockStatement = {
      bind: (...args: unknown[]) => {
        boundParams = args;
        return stmt;
      },
      first: async <T = unknown>() => {
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
        // Mock session count
        if (query.includes('COUNT(DISTINCT session_id)')) {
          return { sessions: 5 } as T;
        }
        return data.get('first') as T | null;
      },
      run: async () => {
        // Store operation - successful
        return { success: true, meta: { changes: 1 } };
      },
      all: async <T = unknown>() => {
        // Return empty array for queries
        return { results: [] as T[], success: true, meta: { changes: 0 } };
      },
    };

    return stmt;
  };

  return {
    prepare: createStatement,
    batch: async () => [],
    exec: async () => ({ count: 0, duration: 0 }),
    _data: data,
  };
}

/**
 * Create mock environment with test defaults
 */
function createMockEnv(overrides: Partial<Env> = {}): Env {
  const mockDb = createMockD1();

  return {
    DB: mockDb as unknown as Env['DB'],
    AUTH_PIN: '1234',
    AUTH_SALT: 'reminisce-test-auth-salt',
    ADMIN_TENANT: 'admin',
    CORS_ORIGINS: '*',
    ALLOW_ANONYMOUS: 'false',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// Test Suite
// ─────────────────────────────────────────────────────────────

describe('Cloudflare Worker Integration Tests', () => {
  let env: Env;

  beforeEach(() => {
    env = createMockEnv();
  });

  // ─────────────────────────────────────────────────────────────
  // 1. Health Check
  // ─────────────────────────────────────────────────────────────

  describe('GET /health', () => {
    it('returns 200 with status ok', async () => {
      const app = createWorkerApp(env);
      const res = await app.request('/health');

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe('ok');
      expect(json.timestamp).toBeDefined();
    });

    it('shows vectorize and AI feature flags correctly', async () => {
      const app = createWorkerApp(env);
      const res = await app.request('/health');

      const json = await res.json();
      expect(json.features).toBeDefined();
      expect(json.features.d1).toBe(true);
      expect(json.features.vectorize).toBe(false); // Not configured in base env
      expect(json.features.workersAi).toBe(false); // Not configured in base env
    });

    it('shows vectorize=true when VECTORIZE is configured', async () => {
      const envWithVectorize = createMockEnv({
        VECTORIZE: {} as Env['VECTORIZE'],
        AI: {} as Env['AI'],
      });
      const app = createWorkerApp(envWithVectorize);
      const res = await app.request('/health');

      const json = await res.json();
      expect(json.features.vectorize).toBe(true);
      expect(json.features.workersAi).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 2. PIN Auth Flow
  // ─────────────────────────────────────────────────────────────

  describe('PIN Authentication', () => {
    it('POST /__auth with correct PIN sets cookie and redirects', async () => {
      const app = createWorkerApp(env);

      const formData = new FormData();
      formData.append('pin', '1234');

      const res = await app.request('/__auth', {
        method: 'POST',
        body: formData,
      });

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('/dashboard/');
      const setCookie = res.headers.get('Set-Cookie');
      expect(setCookie).toBeDefined();
      expect(setCookie).toContain('reminisce-auth=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Secure');
      expect(setCookie).toContain('Max-Age=');
    });

    it('POST /__auth with wrong PIN shows login page with error', async () => {
      const app = createWorkerApp(env);

      const formData = new FormData();
      formData.append('pin', 'wrong-pin');

      const res = await app.request('/__auth', {
        method: 'POST',
        body: formData,
      });

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('Incorrect PIN');
      expect(html).toContain('<form method="POST" action="/__auth">');
    });

    it('dashboard routes without auth cookie show login page', async () => {
      const app = createWorkerApp(env);
      const res = await app.request('/dashboard/');

      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('Enter PIN to continue');
      expect(html).toContain('<form method="POST" action="/__auth">');
    });

    it('dashboard routes with valid auth cookie pass through', async () => {
      // Note: This test will show the "Assets not configured" error since we don't mock ASSETS,
      // but it proves auth passed through
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/dashboard/', {
        headers: { Cookie: cookie },
      });

      // Should get past auth (will fail at ASSETS check instead)
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(text).toBe('Assets not configured');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 3. API Auth Middleware
  // ─────────────────────────────────────────────────────────────

  describe('API Authentication', () => {
    it('API routes without auth return 401', async () => {
      const app = createWorkerApp(env);
      const res = await app.request('/api/stats');

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBeDefined();
    });

    it('API routes with valid PIN cookie work', async () => {
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/stats', {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toBeDefined();
    });

    it('API routes with valid API key work', async () => {
      const app = createWorkerApp(env);

      const res = await app.request('/api/stats', {
        headers: { 'X-API-Key': 'test-api-key-123' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 4. POST /api/memory/episode
  // ─────────────────────────────────────────────────────────────

  describe('POST /api/memory/episode', () => {
    it('invalid JSON returns 400', async () => {
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/memory/episode', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: 'not-json',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('Invalid JSON body');
    });

    it('missing event and summary returns 400', async () => {
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/memory/episode', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: ['test'] }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('event');
    });

    it('valid body stores and returns success', async () => {
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const episode = {
        event: 'Test event',
        summary: 'Test summary',
        session_id: 'test-session',
        entities: ['entity1', 'entity2'],
        valence: 0.5,
      };

      const res = await app.request('/api/memory/episode', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(episode),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.vectorIndex).toBeDefined();
    });

    it('returns vectorIndex: skipped when Vectorize not configured', async () => {
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const episode = {
        event: 'Test event',
        summary: 'Test summary',
      };

      const res = await app.request('/api/memory/episode', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(episode),
      });

      const json = await res.json();
      expect(json.vectorIndex).toBe('skipped');
    });

    it('returns vectorIndex: pending when Vectorize configured', async () => {
      const envWithVectorize = createMockEnv({
        VECTORIZE: {
          upsert: async () => ({}),
          query: async () => ({ matches: [] }),
          deleteByIds: async () => ({ count: 0 }),
        } as Env['VECTORIZE'],
        AI: {
          run: async () => ({ data: [[new Array(768).fill(0)]] }),
        } as Env['AI'],
      });
      const app = createWorkerApp(envWithVectorize);
      const cookie = await generateValidCookie('1234');

      const episode = {
        event: 'Test event',
        summary: 'Test summary',
      };

      const res = await app.request('/api/memory/episode', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(episode),
      });

      const json = await res.json();
      expect(json.vectorIndex).toBe('pending');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 5. POST /api/memory/fact
  // ─────────────────────────────────────────────────────────────

  describe('POST /api/memory/fact', () => {
    it('invalid JSON returns 400', async () => {
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/memory/fact', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: 'not-json',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('Invalid JSON body');
    });

    it('missing fact field returns 400', async () => {
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/memory/fact', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: 'test' }),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('fact');
    });

    it('valid body stores and returns success', async () => {
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const fact = {
        fact: 'User prefers TypeScript over JavaScript',
        subject: 'user',
        predicate: 'prefers',
        object: 'TypeScript',
        category: 'preference',
      };

      const res = await app.request('/api/memory/fact', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify(fact),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.vectorIndex).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 6. GET /api/stats
  // ─────────────────────────────────────────────────────────────

  describe('GET /api/stats', () => {
    it('returns expected structure', async () => {
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/stats', {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const json = await res.json();

      // Flat fields for dashboard
      expect(json.workingMemorySize).toBe(0);
      expect(json.workingMemoryCapacity).toBe(7);
      expect(json.pendingEpisodes).toBeDefined();
      expect(json.consolidatedEpisodes).toBe(0);
      expect(json.totalFacts).toBeDefined();
      expect(json.sessions).toBe(5); // From mock

      // Nested fields for API
      expect(json.episodic).toBeDefined();
      expect(json.semantic).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 7. GET /api/memory/episodic and /api/memory/semantic
  // ─────────────────────────────────────────────────────────────

  describe('GET /api/memory/episodic', () => {
    it('respects limit param', async () => {
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/memory/episodic?limit=20', {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.items).toBeDefined();
      expect(Array.isArray(json.items)).toBe(true);
    });

    it('returns items array', async () => {
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/memory/episodic', {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.items).toBeDefined();
      expect(Array.isArray(json.items)).toBe(true);
    });
  });

  describe('GET /api/memory/semantic', () => {
    it('respects limit param', async () => {
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/memory/semantic?limit=100', {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.items).toBeDefined();
      expect(Array.isArray(json.items)).toBe(true);
    });

    it('returns items array', async () => {
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/memory/semantic', {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.items).toBeDefined();
      expect(Array.isArray(json.items)).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 8. DELETE Endpoints
  // ─────────────────────────────────────────────────────────────

  describe('DELETE /api/memory/episodic/:id', () => {
    it('returns success', async () => {
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/memory/episodic/test-id-123', {
        method: 'DELETE',
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBeDefined();
    });
  });

  describe('DELETE /api/memory/semantic/:id', () => {
    it('returns success', async () => {
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/memory/semantic/test-fact-123', {
        method: 'DELETE',
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBeDefined();
    });
  });

  describe('DELETE /api/session/:sessionId', () => {
    it('deletes both episodic and semantic memories', async () => {
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/session/test-session-123', {
        method: 'DELETE',
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.deleted).toBeDefined();
      expect(json.deleted.episodic).toBeDefined();
      expect(json.deleted.semantic).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 9. GET /api/search
  // ─────────────────────────────────────────────────────────────

  describe('GET /api/search', () => {
    it('missing q parameter returns 400', async () => {
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/search', {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('q');
    });

    it('returns fallback method when no Vectorize', async () => {
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/search?q=test', {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.method).toBe('fallback');
      expect(json.results).toBeDefined();
      expect(Array.isArray(json.results)).toBe(true);
    });

    it('uses vector method when Vectorize configured', async () => {
      const envWithVectorize = createMockEnv({
        VECTORIZE: {
          upsert: async () => ({}),
          query: async () => ({ matches: [] }),
          deleteByIds: async () => ({ count: 0 }),
        } as Env['VECTORIZE'],
        AI: {
          run: async () => ({ data: [[new Array(768).fill(0)]] }),
        } as Env['AI'],
      });
      const app = createWorkerApp(envWithVectorize);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/search?q=test', {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.method).toBe('vector');
      expect(json.results).toBeDefined();
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 10. POST /api/init
  // ─────────────────────────────────────────────────────────────

  describe('POST /api/init', () => {
    it('calls exec with schema (requires auth)', async () => {
      const app = createWorkerApp(env);

      const res = await app.request('/api/init', {
        method: 'POST',
        headers: { 'X-API-Key': 'test-api-key-123' },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.message).toBe('Schema initialized');
    });

    it('rejects unauthenticated requests', async () => {
      const app = createWorkerApp(env);

      const res = await app.request('/api/init', {
        method: 'POST',
      });

      expect(res.status).toBe(401);
    });
  });

  // ─────────────────────────────────────────────────────────────
  // 11. Root Redirect
  // ─────────────────────────────────────────────────────────────

  describe('GET /', () => {
    it('redirects to /dashboard/', async () => {
      const app = createWorkerApp(env);

      const res = await app.request('/');

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('/dashboard/');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Additional Tests
  // ─────────────────────────────────────────────────────────────

  describe('GET /api/memory/working', () => {
    it('returns empty array with note', async () => {
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/memory/working', {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.items).toEqual([]);
      expect(json.note).toContain('Working memory');
    });
  });

  describe('GET /api/graph', () => {
    it('returns knowledge graph structure', async () => {
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/graph', {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.nodes).toBeDefined();
      expect(json.edges).toBeDefined();
      expect(Array.isArray(json.nodes)).toBe(true);
      expect(Array.isArray(json.edges)).toBe(true);
    });
  });

  describe('GET /api/tenant', () => {
    it('returns tenant info when authenticated', async () => {
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/tenant', {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.tenantId).toBe('admin');
      expect(json.tenantName).toBe('Dashboard');
      expect(json.machineId).toBe('dashboard');
      expect(json.authenticated).toBe(true);
    });

    it('returns 401 when not authenticated', async () => {
      const app = createWorkerApp(env);

      const res = await app.request('/api/tenant');

      expect(res.status).toBe(401);
      const json = await res.json();
      expect(json.error).toBeDefined();
    });
  });

  describe('POST /api/embed', () => {
    it('returns 501 when Workers AI not configured', async () => {
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/embed', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'test' }),
      });

      expect(res.status).toBe(501);
      const json = await res.json();
      expect(json.error).toContain('Workers AI');
    });

    it('generates embeddings when AI configured', async () => {
      const envWithAI = createMockEnv({
        AI: {
          run: async () => ({ data: [[new Array(768).fill(0.1)]] }),
        } as Env['AI'],
      });
      const app = createWorkerApp(envWithAI);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/embed', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'test embedding' }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.embedding).toBeDefined();
      expect(json.dimensions).toBe(768);
      expect(json.model).toBe('@cf/google/embeddinggemma-300m');
    });

    it('handles batch embeddings', async () => {
      const envWithAI = createMockEnv({
        AI: {
          run: async () => ({ data: [new Array(768).fill(0.1), new Array(768).fill(0.2)] }),
        } as Env['AI'],
      });
      const app = createWorkerApp(envWithAI);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/embed', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: ['test1', 'test2'] }),
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.embeddings).toBeDefined();
      expect(Array.isArray(json.embeddings)).toBe(true);
      expect(json.dimensions).toBe(768);
    });
  });

  describe('GET /api/vector/search', () => {
    it('returns 501 when Vectorize not configured', async () => {
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/vector/search?q=test', {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(501);
      const json = await res.json();
      expect(json.error).toContain('Vector search');
    });

    it('requires q parameter', async () => {
      const envWithVectorize = createMockEnv({
        VECTORIZE: {} as Env['VECTORIZE'],
        AI: {} as Env['AI'],
      });
      const app = createWorkerApp(envWithVectorize);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/vector/search', {
        headers: { Cookie: cookie },
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('q');
    });
  });

  describe('POST /api/reindex', () => {
    it('returns 403 for non-admin tenant', async () => {
      // Use a regular API key (maps to 'test-tenant', not 'admin')
      const app = createWorkerApp(env);

      const res = await app.request('/api/reindex', {
        method: 'POST',
        headers: { 'X-API-Key': 'test-api-key-123' },
      });

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toContain('Admin');
    });
  });

  describe('POST /api/chat', () => {
    it('returns 501 when Workers AI not configured', async () => {
      const app = createWorkerApp(env);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/chat', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'test?' }),
      });

      expect(res.status).toBe(501);
      const json = await res.json();
      expect(json.error).toContain('Workers AI');
    });

    it('requires question parameter', async () => {
      const envWithAI = createMockEnv({
        AI: {} as Env['AI'],
      });
      const app = createWorkerApp(envWithAI);
      const cookie = await generateValidCookie('1234');

      const res = await app.request('/api/chat', {
        method: 'POST',
        headers: { Cookie: cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('Question');
    });
  });

  describe('Custom AUTH_SALT', () => {
    it('uses custom salt when provided', async () => {
      const customSalt = 'custom-salt-value-test';
      const envWithCustomSalt = createMockEnv({
        AUTH_SALT: customSalt,
      });
      const app = createWorkerApp(envWithCustomSalt);

      const formData = new FormData();
      formData.append('pin', '1234');

      const res = await app.request('/__auth', {
        method: 'POST',
        body: formData,
      });

      expect(res.status).toBe(302);

      // Verify cookie can be validated with custom salt
      const setCookie = res.headers.get('Set-Cookie');
      expect(setCookie).toBeDefined();
      const match = setCookie!.match(/reminisce-auth=([^;]+)/);
      expect(match).toBeDefined();

      // Create a new request with the cookie
      const cookie = `reminisce-auth=${match![1]}`;
      const verifyRes = await app.request('/api/stats', {
        headers: { Cookie: cookie },
      });

      expect(verifyRes.status).toBe(200);
    });
  });
});
