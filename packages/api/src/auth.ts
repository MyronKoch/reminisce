/**
 * Reminisce Authentication Middleware
 *
 * Supports:
 * - API key authentication (X-API-Key header)
 * - JWT bearer tokens (Authorization: Bearer <token>)
 * - Multi-tenant isolation via tenant mapping
 */

import type { Context, Next } from 'hono';
import { createMiddleware } from 'hono/factory';

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

export interface Tenant {
  id: string;
  name: string;
  apiKey: string;
  /** Optional: restrict to specific machine IDs */
  allowedMachines?: string[];
  /** Rate limit: requests per minute */
  rateLimit?: number;
  /** Is this tenant active? */
  active: boolean;
  createdAt: Date;
}

export interface AuthContext {
  tenant: Tenant;
  machineId: string;
  authenticated: boolean;
}

export interface AuthConfig {
  /** API keys mapped to tenant info */
  apiKeys?: Map<string, Tenant>;
  /** JWT secret for token verification */
  jwtSecret?: string;
  /** Allow unauthenticated requests (for local dev) */
  allowAnonymous?: boolean;
  /** Custom API key validator */
  validateApiKey?: (key: string) => Promise<Tenant | null>;
  /** Paths that don't require auth */
  publicPaths?: string[];
}

export interface RateLimitState {
  count: number;
  resetAt: number;
}

// ─────────────────────────────────────────────────────────────
// JWT Utilities (minimal, no external deps)
// ─────────────────────────────────────────────────────────────

function base64UrlDecode(str: string): string {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  return atob(padded);
}

function base64UrlEncode(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function hmacSign(message: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));
}

async function hmacVerify(message: string, signature: string, secret: string): Promise<boolean> {
  const expected = await hmacSign(message, secret);
  return constantTimeEqual(signature, expected);
}

/** Constant-time string comparison to prevent timing attacks (no length leak) */
function constantTimeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let result = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return result === 0;
}

export interface JWTPayload {
  sub: string; // tenant ID
  iat: number; // issued at
  exp: number; // expiration
  machine?: string; // optional machine ID
}

/**
 * Create a JWT token for a tenant
 */
export async function createJWT(
  tenantId: string,
  secret: string,
  options: { expiresIn?: number; machineId?: string } = {}
): Promise<string> {
  const { expiresIn = 3600, machineId } = options;
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload: JWTPayload = {
    sub: tenantId,
    iat: now,
    exp: now + expiresIn,
  };
  if (machineId) {
    payload.machine = machineId;
  }

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmacSign(`${headerB64}.${payloadB64}`, secret);

  return `${headerB64}.${payloadB64}.${signature}`;
}

/**
 * Verify and decode a JWT token
 */
