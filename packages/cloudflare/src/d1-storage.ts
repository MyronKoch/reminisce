/**
 * D1 Storage Adapters for Reminisce
 *
 * Cloudflare D1 is SQLite-compatible, so these adapters follow
 * the same schema as @reminisce/storage-sqlite but use D1's API.
 */

import type {
  EpisodicMemory,
  SemanticMemory,
  MemoryID,
  Provenance,
  Salience,
} from '@reminisce/core';

// D1 types (from @cloudflare/workers-types)
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
  error?: string;
  meta: {
    duration: number;
    changes: number;
    last_row_id: number;
    changed_db: boolean;
    size_after: number;
    rows_read: number;
    rows_written: number;
  };
}

interface D1ExecResult {
  count: number;
  duration: number;
}

// ─────────────────────────────────────────────────────────────
// Schema
// ─────────────────────────────────────────────────────────────

export const SCHEMA = `
-- Episodic memories (events/experiences)
CREATE TABLE IF NOT EXISTS episodic_memories (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  layer TEXT NOT NULL DEFAULT 'episodic',
  event TEXT NOT NULL,
  summary TEXT NOT NULL,
  entities TEXT, -- JSON array
  valence REAL DEFAULT 0,
  tags TEXT, -- JSON array
  consolidated INTEGER DEFAULT 0,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  provenance TEXT NOT NULL, -- JSON
  salience TEXT NOT NULL, -- JSON
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_episodic_tenant ON episodic_memories(tenant_id);
CREATE INDEX IF NOT EXISTS idx_episodic_session ON episodic_memories(tenant_id, session_id);
CREATE INDEX IF NOT EXISTS idx_episodic_created ON episodic_memories(tenant_id, created_at);

-- Semantic memories (facts/knowledge)
CREATE TABLE IF NOT EXISTS semantic_memories (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  machine_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  layer TEXT NOT NULL DEFAULT 'semantic',
  fact TEXT NOT NULL,
  subject TEXT,
  predicate TEXT,
  object TEXT,
  category TEXT,
  source_episode_ids TEXT, -- JSON array of MemoryIDs
  tags TEXT, -- JSON array
  provenance TEXT NOT NULL, -- JSON
  salience TEXT NOT NULL, -- JSON
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_semantic_tenant ON semantic_memories(tenant_id);
CREATE INDEX IF NOT EXISTS idx_semantic_subject ON semantic_memories(tenant_id, subject);
CREATE INDEX IF NOT EXISTS idx_semantic_category ON semantic_memories(tenant_id, category);

-- API keys / tenants
CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  api_key TEXT UNIQUE NOT NULL,
  allowed_machines TEXT, -- JSON array
  rate_limit INTEGER,
  active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tenants_api_key ON tenants(api_key);
`;

// ─────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────

function createDefaultSalience(): Salience {
  const now = new Date();
  return {
    signals: {
      reward_signal: 0,
      error_signal: 0,
      user_pinned: false,
      user_blocked: false,
      novelty_score: 0.5,
      emotional_intensity: 0,
      access_count: 0,
      last_accessed: now,
      goal_relevance: 0,
    },
    current_score: 0.5,
    instrumentation: {
      computed_at: now,
      raw_signals: {},
      weighted_contributions: {},
      final_score: 0.5,
    },
  };
}

function createDefaultProvenance(derivationType: 'direct' | 'consolidated' = 'direct'): Provenance {
  return {
    source_ids: [],
    derivation_type: derivationType,
    confidence: 1.0,
    last_validated: new Date(),
    contradiction_ids: [],
    retracted: false,
  };
}


// ─────────────────────────────────────────────────────────────
// D1 Episodic Store
// ─────────────────────────────────────────────────────────────

export interface D1EpisodicStoreConfig {
  tenantId: string;
  machineId: string;
}

export class D1EpisodicStore {
  constructor(
    private db: D1Database,
    private config: D1EpisodicStoreConfig
  ) {}

  async initialize(): Promise<void> {
    await this.db.exec(SCHEMA);
  }

