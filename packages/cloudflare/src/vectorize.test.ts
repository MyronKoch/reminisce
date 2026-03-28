/**
 * Tests for Cloudflare Vectorize Integration
 *
 * Covers:
 * - WorkersAIEmbeddings: Model configuration, dimensions, embed/embedBatch
 * - VectorStore: indexEpisodic, indexSemantic, indexBatch, search, delete
 * - RAGHelper: answer with context retrieval, system prompts, sources
 */

import { describe, it, expect, beforeEach } from 'bun:test';
import {
  WorkersAIEmbeddings,
  VectorStore,
  RAGHelper,
  type EmbeddingProvider,
  type VectorSearchResult,
} from './vectorize';

// ─────────────────────────────────────────────────────────────
// Mock Factories
// ─────────────────────────────────────────────────────────────

interface MockAI {
  ai: {
    run: (model: string, inputs: unknown) => Promise<unknown>;
  };
  calls: Array<{ model: string; inputs: unknown }>;
}

function createMockAI(): MockAI {
  const calls: Array<{ model: string; inputs: unknown }> = [];
  return {
    ai: {
      run: async (model: string, inputs: unknown) => {
        calls.push({ model, inputs });
        // Return mock embeddings for embedding models
        const text = (inputs as any).text;
        if (Array.isArray(text)) {
          return {
            shape: [text.length, 768],
            data: text.map(() => Array(768).fill(0.1)),
          };
        }
        // For text generation (RAG)
        return { response: 'Mock answer' };
      },
    },
    calls,
  };
}

interface MockVectorize {
  index: {
    upsert: (vectors: any[]) => Promise<{ count: number; ids: string[] }>;
    query: (
      vector: number[],
      options: any
    ) => Promise<{
      matches: Array<{
        id: string;
        score: number;
        metadata?: Record<string, string | number | boolean>;
      }>;
      count: number;
    }>;
    deleteByIds: (ids: string[]) => Promise<{ count: number; ids: string[] }>;
  };
  stored: any[];
  calls: Array<{ method: string; args: unknown[] }>;
}

function createMockVectorize(): MockVectorize {
  const stored: any[] = [];
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    index: {
      upsert: async (vectors: any[]) => {
        calls.push({ method: 'upsert', args: vectors });
        stored.push(...vectors);
        return { count: vectors.length, ids: vectors.map((v) => v.id) };
      },
      query: async (vector: number[], options: any) => {
        calls.push({ method: 'query', args: [vector, options] });
        return {
          matches: stored
            .slice(0, options?.topK || 10)
            .map((v, i) => ({
              id: v.id,
              score: 0.9 - i * 0.1,
              metadata: v.metadata,
            })),
          count: stored.length,
        };
      },
      deleteByIds: async (ids: string[]) => {
        calls.push({ method: 'deleteByIds', args: ids });
        return { count: ids.length, ids };
      },
    },
    stored,
    calls,
  };
}

// ─────────────────────────────────────────────────────────────
// WorkersAIEmbeddings Tests
// ─────────────────────────────────────────────────────────────

