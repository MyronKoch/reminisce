/**
 * Cloudflare Vectorize Integration
 *
 * Provides vector search capabilities using Cloudflare's Vectorize
 * and Workers AI for embeddings generation.
 */

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

// Minimal Vectorize types
interface VectorizeIndex {
  upsert(vectors: VectorizeVector[]): Promise<VectorizeInsertResult>;
  query(
    vector: number[],
    options?: VectorizeQueryOptions
  ): Promise<VectorizeMatches>;
  deleteByIds(ids: string[]): Promise<VectorizeDeleteResult>;
}

interface VectorizeVector {
  id: string;
  values: number[];
  metadata?: Record<string, string | number | boolean>;
  namespace?: string;
}

interface VectorizeInsertResult {
  count: number;
  ids: string[];
}

interface VectorizeQueryOptions {
  topK?: number;
  filter?: Record<string, string | number | boolean>;
  returnValues?: boolean;
  returnMetadata?: 'none' | 'indexed' | 'all';
  namespace?: string;
}

interface VectorizeMatches {
  matches: VectorizeMatch[];
  count: number;
}

interface VectorizeMatch {
  id: string;
  score: number;
  values?: number[];
  metadata?: Record<string, string | number | boolean>;
}

interface VectorizeDeleteResult {
  count: number;
  ids: string[];
}

// Minimal Workers AI types
interface Ai {
  run(model: string, inputs: unknown): Promise<unknown>;
}

interface AiTextEmbeddingsOutput {
  shape: number[];
  data: number[][];
}

interface AiTextGenerationOutput {
  response: string;
}

// ─────────────────────────────────────────────────────────────
// Embedding Provider
// ─────────────────────────────────────────────────────────────

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  dimensions: number;
}

/**
 * Workers AI Embedding Provider
 *
 * Uses Cloudflare Workers AI for embeddings.
 * Standard model: @cf/google/embeddinggemma-300m (768 dimensions)
 * All Reminisce vector stores MUST use EmbeddingGemma-300m for consistency.
 */
export class WorkersAIEmbeddings implements EmbeddingProvider {
  readonly dimensions: number;

  constructor(
    private ai: Ai,
    private model: string = '@cf/google/embeddinggemma-300m'
  ) {
    // Set dimensions based on model
    if (model.includes('embeddinggemma')) {
      this.dimensions = 768;
    } else if (model.includes('large')) {
      this.dimensions = 1024;
    } else if (model.includes('small')) {
      this.dimensions = 384;
    } else {
      this.dimensions = 768;
    }
  }

  async embed(text: string): Promise<number[]> {
    const result = (await this.ai.run(this.model, {
      text: [text],
    })) as AiTextEmbeddingsOutput;

    return result.data[0]!;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    const result = (await this.ai.run(this.model, {
      text: texts,
    })) as AiTextEmbeddingsOutput;

    return result.data;
  }
}

// ─────────────────────────────────────────────────────────────
// Vector Memory Store
// ─────────────────────────────────────────────────────────────

export interface VectorStoreConfig {
  tenantId: string;
  embeddingProvider: EmbeddingProvider;
}

export interface VectorSearchResult {
  id: string;
  score: number;
  memoryType: 'episodic' | 'semantic';
  metadata?: Record<string, string | number | boolean>;
}

/**
 * Vector store backed by Cloudflare Vectorize
 */
export class VectorStore {
  constructor(
    private index: VectorizeIndex,
    private config: VectorStoreConfig
  ) {}

  /**
   * Index an episodic memory
   */
  async indexEpisodic(
    id: string,
    text: string,
    metadata?: Record<string, string | number | boolean>
  ): Promise<void> {
    const embedding = await this.config.embeddingProvider.embed(text);

    await this.index.upsert([
      {
        id,
        values: embedding,
        metadata: {
          ...metadata,
          tenant_id: this.config.tenantId,
          memory_type: 'episodic',
        },
        namespace: this.config.tenantId,
      },
    ]);
  }

