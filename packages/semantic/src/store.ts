/**
 * Semantic Store Interface
 *
 * Long-term storage for facts, entities, and relationships.
 * The "slow learning" neocortical system that receives consolidated knowledge.
 */

import type {
  SemanticMemory,
  MemoryID,
  SalienceSignals,
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

/**
 * Input for storing a fact
 */
export interface FactInput {
  /** The fact statement */
  fact: string;

  /** Subject of the fact (e.g., "user") */
  subject?: string;

  /** Predicate/relationship (e.g., "prefers") */
  predicate?: string;

  /** Object of the fact (e.g., "TypeScript") */
  object?: string;

  /** Category for organization */
  category?: string;

  /** Source episode IDs this was derived from */
  sourceEpisodeIds: MemoryID[];

  /** How this fact was derived */
  derivationType?: 'consolidated' | 'inferred' | 'user_declared';

  /** Initial confidence (0-1) */
  confidence?: number;

  /** Tags for filtering */
  tags?: string[];

  /** Initial salience signals */
  signals?: Partial<SalienceSignals>;

  /** Known contradiction memory IDs (from pre-store contradiction check) */
  contradictionIds?: MemoryID[];
}

/**
 * Query options for semantic retrieval
 */
export interface SemanticQuery {
  /** Search in fact text */
  text?: string;

  /** Filter by subject */
  subject?: string;

  /** Filter by predicate */
  predicate?: string;

  /** Filter by object */
  object?: string;

  /** Filter by category */
  category?: string;

  /** Filter by tags */
  tags?: string[];

  /** Minimum confidence threshold */
  minConfidence?: number;

  /** Include retracted facts */
  includeRetracted?: boolean;

  /** Maximum results */
  limit?: number;

  /** Offset for pagination */
  offset?: number;
}

/**
 * Result of contradiction check
 */
export interface ContradictionResult {
  /** Whether contradiction was found */
  hasContradiction: boolean;

  /** Conflicting facts */
  conflicts: SemanticMemory[];

  /** Suggested resolution */
  suggestion?: 'keep_existing' | 'replace' | 'manual_review';
}

/**
 * Abstract interface for semantic storage backends
 */
export interface SemanticStore {
  /** Store a new fact */
  store(input: FactInput): Promise<SemanticMemory>;

  /** Store multiple facts (batch) */
  storeBatch(inputs: FactInput[]): Promise<SemanticMemory[]>;

  /** Get fact by ID */
  get(id: string): Promise<SemanticMemory | undefined>;

  /** Query facts */
  query(query: SemanticQuery): Promise<SemanticMemory[]>;

  /** Check for contradictions before storing */
  checkContradiction(input: FactInput): Promise<ContradictionResult>;

  /** Retract a fact */
  retract(id: string, reason: string): Promise<SemanticMemory | undefined>;

  /** Supersede a fact with a new one */
  supersede(oldId: string, newInput: FactInput): Promise<{
    old: SemanticMemory;
    new: SemanticMemory;
  } | undefined>;

  /** Reinstate a retracted fact */
  reinstate(id: string): Promise<SemanticMemory | undefined>;

  /** Update salience signals */
  updateSignals(id: string, signals: Partial<SalienceSignals>): Promise<SemanticMemory | undefined>;

  /** Apply confidence decay to all facts */
  applyDecay(halfLifeDays: number): Promise<number>;

  /** Get facts that need validation (low confidence) */
  getValidationCandidates(maxConfidence: number, limit: number): Promise<SemanticMemory[]>;

  /** Validate a fact (boost confidence) */
  validate(id: string, boost?: number): Promise<SemanticMemory | undefined>;

  /** Delete a fact */
  delete(id: string): Promise<boolean>;

  /** Delete facts by source episode (cascade from episodic) */
  deleteBySourceEpisode(episodeId: string): Promise<number>;

  /** Count facts */
  count(query?: SemanticQuery): Promise<number>;

  /** Link related facts */
  linkFacts(id1: string, id2: string): Promise<void>;

  /** Get related facts */
  getRelated(id: string): Promise<SemanticMemory[]>;
}

/**
 * Configuration for semantic store
 */
export interface SemanticStoreConfig {
  /** Machine identifier */
  machineId: string;

  /** Session identifier */
  sessionId: string;

  /** Default confidence decay half-life in days */
  decayHalfLifeDays?: number;
}

/**
 * In-memory implementation of SemanticStore
 */
export class InMemorySemanticStore implements SemanticStore {
  private facts: Map<string, SemanticMemory> = new Map();
  private relations: Map<string, Set<string>> = new Map();
  private config: SemanticStoreConfig;

  constructor(config: SemanticStoreConfig) {
    this.config = {
      decayHalfLifeDays: 30,
      ...config,
    };
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

    const provenance = createProvenance(
      input.sourceEpisodeIds,
      input.derivationType ?? 'consolidated',
      input.confidence ?? 1.0
    );
    if (input.contradictionIds && input.contradictionIds.length > 0) {
      provenance.contradiction_ids = input.contradictionIds;
    }

    const fact: SemanticMemory = {
      memory_id: memoryId as MemoryID & { layer: 'semantic' },
      content,
      provenance,
      salience: createSalience(signals),
      source_episode_ids: input.sourceEpisodeIds,
    };

    if (input.tags !== undefined) {
      fact.tags = input.tags;
    }

    this.facts.set(memoryId.id, fact);
    return fact;
  }

  async storeBatch(inputs: FactInput[]): Promise<SemanticMemory[]> {
    const results: SemanticMemory[] = [];
    for (const input of inputs) {
      results.push(await this.store(input));
    }
    return results;
  }

  async get(id: string): Promise<SemanticMemory | undefined> {
    const fact = this.facts.get(id);
    if (fact) {
      const reinforced: SemanticMemory = {
        ...fact,
        salience: reinforceOnRetrieval(fact.salience),
        provenance: applyProvenanceAction(fact.provenance, { type: 'validate' }),
      };
      this.facts.set(id, reinforced);
      return reinforced;
    }
    return undefined;
  }

  async query(query: SemanticQuery): Promise<SemanticMemory[]> {
    let results = Array.from(this.facts.values());

    // Filter retracted unless explicitly included
    if (!query.includeRetracted) {
      results = results.filter(f => !f.provenance.retracted);
    }

    if (query.text) {
      const searchText = query.text.toLowerCase();
      results = results.filter(f =>
        f.content.fact.toLowerCase().includes(searchText)
      );
    }

    if (query.subject) {
      results = results.filter(f => f.content.subject === query.subject);
    }

    if (query.predicate) {
      results = results.filter(f => f.content.predicate === query.predicate);
    }

    if (query.object) {
      results = results.filter(f => f.content.object === query.object);
    }

    if (query.category) {
      results = results.filter(f => f.content.category === query.category);
    }

    if (query.tags && query.tags.length > 0) {
      results = results.filter(f =>
        f.tags && query.tags!.some(tag => f.tags!.includes(tag))
      );
    }

    if (query.minConfidence !== undefined) {
      results = results.filter(f => f.provenance.confidence >= query.minConfidence!);
    }

    // Sort by salience score (highest first), then confidence as tiebreaker
    results.sort((a, b) =>
      b.salience.current_score - a.salience.current_score ||
      b.provenance.confidence - a.provenance.confidence
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
    const fact = this.facts.get(id);
    if (!fact) return undefined;

    const retracted: SemanticMemory = {
      ...fact,
      provenance: applyProvenanceAction(fact.provenance, { type: 'retract', reason }),
    };

    this.facts.set(id, retracted);
    return retracted;
  }

  async supersede(oldId: string, newInput: FactInput): Promise<{
    old: SemanticMemory;
    new: SemanticMemory;
  } | undefined> {
    const oldFact = this.facts.get(oldId);
    if (!oldFact) return undefined;

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

    this.facts.set(oldId, superseded);

    return { old: superseded, new: newFact };
  }

  async reinstate(id: string): Promise<SemanticMemory | undefined> {
    const fact = this.facts.get(id);
    if (!fact || !fact.provenance.retracted) return undefined;

    const reinstated: SemanticMemory = {
      ...fact,
      provenance: applyProvenanceAction(fact.provenance, { type: 'reinstate' }),
    };

    this.facts.set(id, reinstated);
    return reinstated;
  }

  async updateSignals(
    id: string,
    signals: Partial<SalienceSignals>
  ): Promise<SemanticMemory | undefined> {
    const fact = this.facts.get(id);
    if (!fact) return undefined;

    const updatedSignals: SalienceSignals = {
      ...fact.salience.signals,
      ...signals,
    };

    const updated: SemanticMemory = {
      ...fact,
      salience: createSalience(updatedSignals),
    };

    this.facts.set(id, updated);
    return updated;
  }

  async applyDecay(halfLifeDays: number): Promise<number> {
    let decayedCount = 0;

    for (const [id, fact] of this.facts) {
      if (fact.provenance.retracted) continue;

      const decayedConfidence = calculateDecay(fact.provenance, halfLifeDays);

      if (decayedConfidence < fact.provenance.confidence) {
        const updated: SemanticMemory = {
          ...fact,
          provenance: {
            ...fact.provenance,
            confidence: decayedConfidence,
          },
        };
        this.facts.set(id, updated);
        decayedCount++;
      }
    }

    return decayedCount;
  }

  async getValidationCandidates(
    maxConfidence: number,
    limit: number
  ): Promise<SemanticMemory[]> {
    return Array.from(this.facts.values())
      .filter(f => !f.provenance.retracted && f.provenance.confidence <= maxConfidence)
      .sort((a, b) => a.provenance.confidence - b.provenance.confidence)
      .slice(0, limit);
  }

  async validate(id: string, boost: number = 0.1): Promise<SemanticMemory | undefined> {
    const fact = this.facts.get(id);
    if (!fact) return undefined;

    const validated: SemanticMemory = {
      ...fact,
      provenance: applyProvenanceAction(fact.provenance, {
        type: 'validate',
        confidence_boost: boost,
      }),
    };

    this.facts.set(id, validated);
    return validated;
  }

  async delete(id: string): Promise<boolean> {
    // Also clean up relations
    this.relations.delete(id);
    for (const [, related] of this.relations) {
      related.delete(id);
    }
    return this.facts.delete(id);
  }

  async deleteBySourceEpisode(episodeId: string): Promise<number> {
    let count = 0;
    for (const [id, fact] of this.facts) {
      if (fact.source_episode_ids.some(eid => eid.id === episodeId)) {
        this.facts.delete(id);
        count++;
      }
    }
    return count;
  }

  async count(query?: SemanticQuery): Promise<number> {
    if (!query) {
      return Array.from(this.facts.values()).filter(f => !f.provenance.retracted).length;
    }
    return (await this.query(query)).length;
  }

  async linkFacts(id1: string, id2: string): Promise<void> {
    if (!this.relations.has(id1)) {
      this.relations.set(id1, new Set());
    }
    if (!this.relations.has(id2)) {
      this.relations.set(id2, new Set());
    }
    this.relations.get(id1)!.add(id2);
    this.relations.get(id2)!.add(id1);
  }

  async getRelated(id: string): Promise<SemanticMemory[]> {
    const relatedIds = this.relations.get(id);
    if (!relatedIds) return [];

    const related: SemanticMemory[] = [];
    for (const relatedId of relatedIds) {
      const fact = this.facts.get(relatedId);
      if (fact && !fact.provenance.retracted) {
        related.push(fact);
      }
    }
    return related;
  }
}