describe('WorkersAIEmbeddings', () => {
  it('should use embeddinggemma-300m as default model', () => {
    const mockAI = createMockAI();
    const embedder = new WorkersAIEmbeddings(mockAI.ai);

    // Access via instance to check
    expect((embedder as any).model).toBe('@cf/google/embeddinggemma-300m');
  });

  it('should set dimensions to 768 for embeddinggemma', () => {
    const mockAI = createMockAI();
    const embedder = new WorkersAIEmbeddings(
      mockAI.ai,
      '@cf/google/embeddinggemma-300m'
    );

    expect(embedder.dimensions).toBe(768);
  });

  it('should set dimensions to 1024 for large model', () => {
    const mockAI = createMockAI();
    const embedder = new WorkersAIEmbeddings(
      mockAI.ai,
      '@cf/openai/text-embedding-large'
    );

    expect(embedder.dimensions).toBe(1024);
  });

  it('should set dimensions to 384 for small model', () => {
    const mockAI = createMockAI();
    const embedder = new WorkersAIEmbeddings(
      mockAI.ai,
      '@cf/openai/text-embedding-small'
    );

    expect(embedder.dimensions).toBe(384);
  });

  it('should default to 768 dimensions for unknown models', () => {
    const mockAI = createMockAI();
    const embedder = new WorkersAIEmbeddings(
      mockAI.ai,
      '@cf/unknown/model'
    );

    expect(embedder.dimensions).toBe(768);
  });

  it('should call AI.run with correct model and format for embed()', async () => {
    const mockAI = createMockAI();
    const embedder = new WorkersAIEmbeddings(mockAI.ai);

    await embedder.embed('test text');

    expect(mockAI.calls).toHaveLength(1);
    expect(mockAI.calls[0]!.model).toBe('@cf/google/embeddinggemma-300m');
    expect(mockAI.calls[0]!.inputs).toEqual({ text: ['test text'] });
  });

  it('should return first embedding vector from AI response', async () => {
    const mockAI = createMockAI();
    const embedder = new WorkersAIEmbeddings(mockAI.ai);

    const result = await embedder.embed('test text');

    expect(result).toHaveLength(768);
    expect(result.every((v) => v === 0.1)).toBe(true);
  });

  it('should handle embedBatch() with multiple texts', async () => {
    const mockAI = createMockAI();
    const embedder = new WorkersAIEmbeddings(mockAI.ai);

    const texts = ['text 1', 'text 2', 'text 3'];
    const result = await embedder.embedBatch(texts);

    expect(mockAI.calls).toHaveLength(1);
    expect(mockAI.calls[0]!.inputs).toEqual({ text: texts });
    expect(result).toHaveLength(3);
    expect(result[0]).toHaveLength(768);
  });
});

// ─────────────────────────────────────────────────────────────
// VectorStore Tests
// ─────────────────────────────────────────────────────────────

