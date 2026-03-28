/**
 * @reminisce/cloudflare - Cloudflare Workers Deployment
 *
 * Deploy Reminisce to Cloudflare Workers with:
 * - D1 for SQLite-compatible storage
 * - Vectorize for vector search
 * - Workers AI for free embeddings
 *
 * @example
 * ```typescript
 * // wrangler.toml
 * name = "reminisce-api"
 * main = "node_modules/@reminisce/cloudflare/dist/worker.js"
 *
 * [[d1_databases]]
 * binding = "DB"
 * database_name = "reminisce"
 * database_id = "your-database-id"
 *
 * [ai]
 * binding = "AI"
 * ```
 *
 * @packageDocumentation
 */

// D1 Storage
export {
  D1EpisodicStore,
  D1SemanticStore,
  SCHEMA,
  type D1EpisodicStoreConfig,
  type D1SemanticStoreConfig,
} from './d1-storage.js';

// Vectorize Integration
export {
  VectorStore,
  WorkersAIEmbeddings,
  RAGHelper,
  type EmbeddingProvider,
  type VectorStoreConfig,
  type VectorSearchResult,
  type RAGConfig,
} from './vectorize.js';

// Worker
export { createWorkerApp, type Env } from './worker.js';
