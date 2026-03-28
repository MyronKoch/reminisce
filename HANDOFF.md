# Reminisce Handoff Document

> For the next Claude Code session picking up this project.

## TL;DR

You're building a **productizable memory framework** for AI systems. The MVP is complete with **252 tests passing**. SQLite persistence is working. MCP server is integrated. **Ready for npm publish.**

---

## What Exists

### Codebase Structure

```
reminisce/
├── packages/
│   ├── core/            ✅ Types, salience, provenance (8 tests)
│   ├── working/         ✅ 7-item session buffer (10 tests)
│   ├── episodic/        ✅ Timeline storage (11 tests)
│   ├── semantic/        ✅ Facts + contradictions (13 tests)
│   ├── consolidation/   ✅ Episodic → Semantic (7 tests)
│   ├── orchestrator/    ✅ Unified interface (13 tests)
│   ├── mcp-server/      ✅ MCP protocol wrapper with SQLite (9 tests)
│   ├── storage-sqlite/  ✅ SQLite + vector search (38 tests)
│   ├── procedural/      ✅ Skills/workflows (37 tests)
│   ├── social/          ✅ Cross-agent CRDT sync (7 tests)
│   ├── api/             ✅ REST API server (14 tests)
│   ├── dashboard/       ✅ Web UI
│   ├── cloudflare/      ✅ Cloudflare Workers deployment
│   ├── cli/             ✅ CLI initialization
│   └── reminisce/            ✅ Unified re-export package
├── docs/
│   └── COGNITIVE_SCIENCE.md   # Neuroscience research background
├── ARCHITECTURE.md            # Comprehensive design doc (READ THIS FIRST)
├── README.md                  # Project overview with Quick Start
├── turbo.json                 # Build configuration
├── package.json               # Monorepo root (bun workspaces)
└── bun.lock
```

### Key Commands

```bash
# Run all tests
bun test

# Build all packages
bun run build

# Run specific package tests
cd packages/orchestrator && bun test
```

### What Works

1. **Working Memory** - 7-item buffer with salience-based eviction, auto-overflow
2. **Episodic Memory** - Timeline storage, session tagging, consolidation candidates
3. **Semantic Memory** - Facts with SPO triples, contradiction detection, retraction/supersession
4. **Consolidation** - Pluggable fact extraction, episodic → semantic transfer
5. **Orchestrator** - Unified API: `remember()`, `search()`, `consolidate()`, `forgetSession()`
6. **SQLite Persistence** - Full support via environment variables
7. **MCP Server** - All tools working with SQLite integration
8. **CLI** - Database initialization with vector search support

### What Doesn't Exist Yet

- Real LLM-based fact extraction (mock providers work; real OpenAI/Anthropic providers implemented but untested with live APIs)
- SQLite persistence for procedural and social packages (in-memory stores only)

---

## Quick Start (Ready to Use)

### With Claude Code

Add to `~/.claude/claude_code_config.json`:

```json
{
  "mcpServers": {
    "reminisce": {
      "command": "npx",
      "args": ["@reminisce/mcp-server"],
      "env": {
        "REMINISCE_DB_PATH": "~/.reminisce/memory.db",
        "REMINISCE_MACHINE_ID": "my-machine"
      }
    }
  }
}
```

Or with Bun (faster startup):

```json
{
  "mcpServers": {
    "reminisce": {
      "command": "bunx",
      "args": ["@reminisce/mcp-server"],
      "env": {
        "REMINISCE_DB_PATH": "~/.reminisce/memory.db"
      }
    }
  }
}
```

### Programmatic Usage

```typescript
import { Reminisce, SqliteEpisodicStore, SqliteSemanticStore } from '@reminisce/reminisce';

const reminisce = new Reminisce({
  machineId: 'my-app',
  episodicStore: new SqliteEpisodicStore('./memory.db', { machineId: 'my-app' }),
  semanticStore: new SqliteSemanticStore('./memory.db', {
    machineId: 'my-app',
    sessionId: 'default'
  }),
});

reminisce.startSession();
await reminisce.remember({ type: 'context', data: { user: 'prefers dark mode' } });
await reminisce.storeFact({ fact: 'User prefers dark mode', subject: 'user', predicate: 'prefers', object: 'dark mode', sourceEpisodeIds: [] });
```

---

## MCP Server

The `packages/mcp-server/` package exposes Reminisce via MCP protocol with SQLite persistence.