describe('VectorStore', () => {
  let mockVectorize: MockVectorize;
  let mockAI: MockAI;
  let embedder: EmbeddingProvider;
  let store: VectorStore;

  beforeEach(() => {
    mockVectorize = createMockVectorize();
    mockAI = createMockAI();
    embedder = new WorkersAIEmbeddings(mockAI.ai);
    store = new VectorStore(mockVectorize.index, {
      tenantId: 'test-tenant',
      embeddingProvider: embedder,
    });
  });

  describe('indexEpisodic', () => {
    it('should generate embedding and upsert with correct metadata', async () => {
      await store.indexEpisodic('ep-123', 'test episode', {
        session_id: 'session-1',
      });

      expect(mockVectorize.calls).toHaveLength(1);
      expect(mockVectorize.calls[0]!.method).toBe('upsert');

      const vectors = mockVectorize.calls[0]!.args as any[];
      expect(vectors).toHaveLength(1);
      expect(vectors[0]).toMatchObject({
        id: 'ep-123',
        values: expect.any(Array),
        metadata: {
          session_id: 'session-1',
          tenant_id: 'test-tenant',
          memory_type: 'episodic',
        },
        namespace: 'test-tenant',
      });
    });

    it('should include tenant_id in metadata', async () => {
      await store.indexEpisodic('ep-123', 'test episode');

      const vectors = mockVectorize.calls[0]!.args as any[];
      expect(vectors[0]!.metadata.tenant_id).toBe('test-tenant');
    });

    it('should set memory_type to episodic', async () => {
      await store.indexEpisodic('ep-123', 'test episode');

      const vectors = mockVectorize.calls[0]!.args as any[];
      expect(vectors[0]!.metadata.memory_type).toBe('episodic');
    });
  });

  describe('indexSemantic', () => {
    it('should use correct metadata with memory_type=semantic', async () => {
      await store.indexSemantic('sem-456', 'test fact', {
        subject: 'TypeScript',
      });

      expect(mockVectorize.calls).toHaveLength(1);

      const vectors = mockVectorize.calls[0]!.args as any[];
      expect(vectors[0]).toMatchObject({
        id: 'sem-456',
        metadata: {
          subject: 'TypeScript',
          tenant_id: 'test-tenant',
          memory_type: 'semantic',
        },
        namespace: 'test-tenant',
      });
    });

    it('should set memory_type to semantic', async () => {
      await store.indexSemantic('sem-456', 'test fact');

      const vectors = mockVectorize.calls[0]!.args as any[];
      expect(vectors[0]!.metadata.memory_type).toBe('semantic');
    });
  });

  describe('indexBatch', () => {
    it('should handle empty array as no-op', async () => {
      await store.indexBatch([]);

      expect(mockVectorize.calls).toHaveLength(0);
      expect(mockAI.calls).toHaveLength(0);
    });

    it('should process multiple items with batch embeddings', async () => {
      const items = [
        {
          id: 'ep-1',
          text: 'episode 1',
          memoryType: 'episodic' as const,
          metadata: { session: 's1' },
        },
        {
          id: 'ep-2',
          text: 'episode 2',
          memoryType: 'episodic' as const,
        },
        {
          id: 'sem-1',
          text: 'fact 1',
          memoryType: 'semantic' as const,
          metadata: { subject: 'TypeScript' },
        },
      ];

      await store.indexBatch(items);

      // Should call embedBatch once with all texts
      expect(mockAI.calls).toHaveLength(1);
      expect(mockAI.calls[0]!.inputs).toEqual({
        text: ['episode 1', 'episode 2', 'fact 1'],
      });

      // Should upsert all vectors
      expect(mockVectorize.calls).toHaveLength(1);
      const vectors = mockVectorize.calls[0]!.args as any[];
      expect(vectors).toHaveLength(3);

      // Check first item
      expect(vectors[0]).toMatchObject({
        id: 'ep-1',
        metadata: {
          session: 's1',
          tenant_id: 'test-tenant',
          memory_type: 'episodic',
        },
        namespace: 'test-tenant',
      });

      // Check third item (semantic)
      expect(vectors[2]).toMatchObject({
        id: 'sem-1',
        metadata: {
          subject: 'TypeScript',
          tenant_id: 'test-tenant',
          memory_type: 'semantic',
        },
      });
    });
  });

  describe('search', () => {
    beforeEach(async () => {
      // Pre-populate with some vectors
      await store.indexEpisodic('ep-1', 'episode 1');
      await store.indexSemantic('sem-1', 'fact 1');
    });

    it('should generate query embedding and use namespace for tenant isolation', async () => {
      await store.search('test query');

      // First call is indexing, second is embedBatch, third is search
      const queryCalls = mockVectorize.calls.filter(
        (c) => c.method === 'query'
      );
      expect(queryCalls).toHaveLength(1);

      const [vector, options] = queryCalls[0]!.args as [number[], any];
      expect(vector).toHaveLength(768);
      expect(options.namespace).toBe('test-tenant');
    });

    it('should return default topK of 10', async () => {
      await store.search('test query');

      const queryCalls = mockVectorize.calls.filter(
        (c) => c.method === 'query'
      );
      const [, options] = queryCalls[0]!.args as [number[], any];
      expect(options.topK).toBe(10);
    });

    it('should respect custom topK option', async () => {
      await store.search('test query', { topK: 5 });

      const queryCalls = mockVectorize.calls.filter(
        (c) => c.method === 'query'
      );
      const [, options] = queryCalls[0]!.args as [number[], any];
      expect(options.topK).toBe(5);
    });

    it('should filter by memoryType when provided', async () => {
      await store.search('test query', { memoryType: 'episodic' });

      const queryCalls = mockVectorize.calls.filter(
        (c) => c.method === 'query'
      );
      const [, options] = queryCalls[0]!.args as [number[], any];
      expect(options.filter).toEqual({ memory_type: 'episodic' });
    });

    it('should not include filter when memoryType is not specified', async () => {
      await store.search('test query');

      const queryCalls = mockVectorize.calls.filter(
        (c) => c.method === 'query'
      );
      const [, options] = queryCalls[0]!.args as [number[], any];
      expect(options.filter).toBeUndefined();
    });

    it('should return results with id, score, memoryType, and metadata', async () => {
      const results = await store.search('test query');

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]).toMatchObject({
        id: expect.any(String),
        score: expect.any(Number),
        memoryType: expect.stringMatching(/^(episodic|semantic)$/),
        metadata: expect.any(Object),
      });
    });
  });

  describe('delete', () => {
    it('should handle empty array as no-op', async () => {
      const result = await store.delete([]);

      expect(result).toBe(0);
      expect(mockVectorize.calls).toHaveLength(0);
    });

    it('should delete vectors by IDs', async () => {
      const ids = ['ep-1', 'ep-2', 'sem-1'];
      const result = await store.delete(ids);

      expect(result).toBe(3);
      expect(mockVectorize.calls).toHaveLength(1);
      expect(mockVectorize.calls[0]!.method).toBe('deleteByIds');
      expect(mockVectorize.calls[0]!.args).toEqual(ids);
    });
  });
});

// ─────────────────────────────────────────────────────────────
// RAGHelper Tests
// ─────────────────────────────────────────────────────────────

