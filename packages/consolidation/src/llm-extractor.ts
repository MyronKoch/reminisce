/**
 * LLM-based Fact Extractor
 *
 * Uses language models to extract structured facts from episodic memories.
 * Supports pluggable LLM providers (OpenAI, Anthropic, local models).
 */

import type { EpisodicMemory } from '@reminisce/core';
import type { FactExtractor, ExtractedFact, ExtractionResult } from './engine.js';

/**
 * LLM provider interface
 */
export interface LLMProvider {
  /**
   * Generate a completion for the given prompt
   */
  complete(prompt: string, options?: LLMOptions): Promise<string>;
}

/**
 * Options for LLM completion
 */
export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  stopSequences?: string[];
}

/**
 * Configuration for LLM extractor
 */
export interface LLMExtractorConfig {
  /** LLM provider to use */
  provider: LLMProvider;

  /** Model identifier (provider-specific) */
  model?: string;

  /** Maximum episodes to batch in a single prompt */
  batchSize?: number;

  /** Temperature for extraction (lower = more deterministic) */
  temperature?: number;

  /** Custom system prompt (optional) */
  systemPrompt?: string;

  /** Minimum confidence threshold for extracted facts */
  minConfidence?: number;
}

/**
 * Default system prompt for fact extraction
 */
const DEFAULT_SYSTEM_PROMPT = `You are a fact extraction system. Given episodic memories (events/experiences), extract factual statements that can be learned and remembered long-term.

For each fact, provide:
- fact: A clear, concise factual statement
- subject: The main entity (if applicable)
- predicate: The relationship or property (if applicable)
- object: The related entity or value (if applicable)
- category: One of: preference, skill, relationship, behavior, knowledge, context
- confidence: 0.0-1.0 based on how certain the fact is

Focus on:
- User preferences and habits
- Relationships between entities
- Skills and capabilities
- Behavioral patterns
- Contextual knowledge

Ignore:
- Transient information
- Greetings and small talk
- Ambiguous or unclear statements

Respond with a JSON array of facts. Example:
[
  {
    "fact": "User prefers dark mode for all applications",
    "subject": "user",
    "predicate": "prefers",
    "object": "dark mode",
    "category": "preference",
    "confidence": 0.9
  }
]`;

/**
 * LLM-based fact extractor
 */
export class LLMFactExtractor implements FactExtractor {
  private config: Required<Omit<LLMExtractorConfig, 'provider'>> & { provider: LLMProvider };

  constructor(config: LLMExtractorConfig) {
    this.config = {
      provider: config.provider,
      model: config.model ?? 'default',
      batchSize: config.batchSize ?? 5,
      temperature: config.temperature ?? 0.3,
      systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      minConfidence: config.minConfidence ?? 0.5,
    };
  }

  /**
   * Extract facts from episodes using LLM
   */
  async extract(episodes: EpisodicMemory[]): Promise<ExtractionResult> {
    const allFacts: ExtractedFact[] = [];

    // Process in batches
    for (let i = 0; i < episodes.length; i += this.config.batchSize) {
      const batch = episodes.slice(i, i + this.config.batchSize);
      const batchFacts = await this.extractBatch(batch);
      allFacts.push(...batchFacts);
    }

    // Filter by minimum confidence
    const filteredFacts = allFacts.filter(
      (f) => f.confidence >= this.config.minConfidence
    );

    return {
      facts: filteredFacts,
      sourceEpisodes: episodes,
    };
  }

  /**
   * Extract facts from a batch of episodes
   */
  private async extractBatch(episodes: EpisodicMemory[]): Promise<ExtractedFact[]> {
    const prompt = this.buildPrompt(episodes);

    try {
      const response = await this.config.provider.complete(prompt, {
        temperature: this.config.temperature,
        maxTokens: 2000,
      });

      return this.parseResponse(response);
    } catch (error) {
      console.error('LLM extraction failed:', error);
      // Fall back to simple extraction on failure
      return this.fallbackExtract(episodes);
    }
  }

  /**
   * Build the extraction prompt
   */
  private buildPrompt(episodes: EpisodicMemory[]): string {
    const episodeTexts = episodes.map((ep, i) => {
      const parts = [
        `Episode ${i + 1}:`,
        `  Event: ${ep.content.event}`,
        `  Summary: ${ep.content.summary}`,
      ];

      if (ep.content.entities.length > 0) {
        parts.push(`  Entities: ${ep.content.entities.join(', ')}`);
      }

      if (ep.content.valence !== undefined && ep.content.valence !== 0) {
        const valenceName = ep.content.valence > 0 ? 'positive' : 'negative';
        parts.push(`  Emotional context: ${valenceName} (${ep.content.valence.toFixed(2)})`);
      }

      return parts.join('\n');
    });

    return `${this.config.systemPrompt}

---
Episodes to analyze:

${episodeTexts.join('\n\n')}

---
Extract facts as JSON array:`;
  }

