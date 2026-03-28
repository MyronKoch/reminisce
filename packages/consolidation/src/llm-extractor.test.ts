import { describe, it, expect, mock, beforeEach } from 'bun:test';
import type { EpisodicMemory } from '@reminisce/core';
import {
  LLMFactExtractor,
  type LLMProvider,
  OpenAIProvider,
  AnthropicProvider,
  createOpenAIExtractor,
  createAnthropicExtractor,
} from './llm-extractor.js';

// Mock fetch globally
const mockFetch = mock(() => Promise.resolve(new Response()));
global.fetch = mockFetch as unknown as typeof fetch;

// Helper to create mock episodic memories
function createMockEpisode(overrides: Partial<EpisodicMemory['content']> = {}): EpisodicMemory {
  return {
    memory_id: {
      id: crypto.randomUUID(),
      layer: 'episodic',
      created_at: new Date(),
      source_session: 'test-session',
      source_machine: 'test-machine',
    },
    provenance: {
      source_ids: [],
      derivation_type: 'direct',
      confidence: 1,
      last_validated: new Date(),
      contradiction_ids: [],
      retracted: false,
    },
    salience: {
      current_score: 0.7,
      signals: {},
      decay_rate: 0.1,
      last_accessed: new Date(),
      access_count: 1,
    },
    content: {
      event: 'test-event',
      summary: 'User discussed their preference for TypeScript',
      entities: ['user', 'TypeScript'],
      valence: 0.5,
      ...overrides,
    },
    started_at: new Date(),
    session_id: 'test-session',
    consolidated: false,
    tags: [],
  };
}

// Mock LLM provider for testing
class MockLLMProvider implements LLMProvider {
  private response: string;

  constructor(response: string) {
    this.response = response;
  }

  async complete(): Promise<string> {
    return this.response;
  }
}

describe('LLMFactExtractor', () => {
  describe('extract', () => {
    it('should extract facts from episodes using LLM', async () => {
      const mockResponse = JSON.stringify([
        {
          fact: 'User prefers TypeScript over JavaScript',
          subject: 'user',
          predicate: 'prefers',
          object: 'TypeScript',
          category: 'preference',
          confidence: 0.9,
        },
      ]);

      const extractor = new LLMFactExtractor({
        provider: new MockLLMProvider(mockResponse),
      });

      const episodes = [createMockEpisode()];
      const result = await extractor.extract(episodes);

      expect(result.facts).toHaveLength(1);
      expect(result.facts[0]!.fact).toBe('User prefers TypeScript over JavaScript');
      expect(result.facts[0]!.subject).toBe('user');
      expect(result.facts[0]!.confidence).toBe(0.9);
      expect(result.sourceEpisodes).toEqual(episodes);
    });

    it('should filter facts below minimum confidence', async () => {
      const mockResponse = JSON.stringify([
        { fact: 'High confidence fact', confidence: 0.9 },
        { fact: 'Low confidence fact', confidence: 0.3 },
      ]);

      const extractor = new LLMFactExtractor({
        provider: new MockLLMProvider(mockResponse),
        minConfidence: 0.5,
      });

      const result = await extractor.extract([createMockEpisode()]);

      expect(result.facts).toHaveLength(1);
      expect(result.facts[0]!.fact).toBe('High confidence fact');
    });

    it('should handle batching for many episodes', async () => {
      const completeCalls: string[] = [];
      const provider: LLMProvider = {
        async complete(prompt) {
          completeCalls.push(prompt);
          return JSON.stringify([{ fact: 'Batch fact', confidence: 0.8 }]);
        },
      };

      const extractor = new LLMFactExtractor({
        provider,
        batchSize: 2,
      });

      // 5 episodes should result in 3 batches (2, 2, 1)
      const episodes = Array(5).fill(null).map(() => createMockEpisode());
      const result = await extractor.extract(episodes);

      expect(completeCalls).toHaveLength(3);
      expect(result.facts).toHaveLength(3); // One fact per batch
    });

    it('should handle LLM errors gracefully with fallback', async () => {
      const provider: LLMProvider = {
        async complete() {
          throw new Error('LLM service unavailable');
        },
      };

      const extractor = new LLMFactExtractor({
        provider,
        minConfidence: 0.3,
      });

      const episodes = [createMockEpisode({ summary: 'Fallback summary' })];
      const result = await extractor.extract(episodes);

      // Should use fallback extraction
      expect(result.facts).toHaveLength(1);
      expect(result.facts[0]!.fact).toBe('Fallback summary');
      expect(result.facts[0]!.category).toBe('extracted');
    });

    it('should handle malformed LLM responses', async () => {
      const extractor = new LLMFactExtractor({
        provider: new MockLLMProvider('This is not JSON at all'),
        minConfidence: 0.3,
      });

      const result = await extractor.extract([createMockEpisode()]);

      // Should return empty array for unparseable response
      expect(result.facts).toHaveLength(0);
    });

    it('should extract JSON from response with surrounding text', async () => {
      const responseWithText = `
        Based on the episodes, I extracted the following facts:
        [{"fact": "User likes coding", "confidence": 0.8}]
        These are the main insights.
      `;

      const extractor = new LLMFactExtractor({
        provider: new MockLLMProvider(responseWithText),
      });

      const result = await extractor.extract([createMockEpisode()]);

      expect(result.facts).toHaveLength(1);
      expect(result.facts[0]!.fact).toBe('User likes coding');
    });

    it('should validate fact fields and skip invalid entries', async () => {
      const mockResponse = JSON.stringify([
        { fact: 'Valid fact', confidence: 0.8 },
        { fact: '', confidence: 0.8 }, // Empty fact - invalid
        { fact: null, confidence: 0.8 }, // Null fact - invalid
        { confidence: 0.8 }, // Missing fact - invalid
        { fact: 'Another valid', subject: 123 }, // Invalid subject type - should still work
      ]);

      const extractor = new LLMFactExtractor({
        provider: new MockLLMProvider(mockResponse),
      });

      const result = await extractor.extract([createMockEpisode()]);

      expect(result.facts).toHaveLength(2);
      expect(result.facts[0]!.fact).toBe('Valid fact');
      expect(result.facts[1]!.fact).toBe('Another valid');
    });

    it('should clamp confidence values to 0-1 range', async () => {
      const mockResponse = JSON.stringify([
        { fact: 'High confidence', confidence: 1.5 },
        { fact: 'Negative confidence', confidence: -0.5 },
      ]);

      const extractor = new LLMFactExtractor({
        provider: new MockLLMProvider(mockResponse),
        minConfidence: 0, // Disable filter to test clamping
      });

      const result = await extractor.extract([createMockEpisode()]);

      expect(result.facts[0]!.confidence).toBe(1);
      expect(result.facts[1]!.confidence).toBe(0);
    });

    it('should default confidence to 0.7 when missing', async () => {
      const mockResponse = JSON.stringify([
        { fact: 'No confidence specified' },
      ]);

      const extractor = new LLMFactExtractor({
        provider: new MockLLMProvider(mockResponse),
      });

      const result = await extractor.extract([createMockEpisode()]);

      expect(result.facts[0]!.confidence).toBe(0.7);
    });
  });
});

