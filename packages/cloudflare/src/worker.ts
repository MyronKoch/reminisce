/**
 * Reminisce Cloudflare Worker
 *
 * Entry point for Cloudflare Workers deployment.
 * Uses D1 for storage, Vectorize for search, and Workers AI for embeddings.
 * Serves dashboard static assets at /dashboard/ with PIN auth.
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  createAuthMiddleware,
  getAuth,
  type Tenant,
  type AuthConfig,
} from '@reminisce/api/auth';
import { D1EpisodicStore, D1SemanticStore, SCHEMA } from './d1-storage.js';
import { VectorStore, WorkersAIEmbeddings, RAGHelper } from './vectorize.js';

// ─────────────────────────────────────────────────────────────
// Cloudflare Bindings
// ─────────────────────────────────────────────────────────────

export interface Env {
  // D1 database
  DB: D1Database;
  // Vectorize index (optional)
  VECTORIZE?: VectorizeIndex;
  // Workers AI
  AI?: Ai;
  // KV for rate limiting and config
  KV?: KVNamespace;
  // Static assets binding (run_worker_first mode)
  ASSETS?: { fetch: (request: Request) => Promise<Response> };
  // Environment variables
  JWT_SECRET?: string;
  CORS_ORIGINS?: string;
  ALLOW_ANONYMOUS?: string;
  AUTH_PIN?: string;
  AUTH_SALT?: string;
  // The tenant ID used for PIN dashboard auth and cron consolidation
  ADMIN_TENANT?: string;
}

// Type declarations for Cloudflare bindings
interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<D1ExecResult>;
}

interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(colName?: string): Promise<T | null>;
  run(): Promise<D1Result>;
  all<T = unknown>(): Promise<D1Result<T>>;
}

interface D1Result<T = unknown> {
  results?: T[];
  success: boolean;
  meta: { changes: number };
}

interface D1ExecResult {
  count: number;
}

interface VectorizeIndex {
  upsert(vectors: unknown[]): Promise<unknown>;
  query(vector: number[], options?: unknown): Promise<{ matches: unknown[] }>;
  deleteByIds(ids: string[]): Promise<{ count: number }>;
}

interface Ai {
  run(model: string, inputs: unknown): Promise<unknown>;
}

interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// ─────────────────────────────────────────────────────────────
// Fact Extraction (Workers AI)
// ─────────────────────────────────────────────────────────────

interface ExtractedFact {
  fact: string;
  subject: string;
  predicate: string;
  object: string;
  category: string;
  confidence: number;
}

const EXTRACTION_MODEL = '@cf/meta/llama-3.1-8b-instruct';

const EXTRACTION_SYSTEM_PROMPT = `You are a knowledge extraction engine. Given a session episode (event + summary), extract 0-5 factual statements worth remembering long-term.

Rules:
- Only extract facts that represent durable knowledge (architecture decisions, tool preferences, debugging solutions, project patterns)
- Skip operational noise (started working, ran tests, committed code)
- Each fact must be a complete, self-contained statement
- Subject should be a noun/entity, predicate a verb/relationship, object the target
- Category must be one of: architecture, preference, debugging, pattern, decision, technical
- Confidence 0.0-1.0 based on how clearly the fact is stated
- Return ONLY a JSON array, no other text

Output format (JSON array):
[{"fact":"...","subject":"...","predicate":"...","object":"...","category":"...","confidence":0.9}]

If no facts worth extracting, return: []`;

async function extractFactsFromEpisode(
  ai: Ai,
  episode: { event: string; summary: string; entities?: string[] }
): Promise<ExtractedFact[]> {
  const content = [
    episode.event ? `Event: ${episode.event}` : '',
    episode.summary ? `Summary: ${episode.summary}` : '',
    episode.entities?.length ? `Entities: ${episode.entities.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  // Skip thin episodes
  if (content.length < 80) return [];

  const result = (await ai.run(EXTRACTION_MODEL, {
    messages: [
      { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
      { role: 'user', content },
    ],
    max_tokens: 1024,
  })) as { response?: string };

  if (!result.response) return [];

  // Parse JSON - handle LLM wrapping it in markdown code blocks
  let text = result.response.trim();
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  text = jsonMatch[0];

  try {
    const facts: ExtractedFact[] = JSON.parse(text);
    // Quality gate: filter out low-confidence or incomplete facts
    return facts.filter(f =>
      f.fact && f.fact.length > 20 &&
      f.subject && f.predicate &&
      f.confidence >= 0.6
    );
  } catch {
    console.error('[FactExtraction] Failed to parse LLM response:', text.slice(0, 200));
    return [];
  }
}

// ─────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────

/** Safely parse an integer query param with default and max clamp */
function safeParseInt(value: string | undefined, defaultVal: number, max: number): number {
  const parsed = parseInt(value || String(defaultVal), 10);
  if (isNaN(parsed) || parsed < 1) return defaultVal;
  return Math.min(parsed, max);
}

interface FactRecordParams {
  factId: string;
  extracted: ExtractedFact;
  sourceEpisodeId: string;
  sessionId: string;
  machineId: string;
  tags: string[];
}

/** Build a properly typed SemanticMemory record from extracted fact data */
function buildFactRecord(params: FactRecordParams) {
  const { factId, extracted, sourceEpisodeId, sessionId, machineId, tags } = params;
  const now = new Date();
  const sourceEpisodeMemoryId = {
    id: sourceEpisodeId,
    layer: 'episodic' as const,
    source_session: sessionId,
    source_machine: machineId,
    created_at: now,
  };
  return {
    memory_id: {
      id: factId,
      layer: 'semantic' as const,
      source_session: sessionId,
      source_machine: machineId,
      created_at: now,
    },
    content: {
      fact: extracted.fact,
      subject: extracted.subject,
      predicate: extracted.predicate,
      object: extracted.object,
      category: extracted.category,
    },
    source_episode_ids: [sourceEpisodeMemoryId],
    tags,
    provenance: {
      source_ids: [sourceEpisodeMemoryId],
      derivation_type: 'inferred' as const,
      confidence: extracted.confidence,
      last_validated: now,
      contradiction_ids: [],
      retracted: false,
    },
    salience: {
      signals: {
        reward_signal: 0,
        error_signal: 0,
        user_pinned: false,
        user_blocked: false,
        novelty_score: 0.7,
        emotional_intensity: 0,
        access_count: 0,
        last_accessed: now,
        goal_relevance: 0.5,
      },
      current_score: extracted.confidence,
      instrumentation: {
        computed_at: now,
        raw_signals: {},
        weighted_contributions: {},
        final_score: extracted.confidence,
      },
    },
  };
}

