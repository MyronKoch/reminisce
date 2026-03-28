/**
 * Reminisce Orchestrator
 *
 * Unified interface to the Reminisce.
 * Routes operations to appropriate layers and manages the memory lifecycle.
 */

import type {
  WorkingMemoryItem,
  EpisodicMemory,
  SemanticMemory,
  SalienceSignals,
  MemoryID,
} from '@reminisce/core';
import { WorkingMemoryBuffer, type WorkingMemoryInput } from '@reminisce/working';
import { InMemoryEpisodicStore, type EpisodicStore, type EpisodeInput } from '@reminisce/episodic';
import { InMemorySemanticStore, type SemanticStore, type FactInput, type ContradictionResult } from '@reminisce/semantic';
import {
  ConsolidationEngine,
  SimpleFactExtractor,
  type FactExtractor,
  type ConsolidationResult,
} from '@reminisce/consolidation';
import { ObservabilityCollector, type ObservabilityConfig } from './observability.js';

/**
 * Configuration for Reminisce
 */
export interface ReminisceConfig {
  /** Machine identifier */
  machineId: string;

  /** Working memory capacity */
  workingMemoryCapacity?: number;

  /** Custom episodic store (default: in-memory) */
  episodicStore?: EpisodicStore;

  /** Custom semantic store (default: in-memory) */
  semanticStore?: SemanticStore;

  /** Custom fact extractor (default: simple rule-based) */
  factExtractor?: FactExtractor;

  /** Auto-consolidate on session end */
  autoConsolidate?: boolean;

  /** Consolidation settings */
  consolidation?: {
    minAgeHours?: number;
    minSalience?: number;
    batchSize?: number;
  };

  /** Observability/metrics settings */
  observability?: Partial<ObservabilityConfig>;

  /** Enable observability (default: true) */
  enableObservability?: boolean;
}

/**
 * Search result from multi-layer retrieval
 */
export interface SearchResult {
  working: WorkingMemoryItem[];
  episodic: EpisodicMemory[];
  semantic: SemanticMemory[];
}

/**
 * Session state
 */
export interface Session {
  id: string;
  startedAt: Date;
  machineId: string;
  working: WorkingMemoryBuffer;
}

/**
 * Reminisce - Reminisce
 */
export class Reminisce {
  private config: Required<Omit<ReminisceConfig, 'episodicStore' | 'semanticStore' | 'factExtractor' | 'consolidation' | 'observability'>> & {
    consolidation: Required<NonNullable<ReminisceConfig['consolidation']>>;
  };
  private episodicStore: EpisodicStore;
  private semanticStore: SemanticStore;
  private consolidationEngine: ConsolidationEngine;
  private sessions: Map<string, Session> = new Map();
  private currentSession: Session | null = null;
  private _observability: ObservabilityCollector | null = null;

