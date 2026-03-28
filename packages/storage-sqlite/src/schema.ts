/**
 * SQLite Schema for Reminisce Storage
 *
 * Tables for episodic and semantic memory with JSON columns for complex types.
 * Uses INTEGER PRIMARY KEY for auto-increment and TEXT for timestamps (ISO 8601).
 */

import { Database } from 'bun:sqlite';

/**
 * Initialize the database schema
 */
export function initializeSchema(db: Database): void {
  // Enable WAL mode for better concurrent performance
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  // Episodic memory table
  db.exec(`
    CREATE TABLE IF NOT EXISTS episodic_memories (
      id TEXT PRIMARY KEY,
      memory_id_json TEXT NOT NULL,
      event TEXT NOT NULL,
      event_data_json TEXT,
      summary TEXT NOT NULL,
      entities_json TEXT NOT NULL DEFAULT '[]',
      valence REAL,
      provenance_json TEXT NOT NULL,
      salience_json TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      session_id TEXT NOT NULL,
      consolidated INTEGER NOT NULL DEFAULT 0,
      extracted_fact_ids_json TEXT,
      tags_json TEXT,
      embedding_json TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Indexes for episodic queries
  db.exec(`CREATE INDEX IF NOT EXISTS idx_episodic_session ON episodic_memories(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_episodic_started_at ON episodic_memories(started_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_episodic_consolidated ON episodic_memories(consolidated)`);

  // Semantic memory table
  db.exec(`
    CREATE TABLE IF NOT EXISTS semantic_memories (
      id TEXT PRIMARY KEY,
      memory_id_json TEXT NOT NULL,
      fact TEXT NOT NULL,
      subject TEXT,
      predicate TEXT,
      object TEXT,
      category TEXT,
      provenance_json TEXT NOT NULL,
      salience_json TEXT NOT NULL,
      source_episode_ids_json TEXT NOT NULL DEFAULT '[]',
      related_fact_ids_json TEXT,
      tags_json TEXT,
      embedding_json TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Indexes for semantic queries
  db.exec(`CREATE INDEX IF NOT EXISTS idx_semantic_subject ON semantic_memories(subject)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_semantic_predicate ON semantic_memories(predicate)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_semantic_object ON semantic_memories(object)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_semantic_category ON semantic_memories(category)`);

  // Fact relations table (for linkFacts/getRelated)
  db.exec(`
    CREATE TABLE IF NOT EXISTS fact_relations (
      fact_id_1 TEXT NOT NULL,
      fact_id_2 TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (fact_id_1, fact_id_2),
      FOREIGN KEY (fact_id_1) REFERENCES semantic_memories(id) ON DELETE CASCADE,
      FOREIGN KEY (fact_id_2) REFERENCES semantic_memories(id) ON DELETE CASCADE
    )
  `);
}

/**
 * Database row types for SQLite
 */
export interface EpisodicRow {
  id: string;
  memory_id_json: string;
  event: string;
  event_data_json: string | null;
  summary: string;
  entities_json: string;
  valence: number | null;
  provenance_json: string;
  salience_json: string;
  started_at: string;
  ended_at: string | null;
  session_id: string;
  consolidated: number;
  extracted_fact_ids_json: string | null;
  tags_json: string | null;
  embedding_json: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface SemanticRow {
  id: string;
  memory_id_json: string;
  fact: string;
  subject: string | null;
  predicate: string | null;
  object: string | null;
  category: string | null;
  provenance_json: string;
  salience_json: string;
  source_episode_ids_json: string;
  related_fact_ids_json: string | null;
  tags_json: string | null;
  embedding_json: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}