  /**
   * Parse LLM response into ExtractedFact array
   */
  private parseResponse(response: string): ExtractedFact[] {
    try {
      // Try to find JSON array in response
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        console.warn('No JSON array found in LLM response');
        return [];
      }

      const parsed = JSON.parse(jsonMatch[0]) as unknown[];

      return parsed
        .filter((item): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null
        )
        .map((item) => this.validateFact(item))
        .filter((fact): fact is ExtractedFact => fact !== null);
    } catch (error) {
      console.error('Failed to parse LLM response:', error);
      return [];
    }
  }

  /**
   * Validate and normalize a parsed fact
   */
  private validateFact(item: Record<string, unknown>): ExtractedFact | null {
    // Fact is required
    if (typeof item.fact !== 'string' || item.fact.trim() === '') {
      return null;
    }

    const fact: ExtractedFact = {
      fact: item.fact.trim(),
      confidence: typeof item.confidence === 'number'
        ? Math.max(0, Math.min(1, item.confidence))
        : 0.7,
    };

    // Optional SPO fields
    if (typeof item.subject === 'string' && item.subject.trim()) {
      fact.subject = item.subject.trim();
    }
    if (typeof item.predicate === 'string' && item.predicate.trim()) {
      fact.predicate = item.predicate.trim();
    }
    if (typeof item.object === 'string' && item.object.trim()) {
      fact.object = item.object.trim();
    }

    // Category
    if (typeof item.category === 'string' && item.category.trim()) {
      fact.category = item.category.trim();
    }

    return fact;
  }

  /**
   * Fallback extraction when LLM fails
   */
  private fallbackExtract(episodes: EpisodicMemory[]): ExtractedFact[] {
    const facts: ExtractedFact[] = [];

    for (const episode of episodes) {
      if (episode.content.summary) {
        facts.push({
          fact: episode.content.summary,
          confidence: Math.min(episode.salience.current_score, 0.6),
          category: 'extracted',
        });
      }
    }

    return facts;
  }
}

/**
 * OpenAI-compatible provider
 */
export class OpenAIProvider implements LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(config: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
  }) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api.openai.com/v1';
    this.model = config.model ?? 'gpt-4o-mini';
  }

  async complete(prompt: string, options?: LLMOptions): Promise<string> {
    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: options?.temperature ?? 0.3,
        max_tokens: options?.maxTokens ?? 2000,
        stop: options?.stopSequences,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };

    return data.choices[0]?.message.content ?? '';
  }
}

/**
 * Anthropic provider
 */
export class AnthropicProvider implements LLMProvider {
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(config: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
  }) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? 'https://api.anthropic.com/v1';
    this.model = config.model ?? 'claude-3-haiku-20240307';
  }

  async complete(prompt: string, options?: LLMOptions): Promise<string> {
    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: options?.maxTokens ?? 2000,
        messages: [{ role: 'user', content: prompt }],
        temperature: options?.temperature ?? 0.3,
        stop_sequences: options?.stopSequences,
      }),
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as {
      content: Array<{ type: string; text: string }>;
    };

    const textBlock = data.content.find((c) => c.type === 'text');
    return textBlock?.text ?? '';
  }
}

/**
 * Create an LLM extractor with OpenAI
 */
export function createOpenAIExtractor(
  apiKey: string,
  options?: Partial<Omit<LLMExtractorConfig, 'provider'>> & { model?: string }
): LLMFactExtractor {
  const providerConfig: { apiKey: string; model?: string } = { apiKey };
  if (options?.model !== undefined) {
    providerConfig.model = options.model;
  }
  const provider = new OpenAIProvider(providerConfig);

  return new LLMFactExtractor({
    provider,
    ...options,
  });
}

/**
 * Create an LLM extractor with Anthropic
 */
export function createAnthropicExtractor(
  apiKey: string,
  options?: Partial<Omit<LLMExtractorConfig, 'provider'>> & { model?: string }
): LLMFactExtractor {
  const providerConfig: { apiKey: string; model?: string } = { apiKey };
  if (options?.model !== undefined) {
    providerConfig.model = options.model;
  }
  const provider = new AnthropicProvider(providerConfig);

  return new LLMFactExtractor({
    provider,
    ...options,
  });
}
