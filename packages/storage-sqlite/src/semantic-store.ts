/**
 * SQLite Semantic Store
 *
 * Persistent storage backend for semantic memories (facts, knowledge) using Bun's built-in SQLite.
 */

import { Database } from 'bun:sqlite';
import type {
  SemanticMemory,
  MemoryID,
  SalienceSignals,
  Salience,
  Provenance,
} from '@reminisce/core';
import {
  createMemoryID,
  createProvenance,
  createSalience,
  createSalienceSignals,
  reinforceOnRetrieval,
  applyProvenanceAction,
  calculateDecay,
} from '@reminisce/core';
import type {
  SemanticStore,
  SemanticStoreConfig,
  FactInput,
  SemanticQuery,
  ContradictionResult,
} from '@reminisce/semantic';
import { initializeSchema, type SemanticRow } from './schema.js';

/**
 * SQLite implementation of SemanticStore
 */
export class SqliteSemanticStore implements SemanticStore {
  private db: Database;
  private config: SemanticStoreConfig & { decayHalfLifeDays: number };

  constructor(dbPath: string, config: SemanticStoreConfig) {
    this.db = new Database(dbPath);
    this.config = {
      decayHalfLifeDays: 30,
      ...config,
    };
    initializeSchema(this.db);
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }

  async store(input: FactInput): Promise<SemanticMemory> {
    const memoryId = createMemoryID('semantic', this.config.sessionId, this.config.machineId);

    const signals: SalienceSignals = {
      ...createSalienceSignals(),
      ...input.signals,
      last_accessed: new Date(),
    };

    const content: SemanticMemory['content'] = {
      fact: input.fact,
    };

    if (input.subject !== undefined) content.subject = input.subject;
    if (input.predicate !== undefined) content.predicate = input.predicate;
    if (input.object !== undefined) content.object = input.object;
    if (input.category !== undefined) content.category = input.category;

    const fact: SemanticMemory = {
      memory_id: memoryId as MemoryID & { layer: 'semantic' },
      content,
      provenance: createProvenance(
        input.sourceEpisodeIds,
        input.derivationType ?? 'consolidated',
        input.confidence ?? 1.0
      ),
      salience: createSalience(signals),
      source_episode_ids: input.sourceEpisodeIds,
    };

    if (input.tags !== undefined) {
      fact.tags = input.tags;
    }

    const stmt = this.db.prepare(`
      INSERT INTO semantic_memories (
        id, memory_id_json, fact, subject, predicate, object, category,
        provenance_json, salience_json, source_episode_ids_json, tags_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      memoryId.id,
      JSON.stringify(memoryId),
      input.fact,
      input.subject ?? null,
      input.predicate ?? null,
      input.object ?? null,
      input.category ?? null,
      JSON.stringify(fact.provenance),
      JSON.stringify(fact.salience),
      JSON.stringify(input.sourceEpisodeIds),
      input.tags ? JSON.stringify(input.tags) : null
    );

    return fact;
  }

  async storeBatch(inputs: FactInput[]): Promise<SemanticMemory[]> {
    const results: SemanticMemory[] = [];

    const transaction = this.db.transaction(() => {
      for (const input of inputs) {
        const memoryId = createMemoryID('semantic', this.config.sessionId, this.config.machineId);

        const signals: SalienceSignals = {
          ...createSalienceSignals(),
          ...input.signals,
          last_accessed: new Date(),
        };

        const content: SemanticMemory['content'] = {
          fact: input.fact,
        };

        if (input.subject !== undefined) content.subject = input.subject;
        if (input.predicate !== undefined) content.predicate = input.predicate;
        if (input.object !== undefined) content.object = input.object;
        if (input.category !== undefined) content.category = input.category;

        const fact: SemanticMemory = {
          memory_id: memoryId as MemoryID & { layer: 'semantic' },
          content,
          provenance: createProvenance(
            input.sourceEpisodeIds,
            input.derivationType ?? 'consolidated',
            input.confidence ?? 1.0
          ),
          salience: createSalience(signals),
          source_episode_ids: input.sourceEpisodeIds,
        };

        if (input.tags !== undefined) {
          fact.tags = input.tags;
        }

        const stmt = this.db.prepare(`
          INSERT INTO semantic_memories (
            id, memory_id_json, fact, subject, predicate, object, category,
            provenance_json, salience_json, source_episode_ids_json, tags_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run(
          memoryId.id,
          JSON.stringify(memoryId),
          input.fact,
          input.subject ?? null,
          input.predicate ?? null,
          input.object ?? null,
          input.category ?? null,
          JSON.stringify(fact.provenance),
          JSON.stringify(fact.salience),
          JSON.stringify(input.sourceEpisodeIds),
          input.tags ? JSON.stringify(input.tags) : null
        );

        results.push(fact);
      }
    });