describe('RAGHelper', () => {
  let mockVectorize: MockVectorize;
  let mockAI: MockAI;
  let embedder: EmbeddingProvider;
  let store: VectorStore;
  let rag: RAGHelper;

  beforeEach(() => {
    mockVectorize = createMockVectorize();
    mockAI = createMockAI();
    embedder = new WorkersAIEmbeddings(mockAI.ai);
    store = new VectorStore(mockVectorize.index, {
      tenantId: 'test-tenant',
      embeddingProvider: embedder,
    });
    rag = new RAGHelper({
      vectorStore: store,
      ai: mockAI.ai,
    });
  });

  it('should use llama-2 as default model', () => {
    expect((rag as any).model).toBe('@cf/meta/llama-2-7b-chat-int8');
  });

  it('should use custom model when provided', () => {
    const customRAG = new RAGHelper({
      vectorStore: store,
      ai: mockAI.ai,
      model: '@cf/custom/model',
    });

    expect((customRAG as any).model).toBe('@cf/custom/model');
  });

  it('should retrieve context from vector search', async () => {
    // Pre-populate with test data
    await store.indexEpisodic('ep-1', 'test episode', {
      text: 'This is a test episode',
    });

    const result = await rag.answer('test question');

    // Should have called vector search
    const queryCalls = mockVectorize.calls.filter(
      (c) => c.method === 'query'
    );
    expect(queryCalls.length).toBeGreaterThan(0);

    // Should return answer and sources
    expect(result).toMatchObject({
      answer: expect.any(String),
      sources: expect.any(Array),
    });
  });

  it('should use systemPrompt when provided', async () => {
    const customPrompt = 'You are a specialized assistant for testing.';

    await rag.answer('test question', { systemPrompt: customPrompt });

    // Find the AI.run call for text generation (not embeddings)
    const textGenCalls = mockAI.calls.filter(
      (c) => !(c.inputs as any).text
    );
    expect(textGenCalls.length).toBeGreaterThan(0);

    const lastCall = textGenCalls[textGenCalls.length - 1]!;
    const messages = (lastCall.inputs as any).messages;
    expect(messages[0]!.content).toContain(customPrompt);
  });

  it('should build default system prompt with retrieved context', async () => {
    await store.indexEpisodic('ep-1', 'test episode', {
      text: 'Test context',
    });

    await rag.answer('test question');

    const textGenCalls = mockAI.calls.filter(
      (c) => !(c.inputs as any).text
    );
    const lastCall = textGenCalls[textGenCalls.length - 1]!;
    const messages = (lastCall.inputs as any).messages;

    expect(messages[0]!.content).toContain('helpful assistant');
    expect(messages[0]!.content).toContain('Retrieved memories');
  });

  it('should return sources from vector search', async () => {
    await store.indexEpisodic('ep-1', 'episode 1', { text: 'Episode 1' });
    await store.indexSemantic('sem-1', 'fact 1', { text: 'Fact 1' });

    const result = await rag.answer('test question');

    expect(result.sources).toBeArray();
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.sources[0]).toMatchObject({
      id: expect.any(String),
      score: expect.any(Number),
      memoryType: expect.stringMatching(/^(episodic|semantic)$/),
    });
  });

  it('should limit context items to maxContextItems', async () => {
    const customRAG = new RAGHelper({
      vectorStore: store,
      ai: mockAI.ai,
      maxContextItems: 3,
    });

    // Pre-populate with multiple items
    for (let i = 0; i < 10; i++) {
      await store.indexEpisodic(`ep-${i}`, `episode ${i}`);
    }

    await customRAG.answer('test question');

    // Should request only 3 items in search
    const queryCalls = mockVectorize.calls.filter(
      (c) => c.method === 'query'
    );
    const lastQuery = queryCalls[queryCalls.length - 1]!;
    const [, options] = lastQuery.args as [number[], any];
    expect(options.topK).toBe(3);
  });

  it('should pass memoryType filter to vector search', async () => {
    await rag.answer('test question', { memoryType: 'semantic' });

    const queryCalls = mockVectorize.calls.filter(
      (c) => c.method === 'query'
    );
    const lastQuery = queryCalls[queryCalls.length - 1]!;
    const [, options] = lastQuery.args as [number[], any];

    // The search should have been called with memoryType filter
    // (This tests that the RAG correctly passes options through to search)
    expect(options.filter).toEqual({ memory_type: 'semantic' });
  });
});