export async function verifyJWT(token: string, secret: string): Promise<JWTPayload | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signature] = parts as [string, string, string];

  // Verify signature
  const isValid = await hmacVerify(`${headerB64}.${payloadB64}`, signature, secret);
  if (!isValid) return null;

  // Decode payload
  try {
    const payload = JSON.parse(base64UrlDecode(payloadB64)) as JWTPayload;

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return null;

    return payload;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Rate Limiting
// ─────────────────────────────────────────────────────────────

const rateLimitStore = new Map<string, RateLimitState>();

function checkRateLimit(tenantId: string, limit: number): { allowed: boolean; remaining: number; resetIn: number } {
  const now = Date.now();
  const windowMs = 60_000; // 1 minute window

  let state = rateLimitStore.get(tenantId);

  if (!state || state.resetAt < now) {
    state = { count: 0, resetAt: now + windowMs };
    rateLimitStore.set(tenantId, state);
  }

  state.count++;
  const allowed = state.count <= limit;
  const remaining = Math.max(0, limit - state.count);
  const resetIn = Math.ceil((state.resetAt - now) / 1000);

  return { allowed, remaining, resetIn };
}

// ─────────────────────────────────────────────────────────────
// Auth Middleware
// ─────────────────────────────────────────────────────────────

/**
 * Create authentication middleware
 */
export function createAuthMiddleware(config: AuthConfig = {}) {
  const { apiKeys, jwtSecret, allowAnonymous = false, validateApiKey, publicPaths = ['/health'] } = config;

  return createMiddleware<{ Variables: { auth: AuthContext } }>(async (c, next) => {
    const path = c.req.path;

    // Skip auth for public paths
    if (publicPaths.some((p) => path.startsWith(p))) {
      return next();
    }

    // Try API key auth first
    const apiKey = c.req.header('X-API-Key');
    if (apiKey) {
      let tenant: Tenant | null = null;

      // Custom validator takes precedence
      if (validateApiKey) {
        tenant = await validateApiKey(apiKey);
      } else if (apiKeys) {
        tenant = apiKeys.get(apiKey) ?? null;
      }

      if (tenant && tenant.active) {
        // Check rate limit
        if (tenant.rateLimit) {
          const { allowed, remaining, resetIn } = checkRateLimit(tenant.id, tenant.rateLimit);
          c.header('X-RateLimit-Limit', tenant.rateLimit.toString());
          c.header('X-RateLimit-Remaining', remaining.toString());
          c.header('X-RateLimit-Reset', resetIn.toString());

          if (!allowed) {
            return c.json({ error: 'Rate limit exceeded', resetIn }, 429);
          }
        }

        const machineId = c.req.header('X-Machine-ID') || tenant.id;

        // Check machine restriction
        if (tenant.allowedMachines && !tenant.allowedMachines.includes(machineId)) {
          return c.json({ error: 'Machine not allowed for this tenant' }, 403);
        }

        c.set('auth', { tenant, machineId, authenticated: true });
        return next();
      }
    }

    // Try JWT auth
    const authHeader = c.req.header('Authorization');
    if (authHeader?.startsWith('Bearer ') && jwtSecret) {
      const token = authHeader.slice(7);
      const payload = await verifyJWT(token, jwtSecret);

      if (payload) {
        // Look up tenant
        let tenant: Tenant | null = null;
        if (apiKeys) {
          for (const t of apiKeys.values()) {
            if (t.id === payload.sub) {
              tenant = t;
              break;
            }
          }
        }

        if (tenant && tenant.active) {
          const machineId = payload.machine || c.req.header('X-Machine-ID') || tenant.id;

          // Check machine restriction (same as API key path)
          if (tenant.allowedMachines && !tenant.allowedMachines.includes(machineId)) {
            return c.json({ error: 'Machine not allowed for this tenant' }, 403);
          }

          c.set('auth', { tenant, machineId, authenticated: true });
          return next();
        }
      }

      return c.json({ error: 'Invalid or expired token' }, 401);
    }

    // Allow anonymous if configured
    if (allowAnonymous) {
      const machineId = c.req.header('X-Machine-ID') || 'anonymous';
      c.set('auth', {
        tenant: {
          id: 'anonymous',
          name: 'Anonymous',
          apiKey: '',
          active: true,
          createdAt: new Date(),
        },
        machineId,
        authenticated: false,
      });
      return next();
    }

    // No valid auth
    return c.json({ error: 'Authentication required' }, 401);
  });
}

/**
 * Helper to get auth context from request
 */
export function getAuth(c: Context): AuthContext | undefined {
  return c.get('auth') as AuthContext | undefined;
}

/**
 * Require authentication middleware (use after createAuthMiddleware)
 */
export function requireAuth() {
  return createMiddleware(async (c, next) => {
    const auth = getAuth(c);
    if (!auth?.authenticated) {
      return c.json({ error: 'Authentication required' }, 401);
    }
    return next();
  });
}

// ─────────────────────────────────────────────────────────────
// Tenant Management Utilities
// ─────────────────────────────────────────────────────────────

/**
 * Generate a secure API key
 */
export function generateApiKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return 'reminisce_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Create a new tenant
 */
export function createTenant(name: string, options: Partial<Omit<Tenant, 'id' | 'apiKey' | 'createdAt'>> = {}): Tenant {
  return {
    id: crypto.randomUUID(),
    name,
    apiKey: generateApiKey(),
    active: true,
    createdAt: new Date(),
    ...options,
  };
}

/**
 * Create in-memory tenant store for simple deployments
 */
export function createTenantStore(): {
  apiKeys: Map<string, Tenant>;
  addTenant: (tenant: Tenant) => void;
  removeTenant: (apiKey: string) => void;
  getTenant: (apiKey: string) => Tenant | undefined;
  listTenants: () => Tenant[];
} {
  const apiKeys = new Map<string, Tenant>();

  return {
    apiKeys,
    addTenant: (tenant: Tenant) => apiKeys.set(tenant.apiKey, tenant),
    removeTenant: (apiKey: string) => apiKeys.delete(apiKey),
    getTenant: (apiKey: string) => apiKeys.get(apiKey),
    listTenants: () => Array.from(apiKeys.values()),
  };
}