describe('OpenAIProvider', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(() => Promise.resolve(new Response()));
  });

  it('should call OpenAI API with correct parameters', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'Test response' } }],
      }),
    });

    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      model: 'gpt-4o',
    });

    const result = await provider.complete('Test prompt', { temperature: 0.5 });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer test-key',
        },
      })
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe('gpt-4o');
    expect(body.temperature).toBe(0.5);
    expect(result).toBe('Test response');
  });

  it('should throw on API error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
    });

    const provider = new OpenAIProvider({ apiKey: 'test-key' });

    await expect(provider.complete('Test')).rejects.toThrow('OpenAI API error: 429');
  });
});

describe('AnthropicProvider', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(() => Promise.resolve(new Response()));
  });

  it('should call Anthropic API with correct parameters', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: 'Test response' }],
      }),
    });

    const provider = new AnthropicProvider({
      apiKey: 'test-key',
      model: 'claude-3-sonnet-20240229',
    });

    const result = await provider.complete('Test prompt');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-api-key': 'test-key',
          'anthropic-version': '2023-06-01',
        }),
      })
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.model).toBe('claude-3-sonnet-20240229');
    expect(result).toBe('Test response');
  });
});

describe('Factory functions', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(() => Promise.resolve(new Response()));
  });

  it('createOpenAIExtractor should create extractor with OpenAI provider', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '[]' } }],
      }),
    });

    const extractor = createOpenAIExtractor('test-key', { model: 'gpt-4o' });
    await extractor.extract([createMockEpisode()]);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/chat/completions',
      expect.anything()
    );
  });

  it('createAnthropicExtractor should create extractor with Anthropic provider', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: 'text', text: '[]' }],
      }),
    });

    const extractor = createAnthropicExtractor('test-key', { model: 'claude-3-haiku-20240307' });
    await extractor.extract([createMockEpisode()]);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/messages',
      expect.anything()
    );
  });
});