  constructor(config: ReminisceConfig) {
    this.config = {
      machineId: config.machineId,
      workingMemoryCapacity: config.workingMemoryCapacity ?? 7,
      autoConsolidate: config.autoConsolidate ?? true,
      enableObservability: config.enableObservability ?? true,
      consolidation: {
        minAgeHours: config.consolidation?.minAgeHours ?? 1,
        minSalience: config.consolidation?.minSalience ?? 0.3,
        batchSize: config.consolidation?.batchSize ?? 10,
      },
    };

    // Initialize observability
    if (this.config.enableObservability) {
      this._observability = new ObservabilityCollector(config.observability);
    }

    // Initialize stores
    this.episodicStore = config.episodicStore ?? new InMemoryEpisodicStore({
      machineId: config.machineId,
    });

    this.semanticStore = config.semanticStore ?? new InMemorySemanticStore({
      machineId: config.machineId,
      sessionId: 'global',
    });

    // Initialize consolidation engine
    const extractor = config.factExtractor ?? new SimpleFactExtractor();
    this.consolidationEngine = new ConsolidationEngine(
      this.episodicStore,
      this.semanticStore,
      extractor,
      this.config.consolidation
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Session Management
  // ─────────────────────────────────────────────────────────────

  /**
   * Start a new session
   */
  startSession(sessionId?: string): Session {
    const id = sessionId ?? crypto.randomUUID();

    const working = new WorkingMemoryBuffer({
      sessionId: id,
      machineId: this.config.machineId,
      capacity: this.config.workingMemoryCapacity,
      onOverflow: async (items) => {
        await this.episodicStore.receiveOverflow(items);
      },
    });

    const session: Session = {
      id,
      startedAt: new Date(),
      machineId: this.config.machineId,
      working,
    };

    this.sessions.set(id, session);
    this.currentSession = session;

    return session;
  }

  /**
   * End the current session
   */
  async endSession(): Promise<{
    sessionId: string;
    itemsFlushed: number;
    consolidationResult?: ConsolidationResult;
  }> {
    if (!this.currentSession) {
      throw new Error('No active session');
    }

    const session = this.currentSession;
    const remaining = await session.working.clear();

    // Flush remaining items to episodic
    if (remaining.length > 0) {
      await this.episodicStore.receiveOverflow(remaining);
    }

    this.sessions.delete(session.id);
    this.currentSession = null;

    // Optionally run consolidation
    if (this.config.autoConsolidate) {
      const consolidationResult = await this.consolidationEngine.consolidate();
      return {
        sessionId: session.id,
        itemsFlushed: remaining.length,
        consolidationResult,
      };
    }

    return {
      sessionId: session.id,
      itemsFlushed: remaining.length,
    };
  }

  /**
   * Get current session
   */
  getSession(): Session | null {
    return this.currentSession;
  }

  // ─────────────────────────────────────────────────────────────
  // Write Operations
  // ─────────────────────────────────────────────────────────────

  /**
   * Remember something in working memory
   */
  async remember(input: WorkingMemoryInput): Promise<WorkingMemoryItem> {
    if (!this.currentSession) {
      this.startSession();
    }

    const start = performance.now();
    try {
      const { item } = await this.currentSession!.working.add(input);
      this._observability?.recordOperation('remember', 'working', performance.now() - start, true, {
        type: input.type,
        hasSignals: !!input.signals,
      });
      this._observability?.recordSalience(item.salience.current_score);
      return item;
    } catch (error) {
      this._observability?.recordOperation('remember', 'working', performance.now() - start, false);
      throw error;
    }
  }

  /**
   * Record an episode directly (bypasses working memory)
   */
  async recordEpisode(input: EpisodeInput): Promise<EpisodicMemory> {
    const sessionId = this.currentSession?.id ?? 'direct';
    const start = performance.now();
    try {
      const episode = await this.episodicStore.store({
        ...input,
        sessionId: input.sessionId ?? sessionId,
      });
      this._observability?.recordOperation('record_episode', 'episodic', performance.now() - start, true);
      this._observability?.recordSalience(episode.salience.current_score);
      return episode;
    } catch (error) {
      this._observability?.recordOperation('record_episode', 'episodic', performance.now() - start, false);
      throw error;
    }
  }

  /**
   * Store a fact directly (bypasses consolidation)
   */
  async storeFact(input: FactInput): Promise<SemanticMemory> {
    const start = performance.now();
    try {
      const fact = await this.semanticStore.store(input);
      this._observability?.recordOperation('store_fact', 'semantic', performance.now() - start, true);
      this._observability?.recordSalience(fact.salience.current_score);
      return fact;
    } catch (error) {
      this._observability?.recordOperation('store_fact', 'semantic', performance.now() - start, false);
      throw error;
    }
  }

  /**
   * Check for contradictions before storing a fact
   */
  async checkContradiction(input: FactInput): Promise<ContradictionResult> {
    return this.semanticStore.checkContradiction(input);
  }

  /**
   * Adjust salience score for a memory
   */
  async rateSalience(id: string, layer: 'episodic' | 'semantic', adjustment: number): Promise<boolean> {
    const clampedAdj = Math.max(-1, Math.min(1, adjustment));
    if (layer === 'episodic') {
      const episode = await this.episodicStore.get(id);
      if (!episode) return false;
      const newReward = Math.max(0, Math.min(1, (episode.salience.signals.reward_signal ?? 0) + clampedAdj));
      await this.episodicStore.updateSignals(id, { reward_signal: newReward });
      return true;
    } else {
      const fact = await this.semanticStore.get(id);
      if (!fact) return false;
      const newReward = Math.max(0, Math.min(1, (fact.salience.signals.reward_signal ?? 0) + clampedAdj));
      await this.semanticStore.updateSignals(id, { reward_signal: newReward });
      return true;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Read Operations
  // ─────────────────────────────────────────────────────────────

  /**
   * Search across all memory layers
   */
  async search(query: {
    text?: string;
    tags?: string[];
    sessionId?: string;
    limit?: number;
  }): Promise<SearchResult> {
    const start = performance.now();
    const limit = query.limit ?? 10;

    try {
      // Search working memory (current session only)
      let working: WorkingMemoryItem[] = [];
      if (this.currentSession) {
        working = this.currentSession.working.getAll();
        if (query.text) {
          const lower = query.text.toLowerCase();
          working = working.filter(w => {
            const summary = w.content.summary?.toLowerCase() ?? '';
            const data = JSON.stringify(w.content.data).toLowerCase();
            return summary.includes(lower) || data.includes(lower);
          });
        }
        if (query.tags) {
          working = working.filter(w => w.tags?.some(t => query.tags!.includes(t)));
        }
      }

      // Search episodic
      const episodicQuery: Parameters<typeof this.episodicStore.query>[0] = { limit };
      if (query.text !== undefined) episodicQuery.text = query.text;
      if (query.sessionId !== undefined) episodicQuery.sessionId = query.sessionId;
      if (query.tags !== undefined) episodicQuery.tags = query.tags;
      const episodic = await this.episodicStore.query(episodicQuery);

      // Search semantic
      const semanticQuery: Parameters<typeof this.semanticStore.query>[0] = { limit };
      if (query.text !== undefined) semanticQuery.text = query.text;
      if (query.tags !== undefined) semanticQuery.tags = query.tags;
      const semantic = await this.semanticStore.query(semanticQuery);

      this._observability?.recordOperation('search', 'all', performance.now() - start, true, {
        workingHits: working.length,
        episodicHits: episodic.length,
        semanticHits: semantic.length,
      });

      return { working, episodic, semantic };
    } catch (error) {
      this._observability?.recordOperation('search', 'all', performance.now() - start, false);
      throw error;
    }
  }

  /**
   * Get recent episodes
   */
  async getRecentEpisodes(limit: number = 10): Promise<EpisodicMemory[]> {
    return this.episodicStore.query({ limit });
  }

  /**
   * Get facts about a subject
   */
  async getFactsAbout(subject: string): Promise<SemanticMemory[]> {
    return this.semanticStore.query({ subject });
  }

  /**
   * Get facts by category
   */
  async getFactsByCategory(category: string): Promise<SemanticMemory[]> {
    return this.semanticStore.query({ category });
  }

  // ─────────────────────────────────────────────────────────────
  // Memory Management
  // ─────────────────────────────────────────────────────────────

  /**
   * Pin a working memory item
   */
  pin(id: string): void {
    this.currentSession?.working.pin(id);
  }

  /**
   * Block a memory (mark for forgetting)
   */
  async block(id: string, layer: 'working' | 'episodic' | 'semantic'): Promise<void> {
    const start = performance.now();
    try {
      switch (layer) {
        case 'working':
          this.currentSession?.working.block(id);
          break;
        case 'episodic':
          await this.episodicStore.delete(id);
          break;
        case 'semantic':
          await this.semanticStore.retract(id, 'user_blocked');
          break;
      }
      this._observability?.recordOperation('forget', layer, performance.now() - start, true);
    } catch (error) {
      this._observability?.recordOperation('forget', layer, performance.now() - start, false);
      throw error;
    }
  }

  /**
   * Manually trigger consolidation
   */
  async consolidate(): Promise<ConsolidationResult> {
    const start = performance.now();
    try {
      const result = await this.consolidationEngine.consolidate();
      this._observability?.recordOperation('consolidate', 'all', performance.now() - start, true, {
        episodesProcessed: result.episodesProcessed,
        factsExtracted: result.factsExtracted,
      });
      this._observability?.recordConsolidation(result.episodesProcessed, result.factsExtracted);
      return result;
    } catch (error) {
      this._observability?.recordOperation('consolidate', 'all', performance.now() - start, false);
      throw error;
    }
  }

  /**
   * Get observability collector for direct access to metrics
   */
  get observability(): ObservabilityCollector | null {
    return this._observability;
  }

  /**
   * Get system stats
   */
  async getStats(): Promise<{
    sessions: number;
    workingMemorySize: number;
    workingMemoryCapacity: number;
    pendingEpisodes: number;
    consolidatedEpisodes: number;
    totalFacts: number;
    lowConfidenceFacts: number;
  }> {
    const consolidationStats = await this.consolidationEngine.getStats();

    return {
      sessions: this.sessions.size,
      workingMemorySize: this.currentSession?.working.size ?? 0,
      workingMemoryCapacity: this.config.workingMemoryCapacity,
      ...consolidationStats,
    };
  }

  /**
   * Cleanup resources (stops observability timer, etc.)
   */
  destroy(): void {
    this._observability?.stop();
  }

  /**
   * Forget all data for a user/session (GDPR)
   */
  async forgetSession(sessionId: string): Promise<{
    episodesDeleted: number;
    factsDeleted: number;
  }> {
    // First, query episodes to get their IDs before deletion
    const episodes = await this.episodicStore.query({ sessionId });
    const episodeIds = episodes.map(e => e.memory_id.id);

    // Delete from episodic
    const episodesDeleted = await this.episodicStore.deleteBySession(sessionId);

    // Delete derived facts by source episode IDs
    let factsDeleted = 0;
    for (const episodeId of episodeIds) {
      factsDeleted += await this.semanticStore.deleteBySourceEpisode(episodeId);
    }

    // Clear working memory if current session
    if (this.currentSession?.id === sessionId) {
      await this.currentSession.working.clear();
    }

    return { episodesDeleted, factsDeleted };
  }
}
