/**
 * Episodic Store Interface
 *
 * Pluggable storage backend for episodic memories.
 * Default implementation is in-memory; can be swapped for SQLite, D1, PostgreSQL, etc.
 */

import type {
  EpisodicMemory,
  MemoryID,
  WorkingMemoryItem,
  SalienceSignals,
} from '@reminisce/core';
import {
  createMemoryID,
  createProvenance,
  createSalience,
  createSalienceSignals,
  reinforceOnRetrieval,
} from '@reminisce/core';

/**
 * Query options for episodic retrieval
 */
export interface EpisodicQuery {
  /** Full-text search on event and summary fields */
  text?: string;

  /** Filter by session */
  sessionId?: string;

  /** Filter by time range */
  startTime?: Date;
  endTime?: Date;

  /** Filter by entities mentioned */
  entities?: string[];

  /** Filter by tags */
  tags?: string[];

  /** Only unconsolidated episodes */
  unconsolidatedOnly?: boolean;

  /** Maximum results */
  limit?: number;

  /** Offset for pagination */
  offset?: number;
}

/**
 * Input for creating an episode
 */
export interface EpisodeInput {
  /** What happened */
  event: string;

  /** Structured event data */
  eventData?: Record<string, unknown>;

  /** Summary of the episode */
  summary: string;

  /** Key entities involved */
  entities?: string[];

  /** Emotional valence (-1 to 1) */
  valence?: number;

  /** Session this episode belongs to */
  sessionId: string;

  /** Tags for filtering */
  tags?: string[];

  /** Initial salience signals */
  signals?: Partial<SalienceSignals>;

  /** Source memory IDs (for provenance) */
  sourceIds?: MemoryID[];
}

/**
 * Abstract interface for episodic storage backends
 */
export interface EpisodicStore {
  /** Store a new episode */
  store(input: EpisodeInput): Promise<EpisodicMemory>;

  /** Store multiple episodes (batch) */
  storeBatch(inputs: EpisodeInput[]): Promise<EpisodicMemory[]>;

  /** Receive overflow from working memory */
  receiveOverflow(items: WorkingMemoryItem[]): Promise<EpisodicMemory[]>;

  /** Get episode by ID */
  get(id: string): Promise<EpisodicMemory | undefined>;

  /** Query episodes */
  query(query: EpisodicQuery): Promise<EpisodicMemory[]>;

  /** Mark episodes as consolidated */
  markConsolidated(ids: string[], extractedFactIds: MemoryID[]): Promise<void>;

  /** Get episodes ready for consolidation (by salience and age) */
  getConsolidationCandidates(
    minAgeHours: number,
    minSalience: number,
    limit: number
  ): Promise<EpisodicMemory[]>;

  /** Update salience signals */
  updateSignals(id: string, signals: Partial<SalienceSignals>): Promise<EpisodicMemory | undefined>;

  /** Delete an episode */
  delete(id: string): Promise<boolean>;

  /** Delete episodes by session (for GDPR compliance) */
  deleteBySession(sessionId: string): Promise<number>;

  /** Count episodes */
  count(query?: EpisodicQuery): Promise<number>;
}

/**
 * Configuration for the store
 */
export interface EpisodicStoreConfig {
  /** Machine identifier for memory IDs */
  machineId: string;
}

/**
 * In-memory implementation of EpisodicStore
 * Useful for testing and single-session use cases
 */
export class InMemoryEpisodicStore implements EpisodicStore {
  private episodes: Map<string, EpisodicMemory> = new Map();
  private config: EpisodicStoreConfig;

  constructor(config: EpisodicStoreConfig) {
    this.config = config;
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

    this.episodes.set(memoryId.id, episode);
    return episode;
  }

  async storeBatch(inputs: EpisodeInput[]): Promise<EpisodicMemory[]> {
    const results: EpisodicMemory[] = [];
    for (const input of inputs) {
      results.push(await this.store(input));
    }
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
    const episode = this.episodes.get(id);
    if (episode) {
      // Reinforce on retrieval
      const reinforced: EpisodicMemory = {
        ...episode,
        salience: reinforceOnRetrieval(episode.salience),
      };
      this.episodes.set(id, reinforced);
      return reinforced;
    }
    return undefined;
  }

  async query(query: EpisodicQuery): Promise<EpisodicMemory[]> {
    let results = Array.from(this.episodes.values());

    // Apply text search filter
    if (query.text) {
      const lower = query.text.toLowerCase();
      results = results.filter(e =>
        e.content.event.toLowerCase().includes(lower) ||
        e.content.summary.toLowerCase().includes(lower)
      );
    }

    // Apply filters
    if (query.sessionId) {
      results = results.filter(e => e.session_id === query.sessionId);
    }

    if (query.startTime) {
      results = results.filter(e => e.started_at >= query.startTime!);
    }

    if (query.endTime) {
      results = results.filter(e => e.started_at <= query.endTime!);
    }

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

    if (query.unconsolidatedOnly) {
      results = results.filter(e => !e.consolidated);
    }

    // Sort by salience score (highest first), then recency as tiebreaker
    results.sort((a, b) =>
      b.salience.current_score - a.salience.current_score ||
      b.started_at.getTime() - a.started_at.getTime()
    );

    // Apply pagination
    if (query.offset) {
      results = results.slice(query.offset);
    }
    if (query.limit) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  async markConsolidated(ids: string[], extractedFactIds: MemoryID[]): Promise<void> {
    for (const id of ids) {
      const episode = this.episodes.get(id);
      if (episode) {
        const updated: EpisodicMemory = {
          ...episode,
          consolidated: true,
          extracted_fact_ids: extractedFactIds,
        };
        this.episodes.set(id, updated);
      }
    }
  }

  async getConsolidationCandidates(
    minAgeHours: number,
    minSalience: number,
    limit: number
  ): Promise<EpisodicMemory[]> {
    const cutoff = new Date(Date.now() - minAgeHours * 60 * 60 * 1000);

    return Array.from(this.episodes.values())
      .filter(e =>
        !e.consolidated &&
        e.started_at <= cutoff &&
        e.salience.current_score >= minSalience
      )
      .sort((a, b) => b.salience.current_score - a.salience.current_score)
      .slice(0, limit);
  }

  async updateSignals(
    id: string,
    signals: Partial<SalienceSignals>
  ): Promise<EpisodicMemory | undefined> {
    const episode = this.episodes.get(id);
    if (!episode) return undefined;

    const updatedSignals: SalienceSignals = {
      ...episode.salience.signals,
      ...signals,
    };

    const updated: EpisodicMemory = {
      ...episode,
      salience: createSalience(updatedSignals),
    };

    this.episodes.set(id, updated);
    return updated;
  }

  async delete(id: string): Promise<boolean> {
    return this.episodes.delete(id);
  }

  async deleteBySession(sessionId: string): Promise<number> {
    let count = 0;
    for (const [id, episode] of this.episodes) {
      if (episode.session_id === sessionId) {
        this.episodes.delete(id);
        count++;
      }
    }
    return count;
  }

  async count(query?: EpisodicQuery): Promise<number> {
    if (!query) return this.episodes.size;
    return (await this.query(query)).length;
  }
}