    transaction();
    return results;
  }

  async get(id: string): Promise<SemanticMemory | undefined> {
    const row = this.db.prepare<SemanticRow, [string]>(
      'SELECT * FROM semantic_memories WHERE id = ?'
    ).get(id);

    if (!row) return undefined;

    const fact = this.rowToFact(row);

    // Reinforce on retrieval
    const reinforced: SemanticMemory = {
      ...fact,
      salience: reinforceOnRetrieval(fact.salience),
      provenance: applyProvenanceAction(fact.provenance, { type: 'validate' }),
    };

    // Update in database
    this.db.prepare(`
      UPDATE semantic_memories
      SET salience_json = ?, provenance_json = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(
      JSON.stringify(reinforced.salience),
      JSON.stringify(reinforced.provenance),
      id
    );

    return reinforced;
  }

  async query(query: SemanticQuery): Promise<SemanticMemory[]> {
    let sql = 'SELECT * FROM semantic_memories WHERE 1=1';
    const params: (string | number | null)[] = [];

    if (query.text) {
      sql += ' AND fact LIKE ?';
      params.push(`%${query.text}%`);
    }

    if (query.subject) {
      sql += ' AND subject = ?';
      params.push(query.subject);
    }

    if (query.predicate) {
      sql += ' AND predicate = ?';
      params.push(query.predicate);
    }

    if (query.object) {
      sql += ' AND object = ?';
      params.push(query.object);
    }

    if (query.category) {
      sql += ' AND category = ?';
      params.push(query.category);
    }

    sql += ' ORDER BY id DESC';

    if (query.limit) {
      sql += ' LIMIT ?';
      params.push(query.limit);
    }

    if (query.offset && query.limit) {
      sql += ' OFFSET ?';
      params.push(query.offset);
    }

    const rows = this.db.query<SemanticRow, (string | number | null)[]>(sql).all(...params);

    let results = rows.map(row => this.rowToFact(row));

    // Filter retracted unless explicitly included (check in JS due to JSON field)
    if (!query.includeRetracted) {
      results = results.filter(f => !f.provenance.retracted);
    }

    // Apply tag filter in JS (JSON field)
    if (query.tags && query.tags.length > 0) {
      results = results.filter(f =>
        f.tags && query.tags!.some(tag => f.tags!.includes(tag))
      );
    }

    // Apply confidence filter in JS (JSON field)
    if (query.minConfidence !== undefined) {
      results = results.filter(f => f.provenance.confidence >= query.minConfidence!);
    }

    // Sort by salience score (highest first), then confidence as tiebreaker
    results.sort((a, b) =>
      b.salience.current_score - a.salience.current_score ||
      b.provenance.confidence - a.provenance.confidence
    );

    return results;
  }

  async checkContradiction(input: FactInput): Promise<ContradictionResult> {
    // Simple contradiction detection: same subject+predicate with different object
    if (!input.subject || !input.predicate) {
      return { hasContradiction: false, conflicts: [] };
    }

    const existing = await this.query({
      subject: input.subject,
      predicate: input.predicate,
      includeRetracted: false,
    });

    const conflicts = existing.filter(f =>
      f.content.object !== input.object
    );

    if (conflicts.length === 0) {
      return { hasContradiction: false, conflicts: [] };
    }

    // Suggest resolution based on confidence
    const maxExistingConfidence = Math.max(...conflicts.map(f => f.provenance.confidence));
    const newConfidence = input.confidence ?? 1.0;

    let suggestion: ContradictionResult['suggestion'];
    if (newConfidence > maxExistingConfidence + 0.2) {
      suggestion = 'replace';
    } else if (maxExistingConfidence > newConfidence + 0.2) {
      suggestion = 'keep_existing';
    } else {
      suggestion = 'manual_review';
    }

    return {
      hasContradiction: true,
      conflicts,
      suggestion,
    };
  }

  async retract(id: string, reason: string): Promise<SemanticMemory | undefined> {
    const row = this.db.prepare<SemanticRow, [string]>(
      'SELECT * FROM semantic_memories WHERE id = ?'
    ).get(id);

    if (!row) return undefined;

    const fact = this.rowToFact(row);
    const retracted: SemanticMemory = {
      ...fact,
      provenance: applyProvenanceAction(fact.provenance, { type: 'retract', reason }),
    };

    this.db.prepare(`
      UPDATE semantic_memories
      SET provenance_json = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(JSON.stringify(retracted.provenance), id);

    return retracted;
  }

  async supersede(oldId: string, newInput: FactInput): Promise<{
    old: SemanticMemory;
    new: SemanticMemory;
  } | undefined> {
    const oldRow = this.db.prepare<SemanticRow, [string]>(
      'SELECT * FROM semantic_memories WHERE id = ?'
    ).get(oldId);

    if (!oldRow) return undefined;

    const oldFact = this.rowToFact(oldRow);

    // Store new fact
    const newFact = await this.store(newInput);

    // Mark old as superseded
    const superseded: SemanticMemory = {
      ...oldFact,
      provenance: applyProvenanceAction(oldFact.provenance, {
        type: 'supersede',
        new_memory: newFact.memory_id,
      }),
    };

    this.db.prepare(`
      UPDATE semantic_memories
      SET provenance_json = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(JSON.stringify(superseded.provenance), oldId);

    return { old: superseded, new: newFact };
  }

  async reinstate(id: string): Promise<SemanticMemory | undefined> {
    const row = this.db.prepare<SemanticRow, [string]>(
      'SELECT * FROM semantic_memories WHERE id = ?'
    ).get(id);

    if (!row) return undefined;

    const fact = this.rowToFact(row);
    if (!fact.provenance.retracted) return undefined;

    const reinstated: SemanticMemory = {
      ...fact,
      provenance: applyProvenanceAction(fact.provenance, { type: 'reinstate' }),
    };

    this.db.prepare(`
      UPDATE semantic_memories
      SET provenance_json = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(JSON.stringify(reinstated.provenance), id);

    return reinstated;
  }

  async updateSignals(
    id: string,
    signals: Partial<SalienceSignals>
  ): Promise<SemanticMemory | undefined> {
    const row = this.db.prepare<SemanticRow, [string]>(
      'SELECT * FROM semantic_memories WHERE id = ?'
    ).get(id);

    if (!row) return undefined;

    const fact = this.rowToFact(row);
    const updatedSignals: SalienceSignals = {
      ...fact.salience.signals,
      ...signals,
    };

    const updated: SemanticMemory = {
      ...fact,
      salience: createSalience(updatedSignals),
    };

    this.db.prepare(`
      UPDATE semantic_memories
      SET salience_json = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(JSON.stringify(updated.salience), id);

    return updated;
  }

  async applyDecay(halfLifeDays: number): Promise<number> {
    // Fetch all non-retracted facts
    const rows = this.db.prepare<SemanticRow, []>(
      'SELECT * FROM semantic_memories'
    ).all();

    let decayedCount = 0;

    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        const fact = this.rowToFact(row);
        if (fact.provenance.retracted) continue;

        const decayedConfidence = calculateDecay(fact.provenance, halfLifeDays);

        if (decayedConfidence < fact.provenance.confidence) {
          const updated: Provenance = {
            ...fact.provenance,
            confidence: decayedConfidence,
          };

          this.db.prepare(`
            UPDATE semantic_memories
            SET provenance_json = ?, updated_at = datetime('now')
            WHERE id = ?
          `).run(JSON.stringify(updated), row.id);

          decayedCount++;
        }
      }
    });

    transaction();
    return decayedCount;
  }

  async getValidationCandidates(
    maxConfidence: number,
    limit: number
  ): Promise<SemanticMemory[]> {
    // Fetch all and filter in JS (confidence is in JSON)
    const rows = this.db.prepare<SemanticRow, []>(
      'SELECT * FROM semantic_memories'
    ).all();

    return rows
      .map(row => this.rowToFact(row))
      .filter(f => !f.provenance.retracted && f.provenance.confidence <= maxConfidence)
      .sort((a, b) => a.provenance.confidence - b.provenance.confidence)
      .slice(0, limit);
  }

  async validate(id: string, boost: number = 0.1): Promise<SemanticMemory | undefined> {
    const row = this.db.prepare<SemanticRow, [string]>(
      'SELECT * FROM semantic_memories WHERE id = ?'
    ).get(id);

    if (!row) return undefined;

    const fact = this.rowToFact(row);
    const validated: SemanticMemory = {
      ...fact,
      provenance: applyProvenanceAction(fact.provenance, {
        type: 'validate',
        confidence_boost: boost,
      }),
    };

    this.db.prepare(`
      UPDATE semantic_memories
      SET provenance_json = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(JSON.stringify(validated.provenance), id);

    return validated;
  }

  async delete(id: string): Promise<boolean> {
    // Also clean up relations
    this.db.prepare('DELETE FROM fact_relations WHERE fact_id_1 = ? OR fact_id_2 = ?').run(id, id);
    const result = this.db.prepare('DELETE FROM semantic_memories WHERE id = ?').run(id);
    return result.changes > 0;
  }

  async deleteBySourceEpisode(episodeId: string): Promise<number> {
    // This requires checking JSON field, so fetch and filter in JS
    const rows = this.db.prepare<SemanticRow, []>(
      'SELECT * FROM semantic_memories'
    ).all();

    let count = 0;
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        const sourceIds = JSON.parse(row.source_episode_ids_json) as MemoryID[];
        if (sourceIds.some(eid => eid.id === episodeId)) {
          this.db.prepare('DELETE FROM fact_relations WHERE fact_id_1 = ? OR fact_id_2 = ?').run(row.id, row.id);
          this.db.prepare('DELETE FROM semantic_memories WHERE id = ?').run(row.id);
          count++;
        }
      }
    });

    transaction();
    return count;
  }

  async count(query?: SemanticQuery): Promise<number> {
    if (!query) {
      // Count non-retracted facts using SQL instead of deserializing all rows
      // provenance_json contains "retracted":true when retracted
      const row = this.db.prepare<{ count: number }, []>(
        `SELECT COUNT(*) as count FROM semantic_memories
         WHERE provenance_json NOT LIKE '%"retracted":true%'`
      ).get();
      return row?.count ?? 0;
    }
    return (await this.query(query)).length;
  }

  async linkFacts(id1: string, id2: string): Promise<void> {
    // Insert both directions for symmetric relationship
    this.db.prepare(`
      INSERT OR IGNORE INTO fact_relations (fact_id_1, fact_id_2)
      VALUES (?, ?)
    `).run(id1, id2);

    this.db.prepare(`
      INSERT OR IGNORE INTO fact_relations (fact_id_1, fact_id_2)
      VALUES (?, ?)
    `).run(id2, id1);
  }

  async getRelated(id: string): Promise<SemanticMemory[]> {
    const rows = this.db.prepare<{ fact_id_2: string }, [string]>(`
      SELECT fact_id_2 FROM fact_relations WHERE fact_id_1 = ?
    `).all(id);

    const related: SemanticMemory[] = [];
    for (const row of rows) {
      const factRow = this.db.prepare<SemanticRow, [string]>(
        'SELECT * FROM semantic_memories WHERE id = ?'
      ).get(row.fact_id_2);

      if (factRow) {
        const fact = this.rowToFact(factRow);
        if (!fact.provenance.retracted) {
          related.push(fact);
        }
      }
    }

    return related;
  }

  /**
   * Convert database row to SemanticMemory object
   */
  private rowToFact(row: SemanticRow): SemanticMemory {
    const memoryId = JSON.parse(row.memory_id_json) as MemoryID & { layer: 'semantic' };
    const provenance = JSON.parse(row.provenance_json) as Provenance;
    const salience = JSON.parse(row.salience_json) as Salience;
    const sourceEpisodeIds = JSON.parse(row.source_episode_ids_json) as MemoryID[];

    // Reconstruct dates in salience signals
    if (salience.signals.last_accessed) {
      salience.signals.last_accessed = new Date(salience.signals.last_accessed as unknown as string);
    }

    // Reconstruct dates in provenance
    if (provenance.last_validated) {
      provenance.last_validated = new Date(provenance.last_validated as unknown as string);
    }

    const content: SemanticMemory['content'] = {
      fact: row.fact,
    };

    if (row.subject) content.subject = row.subject;
    if (row.predicate) content.predicate = row.predicate;
    if (row.object) content.object = row.object;
    if (row.category) content.category = row.category;

    const fact: SemanticMemory = {
      memory_id: memoryId,
      content,
      provenance,
      salience,
      source_episode_ids: sourceEpisodeIds,
    };

    if (row.related_fact_ids_json) {
      fact.related_fact_ids = JSON.parse(row.related_fact_ids_json);
    }
    if (row.tags_json) {
      fact.tags = JSON.parse(row.tags_json);
    }
    if (row.embedding_json) {
      fact.embedding = JSON.parse(row.embedding_json);
    }
    if (row.metadata_json) {
      fact.metadata = JSON.parse(row.metadata_json);
    }

    return fact;
  }
}