  /**
   * Index a semantic memory (fact)
   */
  async indexSemantic(
    id: string,
    text: string,
    metadata?: Record<string, string | number | boolean>
  ): Promise<void> {
    const embedding = await this.config.embeddingProvider.embed(text);

    await this.index.upsert([
      {
        id,
        values: embedding,
        metadata: {
          ...metadata,
          tenant_id: this.config.tenantId,
          memory_type: 'semantic',
        },
        namespace: this.config.tenantId,
      },
    ]);
  }

  /**
   * Index multiple memories in batch
   */
  async indexBatch(
    items: Array<{
      id: string;
      text: string;
      memoryType: 'episodic' | 'semantic';
      metadata?: Record<string, string | number | boolean>;
    }>
  ): Promise<void> {
    if (items.length === 0) return;

    const texts = items.map((i) => i.text);
    const embeddings = await this.config.embeddingProvider.embedBatch(texts);

    const vectors: VectorizeVector[] = items.map((item, idx) => ({
      id: item.id,
      values: embeddings[idx]!,
      metadata: {
        ...item.metadata,
        tenant_id: this.config.tenantId,
        memory_type: item.memoryType,
      },
      namespace: this.config.tenantId,
    }));

    await this.index.upsert(vectors);
  }

  /**
   * Search for similar memories
   */
  async search(
    query: string,
    options: {
      topK?: number;
      memoryType?: 'episodic' | 'semantic';
    } = {}
  ): Promise<VectorSearchResult[]> {
    const topK = options.topK ?? 10;

    const queryEmbedding = await this.config.embeddingProvider.embed(query);

    // Use namespace for tenant isolation (no metadata filter needed for tenant_id)
    const filter: Record<string, string | number | boolean> | undefined =
      options.memoryType ? { memory_type: options.memoryType } : undefined;

    const results = await this.index.query(queryEmbedding, {
      topK,
      ...(filter ? { filter } : {}),
      returnMetadata: 'all',
      namespace: this.config.tenantId,
    });

    return results.matches.map((match) => ({
      id: match.id,
      score: match.score,
      memoryType: (match.metadata?.memory_type as 'episodic' | 'semantic') || 'episodic',
      metadata: match.metadata,
    }));
  }

  /**
   * Delete vectors by ID
   */
  async delete(ids: string[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.index.deleteByIds(ids);
    return result.count;
  }
}

// ─────────────────────────────────────────────────────────────
// RAG Helper
// ─────────────────────────────────────────────────────────────

export interface RAGConfig {
  vectorStore: VectorStore;
  ai: Ai;
  model?: string;
  maxContextItems?: number;
}

/**
 * Simple RAG implementation using Vectorize and Workers AI
 */
export class RAGHelper {
  private model: string;
  private maxContextItems: number;

  constructor(private config: RAGConfig) {
    this.model = config.model || '@cf/meta/llama-2-7b-chat-int8';
    this.maxContextItems = config.maxContextItems || 5;
  }

  /**
   * Answer a question using retrieved memories as context
   */
  async answer(
    question: string,
    options: {
      systemPrompt?: string;
      memoryType?: 'episodic' | 'semantic';
    } = {}
  ): Promise<{ answer: string; sources: VectorSearchResult[] }> {
    // Build search options
    const searchOpts: { topK: number; memoryType?: 'episodic' | 'semantic' } = {
      topK: this.maxContextItems,
    };
    if (options.memoryType) {
      searchOpts.memoryType = options.memoryType;
    }

    // Retrieve relevant memories
    const sources = await this.config.vectorStore.search(question, searchOpts);

    // Build context from sources
    const context = sources
      .map((s, i) => `[${i + 1}] (score: ${s.score.toFixed(3)}) ${s.metadata?.text || s.id}`)
      .join('\n');

    const systemPrompt =
      options.systemPrompt ||
      `You are a helpful assistant with access to a memory database. Use the following retrieved memories to answer the user's question. If the memories don't contain relevant information, say so.

Retrieved memories:
${context}`;

    const result = (await this.config.ai.run(this.model, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question },
      ],
      max_tokens: 512,
      temperature: 0.7,
    })) as AiTextGenerationOutput;

    return {
      answer: result.response,
      sources,
    };
  }
}
