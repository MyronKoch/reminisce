/**
 * SQLite Episodic Store
 *
 * Persistent storage backend for episodic memories using Bun's built-in SQLite.
 */

import { Database } from 'bun:sqlite';
import type {
  EpisodicMemory,
  MemoryID,
  WorkingMemoryItem,
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
} from '@reminisce/core';
import type {
  EpisodicStore,
  EpisodicStoreConfig,
  EpisodeInput,
  EpisodicQuery,
} from '@reminisce/episodic';
import { initializeSchema, type EpisodicRow } from './schema.js';

/**
 * SQLite implementation of EpisodicStore
 */
export class SqliteEpisodicStore implements EpisodicStore {
  private db: Database;
  private config: EpisodicStoreConfig;

  constructor(dbPath: string, config: EpisodicStoreConfig) {
    this.db = new Database(dbPath);
    this.config = config;
    initializeSchema(this.db);
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }

  async store(input: EpisodeInput): Promise<EpisodicMemory> {
    const memoryId = createMemoryID('episodic', input.sessionId, this.config.machineId);

    const signals: SalienceSignals = {
      ...createSalienceSignals(),
      ...input.signals,
      last_accessed: new Date(),
    };

    const content: EpisodicMemory['content'] = {
      event: input.event,
      summary: input.summary,
      entities: input.entities ?? [],
    };

    if (input.eventData !== undefined) {
      content.event_data = input.eventData;
    }
    if (input.valence !== undefined) {
      content.valence = input.valence;
    }

    const episode: EpisodicMemory = {
      memory_id: memoryId as MemoryID & { layer: 'episodic' },
      content,
      provenance: createProvenance(input.sourceIds ?? [], 'direct'),
      salience: createSalience(signals),
      started_at: new Date(),
      session_id: input.sessionId,
      consolidated: false,
    };

    if (input.tags !== undefined) {
      episode.tags = input.tags;
    }

    const stmt = this.db.prepare(`
      INSERT INTO episodic_memories (
        id, memory_id_json, event, event_data_json, summary, entities_json,
        valence, provenance_json, salience_json, started_at, session_id,
        consolidated, tags_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      memoryId.id,
      JSON.stringify(memoryId),
      input.event,
      input.eventData ? JSON.stringify(input.eventData) : null,
      input.summary,
      JSON.stringify(content.entities),
      input.valence ?? null,
      JSON.stringify(episode.provenance),
      JSON.stringify(episode.salience),
      episode.started_at.toISOString(),
      input.sessionId,
      0,
      input.tags ? JSON.stringify(input.tags) : null
    );

    return episode;
  }

  async storeBatch(inputs: EpisodeInput[]): Promise<EpisodicMemory[]> {
    const results: EpisodicMemory[] = [];
    const transaction = this.db.transaction(() => {
      for (const input of inputs) {
        // We can't await inside transaction, so inline the logic
        const memoryId = createMemoryID('episodic', input.sessionId, this.config.machineId);

        const signals: SalienceSignals = {
          ...createSalienceSignals(),
          ...input.signals,
          last_accessed: new Date(),
        };

        const content: EpisodicMemory['content'] = {
          event: input.event,
          summary: input.summary,
          entities: input.entities ?? [],
        };

        if (input.eventData !== undefined) {
          content.event_data = input.eventData;
        }
        if (input.valence !== undefined) {
          content.valence = input.valence;
        }

        const episode: EpisodicMemory = {
          memory_id: memoryId as MemoryID & { layer: 'episodic' },
          content,
          provenance: createProvenance(input.sourceIds ?? [], 'direct'),
          salience: createSalience(signals),
          started_at: new Date(),
          session_id: input.sessionId,
          consolidated: false,
        };

        if (input.tags !== undefined) {
          episode.tags = input.tags;
        }

        const stmt = this.db.prepare(`
          INSERT INTO episodic_memories (
            id, memory_id_json, event, event_data_json, summary, entities_json,
            valence, provenance_json, salience_json, started_at, session_id,
            consolidated, tags_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        stmt.run(
          memoryId.id,
          JSON.stringify(memoryId),
          input.event,
          input.eventData ? JSON.stringify(input.eventData) : null,
          input.summary,
          JSON.stringify(content.entities),
          input.valence ?? null,
          JSON.stringify(episode.provenance),
          JSON.stringify(episode.salience),
          episode.started_at.toISOString(),
          input.sessionId,
          0,
          input.tags ? JSON.stringify(input.tags) : null
        );

        results.push(episode);
      }
    });

