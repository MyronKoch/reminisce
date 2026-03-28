/**
 * Consolidation Engine
 *
 * Implements the "slow learning" consolidation from episodic to semantic memory.
 * Inspired by Sharp Wave Ripples that replay and extract patterns during rest.
 */

import type { EpisodicMemory, MemoryID, SemanticMemory } from '@reminisce/core';
import type { EpisodicStore } from '@reminisce/episodic';
import type { SemanticStore, FactInput, ContradictionResult } from '@reminisce/semantic';

/**
 * Extracted fact from an episode
 */
export interface ExtractedFact {
  fact: string;
  subject?: string;
  predicate?: string;
  object?: string;
  category?: string;
  confidence: number;
}

/**
 * Result of fact extraction from episodes
 */
export interface ExtractionResult {
  facts: ExtractedFact[];
  sourceEpisodes: EpisodicMemory[];
}

/**
 * Interface for fact extractors (pluggable - can use LLM, rules, etc.)
 */
export interface FactExtractor {
  /**
   * Extract facts from a batch of episodes
   */
  extract(episodes: EpisodicMemory[]): Promise<ExtractionResult>;
}

/**
 * Simple rule-based extractor for testing
 * In production, replace with LLM-based extraction
 */
export class SimpleFactExtractor implements FactExtractor {
  async extract(episodes: EpisodicMemory[]): Promise<ExtractionResult> {
    const facts: ExtractedFact[] = [];

    for (const episode of episodes) {
      // Extract facts from episode summary
      // This is a naive implementation - real version would use LLM
      if (episode.content.summary) {
        facts.push({
          fact: episode.content.summary,
          confidence: episode.salience.current_score,
          category: 'extracted',
        });
      }

      // Extract entity mentions as facts
      for (const entity of episode.content.entities) {
        facts.push({
          fact: `Entity "${entity}" was mentioned`,
          subject: entity,
          predicate: 'mentioned_in',
          object: episode.session_id,
          confidence: 0.7,
          category: 'entity',
        });
      }
    }

    return { facts, sourceEpisodes: episodes };
  }
}

/**
 * Consolidation configuration
 */
export interface ConsolidationConfig {
  /** Minimum age in hours before consolidation */
  minAgeHours: number;

  /** Minimum salience score for consolidation */
  minSalience: number;

  /** Maximum episodes to consolidate per run */
  batchSize: number;

  /** How to handle contradictions */
  contradictionPolicy: 'skip' | 'replace' | 'manual_flag';

  /** Minimum confidence for extracted facts */
  minFactConfidence: number;
}

const DEFAULT_CONFIG: ConsolidationConfig = {
  minAgeHours: 1,
  minSalience: 0.3,
  batchSize: 10,
  contradictionPolicy: 'skip',
  minFactConfidence: 0.5,
};

/**
 * Result of a consolidation run
 */
export interface ConsolidationResult {
  /** Episodes processed */
  episodesProcessed: number;

  /** Facts extracted */
  factsExtracted: number;

  /** Facts stored (after filtering) */
  factsStored: number;

  /** Contradictions encountered */
  contradictions: Array<{
    fact: ExtractedFact;
    conflicts: SemanticMemory[];
    resolution: 'skipped' | 'replaced' | 'flagged';
  }>;

  /** Errors encountered */
  errors: Array<{
    episode: EpisodicMemory;
    error: string;
  }>;

  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * Consolidation Engine
 */
export class ConsolidationEngine {
  private episodicStore: EpisodicStore;
  private semanticStore: SemanticStore;
  private extractor: FactExtractor;
  private config: ConsolidationConfig;

