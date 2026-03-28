# @reminisce/cloudflare

Deploy Reminisce to Cloudflare Workers with D1, Vectorize, and Workers AI.

## Features

- **D1 Storage** - SQLite-compatible database for episodic and semantic memories
- **Vectorize** - Vector search for semantic similarity queries
- **Workers AI** - Free embeddings and LLM chat capabilities
- **Multi-tenant** - API key authentication with tenant isolation
- **Zero cold starts** - Cloudflare's global edge network

## Quick Start

### 1. Install Wrangler

```bash
bun add -g wrangler
wrangler login
```

### 2. Create D1 Database

```bash
wrangler d1 create reminisce
```

Copy the `database_id` from the output.

### 3. Configure wrangler.toml

```bash
cp node_modules/@reminisce/cloudflare/wrangler.toml.example wrangler.toml
```

Edit `wrangler.toml` and fill in your `database_id`.

### 4. Initialize Schema

```bash
wrangler deploy
curl -X POST -H "X-API-Key: reminisce_your_secure_key_here" https://your-worker.workers.dev/api/init
```

Note: Insert your tenant row (step 5) before running init, or use wrangler D1 to run the schema directly.

### 5. Create an API Key

Connect to your D1 database and insert a tenant:

```bash
wrangler d1 execute reminisce --command "INSERT INTO tenants (id, name, api_key, active, created_at) VALUES ('tenant-1', 'My App', 'reminisce_your_secure_key_here', 1, datetime('now'))"
```

### 6. Test the API

```bash
curl https://your-worker.workers.dev/health

curl -H "X-API-Key: reminisce_your_secure_key_here" \
  https://your-worker.workers.dev/api/stats
```

## Full Configuration

### Enable Vector Search

Create a Vectorize index:

```bash
wrangler vectorize create reminisce-vectors --dimensions 768 --metric cosine
```

Add to `wrangler.toml`:

```toml
[[vectorize]]
binding = "VECTORIZE"
index_name = "reminisce-vectors"
```

### Enable Workers AI

Add to `wrangler.toml`:

```toml
[ai]
binding = "AI"
```

### Set JWT Secret

For token-based authentication:

```bash
wrangler secret put JWT_SECRET
# Enter a secure random string
```

## API Endpoints

### Authentication

All endpoints (except `/health`) require authentication.

**API Key:**
```bash
curl -H "X-API-Key: reminisce_xxx" https://your-worker.workers.dev/api/stats
```

**JWT Token:**
```bash
curl -H "Authorization: Bearer <token>" https://your-worker.workers.dev/api/stats
```

### Memory Operations

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/memory/working` | Get working memory items |
| GET | `/api/memory/episodic` | List episodic memories |
| GET | `/api/memory/semantic` | List semantic facts |
| POST | `/api/memory/remember` | Add to working memory |
| POST | `/api/memory/episode` | Record an episode |
| POST | `/api/memory/fact` | Store a semantic fact |
| DELETE | `/api/memory/:layer/:id` | Delete a memory |

### Search

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/search?q=query` | Text search |
| GET | `/api/vector/search?q=query` | Vector similarity search (requires Vectorize) |

### AI Features

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/chat` | RAG-powered chat (requires Workers AI) |
| POST | `/api/consolidate` | Trigger memory consolidation |

### Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/stats` | Memory statistics |
| GET | `/api/tenant` | Current tenant info |
| DELETE | `/api/session/:id` | GDPR: forget session |

## Pricing

Cloudflare has generous free tiers:

| Service | Free Tier |
|---------|-----------|
| Workers | 100,000 requests/day |
| D1 | 5 million reads/day, 100k writes/day, 5GB storage |
| Vectorize | 30 million vectors queried/month |
| Workers AI | Free for most models |

See [Cloudflare pricing](https://www.cloudflare.com/pricing/) for details.

## Local Development

```bash
# Install dependencies
bun install

# Run locally with wrangler
wrangler dev

# The API will be available at http://localhost:8787
```

## Programmatic Usage

```typescript
import { D1EpisodicStore, D1SemanticStore, VectorStore, WorkersAIEmbeddings } from '@reminisce/cloudflare';

// In your Worker
export default {
  async fetch(request: Request, env: Env) {
    const episodicStore = new D1EpisodicStore(env.DB, {
      tenantId: 'my-tenant',
      machineId: 'worker',
    });

    // With vector search
    const embeddings = new WorkersAIEmbeddings(env.AI);
    const vectorStore = new VectorStore(env.VECTORIZE, {
      tenantId: 'my-tenant',
      embeddingProvider: embeddings,
    });

    // Search for similar memories
    const results = await vectorStore.search('user preferences', { topK: 5 });
  },
};
```

## License

MIT