**Environment Variables:**
| Variable | Description | Default |
|----------|-------------|---------|
| `REMINISCE_DB_PATH` | SQLite database path | (in-memory) |
| `REMINISCE_MACHINE_ID` | Machine identifier | `reminisce-mcp` |
| `REMINISCE_VECTOR` | Enable vector search | `false` |
| `REMINISCE_DIMENSIONS` | Embedding dimensions | `1536` |

**Implemented Tools:**
- `remember` - Add to working memory
- `search` - Search across layers
- `store_fact` - Direct fact storage
- `record_episode` - Record episode directly
- `get_facts` - Get facts about subject
- `forget_session` - GDPR deletion
- `consolidate` - Manual consolidation trigger
- `get_stats` - System stats

**Implemented Resources:**
- `reminisce://facts/{subject}` - Facts about subject
- `reminisce://episodes/recent` - Recent episodes
- `reminisce://working/current` - Current working memory

---

## Packages

| Package | Description | Status |
|---------|-------------|--------|
| `@reminisce/core` | Shared types, salience, provenance | ✅ Complete |
| `@reminisce/working` | Working memory (7-item buffer) | ✅ Complete |
| `@reminisce/episodic` | Episodic memory (timeline) | ✅ Complete |
| `@reminisce/semantic` | Semantic memory (facts) | ✅ Complete |
| `@reminisce/consolidation` | Episodic → Semantic extraction | ✅ Complete |
| `@reminisce/orchestrator` | Unified interface | ✅ Complete |
| `@reminisce/mcp-server` | MCP server wrapper | ✅ Complete |
| `@reminisce/storage-sqlite` | SQLite persistent storage | ✅ Complete |
| `@reminisce/cli` | CLI for initialization | ✅ Complete |
| `@reminisce/reminisce` | Unified re-export | ✅ Complete |
| `@reminisce/procedural` | Procedural memory (skills) | ✅ Complete (in-memory, no SQLite persistence yet) |
| `@reminisce/social` | Social/transactive memory | ✅ Complete (in-memory CRDT sync, no SQLite persistence yet) |
| `@reminisce/api` | REST API server | ✅ Complete |
| `@reminisce/dashboard` | Web UI | ✅ Complete |
| `@reminisce/cloudflare` | Cloudflare Workers deployment | ✅ Complete |

All packages have:
- Proper ESM exports
- TypeScript declarations
- npm metadata (keywords, repository, bugs, homepage)
- `files` field for clean publishing

---

## Key Design Decisions

1. **UUID v7** for all IDs (time-sortable)
2. **Salience scoring** with instrumentation for tuning
3. **Provenance tracking** - every fact links to source
4. **Soft deletes** - retraction with reason, not hard delete
5. **Pluggable stores** - in-memory defaults, swap for persistent
6. **exactOptionalPropertyTypes** - strict TypeScript (don't assign undefined to optional props)

---

## Code Patterns

### TypeScript Strictness

```typescript
// WRONG - can't assign undefined with exactOptionalPropertyTypes
const obj = { required: x, optional: undefined };

// CORRECT - conditionally add
const obj: MyType = { required: x };
if (value !== undefined) obj.optional = value;
```

---

## Files to Read First

1. `ARCHITECTURE.md` - Full design, all APIs documented
2. `packages/orchestrator/src/reminisce.ts` - Main entry point
3. `packages/core/src/types/` - All type definitions
4. `docs/COGNITIVE_SCIENCE.md` - Why it's designed this way

---

## What's Next

### To Publish to npm

```bash
# Login to npm (if not already)
npm login

# Publish all packages (from root)
# Use changesets or manual publish
```

### Future Work

- [ ] Real LLM-based fact extraction in consolidation (providers exist, need live API testing)
- [x] Procedural memory (skills/how-tos) — in-memory complete, needs SQLite persistence
- [x] Social/transactive memory (cross-agent) — CRDT sync complete, needs SQLite persistence
- [x] Dashboard UI — complete
- [x] Cloud hosting option — Cloudflare Workers package complete
- [ ] Published to npm

---

## Success Criteria

Progress:
- [x] `packages/mcp-server/` exists and works
- [x] MCP server uses SQLite when REMINISCE_DB_PATH is set
- [x] SQLite backend persists data across sessions
- [x] README has working Quick Start
- [x] All tests pass (252 tests)
- [x] Unified `@reminisce/reminisce` package created
- [x] All packages have npm metadata
- [x] Local registry testing (Verdaccio)
- [ ] Published to npm
- [ ] Tested with actual Claude Code

---

*Handoff updated: 2026-01-30*