    transaction();
    return results;
  }

  async receiveOverflow(items: WorkingMemoryItem[]): Promise<EpisodicMemory[]> {
    const episodes: EpisodicMemory[] = [];

    for (const item of items) {
      const input: EpisodeInput = {
        event: `working_memory_overflow:${item.content.type}`,
        eventData: { original_data: item.content.data },
        summary: item.content.summary ?? `Overflowed ${item.content.type} from working memory`,
        entities: [],
        sessionId: item.memory_id.source_session,
        signals: item.salience.signals,
        sourceIds: [item.memory_id],
      };

      if (item.tags !== undefined) {
        input.tags = item.tags;
      }

      const episode = await this.store(input);
      episodes.push(episode);
    }

    return episodes;
  }

  async get(id: string): Promise<EpisodicMemory | undefined> {
    const row = this.db.prepare<EpisodicRow, [string]>(
      'SELECT * FROM episodic_memories WHERE id = ?'
    ).get(id);

    if (!row) return undefined;

    const episode = this.rowToEpisode(row);

    // Reinforce on retrieval
    const reinforced: EpisodicMemory = {
      ...episode,
      salience: reinforceOnRetrieval(episode.salience),
    };

    // Update in database
    this.db.prepare(`
      UPDATE episodic_memories
      SET salience_json = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(JSON.stringify(reinforced.salience), id);

    return reinforced;
  }

  async query(query: EpisodicQuery): Promise<EpisodicMemory[]> {
    let sql = 'SELECT * FROM episodic_memories WHERE 1=1';
    const params: (string | number | null)[] = [];

    if (query.text) {
      sql += ' AND (event LIKE ? OR summary LIKE ?)';
      const pattern = `%${query.text}%`;
      params.push(pattern, pattern);
    }

    if (query.sessionId) {
      sql += ' AND session_id = ?';
      params.push(query.sessionId);
    }

    if (query.startTime) {
      sql += ' AND started_at >= ?';
      params.push(query.startTime.toISOString());
    }

    if (query.endTime) {
      sql += ' AND started_at <= ?';
      params.push(query.endTime.toISOString());
    }

    if (query.unconsolidatedOnly) {
      sql += ' AND consolidated = 0';
    }

    sql += ' ORDER BY started_at DESC';

    if (query.limit) {
      sql += ' LIMIT ?';
      params.push(query.limit);
    }

    if (query.offset && query.limit) {
      sql += ' OFFSET ?';
      params.push(query.offset);
    }

    const rows = this.db.query<EpisodicRow, (string | number | null)[]>(sql).all(...params);

    let results = rows.map(row => this.rowToEpisode(row));

    // Apply entity and tag filters in JS (JSON fields)
    if (query.entities && query.entities.length > 0) {
      results = results.filter(e =>
        query.entities!.some(entity => e.content.entities.includes(entity))
      );
    }

    if (query.tags && query.tags.length > 0) {
      results = results.filter(e =>
        e.tags && query.tags!.some(tag => e.tags!.includes(tag))
      );
    }

    // Re-sort by salience score (highest first), then recency as tiebreaker
    results.sort((a, b) =>
      b.salience.current_score - a.salience.current_score ||
      b.started_at.getTime() - a.started_at.getTime()
    );

    return results;
  }

  async markConsolidated(ids: string[], extractedFactIds: MemoryID[]): Promise<void> {
    const stmt = this.db.prepare(`
      UPDATE episodic_memories
      SET consolidated = 1, extracted_fact_ids_json = ?, updated_at = datetime('now')
      WHERE id = ?
    `);

    const factIdsJson = JSON.stringify(extractedFactIds);

    const transaction = this.db.transaction(() => {
      for (const id of ids) {
        stmt.run(factIdsJson, id);
      }
    });

    transaction();
  }

  async getConsolidationCandidates(
    minAgeHours: number,
    minSalience: number,
    limit: number
  ): Promise<EpisodicMemory[]> {
    const cutoff = new Date(Date.now() - minAgeHours * 60 * 60 * 1000);

    const rows = this.db.prepare<EpisodicRow, [string]>(`
      SELECT * FROM episodic_memories
      WHERE consolidated = 0 AND started_at <= ?
      ORDER BY started_at ASC
    `).all(cutoff.toISOString());

    // Filter by salience in JS (JSON field)
    return rows
      .map(row => this.rowToEpisode(row))
      .filter(e => e.salience.current_score >= minSalience)
      .sort((a, b) => b.salience.current_score - a.salience.current_score)
      .slice(0, limit);
  }

  async updateSignals(
    id: string,
    signals: Partial<SalienceSignals>
  ): Promise<EpisodicMemory | undefined> {
    const episode = await this.get(id);
    if (!episode) return undefined;

    const updatedSignals: SalienceSignals = {
      ...episode.salience.signals,
      ...signals,
    };

    const updated: EpisodicMemory = {
      ...episode,
      salience: createSalience(updatedSignals),
    };

    this.db.prepare(`
      UPDATE episodic_memories
      SET salience_json = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(JSON.stringify(updated.salience), id);

    return updated;
  }

  async delete(id: string): Promise<boolean> {
    const result = this.db.prepare('DELETE FROM episodic_memories WHERE id = ?').run(id);
    return result.changes > 0;
  }

  async deleteBySession(sessionId: string): Promise<number> {
    const result = this.db.prepare('DELETE FROM episodic_memories WHERE session_id = ?').run(sessionId);
    return result.changes;
  }

  async count(query?: EpisodicQuery): Promise<number> {
    if (!query) {
      const row = this.db.prepare<{ count: number }, []>(
        'SELECT COUNT(*) as count FROM episodic_memories'
      ).get();
      return row?.count ?? 0;
    }
    return (await this.query(query)).length;
  }

  /**
   * Convert database row to EpisodicMemory object
   */
  private rowToEpisode(row: EpisodicRow): EpisodicMemory {
    const memoryId = JSON.parse(row.memory_id_json) as MemoryID & { layer: 'episodic' };
    const provenance = JSON.parse(row.provenance_json) as Provenance;
    const salience = JSON.parse(row.salience_json) as Salience;
    const entities = JSON.parse(row.entities_json) as string[];

    // Reconstruct dates in salience signals
    if (salience.signals.last_accessed) {
      salience.signals.last_accessed = new Date(salience.signals.last_accessed as unknown as string);
    }

    // Reconstruct dates in provenance
    if (provenance.last_validated) {
      provenance.last_validated = new Date(provenance.last_validated as unknown as string);
    }

    const content: EpisodicMemory['content'] = {
      event: row.event,
      summary: row.summary,
      entities,
    };

    if (row.event_data_json) {
      content.event_data = JSON.parse(row.event_data_json);
    }
    if (row.valence !== null) {
      content.valence = row.valence;
    }

    const episode: EpisodicMemory = {
      memory_id: memoryId,
      content,
      provenance,
      salience,
      started_at: new Date(row.started_at),
      session_id: row.session_id,
      consolidated: row.consolidated === 1,
    };

    if (row.ended_at) {
      episode.ended_at = new Date(row.ended_at);
    }
    if (row.extracted_fact_ids_json) {
      episode.extracted_fact_ids = JSON.parse(row.extracted_fact_ids_json);
    }
    if (row.tags_json) {
      episode.tags = JSON.parse(row.tags_json);
    }
    if (row.embedding_json) {
      episode.embedding = JSON.parse(row.embedding_json);
    }
    if (row.metadata_json) {
      episode.metadata = JSON.parse(row.metadata_json);
    }

    return episode;
  }
}
