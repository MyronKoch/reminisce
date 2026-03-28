/**
 * Comprehensive test suite for Reminisce Authentication
 *
 * Tests:
 * 1. JWT creation and verification
 * 2. Rate limiting
 * 3. Auth middleware (API key, JWT, anonymous, public paths, machine restriction)
 * 4. Tenant utilities
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import {
  createJWT,
  verifyJWT,
  generateApiKey,
  createTenant,
  createTenantStore,
  createAuthMiddleware,
  getAuth,
  type Tenant,
  type AuthContext,
} from './auth.js';

// ─────────────────────────────────────────────────────────────
// Test Helpers
// ─────────────────────────────────────────────────────────────

const TEST_SECRET = 'test-secret-key';

function createTestTenant(overrides: Partial<Tenant> = {}): Tenant {
  return {
    id: 'tenant-123',
    name: 'Test Tenant',
    apiKey: 'test-key-abc',
    active: true,
    createdAt: new Date(),
    ...overrides,
  };
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────
// 1. JWT Creation and Verification
// ─────────────────────────────────────────────────────────────

describe('JWT creation and verification', () => {
  it('should create and verify round-trip token', async () => {
    const tenantId = 'tenant-123';
    const token = await createJWT(tenantId, TEST_SECRET);

    expect(token).toBeDefined();
    expect(typeof token).toBe('string');
    expect(token.split('.')).toHaveLength(3);

    const payload = await verifyJWT(token, TEST_SECRET);
    expect(payload).not.toBeNull();
    expect(payload?.sub).toBe(tenantId);
    expect(payload?.iat).toBeDefined();
    expect(payload?.exp).toBeDefined();
  });

  it('should return null for expired tokens', async () => {
    const tenantId = 'tenant-123';
    // Create token with negative expiration (already expired)
    const token = await createJWT(tenantId, TEST_SECRET, { expiresIn: -10 });

    const payload = await verifyJWT(token, TEST_SECRET);
    expect(payload).toBeNull();
  });

  it('should return null for invalid signatures', async () => {
    const tenantId = 'tenant-123';
    const token = await createJWT(tenantId, TEST_SECRET);

    // Try to verify with wrong secret
    const payload = await verifyJWT(token, 'wrong-secret');
    expect(payload).toBeNull();
  });

  it('should return null for malformed tokens (wrong number of parts)', async () => {
    const malformedTokens = [
      'not.a.valid.token.too.many.parts',
      'only.two',
      'single',
      '',
      'no-dots-at-all',
    ];

    for (const token of malformedTokens) {
      const payload = await verifyJWT(token, TEST_SECRET);
      expect(payload).toBeNull();
    }
  });

  it('should support custom expiration', async () => {
    const tenantId = 'tenant-123';
    const expiresIn = 7200; // 2 hours
    const token = await createJWT(tenantId, TEST_SECRET, { expiresIn });

    const payload = await verifyJWT(token, TEST_SECRET);
    expect(payload).not.toBeNull();

    // Check that expiration is roughly 2 hours from now
    const expectedExp = Math.floor(Date.now() / 1000) + expiresIn;
    expect(payload?.exp).toBeGreaterThanOrEqual(expectedExp - 5); // Allow 5s tolerance
    expect(payload?.exp).toBeLessThanOrEqual(expectedExp + 5);
  });

  it('should support custom machineId in token', async () => {
    const tenantId = 'tenant-123';
    const machineId = 'machine-xyz';
    const token = await createJWT(tenantId, TEST_SECRET, { machineId });

    const payload = await verifyJWT(token, TEST_SECRET);
    expect(payload).not.toBeNull();
    expect(payload?.machine).toBe(machineId);
  });

  it('should create token without machineId when not specified', async () => {
    const tenantId = 'tenant-123';
    const token = await createJWT(tenantId, TEST_SECRET);

    const payload = await verifyJWT(token, TEST_SECRET);
    expect(payload).not.toBeNull();
    expect(payload?.machine).toBeUndefined();
  });

  it('should return null for tokens with invalid JSON payload', async () => {
    // Manually construct a token with invalid JSON
    const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const invalidPayload = btoa('not valid json {{{');
    const token = `${header}.${invalidPayload}.fakesignature`;

    const payload = await verifyJWT(token, TEST_SECRET);
    expect(payload).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// 2. Rate Limiting
// ─────────────────────────────────────────────────────────────

describe('Rate limiting', () => {
  // Note: Rate limit state is stored in a module-level Map, so we need unique tenant IDs
  // for each test to avoid state collision

  it('should allow requests within limit', async () => {
    const tenant = createTestTenant({
      id: `tenant-within-limit-${crypto.randomUUID()}`,
      apiKey: `rate-limit-within-${crypto.randomUUID()}`,
      rateLimit: 3,
    });

    const store = createTenantStore();
    store.addTenant(tenant);

    const app = new Hono();
    app.use('/*', createAuthMiddleware({ apiKeys: store.apiKeys }));
    app.get('/test', (c) => c.json({ ok: true }));

    const headers = { 'X-API-Key': tenant.apiKey };

    // First request
    const res1 = await app.request('/test', { headers });
    expect(res1.status).toBe(200);
    expect(res1.headers.get('X-RateLimit-Limit')).toBe('3');
    expect(res1.headers.get('X-RateLimit-Remaining')).toBe('2');

    // Second request
    const res2 = await app.request('/test', { headers });
    expect(res2.status).toBe(200);
    expect(res2.headers.get('X-RateLimit-Remaining')).toBe('1');

    // Third request
    const res3 = await app.request('/test', { headers });
    expect(res3.status).toBe(200);
    expect(res3.headers.get('X-RateLimit-Remaining')).toBe('0');
  });

  it('should reject requests over limit with 429', async () => {
    const tenant = createTestTenant({
      id: `tenant-over-limit-${crypto.randomUUID()}`,
      apiKey: `rate-limit-over-${crypto.randomUUID()}`,
      rateLimit: 3,
    });

    const store = createTenantStore();
    store.addTenant(tenant);

    const app = new Hono();
    app.use('/*', createAuthMiddleware({ apiKeys: store.apiKeys }));
    app.get('/test', (c) => c.json({ ok: true }));

    const headers = { 'X-API-Key': tenant.apiKey };

    // Make 3 successful requests
    await app.request('/test', { headers });
    await app.request('/test', { headers });
    await app.request('/test', { headers });

    // Fourth request should fail
    const res = await app.request('/test', { headers });
    expect(res.status).toBe(429);

    const body = await res.json();
    expect(body.error).toBe('Rate limit exceeded');
    expect(body.resetIn).toBeGreaterThan(0);
  });

  it('should reset rate limit after window expires', async () => {
    // Note: This test is marked as slow because it requires waiting for the 60-second window
    // In practice, you might want to skip this in quick test runs

    const tenant = createTestTenant({
      id: `tenant-reset-${crypto.randomUUID()}`,
      apiKey: `rate-limit-reset-${crypto.randomUUID()}`,
      rateLimit: 3,
    });

    const store = createTenantStore();
    store.addTenant(tenant);

    const app = new Hono();
    app.use('/*', createAuthMiddleware({ apiKeys: store.apiKeys }));
    app.get('/test', (c) => c.json({ ok: true }));

    const headers = { 'X-API-Key': tenant.apiKey };

    // Exhaust rate limit
    await app.request('/test', { headers });
    await app.request('/test', { headers });
    await app.request('/test', { headers });

    // Fourth request should fail
    const res1 = await app.request('/test', { headers });
    expect(res1.status).toBe(429);

    // Wait for window to expire (1 minute + buffer)
    await sleep(61000);

    // Should succeed after reset
    const res2 = await app.request('/test', { headers });
    expect(res2.status).toBe(200);
    expect(res2.headers.get('X-RateLimit-Remaining')).toBe('2');
  }, 70000); // 70 second timeout

  it('should set rate limit headers correctly', async () => {
    const tenant = createTestTenant({
      id: `tenant-headers-${crypto.randomUUID()}`,
      apiKey: `rate-limit-headers-${crypto.randomUUID()}`,
      rateLimit: 3,
    });

    const store = createTenantStore();
    store.addTenant(tenant);

    const app = new Hono();
    app.use('/*', createAuthMiddleware({ apiKeys: store.apiKeys }));
    app.get('/test', (c) => c.json({ ok: true }));

    const headers = { 'X-API-Key': tenant.apiKey };

    const res = await app.request('/test', { headers });
    expect(res.status).toBe(200);

    expect(res.headers.get('X-RateLimit-Limit')).toBe('3');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('2');
    expect(res.headers.get('X-RateLimit-Reset')).toBeDefined();

    const resetIn = parseInt(res.headers.get('X-RateLimit-Reset') || '0', 10);
    expect(resetIn).toBeGreaterThan(0);
    expect(resetIn).toBeLessThanOrEqual(60);
  });

  it('should not rate limit tenants without rateLimit configured', async () => {
    const unlimitedTenant = createTestTenant({
      apiKey: 'unlimited-key',
      rateLimit: undefined,
    });

    const store = createTenantStore();
    store.addTenant(unlimitedTenant);

    const testApp = new Hono();
    testApp.use('/*', createAuthMiddleware({ apiKeys: store.apiKeys }));
    testApp.get('/test', (c) => c.json({ ok: true }));

    const headers = { 'X-API-Key': unlimitedTenant.apiKey };

    // Make many requests - should all succeed
    for (let i = 0; i < 10; i++) {
      const res = await testApp.request('/test', { headers });
      expect(res.status).toBe(200);
      expect(res.headers.get('X-RateLimit-Limit')).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 3. Auth Middleware
// ─────────────────────────────────────────────────────────────

describe('Auth middleware', () => {
  describe('API key authentication', () => {
    it('should authenticate with valid API key', async () => {
      const tenant = createTestTenant();
      const store = createTenantStore();
      store.addTenant(tenant);

      const app = new Hono();
      app.use('/*', createAuthMiddleware({ apiKeys: store.apiKeys }));
      app.get('/test', (c) => {
        const auth = getAuth(c);
        return c.json({ tenantId: auth?.tenant.id, authenticated: auth?.authenticated });
      });

      const res = await app.request('/test', {
        headers: { 'X-API-Key': tenant.apiKey },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tenantId).toBe(tenant.id);
      expect(body.authenticated).toBe(true);
    });

    it('should reject invalid API key with 401', async () => {
      const tenant = createTestTenant();
      const store = createTenantStore();
      store.addTenant(tenant);

      const app = new Hono();
      app.use('/*', createAuthMiddleware({ apiKeys: store.apiKeys }));
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test', {
        headers: { 'X-API-Key': 'invalid-key' },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Authentication required');
    });

    it('should use custom validateApiKey function', async () => {
      const customKey = 'custom-key-123';
      const customTenant = createTestTenant({ id: 'custom-tenant' });

      const validateApiKey = async (key: string): Promise<Tenant | null> => {
        return key === customKey ? customTenant : null;
      };

      const app = new Hono();
      app.use('/*', createAuthMiddleware({ validateApiKey }));
      app.get('/test', (c) => {
        const auth = getAuth(c);
        return c.json({ tenantId: auth?.tenant.id });
      });

      const res = await app.request('/test', {
        headers: { 'X-API-Key': customKey },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tenantId).toBe('custom-tenant');
    });

    it('should reject inactive tenant', async () => {
      const inactiveTenant = createTestTenant({ active: false });
      const store = createTenantStore();
      store.addTenant(inactiveTenant);

      const app = new Hono();
      app.use('/*', createAuthMiddleware({ apiKeys: store.apiKeys }));
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test', {
        headers: { 'X-API-Key': inactiveTenant.apiKey },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Authentication required');
    });
  });

  describe('JWT bearer token authentication', () => {
    it('should authenticate with valid JWT', async () => {
      const tenant = createTestTenant();
      const store = createTenantStore();
      store.addTenant(tenant);

      const token = await createJWT(tenant.id, TEST_SECRET);

      const app = new Hono();
      app.use('/*', createAuthMiddleware({ apiKeys: store.apiKeys, jwtSecret: TEST_SECRET }));
      app.get('/test', (c) => {
        const auth = getAuth(c);
        return c.json({ tenantId: auth?.tenant.id, authenticated: auth?.authenticated });
      });

      const res = await app.request('/test', {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tenantId).toBe(tenant.id);
      expect(body.authenticated).toBe(true);
    });

    it('should reject expired JWT with 401', async () => {
      const tenant = createTestTenant();
      const store = createTenantStore();
      store.addTenant(tenant);

      // Create token with negative expiration (already expired)
      const token = await createJWT(tenant.id, TEST_SECRET, { expiresIn: -10 });

      const app = new Hono();
      app.use('/*', createAuthMiddleware({ apiKeys: store.apiKeys, jwtSecret: TEST_SECRET }));
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test', {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Invalid or expired token');
    });

    it('should reject JWT with invalid signature', async () => {
      const tenant = createTestTenant();
      const store = createTenantStore();
      store.addTenant(tenant);

      // Create token with one secret, verify with another
      const token = await createJWT(tenant.id, 'wrong-secret');

      const app = new Hono();
      app.use('/*', createAuthMiddleware({ apiKeys: store.apiKeys, jwtSecret: TEST_SECRET }));
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test', {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Invalid or expired token');
    });

    it('should extract machineId from JWT payload', async () => {
      const tenant = createTestTenant();
      const machineId = 'machine-from-jwt';
      const store = createTenantStore();
      store.addTenant(tenant);

      const token = await createJWT(tenant.id, TEST_SECRET, { machineId });

      const app = new Hono();
      app.use('/*', createAuthMiddleware({ apiKeys: store.apiKeys, jwtSecret: TEST_SECRET }));
      app.get('/test', (c) => {
        const auth = getAuth(c);
        return c.json({ machineId: auth?.machineId });
      });

      const res = await app.request('/test', {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.machineId).toBe(machineId);
    });
  });

  describe('Anonymous access', () => {
    it('should allow anonymous access when allowAnonymous=true', async () => {
      const app = new Hono();
      app.use('/*', createAuthMiddleware({ allowAnonymous: true }));
      app.get('/test', (c) => {
        const auth = getAuth(c);
        return c.json({
          tenantId: auth?.tenant.id,
          authenticated: auth?.authenticated,
        });
      });

      const res = await app.request('/test');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tenantId).toBe('anonymous');
      expect(body.authenticated).toBe(false);
    });

    it('should return 401 when no valid auth and allowAnonymous=false', async () => {
      const app = new Hono();
      app.use('/*', createAuthMiddleware({ allowAnonymous: false }));
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test');

      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Authentication required');
    });

    it('should use X-Machine-ID header for anonymous requests', async () => {
      const app = new Hono();
      app.use('/*', createAuthMiddleware({ allowAnonymous: true }));
      app.get('/test', (c) => {
        const auth = getAuth(c);
        return c.json({ machineId: auth?.machineId });
      });

      const res = await app.request('/test', {
        headers: { 'X-Machine-ID': 'custom-machine' },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.machineId).toBe('custom-machine');
    });
  });

  describe('Public paths', () => {
    it('should skip auth for default public paths (/health)', async () => {
      const app = new Hono();
      app.use('/*', createAuthMiddleware({ allowAnonymous: false }));
      app.get('/health', (c) => c.json({ status: 'ok' }));

      const res = await app.request('/health');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
    });

    it('should skip auth for custom public paths', async () => {
      const app = new Hono();
      app.use(
        '/*',
        createAuthMiddleware({
          allowAnonymous: false,
          publicPaths: ['/health', '/status', '/public'],
        })
      );
      app.get('/public/data', (c) => c.json({ data: 'public' }));

      const res = await app.request('/public/data');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.data).toBe('public');
    });

    it('should require auth for non-public paths', async () => {
      const app = new Hono();
      app.use(
        '/*',
        createAuthMiddleware({
          allowAnonymous: false,
          publicPaths: ['/health'],
        })
      );
      app.get('/private', (c) => c.json({ ok: true }));

      const res = await app.request('/private');

      expect(res.status).toBe(401);
    });
  });

  describe('Machine restriction enforcement', () => {
    it('should allow requests from allowed machines', async () => {
      const tenant = createTestTenant({
        allowedMachines: ['machine-1', 'machine-2'],
      });
      const store = createTenantStore();
      store.addTenant(tenant);

      const app = new Hono();
      app.use('/*', createAuthMiddleware({ apiKeys: store.apiKeys }));
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test', {
        headers: {
          'X-API-Key': tenant.apiKey,
          'X-Machine-ID': 'machine-1',
        },
      });

      expect(res.status).toBe(200);
    });

    it('should reject requests from non-allowed machines with 403', async () => {
      const tenant = createTestTenant({
        allowedMachines: ['machine-1', 'machine-2'],
      });
      const store = createTenantStore();
      store.addTenant(tenant);

      const app = new Hono();
      app.use('/*', createAuthMiddleware({ apiKeys: store.apiKeys }));
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test', {
        headers: {
          'X-API-Key': tenant.apiKey,
          'X-Machine-ID': 'machine-3',
        },
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Machine not allowed for this tenant');
    });

    it('should allow requests without machine restriction', async () => {
      const tenant = createTestTenant({
        allowedMachines: undefined, // No restriction
      });
      const store = createTenantStore();
      store.addTenant(tenant);

      const app = new Hono();
      app.use('/*', createAuthMiddleware({ apiKeys: store.apiKeys }));
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test', {
        headers: {
          'X-API-Key': tenant.apiKey,
          'X-Machine-ID': 'any-machine',
        },
      });

      expect(res.status).toBe(200);
    });

    it('should enforce machine restriction with JWT tokens', async () => {
      const tenant = createTestTenant({
        allowedMachines: ['machine-allowed'],
      });
      const store = createTenantStore();
      store.addTenant(tenant);

      const token = await createJWT(tenant.id, TEST_SECRET, { machineId: 'machine-not-allowed' });

      const app = new Hono();
      app.use('/*', createAuthMiddleware({ apiKeys: store.apiKeys, jwtSecret: TEST_SECRET }));
      app.get('/test', (c) => c.json({ ok: true }));

      const res = await app.request('/test', {
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe('Machine not allowed for this tenant');
    });
  });

  describe('Auth context', () => {
    it('should set auth context on successful authentication', async () => {
      const tenant = createTestTenant();
      const store = createTenantStore();
      store.addTenant(tenant);

      const app = new Hono();
      app.use('/*', createAuthMiddleware({ apiKeys: store.apiKeys }));
      app.get('/test', (c) => {
        const auth = getAuth(c);
        return c.json({
          tenantId: auth?.tenant.id,
          tenantName: auth?.tenant.name,
          machineId: auth?.machineId,
          authenticated: auth?.authenticated,
        });
      });

      const res = await app.request('/test', {
        headers: {
          'X-API-Key': tenant.apiKey,
          'X-Machine-ID': 'test-machine',
        },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tenantId).toBe(tenant.id);
      expect(body.tenantName).toBe(tenant.name);
      expect(body.machineId).toBe('test-machine');
      expect(body.authenticated).toBe(true);
    });

    it('should default machineId to tenant.id when header not provided', async () => {
      const tenant = createTestTenant();
      const store = createTenantStore();
      store.addTenant(tenant);

      const app = new Hono();
      app.use('/*', createAuthMiddleware({ apiKeys: store.apiKeys }));
      app.get('/test', (c) => {
        const auth = getAuth(c);
        return c.json({ machineId: auth?.machineId });
      });

      const res = await app.request('/test', {
        headers: { 'X-API-Key': tenant.apiKey },
      });

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.machineId).toBe(tenant.id);
    });
  });
});

// ─────────────────────────────────────────────────────────────
// 4. Tenant Utilities
// ─────────────────────────────────────────────────────────────

describe('Tenant utilities', () => {
  describe('generateApiKey', () => {
    it('should produce key starting with "reminisce_"', () => {
      const key = generateApiKey();
      expect(key.startsWith('reminisce_')).toBe(true);
    });

    it('should generate unique keys', () => {
      const keys = new Set<string>();
      for (let i = 0; i < 100; i++) {
        keys.add(generateApiKey());
      }
      expect(keys.size).toBe(100);
    });

    it('should generate keys with correct format (prefix + 64 hex chars)', () => {
      const key = generateApiKey();
      const hexPart = key.slice('reminisce_'.length);

      // 32 bytes = 64 hex characters
      expect(hexPart.length).toBe(64);
      expect(/^[0-9a-f]{64}$/.test(hexPart)).toBe(true);
    });
  });

  describe('createTenant', () => {
    it('should generate valid tenant', () => {
      const tenant = createTenant('Test Tenant');

      expect(tenant.id).toBeDefined();
      expect(tenant.name).toBe('Test Tenant');
      expect(tenant.apiKey.startsWith('reminisce_')).toBe(true);
      expect(tenant.active).toBe(true);
      expect(tenant.createdAt).toBeInstanceOf(Date);
    });

    it('should support custom options', () => {
      const tenant = createTenant('Custom Tenant', {
        active: false,
        rateLimit: 100,
        allowedMachines: ['machine-1'],
      });

      expect(tenant.name).toBe('Custom Tenant');
      expect(tenant.active).toBe(false);
      expect(tenant.rateLimit).toBe(100);
      expect(tenant.allowedMachines).toEqual(['machine-1']);
    });

    it('should generate unique IDs', () => {
      const tenant1 = createTenant('Tenant 1');
      const tenant2 = createTenant('Tenant 2');

      expect(tenant1.id).not.toBe(tenant2.id);
      expect(tenant1.apiKey).not.toBe(tenant2.apiKey);
    });
  });

  describe('createTenantStore', () => {
    it('should add tenant', () => {
      const store = createTenantStore();
      const tenant = createTestTenant();

      store.addTenant(tenant);

      expect(store.getTenant(tenant.apiKey)).toEqual(tenant);
    });

    it('should remove tenant', () => {
      const store = createTenantStore();
      const tenant = createTestTenant();

      store.addTenant(tenant);
      expect(store.getTenant(tenant.apiKey)).toEqual(tenant);

      store.removeTenant(tenant.apiKey);
      expect(store.getTenant(tenant.apiKey)).toBeUndefined();
    });

    it('should list all tenants', () => {
      const store = createTenantStore();
      const tenant1 = createTestTenant({ id: 'tenant-1', apiKey: 'key-1' });
      const tenant2 = createTestTenant({ id: 'tenant-2', apiKey: 'key-2' });

      store.addTenant(tenant1);
      store.addTenant(tenant2);

      const tenants = store.listTenants();
      expect(tenants).toHaveLength(2);
      expect(tenants).toContainEqual(tenant1);
      expect(tenants).toContainEqual(tenant2);
    });

    it('should update tenant on re-add', () => {
      const store = createTenantStore();
      const tenant = createTestTenant();

      store.addTenant(tenant);

      const updatedTenant = { ...tenant, name: 'Updated Name' };
      store.addTenant(updatedTenant);

      expect(store.getTenant(tenant.apiKey)?.name).toBe('Updated Name');
    });

    it('should return apiKeys map', () => {
      const store = createTenantStore();
      const tenant = createTestTenant();

      store.addTenant(tenant);

      expect(store.apiKeys).toBeInstanceOf(Map);
      expect(store.apiKeys.get(tenant.apiKey)).toEqual(tenant);
    });
  });
});
