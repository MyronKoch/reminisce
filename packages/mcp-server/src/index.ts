#!/usr/bin/env node

/**
 * @reminisce/mcp-server - MCP Server for Reminisce
 *
 * Exposes Reminisce memory operations via the Model Context Protocol.
 *
 * Environment Variables:
 *   REMINISCE_DB_PATH     - Path to SQLite database (enables persistence)
 *   REMINISCE_MACHINE_ID  - Machine identifier (default: 'reminisce-mcp')
 *   REMINISCE_VECTOR      - Enable vector search ('true' to enable)
 *   REMINISCE_DIMENSIONS  - Vector dimensions (default: 768)
 *   REMINISCE_EMBED_URL   - Embedding API URL (default: 'http://localhost:1234', LM Studio)
 *   REMINISCE_EMBED_MODEL - Embedding model (default: 'text-embedding-embeddinggemma-300m')
 *
 * @packageDocumentation
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Reminisce, type ReminisceConfig } from '@reminisce/orchestrator';
import type { SalienceSignals, WorkingMemoryItem, EpisodicMemory, SemanticMemory } from '@reminisce/core';
import type { WorkingMemoryInput } from '@reminisce/working';
import type { EpisodeInput, EpisodicStore } from '@reminisce/episodic';
import type { FactInput, SemanticStore, ContradictionResult } from '@reminisce/semantic';
import {
  SqliteEpisodicStore,
  SqliteSemanticStore,
  initializeVectorSearch,
  isVectorSearchAvailable,
  storeSemanticEmbedding,
  searchSemanticByVector,
} from '@reminisce/storage-sqlite';
import { createAnthropicExtractor } from '@reminisce/consolidation';
import { Database } from 'bun:sqlite';

// Parse configuration from environment
const dbPath = process.env.REMINISCE_DB_PATH;
const machineId = process.env.REMINISCE_MACHINE_ID || process.argv[2] || 'reminisce-mcp';
const enableVector = process.env.REMINISCE_VECTOR === 'true';
const dimensions = parseInt(process.env.REMINISCE_DIMENSIONS || '768', 10);
const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
const embedUrl = process.env.REMINISCE_EMBED_URL || 'http://localhost:1234';
const embedModel = process.env.REMINISCE_EMBED_MODEL || 'text-embedding-embeddinggemma-300m';

// Embed text via LM Studio (OpenAI-compatible API) - returns null on failure (graceful degradation)
async function embedText(text: string): Promise<number[] | null> {
  try {
    const res = await fetch(`${embedUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: embedModel, input: text }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { data: Array<{ embedding: number[] }> };
    return data.data[0]?.embedding ?? null;
  } catch {
    return null;
  }
}

// Create stores - SQLite if path provided, otherwise in-memory
let episodicStore: EpisodicStore | undefined;
let semanticStore: SemanticStore | undefined;
let vectorDb: Database | null = null;

if (dbPath) {
  console.error(`Using SQLite storage: ${dbPath}`);

  // On macOS, try Homebrew SQLite for extension support
  if (process.platform === 'darwin' && enableVector) {
    try {
      Database.setCustomSQLite('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib');
    } catch {
      try {
        Database.setCustomSQLite('/usr/local/opt/sqlite3/lib/libsqlite3.dylib');
      } catch {
        // Fall through to system SQLite
      }
    }
  }

  episodicStore = new SqliteEpisodicStore(dbPath, { machineId });
  semanticStore = new SqliteSemanticStore(dbPath, { machineId, sessionId: 'mcp-session' });

  // Initialize vector search if enabled - keep DB handle open for runtime use
  if (enableVector) {
    try {
      const db = new Database(dbPath);
      initializeVectorSearch(db, { dimensions });
      if (isVectorSearchAvailable(db)) {
        vectorDb = db;
        console.error(`Vector search enabled (${dimensions} dimensions, model: ${embedModel})`);
      } else {
        db.close();
      }
    } catch (e) {
      console.error('Vector search not available:', e);
    }
  }
} else {
  console.error('Using in-memory storage (set REMINISCE_DB_PATH for persistence)');
}

// Create Reminisce instance with conditional store configuration
// Using exactOptionalPropertyTypes, we can't assign undefined to optional properties
const reminisceConfig: ReminisceConfig = {
  machineId,
  autoConsolidate: true,
  consolidation: {
    minAgeHours: 0, // For MCP, allow immediate consolidation
    minSalience: 0.2,
    batchSize: 20,
  },
};

if (episodicStore) {
  reminisceConfig.episodicStore = episodicStore;
}
if (semanticStore) {
  reminisceConfig.semanticStore = semanticStore;
}
if (anthropicApiKey) {
  reminisceConfig.factExtractor = createAnthropicExtractor(anthropicApiKey, {
    model: 'claude-haiku-4-20250414',
  });
  console.error('LLM consolidation enabled (Anthropic)');
}

const reminisce = new Reminisce(reminisceConfig);

// Auto-start a session
reminisce.startSession();

// Create the MCP server
const server = new McpServer({
  name: 'reminisce-mcp-server',
  version: '0.1.0',
});

// ─────────────────────────────────────────────────────────────
// Tools
// ─────────────────────────────────────────────────────────────

// Tool: remember - Add to working memory
server.tool(
  'remember',
  'Add an item to working memory. Items overflow to episodic memory when capacity (7) is exceeded.',
  {
    type: z.enum(['message', 'tool_result', 'context', 'goal']).describe('Type of memory item'),
    data: z.unknown().describe('The data to remember'),
    summary: z.string().optional().describe('Brief summary of the item'),
    tags: z.array(z.string()).optional().describe('Tags for categorization'),
    importance: z.enum(['low', 'normal', 'high', 'critical']).optional().describe(
      'Importance preset: low (evict first), normal (default), high (reward+goal boost), critical (max signals + auto-pin)'
    ),
    signals: z
      .object({
        reward_signal: z.number().min(0).max(1).optional(),
        error_signal: z.number().min(0).max(1).optional(),
        novelty_score: z.number().min(0).max(1).optional(),
        emotional_intensity: z.number().min(0).max(1).optional(),
        goal_relevance: z.number().min(0).max(1).optional(),
      })
      .optional()
      .describe('Salience signals (0-1 each). Overrides importance preset if both provided.'),
  },
  async ({ type, data, summary, tags, importance, signals }) => {
    try {
      // Build input object, only adding defined optional properties
      const input: WorkingMemoryInput = {
        type,
        data,
      };
      if (summary !== undefined) input.summary = summary;
      if (tags !== undefined) input.tags = tags;

      // Apply importance presets (signals override if both provided)
      if (signals !== undefined) {
        const sigs: Partial<SalienceSignals> = {};
        if (signals.reward_signal !== undefined) sigs.reward_signal = signals.reward_signal;
        if (signals.error_signal !== undefined) sigs.error_signal = signals.error_signal;
        if (signals.novelty_score !== undefined) sigs.novelty_score = signals.novelty_score;
        if (signals.emotional_intensity !== undefined) sigs.emotional_intensity = signals.emotional_intensity;
        if (signals.goal_relevance !== undefined) sigs.goal_relevance = signals.goal_relevance;
        input.signals = sigs;
      } else if (importance !== undefined && importance !== 'normal') {
        const presets: Record<string, Partial<SalienceSignals>> = {
          low: { reward_signal: 0, goal_relevance: 0 },
          high: { reward_signal: 0.7, goal_relevance: 0.8 },
          critical: { reward_signal: 1.0, goal_relevance: 1.0, error_signal: 0.8 },
        };
        const preset = presets[importance];
        if (preset) input.signals = preset;
      }

      const item = await reminisce.remember(input);

      // Auto-pin critical items
      if (importance === 'critical') {
        reminisce.pin(item.memory_id.id);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              id: item.memory_id.id,
              layer: item.memory_id.layer,
              salience: item.salience.current_score,
              slot: item.slot,
            }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }],
      };
    }
  }
);

// Tool: search - Search across all memory layers
server.tool(
  'search',
  'Search across working, episodic, and semantic memory layers.',
  {
    text: z.string().optional().describe('Text to search for'),
    tags: z.array(z.string()).optional().describe('Filter by tags'),
    sessionId: z.string().optional().describe('Filter by session ID'),
    limit: z.number().optional().default(10).describe('Max results per layer'),
  },
  async ({ text, tags, sessionId, limit }) => {
    try {
      // Build query object conditionally
      const query: { text?: string; tags?: string[]; sessionId?: string; limit?: number } = {};
      if (text !== undefined) query.text = text;
      if (tags !== undefined) query.tags = tags;
      if (sessionId !== undefined) query.sessionId = sessionId;
      if (limit !== undefined) query.limit = limit;

      const results = await reminisce.search(query);

      // Augment semantic results with vector search when available
      if (text && enableVector && vectorDb) {
        const queryEmbedding = await embedText(text);
        if (queryEmbedding) {
          const vectorHits = searchSemanticByVector(vectorDb, queryEmbedding, limit ?? 10);
          // Collect IDs already in LIKE results
          const existingIds = new Set(results.semantic.map((s: SemanticMemory) => s.memory_id.id));
          // Hydrate vector-found facts not already in LIKE results
          const missingIds = vectorHits
            .map(h => h.memory_id)
            .filter(id => !existingIds.has(id));
          if (missingIds.length > 0) {
            // Query the DB directly to hydrate vector-found facts
            for (const id of missingIds) {
              const row = vectorDb.prepare<
                { id: string; fact: string; subject: string | null; predicate: string | null; object: string | null; category: string | null; salience_json: string; provenance_json: string },
                [string]
              >('SELECT id, fact, subject, predicate, object, category, salience_json, provenance_json FROM semantic_memories WHERE id = ?').get(id);
              if (row) {
                const salience = JSON.parse(row.salience_json);
                const provenance = JSON.parse(row.provenance_json);
                if (!provenance.retracted) {
                  // Build a minimal SemanticMemory-compatible object for output mapping
                  results.semantic.push({
                    memory_id: { id: row.id, layer: 'semantic' },
                    content: {
                      fact: row.fact,
                      subject: row.subject ?? undefined,
                      predicate: row.predicate ?? undefined,
                      object: row.object ?? undefined,
                      category: row.category ?? undefined,
                    },
                    salience: { current_score: salience.current_score ?? 0.125, ...salience },
                    provenance: { confidence: provenance.confidence ?? 0.9, retracted: false, ...provenance },
                    tags: [],
                  } as unknown as SemanticMemory);
                }
              }
            }
          }
        }
      }

      const totalResults = results.working.length + results.episodic.length + results.semantic.length;

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              total: totalResults,
              working: results.working.map((w: WorkingMemoryItem) => ({
                id: w.memory_id.id,
                layer: 'working',
                type: w.content.type,
                summary: w.content.summary,
                salience: w.salience.current_score,
                pinned: !!w.salience.signals.user_pinned,
              })),
              episodic: results.episodic.map((e: EpisodicMemory) => ({
                id: e.memory_id.id,
                layer: 'episodic',
                event: e.content.event,
                summary: e.content.summary,
                salience: e.salience.current_score,
                timestamp: e.started_at,
                sessionId: e.session_id,
                consolidated: e.consolidated,
              })),
              semantic: results.semantic.map((s: SemanticMemory) => ({
                id: s.memory_id.id,
                layer: 'semantic',
                fact: s.content.fact,
                subject: s.content.subject,
                predicate: s.content.predicate,
                object: s.content.object,
                category: s.content.category,
                salience: s.salience.current_score,
                confidence: s.provenance.confidence,
                retracted: s.provenance.retracted ?? false,
              })),
            }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }],
      };
    }
  }
);

// Tool: store_fact - Store a fact directly
server.tool(
  'store_fact',
  'Store a fact directly in semantic memory, bypassing episodic storage and consolidation.',
  {
    fact: z.string().describe('The fact to store'),
    subject: z.string().optional().describe('Subject of the fact (for SPO triple)'),
    predicate: z.string().optional().describe('Predicate/relationship'),
    object: z.string().optional().describe('Object of the fact'),
    category: z.string().optional().describe('Category for organization'),
    confidence: z.number().min(0).max(1).optional().default(0.9).describe('Confidence level'),
    tags: z.array(z.string()).optional().describe('Tags for categorization'),
  },
  async ({ fact, subject, predicate, object, category, confidence, tags }) => {
    try {
      // Build input conditionally
      const input: FactInput = {
        fact,
        sourceEpisodeIds: [],
        confidence,
      };
      if (subject !== undefined) input.subject = subject;
      if (predicate !== undefined) input.predicate = predicate;
      if (object !== undefined) input.object = object;
      if (category !== undefined) input.category = category;
      if (tags !== undefined) input.tags = tags;

      // Check for contradictions before storing
      const contradiction = await reminisce.checkContradiction(input);

      // Wire contradiction IDs into provenance so the data model tracks them
      if (contradiction.hasContradiction && contradiction.conflicts.length > 0) {
        input.contradictionIds = contradiction.conflicts.map(c => c.memory_id);
      }

      const stored = await reminisce.storeFact(input);

      // Auto-embed for vector search
      let vectorIndexed = false;
      if (enableVector && vectorDb) {
        const factText = [input.subject, input.predicate, input.object, input.fact]
          .filter(Boolean).join(' ');
        const embedding = await embedText(factText);
        if (embedding) {
          storeSemanticEmbedding(vectorDb, stored.memory_id.id, embedding);
          vectorIndexed = true;
        }
      }

      const result: Record<string, unknown> = {
        success: true,
        id: stored.memory_id.id,
        fact: stored.content.fact,
        confidence: stored.provenance.confidence,
        vectorIndexed,
      };

      if (contradiction.hasContradiction) {
        result.contradiction = {
          detected: true,
          suggestion: contradiction.suggestion,
          conflicts: contradiction.conflicts.map(c => ({
            id: c.memory_id.id,
            fact: c.content.fact,
            confidence: c.provenance.confidence,
          })),
        };
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }],
      };
    }
  }
);

// Tool: forget_session - GDPR deletion
server.tool(
  'forget_session',
  'Delete all memories associated with a session ID. Use for GDPR compliance or user data removal.',
  {
    sessionId: z.string().describe('Session ID to forget'),
  },
  async ({ sessionId }) => {
    try {
      const result = await reminisce.forgetSession(sessionId);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              episodesDeleted: result.episodesDeleted,
              factsDeleted: result.factsDeleted,
            }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }],
      };
    }
  }
);

// Tool: consolidate - Manual consolidation
server.tool(
  'consolidate',
  'Manually trigger consolidation of episodic memories into semantic facts.',
  {},
  async () => {
    try {
      const result = await reminisce.consolidate();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              episodesProcessed: result.episodesProcessed,
              factsExtracted: result.factsExtracted,
              factsStored: result.factsStored,
              contradictions: result.contradictions.length,
              errors: result.errors.length,
              durationMs: result.durationMs,
            }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }],
      };
    }
  }
);

// Tool: get_stats - System statistics
server.tool(
  'get_stats',
  'Get current system statistics including memory usage across all layers.',
  {},
  async () => {
    try {
      const stats = await reminisce.getStats();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              sessions: stats.sessions,
              workingMemory: {
                size: stats.workingMemorySize,
                capacity: stats.workingMemoryCapacity,
                utilizationPercent: Math.round(
                  (stats.workingMemorySize / stats.workingMemoryCapacity) * 100
                ),
              },
              episodic: {
                pending: stats.pendingEpisodes,
                consolidated: stats.consolidatedEpisodes,
              },
              semantic: {
                total: stats.totalFacts,
                lowConfidence: stats.lowConfidenceFacts,
              },
            }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }],
      };
    }
  }
);

// Tool: record_episode - Record episode directly
server.tool(
  'record_episode',
  'Record an episode directly to episodic memory, bypassing working memory.',
  {
    event: z.string().describe('Event type/name'),
    summary: z.string().describe('Summary of what happened'),
    entities: z.array(z.string()).optional().describe('Entities involved'),
    tags: z.array(z.string()).optional().describe('Tags for categorization'),
    valence: z.number().min(-1).max(1).optional().describe('Emotional valence (-1 to 1)'),
  },
  async ({ event, summary, entities, tags, valence }) => {
    try {
      // Build input conditionally - sessionId comes from current session
      const session = reminisce.getSession();
      const input: EpisodeInput = {
        event,
        summary,
        sessionId: session?.id ?? 'direct',
      };
      if (entities !== undefined) input.entities = entities;
      if (tags !== undefined) input.tags = tags;
      if (valence !== undefined) input.valence = valence;

      const episode = await reminisce.recordEpisode(input);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              id: episode.memory_id.id,
              event: episode.content.event,
              timestamp: episode.started_at,
            }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }],
      };
    }
  }
);

// Tool: get_facts - Get facts about a subject
server.tool(
  'get_facts',
  'Get all known facts about a specific subject.',
  {
    subject: z.string().describe('Subject to get facts about'),
  },
  async ({ subject }) => {
    try {
      const facts = await reminisce.getFactsAbout(subject);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              subject,
              factCount: facts.length,
              facts: facts.map((f: SemanticMemory) => ({
                id: f.memory_id.id,
                fact: f.content.fact,
                predicate: f.content.predicate,
                object: f.content.object,
                confidence: f.provenance.confidence,
                retracted: f.provenance.retracted,
              })),
            }),
          },
        ],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }],
      };
    }
  }
);

// Tool: pin_memory - Pin a working memory item
server.tool(
  'pin_memory',
  'Pin a working memory item to prevent eviction. Pinned items stay in working memory regardless of capacity.',
  {
    id: z.string().describe('Memory ID to pin'),
  },
  async ({ id }) => {
    try {
      reminisce.pin(id);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, id, pinned: true }) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }],
      };
    }
  }
);

// Tool: block_memory - Block/forget a memory
server.tool(
  'block_memory',
  'Block a memory, marking it for forgetting. Working memory items are removed, episodic are deleted, semantic are retracted.',
  {
    id: z.string().describe('Memory ID to block'),
    layer: z.enum(['working', 'episodic', 'semantic']).describe('Which memory layer the item is in'),
  },
  async ({ id, layer }) => {
    try {
      await reminisce.block(id, layer);
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, id, layer, blocked: true }) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }],
      };
    }
  }
);

// Tool: rate_memory - Adjust salience of a memory
server.tool(
  'rate_memory',
  'Adjust the salience (importance) of a memory. Positive values boost it, negative values penalize it.',
  {
    id: z.string().describe('Memory ID to rate'),
    layer: z.enum(['episodic', 'semantic']).describe('Which memory layer the item is in'),
    adjustment: z.number().min(-1).max(1).describe('Salience adjustment (-1.0 to 1.0)'),
  },
  async ({ id, layer, adjustment }) => {
    try {
      const success = await reminisce.rateSalience(id, layer, adjustment);
      if (!success) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Memory ${id} not found in ${layer}` }) }],
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify({ success: true, id, layer, adjustment }) }],
      };
    } catch (error) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: String(error) }) }],
      };
    }
  }
);

// ─────────────────────────────────────────────────────────────
// Resources
// ─────────────────────────────────────────────────────────────

// Resource: Current working memory
server.resource(
  'reminisce://working/current',
  'Current working memory contents',
  async () => {
    const session = reminisce.getSession();
    if (!session) {
      return {
        contents: [
          {
            uri: 'reminisce://working/current',
            text: JSON.stringify({ error: 'No active session' }),
            mimeType: 'application/json',
          },
        ],
      };
    }

    const items = session.working.getAll();
    return {
      contents: [
        {
          uri: 'reminisce://working/current',
          text: JSON.stringify({
            sessionId: session.id,
            capacity: 7,
            size: items.length,
            items: items.map((item: WorkingMemoryItem) => ({
              id: item.memory_id.id,
              type: item.content.type,
              summary: item.content.summary,
              salience: item.salience.current_score,
              slot: item.slot,
              pinned: item.salience.signals.user_pinned,
            })),
          }),
          mimeType: 'application/json',
        },
      ],
    };
  }
);

// Resource: Recent episodes
server.resource(
  'reminisce://episodes/recent',
  'Recent episodic memories (last 20)',
  async () => {
    const episodes = await reminisce.getRecentEpisodes(20);
    return {
      contents: [
        {
          uri: 'reminisce://episodes/recent',
          text: JSON.stringify({
            count: episodes.length,
            episodes: episodes.map((ep: EpisodicMemory) => ({
              id: ep.memory_id.id,
              event: ep.content.event,
              summary: ep.content.summary,
              entities: ep.content.entities,
              timestamp: ep.started_at,
              sessionId: ep.session_id,
              consolidated: ep.consolidated,
              salience: ep.salience.current_score,
            })),
          }),
          mimeType: 'application/json',
        },
      ],
    };
  }
);

// Resource template: Facts about a subject
server.resource(
  'reminisce://facts/{subject}',
  'Facts about a specific subject',
  async (uri) => {
    // Extract subject from URI
    const match = uri.href.match(/reminisce:\/\/facts\/(.+)/);
    const subject = match?.[1] ? decodeURIComponent(match[1]) : '';

    if (!subject) {
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify({ error: 'No subject provided' }),
            mimeType: 'application/json',
          },
        ],
      };
    }

    const facts = await reminisce.getFactsAbout(subject);
    return {
      contents: [
        {
          uri: uri.href,
          text: JSON.stringify({
            subject,
            factCount: facts.length,
            facts: facts
              .filter((f: SemanticMemory) => !f.provenance.retracted)
              .map((f: SemanticMemory) => ({
                id: f.memory_id.id,
                fact: f.content.fact,
                predicate: f.content.predicate,
                object: f.content.object,
                category: f.content.category,
                confidence: f.provenance.confidence,
              })),
          }),
          mimeType: 'application/json',
        },
      ],
    };
  }
);

// ─────────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────────

// Graceful shutdown
process.on('SIGINT', async () => {
  await reminisce.endSession();
  vectorDb?.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await reminisce.endSession();
  vectorDb?.close();
  process.exit(0);
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`reminisce-mcp-server running (machineId: ${machineId})`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

// Export for programmatic use
export { reminisce, server };