  async store(episode: EpisodicMemory): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO episodic_memories
         (id, tenant_id, machine_id, session_id, layer, event, summary, entities, valence, tags, consolidated, started_at, ended_at, provenance, salience, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        episode.memory_id.id,
        this.config.tenantId,
        this.config.machineId,
        episode.session_id,
        episode.memory_id.layer,
        episode.content.event,
        episode.content.summary,
        JSON.stringify(episode.content.entities || []),
        episode.content.valence ?? 0,
        JSON.stringify(episode.tags || []),
        episode.consolidated ? 1 : 0,
        episode.started_at.toISOString(),
        episode.ended_at?.toISOString() ?? null,
        JSON.stringify(episode.provenance),
        JSON.stringify(episode.salience),
        episode.memory_id.created_at.toISOString(),
        now
      )
      .run();
  }

  async query(options: {
    sessionId?: string;
    tags?: string[];
    limit?: number;
    offset?: number;
  }): Promise<EpisodicMemory[]> {
    let sql = `SELECT * FROM episodic_memories WHERE tenant_id = ?`;
    const params: unknown[] = [this.config.tenantId];

    if (options.sessionId) {
      sql += ` AND session_id = ?`;
      params.push(options.sessionId);
    }

    sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(options.limit ?? 50, options.offset ?? 0);

    const result = await this.db.prepare(sql).bind(...params).all<D1EpisodicRow>();

    return (result.results || []).map(rowToEpisodic);
  }

  async getById(id: string): Promise<EpisodicMemory | null> {
    const row = await this.db
      .prepare(`SELECT * FROM episodic_memories WHERE id = ? AND tenant_id = ?`)
      .bind(id, this.config.tenantId)
      .first<D1EpisodicRow>();

    return row ? rowToEpisodic(row) : null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .prepare(`DELETE FROM episodic_memories WHERE id = ? AND tenant_id = ?`)
      .bind(id, this.config.tenantId)
      .run();

    return result.meta.changes > 0;
  }

  async deleteBySession(sessionId: string): Promise<number> {
    const result = await this.db
      .prepare(`DELETE FROM episodic_memories WHERE session_id = ? AND tenant_id = ?`)
      .bind(sessionId, this.config.tenantId)
      .run();

    return result.meta.changes;
  }

  async count(): Promise<number> {
    const result = await this.db
      .prepare(`SELECT COUNT(*) as count FROM episodic_memories WHERE tenant_id = ?`)
      .bind(this.config.tenantId)
      .first<{ count: number }>();

    return result?.count ?? 0;
  }
}

// ─────────────────────────────────────────────────────────────
// D1 Semantic Store
// ─────────────────────────────────────────────────────────────

export interface D1SemanticStoreConfig {
  tenantId: string;
  machineId: string;
  sessionId: string;
}

export class D1SemanticStore {
  constructor(
    private db: D1Database,
    private config: D1SemanticStoreConfig
  ) {}

  async initialize(): Promise<void> {
    await this.db.exec(SCHEMA);
  }

  async store(fact: SemanticMemory): Promise<void> {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO semantic_memories
         (id, tenant_id, machine_id, session_id, layer, fact, subject, predicate, object, category, source_episode_ids, tags, provenance, salience, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        fact.memory_id.id,
        this.config.tenantId,
        this.config.machineId,
        this.config.sessionId,
        fact.memory_id.layer,
        fact.content.fact,
        fact.content.subject ?? null,
        fact.content.predicate ?? null,
        fact.content.object ?? null,
        fact.content.category ?? null,
        JSON.stringify(fact.source_episode_ids || []),
        JSON.stringify(fact.tags || []),
        JSON.stringify(fact.provenance),
        JSON.stringify(fact.salience),
        fact.memory_id.created_at.toISOString(),
        now
      )
      .run();
  }

  async query(options: {
    subject?: string;
    category?: string;
    tags?: string[];
    limit?: number;
    offset?: number;
  }): Promise<SemanticMemory[]> {
    let sql = `SELECT * FROM semantic_memories WHERE tenant_id = ?`;
    const params: unknown[] = [this.config.tenantId];

    if (options.subject) {
      sql += ` AND subject = ?`;
      params.push(options.subject);
    }

    if (options.category) {
      sql += ` AND category = ?`;
      params.push(options.category);
    }

    sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(options.limit ?? 50, options.offset ?? 0);

    const result = await this.db.prepare(sql).bind(...params).all<D1SemanticRow>();

    return (result.results || []).map(rowToSemantic);
  }

  async getById(id: string): Promise<SemanticMemory | null> {
    const row = await this.db
      .prepare(`SELECT * FROM semantic_memories WHERE id = ? AND tenant_id = ?`)
      .bind(id, this.config.tenantId)
      .first<D1SemanticRow>();

    return row ? rowToSemantic(row) : null;
  }

  async getBySubject(subject: string): Promise<SemanticMemory[]> {
    return this.query({ subject });
  }

  async getByCategory(category: string): Promise<SemanticMemory[]> {
    return this.query({ category });
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .prepare(`DELETE FROM semantic_memories WHERE id = ? AND tenant_id = ?`)
      .bind(id, this.config.tenantId)
      .run();

    return result.meta.changes > 0;
  }

