/**
 * Vector Search Integration
 *
 * Uses sqlite-vec for vector similarity search on memory embeddings.
 * Supports both episodic and semantic memory vector search.
 */

import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';

/**
 * Configuration for vector search
 */
export interface VectorConfig {
  /** Dimension of embedding vectors */
  dimensions: number;

  /** Maximum number of results for similarity search */
  defaultLimit?: number;
}

/**
 * Initialize sqlite-vec extension and create vector tables
 */
export function initializeVectorSearch(db: Database, config: VectorConfig): void {
  // Load sqlite-vec extension
  sqliteVec.load(db);

  const dims = config.dimensions;

  // Create virtual table for episodic memory embeddings
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS episodic_vec USING vec0(
      memory_id TEXT PRIMARY KEY,
      embedding float[${dims}]
    )
  `);

  // Create virtual table for semantic memory embeddings
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS semantic_vec USING vec0(
      memory_id TEXT PRIMARY KEY,
      embedding float[${dims}]
    )
  `);
}

/**
 * Store an embedding for an episodic memory
 * If embedding already exists, it will be updated.
 */
export function storeEpisodicEmbedding(
  db: Database,
  memoryId: string,
  embedding: number[]
): void {
  // vec0 doesn't support INSERT OR REPLACE, so delete first then insert
  db.prepare('DELETE FROM episodic_vec WHERE memory_id = ?').run(memoryId);
  const stmt = db.prepare(`
    INSERT INTO episodic_vec(memory_id, embedding)
    VALUES (?, vec_f32(?))
  `);
  stmt.run(memoryId, new Float32Array(embedding));
}

/**
 * Store an embedding for a semantic memory
 * If embedding already exists, it will be updated.
 */
export function storeSemanticEmbedding(
  db: Database,
  memoryId: string,
  embedding: number[]
): void {
  // vec0 doesn't support INSERT OR REPLACE, so delete first then insert
  db.prepare('DELETE FROM semantic_vec WHERE memory_id = ?').run(memoryId);
  const stmt = db.prepare(`
    INSERT INTO semantic_vec(memory_id, embedding)
    VALUES (?, vec_f32(?))
  `);
  stmt.run(memoryId, new Float32Array(embedding));
}

/**
 * Search for similar episodic memories by vector
 */
export function searchEpisodicByVector(
  db: Database,
  queryEmbedding: number[],
  limit: number = 10
): Array<{ memory_id: string; distance: number }> {
  const stmt = db.prepare<{ memory_id: string; distance: number }, [Float32Array, number]>(`
    SELECT memory_id, distance
    FROM episodic_vec
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT ?
  `);

  return stmt.all(new Float32Array(queryEmbedding), limit);
}

/**
 * Search for similar semantic memories by vector
 */
export function searchSemanticByVector(
  db: Database,
  queryEmbedding: number[],
  limit: number = 10
): Array<{ memory_id: string; distance: number }> {
  const stmt = db.prepare<{ memory_id: string; distance: number }, [Float32Array, number]>(`
    SELECT memory_id, distance
    FROM semantic_vec
    WHERE embedding MATCH ?
    ORDER BY distance
    LIMIT ?
  `);

  return stmt.all(new Float32Array(queryEmbedding), limit);
}

/**
 * Delete an episodic embedding
 */
export function deleteEpisodicEmbedding(db: Database, memoryId: string): void {
  db.prepare('DELETE FROM episodic_vec WHERE memory_id = ?').run(memoryId);
}

/**
 * Delete a semantic embedding
 */
export function deleteSemanticEmbedding(db: Database, memoryId: string): void {
  db.prepare('DELETE FROM semantic_vec WHERE memory_id = ?').run(memoryId);
}

/**
 * Batch store episodic embeddings
 */
export function batchStoreEpisodicEmbeddings(
  db: Database,
  embeddings: Array<{ memoryId: string; embedding: number[] }>
): void {
  const deleteStmt = db.prepare('DELETE FROM episodic_vec WHERE memory_id = ?');
  const insertStmt = db.prepare(`
    INSERT INTO episodic_vec(memory_id, embedding)
    VALUES (?, vec_f32(?))
  `);

  const transaction = db.transaction(() => {
    for (const { memoryId, embedding } of embeddings) {
      deleteStmt.run(memoryId);
      insertStmt.run(memoryId, new Float32Array(embedding));
    }
  });

  transaction();
}

/**
 * Batch store semantic embeddings
 */
export function batchStoreSemanticEmbeddings(
  db: Database,
  embeddings: Array<{ memoryId: string; embedding: number[] }>
): void {
  const deleteStmt = db.prepare('DELETE FROM semantic_vec WHERE memory_id = ?');
  const insertStmt = db.prepare(`
    INSERT INTO semantic_vec(memory_id, embedding)
    VALUES (?, vec_f32(?))
  `);

  const transaction = db.transaction(() => {
    for (const { memoryId, embedding } of embeddings) {
      deleteStmt.run(memoryId);
      insertStmt.run(memoryId, new Float32Array(embedding));
    }
  });

  transaction();
}

/**
 * Check if vector search is available
 */
export function isVectorSearchAvailable(db: Database): boolean {
  try {
    const result = db.prepare<{ version: string }, []>(
      'SELECT vec_version() as version'
    ).get();
    return result !== undefined;
  } catch {
    return false;
  }
}

/**
 * Get the vector search version
 */
export function getVectorVersion(db: Database): string | null {
  try {
    const result = db.prepare<{ version: string }, []>(
      'SELECT vec_version() as version'
    ).get();
    return result?.version ?? null;
  } catch {
    return null;
  }
}