// ─────────────────────────────────────────────────────────────
// PIN Auth (Dashboard)
// ─────────────────────────────────────────────────────────────

const COOKIE_NAME = 'reminisce-auth';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

/** Constant-time string comparison to prevent timing attacks (no length leak) */
function constantTimeEqual(a: string, b: string): boolean {
  const maxLen = Math.max(a.length, b.length);
  let result = a.length ^ b.length;
  for (let i = 0; i < maxLen; i++) {
    result |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return result === 0;
}

async function generateToken(pin: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(salt),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(pin));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function verifyToken(token: string, pin: string, salt: string): Promise<boolean> {
  const expected = await generateToken(pin, salt);
  return constantTimeEqual(token, expected);
}

function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(';')) {
    const [key, ...vals] = pair.trim().split('=');
    if (key) cookies[key.trim()] = vals.join('=').trim();
  }
  return cookies;
}

function renderLoginPage(error: boolean): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Reminisce — Cognition Substrate</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', system-ui, sans-serif;
      background: #000;
      color: rgba(255,255,255,0.95);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      -webkit-font-smoothing: antialiased;
    }
    .card {
      background: rgba(28,28,30,0.8);
      backdrop-filter: blur(20px) saturate(180%);
      -webkit-backdrop-filter: blur(20px) saturate(180%);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 20px;
      padding: 40px;
      width: 360px;
      text-align: center;
      position: relative;
      overflow: hidden;
    }
    .card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 1px;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.15), transparent);
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 600;
      letter-spacing: -0.02em;
      margin-bottom: 6px;
    }
    .subtitle {
      color: rgba(255,255,255,0.5);
      font-size: 0.9rem;
      margin-bottom: 28px;
    }
    .error {
      color: #FF453A;
      font-size: 0.85rem;
      margin-bottom: 16px;
      padding: 8px 12px;
      background: rgba(255,69,58,0.1);
      border: 1px solid rgba(255,69,58,0.2);
      border-radius: 8px;
    }
    input[type="password"] {
      width: 100%;
      padding: 12px 16px;
      font-size: 1rem;
      font-family: inherit;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 10px;
      color: #fff;
      outline: none;
      transition: border-color 0.2s;
      text-align: center;
      letter-spacing: 0.15em;
    }
    input[type="password"]:focus {
      border-color: #30D158;
      box-shadow: 0 0 0 3px rgba(48,209,88,0.2);
    }
    button {
      width: 100%;
      margin-top: 16px;
      padding: 12px;
      font-size: 1rem;
      font-weight: 500;
      font-family: inherit;
      background: #30D158;
      color: #fff;
      border: none;
      border-radius: 10px;
      cursor: pointer;
      transition: all 0.2s;
    }
    button:hover {
      background: #3EE066;
      box-shadow: 0 4px 12px rgba(48,209,88,0.4);
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Reminisce</h1>
    <p class="subtitle">Enter PIN to continue</p>
    ${error ? '<div class="error">Incorrect PIN</div>' : ''}
    <form method="POST" action="/__auth">
      <input type="password" name="pin" placeholder="PIN" autofocus autocomplete="current-password" />
      <button type="submit">Unlock</button>
    </form>
  </div>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────
// Store Cache
// ─────────────────────────────────────────────────────────────

interface StoreCache {
  episodic: D1EpisodicStore;
  semantic: D1SemanticStore;
}

const storeCache = new Map<string, StoreCache>();

function getOrCreateStores(
  tenantId: string,
  machineId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any
): StoreCache {
  const cacheKey = `${tenantId}:${machineId}`;

  let stores = storeCache.get(cacheKey);
  if (!stores) {
    stores = {
      episodic: new D1EpisodicStore(db, { tenantId, machineId }),
      semantic: new D1SemanticStore(db, { tenantId, machineId, sessionId: 'system' }),
    };
    storeCache.set(cacheKey, stores);
  }

  return stores;
}

// ─────────────────────────────────────────────────────────────
// Tenant Loader from D1
// ─────────────────────────────────────────────────────────────

async function loadTenantByApiKey(db: D1Database, apiKey: string): Promise<Tenant | null> {
  const row = await db
    .prepare(
      `SELECT id, name, api_key, allowed_machines, rate_limit, active, created_at
       FROM tenants WHERE api_key = ? AND active = 1`
    )
    .bind(apiKey)
    .first<{
      id: string;
      name: string;
      api_key: string;
      allowed_machines: string | null;
      rate_limit: number | null;
      active: number;
      created_at: string;
    }>();

  if (!row) return null;

  const tenant: Tenant = {
    id: row.id,
    name: row.name,
    apiKey: row.api_key,
    active: row.active === 1,
    createdAt: new Date(row.created_at),
  };

  if (row.allowed_machines) {
    tenant.allowedMachines = JSON.parse(row.allowed_machines);
  }
  if (row.rate_limit) {
    tenant.rateLimit = row.rate_limit;
  }

  return tenant;
}

// ─────────────────────────────────────────────────────────────
// Worker App
// ─────────────────────────────────────────────────────────────

export function createWorkerApp(env: Env, ctx?: ExecutionContext): Hono {
  const app = new Hono();

  // AUTH_SALT is required - no default allowed (prevents token forgery across deployments)
  const authSalt = env.AUTH_SALT;
  if (!authSalt) {
    console.warn('[Auth] AUTH_SALT is not set - PIN auth endpoints will return 500');
  }

  // Parse config from env
  const corsOrigins = env.CORS_ORIGINS?.split(',') || ['*'];
  const allowAnonymous = env.ALLOW_ANONYMOUS === 'true';

  // ─── PIN Auth for dashboard routes ───────────────────────

  // Handle PIN login POST
  app.post('/__auth', async (c) => {
    if (!authSalt) {
      return c.text('Internal server error', 500);
    }
    const formData = await c.req.formData();
    const pin = formData.get('pin') as string;

    if (pin && env.AUTH_PIN && constantTimeEqual(pin, env.AUTH_PIN)) {
      const token = await generateToken(pin, authSalt);
      return new Response(null, {
        status: 302,
        headers: {
          'Location': '/dashboard/',
          'Set-Cookie': `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`,
        },
      });
    }

    return c.html(renderLoginPage(true));
  });

  // Redirect root to dashboard
  app.get('/', (c) => c.redirect('/dashboard/'));

  // PIN auth middleware for /dashboard/* routes
  app.use('/dashboard/*', async (c, next) => {
    // If no AUTH_PIN configured, allow through (dev mode)
    if (!env.AUTH_PIN) return next();

    if (!authSalt) {
      return c.text('Internal server error', 500);
    }

    const cookies = parseCookies(c.req.header('Cookie') || '');
    const authToken = cookies[COOKIE_NAME];

    if (authToken && await verifyToken(authToken, env.AUTH_PIN, authSalt)) {
      return next();
    }

    return c.html(renderLoginPage(false));
  });

  // Serve dashboard static assets (after PIN auth passes)
  app.get('/dashboard/*', async (c) => {
    if (!env.ASSETS) return c.text('Assets not configured', 500);
    // Try to serve the exact file first
    const assetResponse = await env.ASSETS.fetch(c.req.raw);
    // If the asset exists, return it; otherwise serve index.html for SPA routing
    if (assetResponse.status === 200) return assetResponse;
    // SPA fallback: serve /dashboard/index.html for client-side routes
    const url = new URL(c.req.url);
    url.pathname = '/dashboard/index.html';
    return env.ASSETS.fetch(new Request(url.toString(), c.req.raw));
  });

  // ─── CORS for API routes ─────────────────────────────────

  app.use(
    '/api/*',
    cors({
      origin: corsOrigins,
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'X-API-Key', 'Authorization', 'X-Machine-ID'],
    })
  );

  // Auth middleware for /api/* routes
  // Accepts: valid PIN cookie (dashboard), API key header, or JWT
  app.use('/api/*', async (c, next) => {
    const path = c.req.path;

    // Public API paths skip auth (init requires auth — DDL must not be public)
    const publicPaths = ['/health'];
    if (publicPaths.some((p) => path.startsWith(p))) {
      return next();
    }

    // Check PIN cookie first (dashboard browser requests)
    const cookies = parseCookies(c.req.header('Cookie') || '');
    const token = cookies[COOKIE_NAME];
    if (token && env.AUTH_PIN && authSalt && await verifyToken(token, env.AUTH_PIN, authSalt)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (c as any).set('auth', {
        tenant: { id: env.ADMIN_TENANT || 'admin', name: 'Dashboard', apiKey: '', active: true, createdAt: new Date() },
        machineId: 'dashboard',
        authenticated: true,
      });
      return next();
    }

    // Fall through to API key / JWT auth
    const authConfig: AuthConfig = {
      allowAnonymous,
      publicPaths,
      validateApiKey: async (key) => loadTenantByApiKey(env.DB, key),
    };
    if (env.JWT_SECRET) {
      authConfig.jwtSecret = env.JWT_SECRET;
    }
    const authMiddleware = createAuthMiddleware(authConfig);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return authMiddleware(c as any, next);
  });

  // Health check
  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      features: {
        d1: true,
        vectorize: !!env.VECTORIZE,
        workersAi: !!env.AI,
      },
    })
  );

  // Initialize schema (call once on first deploy)
  app.post('/api/init', async (c) => {
    try {
      await env.DB.exec(SCHEMA);
      return c.json({ success: true, message: 'Schema initialized' });
    } catch (error) {
      return c.json(
        { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
        500
      );
    }
  });

  // Helper to get stores for current tenant
  const getTenantStores = (c: { get: (key: string) => unknown }): StoreCache => {
    const auth = c.get('auth') as { tenant: { id: string }; machineId: string } | undefined;
    const tenantId = auth?.tenant.id || 'anonymous';
    const machineId = auth?.machineId || 'default';
    return getOrCreateStores(tenantId, machineId, env.DB);
  };

  // ─────────────────────────────────────────────────────────────
  // Memory Endpoints
  // ─────────────────────────────────────────────────────────────

  app.get('/api/memory/episodic', async (c) => {
    const stores = getTenantStores(c);
    const limit = safeParseInt(c.req.query('limit'), 50, 500);
    const sessionId = c.req.query('sessionId');

    const queryOpts: { limit: number; sessionId?: string } = { limit };
    if (sessionId) {
      queryOpts.sessionId = sessionId;
    }

    const items = await stores.episodic.query(queryOpts);
    return c.json({ items });
  });

  app.get('/api/memory/semantic', async (c) => {
    const stores = getTenantStores(c);
    const limit = safeParseInt(c.req.query('limit'), 50, 500);
    const subject = c.req.query('subject');
    const category = c.req.query('category');

    const queryOpts: { limit: number; subject?: string; category?: string } = { limit };
    if (subject) {
      queryOpts.subject = subject;
    }
    if (category) {
      queryOpts.category = category;
    }

    const items = await stores.semantic.query(queryOpts);
    return c.json({ items });
  });

  app.get('/api/stats', async (c) => {
    const stores = getTenantStores(c);
    const auth = getAuth(c);
    const tenantId = auth?.tenant.id || 'anonymous';
    const [episodicCount, semanticCount, sessionResult, consolidatedResult] = await Promise.all([
      stores.episodic.count(),
      stores.semantic.count(),
      env.DB.prepare('SELECT COUNT(DISTINCT session_id) as sessions FROM episodic_memories WHERE tenant_id = ?').bind(tenantId).first<{ sessions: number }>(),
      env.DB.prepare('SELECT COUNT(*) as count FROM episodic_memories WHERE tenant_id = ? AND consolidated = 1').bind(tenantId).first<{ count: number }>(),
    ]);
    const sessions = sessionResult?.sessions ?? 0;
    const consolidatedCount = consolidatedResult?.count ?? 0;

    // Return both flat fields (dashboard expects these) and nested (for API consumers)
    return c.json({
      // Flat fields for dashboard compatibility
      workingMemorySize: 0,
      workingMemoryCapacity: 7,
      pendingEpisodes: episodicCount,
      consolidatedEpisodes: consolidatedCount,
      totalFacts: semanticCount,
      sessions,
      // Nested fields for API consumers
      episodic: { count: episodicCount },
      semantic: { count: semanticCount },
    });
  });

  // Write operations
  app.post('/api/memory/episode', async (c) => {
    const stores = getTenantStores(c);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const event = body.event || body.content?.event;
    if (!event && !body.summary && !body.content?.summary) {
      return c.json({ error: 'At least one of "event" or "summary" is required' }, 400);
    }
    const now = new Date();
    // Generate ID once — reused for both D1 and Vectorize
    const memoryId = body.memory_id?.id || body.id || crypto.randomUUID();
    // Reshape flat API body into EpisodicMemory structure expected by D1 store
    const episode = {
      memory_id: {
        id: memoryId,
        layer: 'episodic' as const,
        source_session: body.memory_id?.session || body.memory_id?.source_session || body.session_id || 'unknown',
        source_machine: body.memory_id?.machine || body.memory_id?.source_machine || 'unknown',
        created_at: new Date(body.memory_id?.created_at || now),
      },
      content: {
        event: body.event || body.content?.event || '',
        summary: body.summary || body.content?.summary || '',
        entities: body.entities || body.content?.entities || [],
        valence: body.valence ?? body.content?.valence ?? 0,
      },
      session_id: body.session_id || body.memory_id?.session || 'unknown',
      started_at: new Date(body.started_at || now),
      ended_at: body.ended_at ? new Date(body.ended_at) : undefined,
      tags: body.tags || [],
      consolidated: body.consolidated ?? false,
      provenance: {
        source_ids: body.provenance?.source_ids || [],
        derivation_type: body.provenance?.derivation_type || 'direct',
        confidence: body.provenance?.confidence ?? 1.0,
        last_validated: new Date(body.provenance?.last_validated || now),
        contradiction_ids: body.provenance?.contradiction_ids || [],
        retracted: body.provenance?.retracted ?? false,
      },
      salience: {
        signals: {
          reward_signal: body.salience?.signals?.reward_signal ?? 0,
          error_signal: body.salience?.signals?.error_signal ?? 0,
          user_pinned: body.salience?.signals?.user_pinned ?? false,
          user_blocked: body.salience?.signals?.user_blocked ?? false,
          novelty_score: body.salience?.signals?.novelty ?? body.salience?.signals?.novelty_score ?? 0.5,
          emotional_intensity: body.salience?.signals?.emotional_intensity ?? 0,
          access_count: body.salience?.signals?.access_count ?? 0,
          last_accessed: new Date(body.salience?.signals?.last_accessed || now),
          goal_relevance: body.salience?.signals?.goal ?? body.salience?.signals?.goal_relevance ?? 0,
        },
        current_score: body.salience?.current_score ?? 0.5,
        instrumentation: {
          computed_at: new Date(body.salience?.instrumentation?.computed_at || now),
          raw_signals: body.salience?.instrumentation?.raw_signals || {},
          weighted_contributions: body.salience?.instrumentation?.weighted_contributions || {},
          final_score: body.salience?.instrumentation?.final_score ?? body.salience?.current_score ?? 0.5,
        },
      },
    };
    await stores.episodic.store(episode as any);

    // Auto-index into Vectorize (non-blocking, but track status)
    let vectorIndexed: 'pending' | 'skipped' = 'skipped';
    if (env.VECTORIZE && env.AI) {
      const auth = getAuth(c);
      const tenantId = auth?.tenant.id || 'anonymous';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const embeddings = new WorkersAIEmbeddings(env.AI as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vectorStore = new VectorStore(env.VECTORIZE as any, { tenantId, embeddingProvider: embeddings });
      const text = `${body.event || ''}: ${body.summary || ''}`;
      vectorIndexed = 'pending';
      ctx?.waitUntil(
        vectorStore.indexEpisodic(memoryId, text, {
          event: body.event || '',
          session_id: body.session_id || '',
        }).catch((e: unknown) => console.error('[Vectorize] Episode index failed:', e))
      );
    }

    // Auto-extract facts from episode using Workers AI (non-blocking)
    let factsQueued = false;
    if (env.AI) {
      factsQueued = true;
      ctx?.waitUntil(
        (async () => {
          try {
            const facts = await extractFactsFromEpisode(env.AI!, {
              event: body.event || body.content?.event || '',
              summary: body.summary || body.content?.summary || '',
              entities: body.entities || body.content?.entities || [],
            });

            const auth = getAuth(c);
            const tenantId = auth?.tenant.id || 'anonymous';

            // Mark as consolidated even if no facts extracted (thin episode - don't retry)
            if (facts.length === 0) {
              await env.DB.prepare(
                'UPDATE episodic_memories SET consolidated = 1 WHERE id = ? AND tenant_id = ?'
              ).bind(memoryId, tenantId).run();
              return;
            }

            // Hoist Vectorize client outside loop
            const vecEmbed = env.VECTORIZE ? new WorkersAIEmbeddings(env.AI as any) : null;
            const vecStore = env.VECTORIZE && vecEmbed ? new VectorStore(env.VECTORIZE as any, { tenantId, embeddingProvider: vecEmbed }) : null;

            for (const extracted of facts) {
              const factId = crypto.randomUUID();
              const factRecord = buildFactRecord({
                factId,
                extracted,
                sourceEpisodeId: memoryId,
                sessionId: body.session_id || 'auto-extract',
                machineId: body.memory_id?.machine || body.memory_id?.source_machine || 'workers-ai',
                tags: ['auto-extracted', 'workers-ai'],
              });
              await stores.semantic.store(factRecord);

              if (vecStore) {
                const text = `${extracted.subject} ${extracted.predicate} ${extracted.object}: ${extracted.fact}`;
                await vecStore.indexSemantic(factId, text, {
                  subject: extracted.subject,
                  category: extracted.category,
                }).catch((e: unknown) => console.error('[Vectorize] Auto-extracted fact index failed:', e));
              }
            }

            // Mark episode as consolidated
            await env.DB.prepare(
              'UPDATE episodic_memories SET consolidated = 1 WHERE id = ? AND tenant_id = ?'
            ).bind(memoryId, tenantId).run();

            console.log(`[FactExtraction] Extracted ${facts.length} facts from episode ${memoryId}`);
          } catch (e) {
            console.error('[FactExtraction] Auto-extraction failed:', e);
          }
        })()
      );
    }

    return c.json({ success: true, vectorIndex: vectorIndexed, factsQueued });
  });

  app.post('/api/memory/fact', async (c) => {
    const stores = getTenantStores(c);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    if (!body.fact && !body.content?.fact) {
      return c.json({ error: '"fact" field is required' }, 400);
    }
    const now = new Date();
    // Generate ID once — reused for both D1 and Vectorize
    const factId = body.memory_id?.id || body.id || crypto.randomUUID();
    // Reshape flat API body into SemanticMemory structure expected by D1 store
    const fact = {
      memory_id: {
        id: factId,
        layer: 'semantic' as const,
        source_session: body.memory_id?.session || body.memory_id?.source_session || 'migration',
        source_machine: body.memory_id?.machine || body.memory_id?.source_machine || 'unknown',
        created_at: new Date(body.memory_id?.created_at || now),
      },
      content: {
        fact: body.fact || body.content?.fact || '',
        subject: body.subject ?? body.content?.subject ?? null,
        predicate: body.predicate ?? body.content?.predicate ?? null,
        object: body.object ?? body.content?.object ?? null,
        category: body.category ?? body.content?.category ?? null,
      },
      source_episode_ids: body.source_episode_ids || [],
      tags: body.tags || [],
      provenance: {
        source_ids: body.provenance?.source_ids || [],
        derivation_type: body.provenance?.derivation_type || 'direct',
        confidence: body.provenance?.confidence ?? 1.0,
        last_validated: new Date(body.provenance?.last_validated || now),
        contradiction_ids: body.provenance?.contradiction_ids || [],
        retracted: body.provenance?.retracted ?? false,
      },
      salience: {
        signals: {
          reward_signal: body.salience?.signals?.reward_signal ?? 0,
          error_signal: body.salience?.signals?.error_signal ?? 0,
          user_pinned: body.salience?.signals?.user_pinned ?? false,
          user_blocked: body.salience?.signals?.user_blocked ?? false,
          novelty_score: body.salience?.signals?.novelty ?? body.salience?.signals?.novelty_score ?? 0.5,
          emotional_intensity: body.salience?.signals?.emotional_intensity ?? 0,
          access_count: body.salience?.signals?.access_count ?? 0,
          last_accessed: new Date(body.salience?.signals?.last_accessed || now),
          goal_relevance: body.salience?.signals?.goal ?? body.salience?.signals?.goal_relevance ?? 0,
        },
        current_score: body.salience?.current_score ?? 0.5,
        instrumentation: {
          computed_at: new Date(body.salience?.instrumentation?.computed_at || now),
          raw_signals: body.salience?.instrumentation?.raw_signals || {},
          weighted_contributions: body.salience?.instrumentation?.weighted_contributions || {},
          final_score: body.salience?.instrumentation?.final_score ?? body.salience?.current_score ?? 0.5,
        },
      },
    };
    await stores.semantic.store(fact as any);

    // Auto-index into Vectorize (non-blocking, but track status)
    let vectorIndexed: 'pending' | 'skipped' = 'skipped';
    if (env.VECTORIZE && env.AI) {
      const auth = getAuth(c);
      const tenantId = auth?.tenant.id || 'anonymous';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const embeddings = new WorkersAIEmbeddings(env.AI as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vectorStore = new VectorStore(env.VECTORIZE as any, { tenantId, embeddingProvider: embeddings });
      const text = `${body.subject || ''} ${body.predicate || ''} ${body.object || ''}: ${body.fact || ''}`;
      vectorIndexed = 'pending';
      ctx?.waitUntil(
        vectorStore.indexSemantic(factId, text, {
          subject: body.subject || '',
          category: body.category || '',
        }).catch((e: unknown) => console.error('[Vectorize] Fact index failed:', e))
      );
    }

    return c.json({ success: true, vectorIndex: vectorIndexed });
  });

  app.delete('/api/memory/episodic/:id', async (c) => {
    const stores = getTenantStores(c);
    const { id } = c.req.param();
    const deleted = await stores.episodic.delete(id);
    return c.json({ success: deleted });
  });

  app.delete('/api/memory/semantic/:id', async (c) => {
    const stores = getTenantStores(c);
    const { id } = c.req.param();
    const deleted = await stores.semantic.delete(id);
    return c.json({ success: deleted });
  });

  // GDPR: Forget session
  app.delete('/api/session/:sessionId', async (c) => {
    const stores = getTenantStores(c);
    const { sessionId } = c.req.param();

    const reservedIds = ['default', 'system', 'unknown', 'auto-extract', 'migration', 'consolidation', 'cron'];
    if (reservedIds.includes(sessionId)) {
      return c.json({ error: `Cannot delete reserved session ID: ${sessionId}` }, 400);
    }

    const [episodicDeleted, semanticDeleted] = await Promise.all([
      stores.episodic.deleteBySession(sessionId),
      stores.semantic.deleteBySession(sessionId),
    ]);

    // Clean up Vectorize vectors if available
    if (env.VECTORIZE && (episodicDeleted > 0 || semanticDeleted > 0)) {
      try {
        const auth = getAuth(c);
        const tenantId = auth?.tenant.id || 'anonymous';
        const epResults = await env.DB.prepare(
          'SELECT id FROM episodic_memories WHERE tenant_id = ? AND session_id = ?'
        ).bind(tenantId, sessionId).all<{ id: string }>();
        const smResults = await env.DB.prepare(
          'SELECT id FROM semantic_memories WHERE tenant_id = ? AND json_extract(provenance_json, \'$.source_session\') = ?'
        ).bind(tenantId, sessionId).all<{ id: string }>();
        const vectorIds = [
          ...(epResults.results ?? []).map(r => r.id),
          ...(smResults.results ?? []).map(r => r.id),
        ];
        if (vectorIds.length > 0) {
          await (env.VECTORIZE as any).deleteByIds(vectorIds);
        }
      } catch {
        // Vectorize cleanup is best-effort
      }
    }

    return c.json({
      success: true,
      deleted: {
        episodic: episodicDeleted,
        semantic: semanticDeleted,
      },
    });
  });

  // Reindex all D1 records into Vectorize (admin operation)
  app.post('/api/reindex', async (c) => {
    const auth = getAuth(c);
    const adminTenant = env.ADMIN_TENANT || 'admin';
    if (auth?.tenant.id !== adminTenant) {
      return c.json({ error: 'Admin access required' }, 403);
    }
    if (!env.VECTORIZE || !env.AI) {
      return c.json({ error: 'Vectorize not configured' }, 501);
    }

    const tenantId = auth?.tenant.id || 'anonymous';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const embeddings = new WorkersAIEmbeddings(env.AI as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vectorStore = new VectorStore(env.VECTORIZE as any, { tenantId, embeddingProvider: embeddings });

    const batchSize = safeParseInt(c.req.query('batch'), 20, 100);
    const stores = getTenantStores(c);
    let indexed = 0;
    let failed = 0;

    // Index episodic memories
    const episodes = await stores.episodic.query({ limit: 1000 });
    for (let i = 0; i < episodes.length; i += batchSize) {
      const batch = episodes.slice(i, i + batchSize);
      try {
        await vectorStore.indexBatch(
          batch.map(ep => ({
            id: ep.memory_id.id,
            text: `${ep.content.event}: ${ep.content.summary}`,
            memoryType: 'episodic' as const,
            metadata: {
              event: ep.content.event.slice(0, 100),
              session_id: ep.session_id,
            },
          }))
        );
        indexed += batch.length;
      } catch (e) {
        console.error(`[Reindex] Episode batch failed:`, e);
        failed += batch.length;
      }
    }

    // Index semantic memories
    const facts = await stores.semantic.query({ limit: 5000 });
    for (let i = 0; i < facts.length; i += batchSize) {
      const batch = facts.slice(i, i + batchSize);
      try {
        await vectorStore.indexBatch(
          batch.map(f => ({
            id: f.memory_id.id,
            text: `${f.content.subject || ''} ${f.content.predicate || ''} ${f.content.object || ''}: ${f.content.fact}`,
            memoryType: 'semantic' as const,
            metadata: {
              subject: (f.content.subject || '').slice(0, 100),
              category: (f.content.category || '').slice(0, 100),
            },
          }))
        );
        indexed += batch.length;
      } catch (e) {
        console.error(`[Reindex] Fact batch failed:`, e);
        failed += batch.length;
      }
    }

    return c.json({
      success: true,
      indexed,
      failed,
      total: { episodes: episodes.length, facts: facts.length },
    });
  });

  // Consolidate: batch-extract facts from unconsolidated episodes using Workers AI
  // Called by cron trigger or manually via API. Only processes consolidated=0 episodes.
  app.post('/api/consolidate', async (c) => {
    const auth = getAuth(c);
    const adminTenant = env.ADMIN_TENANT || 'admin';
    if (auth?.tenant.id !== adminTenant) {
      return c.json({ error: 'Admin access required' }, 403);
    }
    if (!env.AI) {
      return c.json({ error: 'Workers AI not configured' }, 501);
    }
    const tenantId = auth?.tenant.id || 'anonymous';
    const limit = safeParseInt(c.req.query('limit'), 50, 200);

    // Query only unconsolidated episodes directly via D1
    const result = await env.DB.prepare(
      `SELECT * FROM episodic_memories WHERE tenant_id = ? AND consolidated = 0
       ORDER BY created_at DESC LIMIT ?`
    ).bind(tenantId, limit).all<Record<string, unknown>>();
    const rows = result.results || [];

    if (rows.length === 0) {
      return c.json({ success: true, processed: 0, extracted: 0, skipped: 0, message: 'No unconsolidated episodes' });
    }

    const stores = getTenantStores(c);
    const conEmbed = env.VECTORIZE ? new WorkersAIEmbeddings(env.AI as any) : null;
    const conVecStore = env.VECTORIZE && conEmbed ? new VectorStore(env.VECTORIZE as any, { tenantId, embeddingProvider: conEmbed }) : null;
    let extracted = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const row of rows) {
      const epId = row.id as string;
      try {
        const facts = await extractFactsFromEpisode(env.AI!, {
          event: (row.event as string) || '',
          summary: (row.summary as string) || '',
          entities: row.entities ? JSON.parse(row.entities as string) : [],
        });

        // Mark as consolidated regardless of whether facts were found
        await env.DB.prepare(
          'UPDATE episodic_memories SET consolidated = 1 WHERE id = ? AND tenant_id = ?'
        ).bind(epId, tenantId).run();

        if (facts.length === 0) {
          skipped++;
          continue;
        }

        for (const f of facts) {
          const factId = crypto.randomUUID();
          await stores.semantic.store(buildFactRecord({
            factId,
            extracted: f,
            sourceEpisodeId: epId,
            sessionId: (row.session_id as string) || 'consolidation',
            machineId: (row.machine_id as string) || 'workers-ai',
            tags: ['auto-extracted', 'workers-ai', 'consolidation'],
          }));

          if (conVecStore) {
            await conVecStore.indexSemantic(factId, `${f.subject} ${f.predicate} ${f.object}: ${f.fact}`, {
              subject: f.subject, category: f.category,
            }).catch(() => {});
          }

          extracted++;
        }
      } catch (e) {
        errors.push(`Episode ${epId}: ${e instanceof Error ? e.message : 'unknown'}`);
      }
    }

    return c.json({
      success: true,
      processed: rows.length,
      extracted,
      skipped,
      errors: errors.length > 0 ? errors.slice(0, 10) : undefined,
    });
  });

  // Tenant info
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

  // ─────────────────────────────────────────────────────────────
  // Working Memory (volatile/session-scoped — always empty in cloud)
  // ─────────────────────────────────────────────────────────────

  app.get('/api/memory/working', (c) => {
    // Working memory is volatile and lives in the MCP server's in-memory buffer.
    // The cloud Worker has no persistent working memory to query.
    return c.json({ items: [], note: 'Working memory is session-local and not persisted to the cloud.' });
  });

  // ─────────────────────────────────────────────────────────────
  // Knowledge Graph (derived from semantic SPO triples)
  // ─────────────────────────────────────────────────────────────

  app.get('/api/graph', async (c) => {
    const stores = getTenantStores(c);
    const facts = await stores.semantic.query({ limit: 500 });

    const nodeMap = new Map<string, { id: string; label: string; type: string }>();
    const edges: Array<{ from: string; to: string; label: string; type: string }> = [];

    for (const fact of facts) {
      const subject = fact.content.subject;
      const predicate = fact.content.predicate;
      const object = fact.content.object;

      if (!subject) continue;

      // Add subject node
      const subjectId = `s:${subject}`;
      if (!nodeMap.has(subjectId)) {
        nodeMap.set(subjectId, { id: subjectId, label: subject, type: 'subject' });
      }

      if (object) {
        // Add object node
        const objectId = `o:${object}`;
        if (!nodeMap.has(objectId)) {
          nodeMap.set(objectId, { id: objectId, label: object, type: 'object' });
        }

        // Add edge: subject → object via predicate
        edges.push({
          from: subjectId,
          to: objectId,
          label: predicate || 'relates to',
          type: predicate || 'relation',
        });
      } else if (predicate) {
        // Fact without explicit object — create a fact node from the fact text
        const factId = `f:${fact.memory_id.id}`;
        const factLabel = fact.content.fact.length > 60
          ? fact.content.fact.slice(0, 57) + '...'
          : fact.content.fact;
        nodeMap.set(factId, { id: factId, label: factLabel, type: 'fact' });

        edges.push({
          from: subjectId,
          to: factId,
          label: predicate,
          type: predicate,
        });
      }
    }

    return c.json({
      nodes: Array.from(nodeMap.values()),
      edges,
    });
  });

  // ─────────────────────────────────────────────────────────────
  // Vector Search (if Vectorize is configured)
  // ─────────────────────────────────────────────────────────────

  app.get('/api/vector/search', async (c) => {
    if (!env.VECTORIZE || !env.AI) {
      return c.json({ error: 'Vector search not configured' }, 501);
    }

    const auth = getAuth(c);
    const tenantId = auth?.tenant.id || 'anonymous';

    const q = c.req.query('q');
    if (!q) {
      return c.json({ error: 'Query parameter "q" required' }, 400);
    }

    const topK = safeParseInt(c.req.query('topK'), 10, 100);
    const rawType = c.req.query('type');
    if (rawType && rawType !== 'episodic' && rawType !== 'semantic') {
      return c.json({ error: 'Invalid type parameter. Must be "episodic" or "semantic"' }, 400);
    }
    const memoryType = rawType as 'episodic' | 'semantic' | undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const embeddings = new WorkersAIEmbeddings(env.AI as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const vectorStore = new VectorStore(env.VECTORIZE as any, {
      tenantId,
      embeddingProvider: embeddings,
    });

    const searchOpts: { topK: number; memoryType?: 'episodic' | 'semantic' } = { topK };
    if (memoryType) {
      searchOpts.memoryType = memoryType;
    }

    const results = await vectorStore.search(q, searchOpts);
    return c.json({ results });
  });

  // ─────────────────────────────────────────────────────────────
  // RAG Chat (if Workers AI is configured)
  // ─────────────────────────────────────────────────────────────

  app.post('/api/chat', async (c) => {
    if (!env.AI) {
      return c.json({ error: 'Workers AI not configured' }, 501);
    }

    const auth = getAuth(c);
    const tenantId = auth?.tenant.id || 'anonymous';

    let body: { question: string };
    try {
      body = await c.req.json<{ question: string }>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    if (!body.question) {
      return c.json({ error: 'Question required' }, 400);
    }

    const INTERNAL_SYSTEM_PROMPT = 'You are a memory assistant for the Reminisce cognitive memory system. Answer questions based on the provided memory context. Be concise and accurate.';

    // If Vectorize is available, use RAG
    if (env.VECTORIZE) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const embeddings = new WorkersAIEmbeddings(env.AI as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vectorStore = new VectorStore(env.VECTORIZE as any, {
        tenantId,
        embeddingProvider: embeddings,
      });

      const rag = new RAGHelper({
        vectorStore,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ai: env.AI as any,
      });

      const result = await rag.answer(body.question, { systemPrompt: INTERNAL_SYSTEM_PROMPT });
      return c.json(result);
    }

    // Without Vectorize, just use the LLM directly
    const result = (await env.AI.run('@cf/meta/llama-2-7b-chat-int8', {
      messages: [
        { role: 'system', content: INTERNAL_SYSTEM_PROMPT },
        { role: 'user', content: body.question },
      ],
      max_tokens: 512,
    })) as { response: string };

    return c.json({ answer: result.response, sources: [] });
  });

  // ─────────────────────────────────────────────────────────────
  // Embedding Endpoint (fallback for hooks when LM Studio is down)
  // ─────────────────────────────────────────────────────────────

  app.post('/api/embed', async (c) => {
    if (!env.AI) {
      return c.json({ error: 'Workers AI not configured' }, 501);
    }
    let body: { text: string | string[] };
    try {
      body = await c.req.json<{ text: string | string[] }>();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    if (!body.text) {
      return c.json({ error: 'Text required' }, 400);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const embeddings = new WorkersAIEmbeddings(env.AI as any);
    if (Array.isArray(body.text)) {
      if (body.text.length > 100) {
        return c.json({ error: 'Batch size exceeds maximum of 100 items' }, 400);
      }
      body.text = body.text.map((t: string) => typeof t === 'string' ? t.slice(0, 8000) : '');
      const vectors = await embeddings.embedBatch(body.text);
      return c.json({ embeddings: vectors, dimensions: embeddings.dimensions, model: '@cf/google/embeddinggemma-300m' });
    }
    const text = typeof body.text === 'string' ? body.text.slice(0, 8000) : '';
    const embedding = await embeddings.embed(text);
    return c.json({ embedding, dimensions: embeddings.dimensions, model: '@cf/google/embeddinggemma-300m' });
  });

  // ─────────────────────────────────────────────────────────────
  // Unified Search (vector search → D1 hydration)
  // ─────────────────────────────────────────────────────────────

  app.get('/api/search', async (c) => {
    const auth = getAuth(c);
    const tenantId = auth?.tenant.id || 'anonymous';
    const q = c.req.query('q');
    if (!q) return c.json({ error: 'Query parameter "q" required' }, 400);

    const limit = safeParseInt(c.req.query('limit'), 10, 100);
    const rawType = c.req.query('type');
    if (rawType && rawType !== 'episodic' && rawType !== 'semantic') {
      return c.json({ error: 'Invalid type parameter. Must be "episodic" or "semantic"' }, 400);
    }
    const memoryType = rawType as 'episodic' | 'semantic' | undefined;

    // Vector search path (preferred)
    if (env.VECTORIZE && env.AI) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const embeddings = new WorkersAIEmbeddings(env.AI as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const vectorStore = new VectorStore(env.VECTORIZE as any, { tenantId, embeddingProvider: embeddings });
      const vectorResults = await vectorStore.search(q, { topK: limit, memoryType });

      // Hydrate with full records from D1
      const stores = getTenantStores(c);
      const hydrated = await Promise.all(vectorResults.map(async (vr) => {
        const record = vr.memoryType === 'episodic'
          ? await stores.episodic.getById(vr.id)
          : await stores.semantic.getById(vr.id);
        return {
          id: vr.id,
          score: vr.score,
          memoryType: vr.memoryType,
          record: record || null,
        };
      }));

      return c.json({ results: hydrated.filter(r => r.record), method: 'vector' });
    }

    // Fallback: return recent records from D1 (no FTS5 available)
    const stores = getTenantStores(c);
    const results: Array<{ id: string; memoryType: string; record: unknown }> = [];

    if (!memoryType || memoryType === 'episodic') {
      const episodes = await stores.episodic.query({ limit });
      for (const ep of episodes) {
        results.push({ id: ep.memory_id.id, memoryType: 'episodic', record: ep });
      }
    }
    if (!memoryType || memoryType === 'semantic') {
      const facts = await stores.semantic.query({ limit });
      for (const f of facts) {
        results.push({ id: f.memory_id.id, memoryType: 'semantic', record: f });
      }
    }

    return c.json({ results, method: 'fallback' });
  });

  return app;
}

// ─────────────────────────────────────────────────────────────
// Worker Export
// ─────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const app = createWorkerApp(env, ctx);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return app.fetch(request, env, ctx as any);
  },

  // Cron trigger: auto-consolidate unconsolidated episodes
  async scheduled(event: { cron: string; scheduledTime: number }, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        if (!env.AI) {
          console.log('[Cron] Workers AI not configured, skipping consolidation');
          return;
        }

        // Get the admin tenant for cron runs (configured via ADMIN_TENANT env var)
        const tenantId = env.ADMIN_TENANT || 'admin';
        const limit = 50;

        const result = await env.DB.prepare(
          `SELECT * FROM episodic_memories WHERE tenant_id = ? AND consolidated = 0
           ORDER BY created_at ASC LIMIT ?`
        ).bind(tenantId, limit).all<Record<string, unknown>>();
        const rows = result.results || [];

        if (rows.length === 0) {
          console.log('[Cron] No unconsolidated episodes');
          return;
        }

        console.log(`[Cron] Processing ${rows.length} unconsolidated episodes`);

        const stores = getOrCreateStores(tenantId, 'cron', env.DB);
        const cronEmbed = env.VECTORIZE ? new WorkersAIEmbeddings(env.AI as any) : null;
        const cronVecStore = env.VECTORIZE && cronEmbed ? new VectorStore(env.VECTORIZE as any, { tenantId, embeddingProvider: cronEmbed }) : null;
        let extracted = 0;

        for (const row of rows) {
          const epId = row.id as string;
          try {
            const facts = await extractFactsFromEpisode(env.AI!, {
              event: (row.event as string) || '',
              summary: (row.summary as string) || '',
              entities: row.entities ? JSON.parse(row.entities as string) : [],
            });

            // Mark consolidated
            await env.DB.prepare(
              'UPDATE episodic_memories SET consolidated = 1 WHERE id = ? AND tenant_id = ?'
            ).bind(epId, tenantId).run();

            for (const f of facts) {
              const factId = crypto.randomUUID();
              await stores.semantic.store(buildFactRecord({
                factId,
                extracted: f,
                sourceEpisodeId: epId,
                sessionId: (row.session_id as string) || 'cron',
                machineId: (row.machine_id as string) || 'cron',
                tags: ['auto-extracted', 'workers-ai', 'cron'],
              }));

              if (cronVecStore) {
                await cronVecStore.indexSemantic(factId, `${f.subject} ${f.predicate} ${f.object}: ${f.fact}`, {
                  subject: f.subject, category: f.category,
                }).catch(() => {});
              }
              extracted++;
            }
          } catch (e) {
            console.error(`[Cron] Failed on episode ${epId}:`, e);
          }
        }

        console.log(`[Cron] Done: processed ${rows.length} episodes, extracted ${extracted} facts`);
      })()
    );
  },
};