  constructor(
    episodicStore: EpisodicStore,
    semanticStore: SemanticStore,
    extractor: FactExtractor,
    config: Partial<ConsolidationConfig> = {}
  ) {
    this.episodicStore = episodicStore;
    this.semanticStore = semanticStore;
    this.extractor = extractor;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Run a consolidation cycle
   */
  async consolidate(): Promise<ConsolidationResult> {
    const startTime = Date.now();
    const result: ConsolidationResult = {
      episodesProcessed: 0,
      factsExtracted: 0,
      factsStored: 0,
      contradictions: [],
      errors: [],
      durationMs: 0,
    };

    try {
      // Get episodes ready for consolidation
      const candidates = await this.episodicStore.getConsolidationCandidates(
        this.config.minAgeHours,
        this.config.minSalience,
        this.config.batchSize
      );

      if (candidates.length === 0) {
        result.durationMs = Date.now() - startTime;
        return result;
      }

      result.episodesProcessed = candidates.length;

      // Extract facts from episodes
      const extraction = await this.extractor.extract(candidates);
      result.factsExtracted = extraction.facts.length;

      // Store facts with contradiction handling
      const storedFactIds: MemoryID[] = [];

      for (let factIdx = 0; factIdx < extraction.facts.length; factIdx++) {
        const fact = extraction.facts[factIdx]!;
        // Skip low-confidence facts
        if (fact.confidence < this.config.minFactConfidence) {
          continue;
        }

        try {
          const factInput: FactInput = {
            fact: fact.fact,
            sourceEpisodeIds: candidates.map(e => e.memory_id),
            derivationType: 'consolidated',
            confidence: fact.confidence,
          };

          if (fact.subject !== undefined) factInput.subject = fact.subject;
          if (fact.predicate !== undefined) factInput.predicate = fact.predicate;
          if (fact.object !== undefined) factInput.object = fact.object;
          if (fact.category !== undefined) factInput.category = fact.category;

          // Check for contradictions
          const contradiction = await this.semanticStore.checkContradiction(factInput);

          if (contradiction.hasContradiction) {
            const resolution = await this.handleContradiction(
              fact,
              factInput,
              contradiction
            );

            result.contradictions.push({
              fact,
              conflicts: contradiction.conflicts,
              resolution,
            });

            if (resolution === 'skipped') {
              continue;
            }
          }

          // Store the fact
          const stored = await this.semanticStore.store(factInput);
          storedFactIds.push(stored.memory_id);
          result.factsStored++;
        } catch (error) {
          // Use the source episode most related to this fact, or fall back to first candidate
          const sourceEpisode = candidates[Math.min(factIdx, candidates.length - 1)] ?? candidates[0]!;
          result.errors.push({
            episode: sourceEpisode,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Mark episodes as consolidated
      const episodeIds = candidates.map(e => e.memory_id.id);
      await this.episodicStore.markConsolidated(episodeIds, storedFactIds);
    } catch (error) {
      result.errors.push({
        episode: {} as EpisodicMemory,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    result.durationMs = Date.now() - startTime;
    return result;
  }

  /**
   * Handle a contradiction based on policy
   */
  private async handleContradiction(
    fact: ExtractedFact,
    factInput: FactInput,
    contradiction: ContradictionResult
  ): Promise<'skipped' | 'replaced' | 'flagged'> {
    switch (this.config.contradictionPolicy) {
      case 'skip':
        return 'skipped';

      case 'replace':
        // Replace all conflicting facts
        for (const conflict of contradiction.conflicts) {
          await this.semanticStore.supersede(conflict.memory_id.id, factInput);
        }
        return 'replaced';

      case 'manual_flag':
        // Store with lower confidence and flag
        factInput.confidence = Math.min(factInput.confidence ?? 1, 0.5);
        factInput.tags = [...(factInput.tags ?? []), 'needs_review', 'contradiction'];
        return 'flagged';
    }
  }

  /**
   * Get statistics about consolidation state
   */
  async getStats(): Promise<{
    pendingEpisodes: number;
    consolidatedEpisodes: number;
    totalFacts: number;
    lowConfidenceFacts: number;
  }> {
    const pending = await this.episodicStore.count({ unconsolidatedOnly: true });
    const total = await this.episodicStore.count();
    const facts = await this.semanticStore.count();
    const lowConfidence = (await this.semanticStore.getValidationCandidates(0.5, 1000)).length;

    return {
      pendingEpisodes: pending,
      consolidatedEpisodes: total - pending,
      totalFacts: facts,
      lowConfidenceFacts: lowConfidence,
    };
  }
}
