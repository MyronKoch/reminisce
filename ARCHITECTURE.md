# Reminisce (Reminisce) - Architecture

> A cognitive science-inspired memory architecture for AI systems.

This document describes the architecture of Reminisce, including what's currently implemented (MVP) and the design vision for future development.

The design draws on neuroscience research into human memory systems including working memory capacity limits, hippocampal episodic encoding, and neocortical semantic consolidation.

---

## Table of Contents

1. [Overview](#overview)
2. [Core Principles](#core-principles)
3. [Package Structure](#package-structure)
4. [Type System](#type-system)
5. [Memory Layers](#memory-layers)
6. [Consolidation Pipeline](#consolidation-pipeline)
7. [Usage Examples](#usage-examples)
8. [Future Work](#future-work)

---

## Overview

Reminisce implements a Reminisce architecture inspired by human cognitive systems:

```
┌─────────────────────────────────────────────────────────────────┐
│                       ORCHESTRATOR                               │
│                      @reminisce/orchestrator                          │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  Session Management │ Query Router │ Memory Lifecycle     │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
              │                │                │
              ▼                ▼                ▼
     ┌─────────────┐  ┌─────────────┐  ┌─────────────┐
     │   WORKING   │  │  EPISODIC   │  │  SEMANTIC   │
     │   MEMORY    │  │   MEMORY    │  │   MEMORY    │
     │             │  │             │  │             │
     │ • 7 items   │  │ • Events    │  │ • Facts     │
     │ • Session   │  │ • Timeline  │  │ • Entities  │
     │ • Volatile  │  │ • Salience  │  │ • Relations │
     │             │  │             │  │             │
     │ @reminisce/      │  │ @reminisce/      │  │ @reminisce/      │
     │ working     │  │ episodic    │  │ semantic    │
     └─────────────┘  └─────────────┘  └─────────────┘
              │                │                ▲
              │    overflow    │                │
              └───────────────►│    consolidate │
                               └────────────────┘
                                      │
                          ┌───────────┴───────────┐
                          │    CONSOLIDATION      │
                          │  @reminisce/consolidation  │
                          │                       │
                          │ • Fact extraction     │
                          │ • Contradiction check │
                          │ • Salience filtering  │
                          └───────────────────────┘
```

### Design Philosophy

Human memory isn't monolithic - it's specialized systems working together:

| Human System | Reminisce Package | Function |
|--------------|--------------|----------|
| Prefrontal Cortex | `@reminisce/orchestrator` | Coordination, attention, routing |
| Working Memory | `@reminisce/working` | Active context (7±2 items) |
| Hippocampus | `@reminisce/episodic` | Events, timeline, context |
| Neocortex | `@reminisce/semantic` | Facts, knowledge, relationships |
| Sleep/Replay | `@reminisce/consolidation` | Transfer episodic → semantic |

---

## Core Principles

### 1. Every Memory Has Provenance

No orphan facts. Every piece of knowledge traces back to its source.

```typescript
interface Provenance {
  source_ids: MemoryID[];           // Parent memories
  derivation_type: DerivationType;  // How it was created
  confidence: number;               // 0-1, decays over time
  last_validated: Date;             // Last access/validation
  contradiction_ids: MemoryID[];    // Conflicting memories
  retracted: boolean;               // Soft delete
  retracted_reason?: string;
  superseded_by?: MemoryID;         // Replaced by newer fact
}

type DerivationType =
  | 'direct'         // User explicitly stated
  | 'consolidated'   // Extracted from episodes
  | 'inferred'       // LLM inference
  | 'user_declared'; // User correction
```

**State transitions** are explicit via `applyProvenanceAction()`:
- `validate` - Boost confidence on access
- `decay` - Reduce confidence over time
- `add_contradiction` / `resolve_contradiction`
- `retract` - Soft delete with reason
- `supersede` - Replace with newer fact
- `reinstate` - Un-retract

### 2. Salience is Scored at Capture

Not everything deserves to be remembered. Score importance immediately.

```typescript
interface SalienceSignals {
  reward_signal: number;       // 0-1: Positive outcome followed
  error_signal: number;        // 0-1: Correction/failure followed
  novelty_score: number;       // 0-1: Different from existing
  emotional_intensity: number; // 0-1: Strong reaction
  goal_relevance: number;      // 0-1: Relevant to objectives
  access_count: number;        // Retrieval reinforcement
  last_accessed: Date;
  user_pinned: boolean;        // Explicit importance
  user_blocked: boolean;       // Explicit forget
}
```

**Salience computation** uses weighted combination:

```typescript
const DEFAULT_WEIGHTS = {
  reward: 0.25,
  error: 0.20,      // Errors are memorable
  novelty: 0.15,
  emotion: 0.15,
  access: 0.10,
  goal: 0.10,
  user_pin: 0.05,
};

function computeSalience(signals, weights): { score, instrumentation } {
  if (signals.user_blocked) return { score: -1, ... };

  let score = 0;
  score += signals.reward_signal * weights.reward;
  score += signals.error_signal * weights.error;
  score += signals.novelty_score * weights.novelty;
  // ... etc

  if (signals.user_pinned) score += 0.3;  // Significant boost

  return { score: clamp(score, 0, 1), instrumentation };
}
```

**Instrumentation** tracks per-signal contributions for tuning weights via feedback.

### 3. Working Memory Has Hard Limits

Like human working memory (~7 items), the buffer is intentionally constrained.

```typescript
const buffer = new WorkingMemoryBuffer({
  capacity: 7,  // Default, configurable
  onOverflow: async (items) => {
    // Automatically send to episodic store
    await episodicStore.receiveOverflow(items);
  }
});
```

When capacity is exceeded, the **lowest-salience unpinned item** overflows to episodic memory. Pinned items resist overflow.

### 4. Consolidation is Importance-Driven

Episodic → Semantic transfer happens based on salience, not arbitrary timers.

```typescript
interface ConsolidationConfig {
  minAgeHours: number;    // Don't consolidate too fresh
  minSalience: number;    // Threshold for extraction
  batchSize: number;      // Items per run
}

// Only high-salience episodes become semantic facts
const candidates = await episodicStore.getConsolidationCandidates({
  minAge: config.minAgeHours,
  minSalience: config.minSalience,
});
```

---

## Package Structure

```
packages/
├── core/           # Shared types, salience computation, eval harness
├── working/        # Session buffer with overflow
├── episodic/       # Timeline storage, receives overflow
├── semantic/       # Facts with contradictions, retraction
├── consolidation/  # Episodic → Semantic extraction
├── orchestrator/   # Unified interface to all layers
├── storage-sqlite/ # SQLite persistent storage + sqlite-vec vector search
└── mcp-server/     # MCP protocol server (vector-augmented search)
```

### @reminisce/core

Foundation types and utilities:

- **MemoryID**: Cross-layer identifier with UUID v7 (time-sortable)
- **Provenance**: Source tracking, confidence, retraction
- **Salience**: Signals, weights, computation with instrumentation
- **Memory types**: WorkingMemoryItem, EpisodicMemory, SemanticMemory

```typescript
import {
  createMemoryID,
  createProvenance,
  computeSalience,
  type WorkingMemoryItem,
  type EpisodicMemory,
  type SemanticMemory,
} from '@reminisce/core';
```

### @reminisce/working

In-memory session buffer:

```typescript
import { WorkingMemoryBuffer } from '@reminisce/working';

const buffer = new WorkingMemoryBuffer({
  sessionId: 'session-123',
  machineId: 'agent-1',
  capacity: 7,
  onOverflow: async (items) => { /* handle overflow */ }
});

// Add items (auto-computes salience)
const { item, overflowed } = await buffer.add({
  type: 'message',
  data: { text: 'User said hello' },
  summary: 'Greeting',
  signals: { reward_signal: 0.1 }
});

// Pin important items
buffer.pin(item.memory_id.id);

// Retrieve (reinforces salience)
const retrieved = buffer.get(item.memory_id.id);

// Filter by type or tag
const messages = buffer.getByType('message');
const important = buffer.getByTag('important');
```

### @reminisce/episodic

Timeline storage for events:

```typescript
import { InMemoryEpisodicStore } from '@reminisce/episodic';

const store = new InMemoryEpisodicStore({ machineId: 'agent-1' });

// Store episode
const episode = await store.store({
  event: 'user_request',
  summary: 'User asked about TypeScript',
  sessionId: 'session-123',
  entities: ['TypeScript', 'User'],
  tags: ['question', 'programming'],
});

// Receive overflow from working memory
await store.receiveOverflow(workingMemoryItems);

// Query by various criteria
const recent = await store.query({ limit: 10 });
const bySession = await store.query({ sessionId: 'session-123' });
const byEntity = await store.query({ entities: ['TypeScript'] });
const byTime = await store.query({
  startTime: new Date('2024-01-01'),
  endTime: new Date('2024-12-31'),
});

// Get consolidation candidates
const candidates = await store.getConsolidationCandidates({
  minAge: 1,        // At least 1 hour old
  minSalience: 0.3, // Salience threshold
  limit: 10,
});

// Mark as consolidated
await store.markConsolidated(episode.memory_id.id, [factId1, factId2]);

// GDPR: Delete by session
const deleted = await store.deleteBySession('user-123');
```

### @reminisce/semantic

Facts and knowledge storage:

```typescript
import { InMemorySemanticStore } from '@reminisce/semantic';

const store = new InMemorySemanticStore({
  machineId: 'agent-1',
  sessionId: 'global',
});

// Store fact (with optional SPO triple)
const fact = await store.store({
  fact: 'User prefers TypeScript over JavaScript',
  subject: 'user',
  predicate: 'prefers',
  object: 'TypeScript',
  category: 'preferences',
  sourceEpisodeIds: [episodeId],
  confidence: 0.9,
});

// Query by subject/predicate/object
const userFacts = await store.query({ subject: 'user' });
const preferences = await store.query({ category: 'preferences' });

// Check for contradictions before storing
const result = await store.checkContradiction({
  fact: 'User prefers JavaScript',
  subject: 'user',
  predicate: 'prefers',
  object: 'JavaScript',
});
// result: { hasContradiction: true, existingFact: ..., confidenceDelta: 0.4 }

// Retract fact (soft delete with reason)
await store.retract(fact.memory_id.id, 'user_corrected');

// Supersede (retract old, create new with link)
const { old, new: newFact } = await store.supersede(oldFactId, {
  fact: 'User now prefers Rust',
  subject: 'user',
  predicate: 'prefers',
  object: 'Rust',
});

// Reinstate retracted fact
await store.reinstate(factId);

// Validate (boost confidence)
await store.validate(factId, 0.1);

// Apply decay
await store.applyDecay(factId, 0.05);

// Get low-confidence facts for validation
const needsValidation = await store.getValidationCandidates(0.5);
```

### @reminisce/consolidation

Episodic → Semantic transfer:

```typescript
import { ConsolidationEngine, SimpleFactExtractor } from '@reminisce/consolidation';

const engine = new ConsolidationEngine(
  episodicStore,
  semanticStore,
  new SimpleFactExtractor(),  // Or custom extractor
  {
    minAgeHours: 1,
    minSalience: 0.3,
    batchSize: 10,
  }
);

// Run consolidation
const result = await engine.consolidate();
// result: {
//   episodesProcessed: 5,
//   factsExtracted: 12,
//   contradictionsSkipped: 1,
//   lowConfidenceFiltered: 2,
// }

// Get stats
const stats = await engine.getStats();
// stats: {
//   pendingEpisodes: 23,
//   consolidatedEpisodes: 100,
//   totalFacts: 456,
//   lowConfidenceFacts: 12,
// }
```

**Custom fact extraction**:

```typescript
import { FactExtractor } from '@reminisce/consolidation';

class LLMFactExtractor implements FactExtractor {
  async extract(episode: EpisodicMemory): Promise<ExtractedFact[]> {
    // Call LLM to extract structured facts
    const response = await llm.complete({
      prompt: `Extract facts from: ${episode.content.summary}`,
    });
    return parseFacts(response);
  }
}
```

### @reminisce/orchestrator

Unified interface tying everything together:

```typescript
import { Reminisce } from '@reminisce/orchestrator';

const reminisce = new Reminisce({
  machineId: 'my-agent',
  workingMemoryCapacity: 7,
  autoConsolidate: true,
  consolidation: {
    minAgeHours: 1,
    minSalience: 0.3,
    batchSize: 10,
  },
});

// Session management
const session = reminisce.startSession('session-123');
// ... do work ...
const result = await reminisce.endSession();
// result: { sessionId, itemsFlushed, consolidationResult }

// Remember (goes to working memory, overflows to episodic)
const item = await reminisce.remember({
  type: 'message',
  data: { text: 'Hello world' },
  summary: 'Greeting',
  tags: ['conversation'],
});

// Pin important items
reminisce.pin(item.memory_id.id);

// Record episode directly (bypasses working memory)
await reminisce.recordEpisode({
  event: 'user_action',
  summary: 'User clicked button',
  entities: ['User', 'Button'],
});

// Store fact directly (bypasses consolidation)
await reminisce.storeFact({
  fact: 'User is a developer',
  subject: 'user',
  category: 'profile',
  sourceEpisodeIds: [],
});

// Search across all layers
const results = await reminisce.search({
  text: 'TypeScript',
  tags: ['programming'],
  limit: 10,
});
// results: { working: [...], episodic: [...], semantic: [...] }

// Get facts about a subject
const userFacts = await reminisce.getFactsAbout('user');

// Block memory (mark for forgetting)
await reminisce.block(memoryId, 'working');   // Remove from buffer
await reminisce.block(memoryId, 'episodic');  // Delete episode
await reminisce.block(memoryId, 'semantic');  // Retract fact

// Manual consolidation
const consolidationResult = await reminisce.consolidate();

// System stats
const stats = await reminisce.getStats();
// stats: {
//   sessions: 1,
//   workingMemorySize: 5,
//   workingMemoryCapacity: 7,
//   pendingEpisodes: 23,
//   consolidatedEpisodes: 100,
//   totalFacts: 456,
//   lowConfidenceFacts: 12,
// }

// GDPR: Forget all data for a session/user
await reminisce.forgetSession('user-123');
```

---

## Type System

### MemoryID

Every memory gets a globally unique, time-sortable identifier:

```typescript
interface MemoryID {
  id: string;              // UUID v7 (time-sortable)
  layer: MemoryLayer;      // 'working' | 'episodic' | 'semantic' | 'procedural'
  created_at: Date;
  source_session: string;
  source_machine: string;
}
```

### BaseMemory

All memory types extend this:

```typescript
interface BaseMemory {
  memory_id: MemoryID;
  content: unknown;           // Layer-specific
  embedding?: number[];       // For vector search
  provenance: Provenance;
  salience: Salience;
  tags?: string[];
  metadata?: Record<string, unknown>;
}
```

### WorkingMemoryItem

```typescript
interface WorkingMemoryItem extends BaseMemory {
  memory_id: MemoryID & { layer: 'working' };
  content: {
    type: 'message' | 'tool_result' | 'context' | 'goal';
    data: unknown;
    summary?: string;
  };
  slot: number;
  overflowed: boolean;
}
```

### EpisodicMemory

```typescript
interface EpisodicMemory extends BaseMemory {
  memory_id: MemoryID & { layer: 'episodic' };
  content: {
    event: string;
    event_data?: Record<string, unknown>;
    summary: string;
    entities: string[];
    valence?: number;  // -1 to 1 (emotional tone)
  };
  started_at: Date;
  ended_at?: Date;
  session_id: string;
  consolidated: boolean;
  extracted_fact_ids?: MemoryID[];
}
```

### SemanticMemory

```typescript
interface SemanticMemory extends BaseMemory {
  memory_id: MemoryID & { layer: 'semantic' };
  content: {
    fact: string;
    subject?: string;
    predicate?: string;
    object?: string;
    category?: string;
  };
  source_episode_ids: MemoryID[];
  related_fact_ids?: MemoryID[];
}
```

---

## Memory Layers

### Working Memory

**Purpose**: Active context during a session. Like human working memory, limited to ~7 items.

**Characteristics**:
- In-memory only (not persisted)
- Session-scoped
- Hard capacity limit with salience-based eviction
- Automatic overflow to episodic

**When to use**: Current conversation context, active task state, goals.

### Episodic Memory

**Purpose**: Timeline of events. "What happened when."

**Characteristics**:
- Persisted (in-memory for MVP, pluggable storage)
- Time-indexed, session-tagged
- Contains raw event data + summary
- Candidates for consolidation based on salience + age

**When to use**: Conversation history, user actions, system events.

### Semantic Memory

**Purpose**: Facts and knowledge. "What is true."

**Characteristics**:
- Persisted with provenance
- Subject-predicate-object triples (optional)
- Contradiction detection
- Confidence scoring with decay
- Soft delete (retraction) with reason tracking

**When to use**: User preferences, learned facts, entity knowledge.

---

## Consolidation Pipeline

```
┌─────────────────────────────────────────────────────────────────┐
│                    CONSOLIDATION FLOW                            │
└─────────────────────────────────────────────────────────────────┘

     EPISODIC STORE                         SEMANTIC STORE
     ─────────────                          ──────────────
           │
           │  getConsolidationCandidates()
           │  (minAge, minSalience)
           ▼
     ┌───────────┐
     │ Episode 1 │──┐
     │ Episode 2 │  │
     │ Episode 3 │  │
     └───────────┘  │
                    │
                    ▼
           ┌───────────────┐
           │ FactExtractor │
           │               │
           │ • Parse text  │
           │ • Extract SPO │
           │ • Score conf  │
           └───────────────┘
                    │
                    ▼
           ┌───────────────┐
           │ Filter        │
           │               │
           │ • Min conf    │
           │ • Check dups  │
           └───────────────┘
                    │
                    ▼
           ┌───────────────┐
           │ Contradiction │
           │ Check         │
           │               │
           │ • Same SPO?   │
           │ • Conf delta? │
           └───────────────┘
                    │
         ┌─────────┴─────────┐
         │                   │
         ▼                   ▼
    No conflict         Conflict found
         │                   │
         │              ┌────┴────┐
         │              │ Policy  │
         │              │ • skip  │
         │              │ • super │
         │              └────┬────┘
         │                   │
         ▼                   ▼
     ┌─────────────────────────┐
     │   Store to Semantic     │──────────────►  SEMANTIC
     │   Link provenance       │                  STORE
     │   Mark episode done     │
     └─────────────────────────┘
```

### Fact Extraction

The default `SimpleFactExtractor` uses pattern matching:

```typescript
// Extracts from episode summary
// "User mentioned they prefer TypeScript"
// → { fact: "User prefers TypeScript", subject: "user", ... }
```

For production, implement a custom extractor using an LLM.

### Contradiction Handling

When a new fact contradicts an existing one:

1. **Skip** (default): Don't store the new fact
2. **Supersede**: Retract old, store new with link
3. **Manual**: Flag for human review

Contradiction is detected by matching subject + predicate with different objects.

---

## Usage Examples

### Basic Session Flow

```typescript
import { Reminisce } from '@reminisce/orchestrator';

const reminisce = new Reminisce({ machineId: 'my-agent' });

// Start session
reminisce.startSession();

// Remember conversation
await reminisce.remember({
  type: 'message',
  data: { role: 'user', text: 'I prefer TypeScript' },
  summary: 'User stated TypeScript preference',
  tags: ['preference'],
  signals: { reward_signal: 0.3 }
});

// Later: search for preferences
const results = await reminisce.search({ tags: ['preference'] });

// End session (auto-consolidates)
await reminisce.endSession();
```

### Custom Stores

```typescript
import { Reminisce } from '@reminisce/orchestrator';
import { PostgresEpisodicStore } from './my-stores';
import { PineconeSemanticStore } from './my-stores';

const reminisce = new Reminisce({
  machineId: 'my-agent',
  episodicStore: new PostgresEpisodicStore(connectionString),
  semanticStore: new PineconeSemanticStore(apiKey),
});
```

### GDPR Compliance

```typescript
// User requests data deletion
const result = await reminisce.forgetSession('user-123');
console.log(`Deleted ${result.episodesDeleted} episodes`);
```

---

## MCP Server Vector Search Integration

The `@reminisce/mcp-server` augments the core semantic search with vector similarity search at the MCP server level. This is a thin integration layer - all changes live in `packages/mcp-server/src/index.ts`.

### Why MCP Server Level

The core `@reminisce/semantic` package uses `LIKE '%text%'` for text search, which only matches contiguous substrings. Vector search infrastructure existed in `@reminisce/storage-sqlite` (sqlite-vec tables, `storeSemanticEmbedding()`, `searchSemanticByVector()`) but was never called from the query path. Rather than refactoring the type system and store interfaces across multiple packages, the integration was done at the MCP server boundary - the thinnest possible layer.

### How It Works

**Auto-embed on store:** When `store_fact` is called and vector search is enabled, the MCP server generates an embedding from the composite text (`subject + predicate + object + fact`) via LM Studio's OpenAI-compatible API (`/v1/embeddings`) and stores it in the `semantic_vec` sqlite-vec table.

**Vector-augmented search:** When `search` is called with a `text` query, the MCP server:
1. Runs the existing LIKE search through the orchestrator (baseline results)
2. Embeds the query text via LM Studio
3. Calls `searchSemanticByVector()` to find similar facts by cosine distance
4. Hydrates vector hits by querying the `semantic_memories` table directly
5. Merges results (union, deduplicated by memory ID)

**Graceful degradation:** If LM Studio is unavailable or embedding fails, the server silently falls back to LIKE-only search. No errors, no broken functionality.

### Embedding Configuration

| Env Variable | Description | Default |
|-------------|-------------|---------|
| `REMINISCE_EMBED_URL` | LM Studio base URL | `http://localhost:1234` |
| `REMINISCE_EMBED_MODEL` | Embedding model name | `text-embedding-embeddinggemma-300m` |

All embeddings are 768 dimensions via EmbeddingGemma-300m. LM Studio is the only supported local embedding provider (not Ollama).

### Architecture Diagram

```
┌──────────────────────────────────────────────────────┐
│                   MCP Server (index.ts)              │
│                                                      │
│  store_fact ─────┬──► orchestrator.storeFact()       │
│                  └──► embedText() ──► LM Studio      │
│                       └──► storeSemanticEmbedding()  │
│                                                      │
│  search ─────────┬──► orchestrator.search() (LIKE)   │
│                  └──► embedText() ──► LM Studio      │
│                       └──► searchSemanticByVector()   │
│                            └──► hydrate + merge      │
└──────────────────────────────────────────────────────┘
         │                    │
         ▼                    ▼
  ┌─────────────┐    ┌──────────────┐
  │ SQLite DB   │    │  LM Studio   │
  │ memory.db   │    │  :1234       │
  │             │    │              │
  │ semantic_   │    │ /v1/         │
  │ memories    │    │ embeddings   │
  │ semantic_   │    │              │
  │ vec (vec0)  │    │ EmbeddingGemma│
  └─────────────┘    │ -300m (768d) │
                     └──────────────┘
```

---

## Future Work

### Phase 2: Production Readiness

- [x] Persistent stores (SQLite)
- [x] Vector embeddings for semantic search (sqlite-vec + LM Studio)
- [ ] LLM-based fact extraction
- [ ] Evaluation benchmark suite
- [x] MCP server wrapper
- [x] MCP-level vector search integration (auto-embed on store, vector-augmented search)

### Phase 3: Advanced Features

- [ ] **Procedural Memory** (`@reminisce/procedural`): Skills, workflows, patterns
- [ ] **Social Memory** (`@reminisce/social`): Cross-agent sharing via CRDT
- [ ] **Retrieval-induced forgetting**: Accessing memories suppresses competitors
- [ ] **Suppression policies**: Topic/session blocking
- [ ] **Observability**: Metrics, dashboards

### Phase 4: Product

- [ ] Cloud hosted option
- [ ] Dashboard UI
- [ ] Multi-tenant support

---

## Implementation Status

| Package | Status | Tests | Description |
|---------|--------|-------|-------------|
| `@reminisce/core` | ✅ Complete | 8 | Types, salience, provenance |
| `@reminisce/working` | ✅ Complete | 10 | Session buffer with overflow |
| `@reminisce/episodic` | ✅ Complete | 11 | Timeline storage |
| `@reminisce/semantic` | ✅ Complete | 13 | Facts with contradictions |
| `@reminisce/consolidation` | ✅ Complete | 7 | Episodic → Semantic |
| `@reminisce/orchestrator` | ✅ Complete | 13 | Unified interface |
| `@reminisce/storage-sqlite` | ✅ Complete | 38 | SQLite + vector search |
| `@reminisce/mcp-server` | ✅ Complete | 9 | MCP protocol wrapper |
| `@reminisce/cli` | ✅ Complete | - | CLI initialization |
| `@reminisce/reminisce` | ✅ Complete | - | Unified re-export |
| `@reminisce/procedural` | ✅ Complete | 37 | Skills/workflows (in-memory) |
| `@reminisce/social` | ✅ Complete | 7 | Cross-agent CRDT sync (in-memory) |
| `@reminisce/api` | ✅ Complete | 14 | REST API server |
| `@reminisce/dashboard` | ✅ Complete | - | Web UI |
| `@reminisce/cloudflare` | ✅ Complete | - | Cloudflare Workers deployment |

**Total: 606 tests passing**

---

*Document version: 3.3*
*Last updated: 2026-03-01*
*Status: Phase 3 Complete, MCP vector search integrated*