  async deleteBySession(sessionId: string): Promise<number> {
    const result = await this.db
      .prepare(`DELETE FROM semantic_memories WHERE session_id = ? AND tenant_id = ?`)
      .bind(sessionId, this.config.tenantId)
      .run();

    return result.meta.changes;
  }

  async count(): Promise<number> {
    const result = await this.db
      .prepare(`SELECT COUNT(*) as count FROM semantic_memories WHERE tenant_id = ?`)
      .bind(this.config.tenantId)
      .first<{ count: number }>();

    return result?.count ?? 0;
  }
}

// ─────────────────────────────────────────────────────────────
// Row Types and Converters
// ─────────────────────────────────────────────────────────────

interface D1EpisodicRow {
  id: string;
  tenant_id: string;
  machine_id: string;
  session_id: string;
  layer: string;
  event: string;
  summary: string;
  entities: string | null;
  valence: number | null;
  tags: string | null;
  consolidated: number;
  started_at: string;
  ended_at: string | null;
  provenance: string;
  salience: string;
  created_at: string;
  updated_at: string;
}

interface D1SemanticRow {
  id: string;
  tenant_id: string;
  machine_id: string;
  session_id: string;
  layer: string;
  fact: string;
  subject: string | null;
  predicate: string | null;
  object: string | null;
  category: string | null;
  source_episode_ids: string | null;
  tags: string | null;
  provenance: string;
  salience: string;
  created_at: string;
  updated_at: string;
}

function parseProvenance(json: string): Provenance {
  try {
    const parsed = JSON.parse(json);
    return {
      ...parsed,
      last_validated: new Date(parsed.last_validated),
      source_ids: (parsed.source_ids || []).map((s: MemoryID) => ({
        ...s,
        created_at: new Date(s.created_at),
      })),
      contradiction_ids: (parsed.contradiction_ids || []).map((s: MemoryID) => ({
        ...s,
        created_at: new Date(s.created_at),
      })),
    };
  } catch {
    return createDefaultProvenance();
  }
}

function parseSalience(json: string): Salience {
  try {
    const parsed = JSON.parse(json);
    return {
      signals: {
        ...parsed.signals,
        last_accessed: new Date(parsed.signals?.last_accessed || Date.now()),
      },
      current_score: parsed.current_score ?? 0.5,
      instrumentation: {
        ...parsed.instrumentation,
        computed_at: new Date(parsed.instrumentation?.computed_at || Date.now()),
      },
    };
  } catch {
    return createDefaultSalience();
  }
}

function rowToEpisodic(row: D1EpisodicRow): EpisodicMemory {
  const memoryId: MemoryID & { layer: 'episodic' } = {
    id: row.id,
    layer: 'episodic',
    source_machine: row.machine_id,
    source_session: row.session_id,
    created_at: new Date(row.created_at),
  };

  return {
    memory_id: memoryId,
    session_id: row.session_id,
    content: {
      event: row.event,
      summary: row.summary,
      entities: row.entities ? JSON.parse(row.entities) : [],
      valence: row.valence ?? 0,
    },
    tags: row.tags ? JSON.parse(row.tags) : [],
    provenance: parseProvenance(row.provenance),
    salience: parseSalience(row.salience),
    consolidated: row.consolidated === 1,
    started_at: new Date(row.started_at),
    ended_at: row.ended_at ? new Date(row.ended_at) : undefined,
  };
}

function rowToSemantic(row: D1SemanticRow): SemanticMemory {
  const memoryId: MemoryID & { layer: 'semantic' } = {
    id: row.id,
    layer: 'semantic',
    source_machine: row.machine_id,
    source_session: row.session_id,
    created_at: new Date(row.created_at),
  };

  const content: SemanticMemory['content'] = {
    fact: row.fact,
  };

  if (row.subject) content.subject = row.subject;
  if (row.predicate) content.predicate = row.predicate;
  if (row.object) content.object = row.object;
  if (row.category) content.category = row.category;

  let sourceEpisodeIds: MemoryID[] = [];
  if (row.source_episode_ids) {
    try {
      const parsed = JSON.parse(row.source_episode_ids);
      sourceEpisodeIds = parsed.map((s: MemoryID) => ({
        ...s,
        created_at: new Date(s.created_at),
      }));
    } catch {
      // Ignore parse errors
    }
  }

  return {
    memory_id: memoryId,
    content,
    source_episode_ids: sourceEpisodeIds,
    tags: row.tags ? JSON.parse(row.tags) : [],
    provenance: parseProvenance(row.provenance),
    salience: parseSalience(row.salience),
  };
}
